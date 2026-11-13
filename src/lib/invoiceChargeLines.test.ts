import { describe, expect, it } from 'vitest';
import { CHARGE_TYPE_OPTIONS, chargeTypeLabel, fromScratchLinesProblem, invoiceBreakdown, invoiceMarginCents, isFromScratchInvoice } from './invoiceChargeLines';

describe('isFromScratchInvoice', () => {
  it('is a misc_charge or chemical_sale with no order and no delivery', () => {
    expect(isFromScratchInvoice({ invoice_type: 'misc_charge' })).toBe(true);
    expect(isFromScratchInvoice({ invoice_type: 'chemical_sale', order_id: null, delivery_id: null })).toBe(true);
  });

  it('is never an order- or delivery-backed invoice, a field invoice or a credit memo', () => {
    expect(isFromScratchInvoice({ invoice_type: 'chemical_sale', order_id: 'o1' })).toBe(false);
    expect(isFromScratchInvoice({ invoice_type: 'misc_charge', delivery_id: 'd1' })).toBe(false);
    expect(isFromScratchInvoice({ invoice_type: 'field_application' })).toBe(false);
    expect(isFromScratchInvoice({ invoice_type: 'credit_memo' })).toBe(false);
  });
});

describe('fromScratchLinesProblem', () => {
  const charge = { product_id: null, charge_type: 'freight' as const, description: 'Freight', quantity: 1, unit_price_cents: 2500 };

  it('passes typed charges with a description and an amount', () => {
    expect(fromScratchLinesProblem([charge, { ...charge, charge_type: 'other' }])).toBeNull();
    expect(fromScratchLinesProblem([])).toBeNull();
  });

  it('refuses a product line, an untyped line, a blank description and a $0 amount', () => {
    expect(fromScratchLinesProblem([{ ...charge, product_id: 'p1', charge_type: null }])).toMatch(/cannot carry products/);
    expect(fromScratchLinesProblem([{ ...charge, charge_type: null }])).toBe('Pick a charge type for every line.');
    expect(fromScratchLinesProblem([{ ...charge, description: '  ' }])).toBe('Add a description to every charge.');
    expect(fromScratchLinesProblem([{ ...charge, unit_price_cents: 0 }])).toBe('Every charge needs an amount above $0.00.');
    expect(fromScratchLinesProblem([{ ...charge, quantity: 2 }])).toMatch(/one amount/);
  });
});

describe('the standing discount line (billing plan M4b)', () => {
  const discount = { product_id: null, charge_type: 'standing_discount' as const, description: 'Standing discount 3%', quantity: 1, unit_price_cents: -300 };
  const freight = { product_id: null, charge_type: 'freight' as const, description: 'Freight', quantity: 1, unit_price_cents: 4500 };

  it('lets a discounted chemical sale be saved: the database writes that line, so the screen does not check it', () => {
    expect(fromScratchLinesProblem([freight, discount])).toBeNull();
    expect(fromScratchLinesProblem([discount])).toBeNull();
  });

  it('still checks every other charge line beside it', () => {
    expect(fromScratchLinesProblem([{ ...freight, unit_price_cents: 0 }, discount])).toBe('Every charge needs an amount above $0.00.');
  });

  it('is labelled but never offered as a type to pick', () => {
    expect(chargeTypeLabel('standing_discount')).toBe('Standing discount');
    expect(CHARGE_TYPE_OPTIONS.map((option) => option.value)).not.toContain('standing_discount');
  });
});

describe('the sales tax line (billing plan M4a)', () => {
  const tax = { product_id: null, charge_type: 'sales_tax' as const, description: 'Sales tax 6.25%', quantity: 1, unit_price_cents: 281 };
  const freight = { product_id: null, charge_type: 'freight' as const, description: 'Freight', quantity: 1, unit_price_cents: 4500 };

  it('is the database\'s own line, so the screen does not check it, and still checks the lines beside it', () => {
    expect(fromScratchLinesProblem([freight, tax])).toBeNull();
    expect(fromScratchLinesProblem([{ ...freight, description: ' ' }, tax])).toBe('Add a description to every charge.');
  });

  it('is labelled but never offered as a type to pick', () => {
    expect(chargeTypeLabel('sales_tax')).toBe('Sales tax');
    expect(CHARGE_TYPE_OPTIONS.map((option) => option.value)).not.toContain('sales_tax');
  });
});

describe('charge types', () => {
  it('offer staff the four types they can pick (the database also writes its own standing_discount and sales_tax lines)', () => {
    expect(CHARGE_TYPE_OPTIONS.map((o) => o.value)).toEqual(['freight', 'application_fee', 'service', 'other']);
    expect(chargeTypeLabel('application_fee')).toBe('Application fee');
    expect(chargeTypeLabel(null)).toBe('');
  });
});

describe('invoiceMarginCents (billing plan M4a)', () => {
  it('leaves the sales tax out: tax is collected for the state, not earned', () => {
    const lines = [
      { extended_cents: 100000, charge_type: null },
      { extended_cents: 4500, charge_type: 'freight' as const },
      { extended_cents: -3000, charge_type: 'standing_discount' as const },
      { extended_cents: 6408, charge_type: 'sales_tax' as const },
    ];
    expect(invoiceMarginCents(lines, 90000)).toBe(100000 + 4500 - 3000 - 90000);
  });
});

describe('invoiceBreakdown', () => {
  const products = [
    { extended_cents: 24740 },
    { extended_cents: 26850, charge_type: null },
    { extended_cents: 15070, product_id: 'p1' },
  ];

  it('splits products, charges, standing discount and tax', () => {
    expect(
      invoiceBreakdown([
        ...products,
        { extended_cents: 4500, charge_type: 'freight' },
        { extended_cents: -2000, charge_type: 'standing_discount', description: 'Standing discount 3%' },
        { extended_cents: 4323, charge_type: 'sales_tax', description: 'Sales tax 6.25%' },
      ]),
    ).toEqual({
      productsCents: 66660,
      charges: [{ label: 'Freight', cents: 4500 }],
      discount: { label: 'Standing discount 3%', cents: -2000 },
      tax: { label: 'Sales tax 6.25%', cents: 4323 },
      totalCents: 73483,
    });
  });

  it('products only: no charges, discount or tax', () => {
    expect(invoiceBreakdown(products)).toEqual({ productsCents: 66660, charges: [], discount: null, tax: null, totalCents: 66660 });
  });

  it('groups charges by label and falls back to the type label', () => {
    const b = invoiceBreakdown([
      { extended_cents: 100, charge_type: 'freight' },
      { extended_cents: 250, charge_type: 'freight' },
      { extended_cents: 900, charge_type: 'service' },
      { extended_cents: -50, charge_type: 'standing_discount' },
      { extended_cents: 7, charge_type: 'sales_tax', description: '' },
    ]);
    expect(b.charges).toEqual([{ label: 'Freight', cents: 350 }, { label: 'Service', cents: 900 }]);
    expect(b.discount).toEqual({ label: 'Standing discount', cents: -50 });
    expect(b.tax).toEqual({ label: 'Sales tax', cents: 7 });
    expect(b.totalCents).toBe(1207);
  });
});
