/**
 * invoicePdf.test.ts — Tests for invoice PDF generation (3 layouts)
 * Uses the same jsPDF/autoTable mock pattern as statementPdf.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock jsPDF doc instance ─────────────────────────────────────────────

const mockDoc = {
  internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
  setFillColor: vi.fn(),
  rect: vi.fn(),
  setFont: vi.fn(),
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  text: vi.fn(),
  setDrawColor: vi.fn(),
  setLineWidth: vi.fn(),
  line: vi.fn(),
  roundedRect: vi.fn(),
  splitTextToSize: vi.fn((text: string) => [text]),
  getTextWidth: vi.fn(() => 50),
  setLineDashPattern: vi.fn(),
  addPage: vi.fn(),
  addImage: vi.fn(),
  setPage: vi.fn(),
  getNumberOfPages: vi.fn(() => 1),
  save: vi.fn(),
  lastAutoTable: { finalY: 300 },
};

vi.mock('jspdf', () => {
  function JsPDFMock() { return mockDoc; }
  return { default: JsPDFMock };
});

vi.mock('jspdf-autotable', () => ({
  default: vi.fn((doc: Record<string, unknown>, opts: Record<string, unknown>) => {
    (doc as typeof mockDoc).lastAutoTable = { finalY: ((opts.startY as number) || 0) + 100 };
  }),
}));

// The Settings read: built-in company details unless a test supplies saved ones.
const companyInfo = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./companyInfoForPdf', () => ({ loadCompanyInfoForPdf: companyInfo.load }));

import { DEFAULT_COMPANY_INFO } from './companyInfo';
import { generateInvoicePdf, downloadInvoicePdf, generateBatchInvoicePdf, groupReturnCreditDisplayItems, mapInvoicePdfItem } from './invoicePdf';
import { INVOICE_PDF_ITEM_COLUMNS } from '../../supabase/functions/_shared/pdf/invoicePdf.ts';

companyInfo.load.mockResolvedValue(DEFAULT_COMPANY_INFO);
import type { InvoicePdfData, InvoicePdfItem, InvoicePdfShare } from './invoicePdf';

// ── Test Data Factories ─────────────────────────────────────────────────

function makeItem(overrides: Partial<InvoicePdfItem> = {}): InvoicePdfItem {
  return {
    description: 'Atrazine 4L',
    product_name: 'Atrazine 4L',
    quantity: 10,
    unit_size: 'gal',
    unit_price_cents: 1850,
    extended_cents: 18500,
    cost_cents: 1200,
    rate_per_acre: 2.0,
    rate_unit: 'QT',
    acres: 100,
    total_applied: 200,
    total_applied_unit: 'QT',
    total_applied_gl_lb: 50,
    gl_lb_unit: 'GL',
    epa_registration: '100-497',
    is_application_fee: false,
    product_form: 'liquid',
    ...overrides,
  };
}

function makeShare(overrides: Partial<InvoicePdfShare> = {}): InvoicePdfShare {
  return {
    customer_name: 'Jones Farm',
    split_percentage: 50,
    acres: 50,
    amount_cents: 9250,
    price_per_acre_cents: 185,
    pricing_note: '50/50 split',
    ...overrides,
  };
}

function makeInvoiceData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoice_number: 'INV-2026-0001',
    invoice_date: '2026-03-01',
    due_date: '2026-04-01',
    invoice_type: 'field_application',
    status: 'posted',
    customer_name: 'Smith Farm',
    customer_email: 'john@smith.com',
    customer_phone: '555-1234',
    customer_address: '123 Farm Rd',
    customer_city: 'Robinson',
    customer_state: 'IL',
    customer_zip: '62454',
    account_number: 'ACC-001',
    salesman_name: 'Mason Wells',
    payment_terms: 'Net 30',
    items: [makeItem()],
    total_amount_cents: 18500,
    total_cost_cents: 12000,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    balance_cents: 18500,
    crop_type: 'corn',
    field_names: ['North 40', 'South 80'],
    total_acres: 120,
    applicator_name: 'Driver Test',
    vehicle_name: 'Truck 1',
    application_date: '2026-03-01',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('groupReturnCreditDisplayItems', () => {
  it('shows one customer line while preserving the exact summed credit', () => {
    const grouped = groupReturnCreditDisplayItems('credit_memo', [
      makeItem({ order_item_id: 'order-item-1', product_id: 'product-1', return_credit_cogs_cents: -12000, description: 'Return credit - Atrazine 4L', quantity: -10, extended_cents: -18500, cost_cents: 1200 }),
      makeItem({ order_item_id: 'order-item-1', product_id: 'product-1', return_credit_cogs_cents: -6500, description: 'Return credit - Atrazine 4L', quantity: -5, extended_cents: -9250, cost_cents: 1300 }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ quantity: -15, extended_cents: -27750, cost_cents: undefined });
  });

  it('does not collapse ordinary invoices or manual credit rows', () => {
    const rows = [
      makeItem({ order_item_id: 'order-item-1', description: 'Return credit - manually entered' }),
      makeItem({ order_item_id: 'order-item-1', description: 'Return credit - manually entered' }),
    ];
    expect(groupReturnCreditDisplayItems('chemical_sale', rows)).toBe(rows);
    expect(groupReturnCreditDisplayItems('credit_memo', rows)).toHaveLength(2);
  });

  it('maps the stored COGS marker into the shared PDF item shape', () => {
    const mapped = mapInvoicePdfItem({
      order_item_id: 'order-item-1',
      product_id: 'product-1',
      return_credit_cogs_cents: '-12000',
      description: 'Return credit - Atrazine 4L',
      quantity: '-10',
      unit_price_cents: '1850',
      extended_cents: '-18500',
      cost_cents: '1200',
      product: { product_name: 'Atrazine 4L' },
    });

    expect(mapped).toMatchObject({
      order_item_id: 'order-item-1',
      product_id: 'product-1',
      return_credit_cogs_cents: -12000,
      product_name: 'Atrazine 4L',
      quantity: -10,
      extended_cents: -18500,
    });
  });
});

describe('generateInvoicePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('returns a jsPDF document for field_application layout', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({ invoice_type: 'field_application' }));
    expect(doc).toBe(mockDoc);
  });

  it('returns a jsPDF document for chemical_sale layout', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({ invoice_type: 'chemical_sale' }));
    expect(doc).toBe(mockDoc);
  });

  it('returns a jsPDF document for misc_charge layout', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({ invoice_type: 'misc_charge' }));
    expect(doc).toBe(mockDoc);
  });

  it('renders the company name as saved, as the quote PDF does', async () => {
    await generateInvoicePdf(makeInvoiceData());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'Crop RX Solutions',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders customer name', async () => {
    await generateInvoicePdf(makeInvoiceData());
    const textCalls = mockDoc.text.mock.calls.flat();
    const hasCustomer = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('SMITH FARM'),
    );
    expect(hasCustomer).toBe(true);
  });

  it('renders invoice number', async () => {
    await generateInvoicePdf(makeInvoiceData());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'INV-2026-0001',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('handles empty items array', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({ items: [] }));
    expect(doc).toBe(mockDoc);
  });

  it('handles items with null optional fields', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      items: [makeItem({
        rate_per_acre: null,
        rate_unit: null,
        acres: null,
        total_applied: null,
        total_applied_unit: null,
        total_applied_gl_lb: null,
        gl_lb_unit: null,
        epa_registration: null,
        cost_cents: undefined,
        product_form: null,
      })],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles field_application with shares', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      shares: [
        makeShare({ customer_name: 'Smith Farm', split_percentage: 50, amount_cents: 9250 }),
        makeShare({ customer_name: 'Jones Farm', split_percentage: 50, amount_cents: 9250 }),
      ],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('Old Print names a share table with no acres "Customer", fitting a Bill Split payer and a legacy grower alike', async () => {
    const autoTable = (await import('jspdf-autotable')).default as unknown as ReturnType<typeof vi.fn>;
    autoTable.mockClear();
    await generateInvoicePdf(makeInvoiceData({
      options: { format: 'legacy', show_shares: true, show_price_per_acre: false, show_epa_registration: false },
      shares: [makeShare({ customer_name: 'Smith Farm', acres: null, price_per_acre_cents: null }), makeShare({ customer_name: 'Landlord', acres: null, price_per_acre_cents: null })],
    }));
    const heads = autoTable.mock.calls.map((c) => JSON.stringify((c[1] as { head?: unknown }).head ?? ''));
    expect(heads.some((h) => h.includes('"Customer"') && !h.includes('Acres'))).toBe(true);
    expect(heads.some((h) => h.includes('"Payer"'))).toBe(false);
  });

  it("a Bill Split payer's misc charge invoice prints the payer table too (Mason, 9 Nov: every payer's invoice shows every payer)", async () => {
    const autoTable = (await import('jspdf-autotable')).default as unknown as ReturnType<typeof vi.fn>;
    autoTable.mockClear();
    await generateInvoicePdf(makeInvoiceData({
      invoice_type: 'misc_charge',
      options: { show_shares: true, show_price_per_acre: false, show_epa_registration: false },
      shares: [makeShare({ customer_name: 'Farmer', acres: null, price_per_acre_cents: null }), makeShare({ customer_name: 'Landlord', acres: null, price_per_acre_cents: null })],
    }));
    const heads = autoTable.mock.calls.map((c) => JSON.stringify((c[1] as { head?: unknown }).head ?? ''));
    expect(heads.some((h) => h.includes('"Customer"') && h.includes('"Shares"'))).toBe(true);
  });

  it('handles field_application with finance charges', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      finance_charge_cents: 1500,
    }));
    expect(doc).toBe(mockDoc);
    const textCalls = mockDoc.text.mock.calls.flat();
    const hasFinanceCharges = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('Finance Charges'),
    );
    expect(hasFinanceCharges).toBe(true);
  });

  it('prints a Write-off line so the current-format totals reconcile to Balance Due', async () => {
    // Posted invoice WITH a hidden write-off: Subtotal 18500, Payments 5000,
    // Prepay 1500, Write-off 3000 → Balance Due 9000. Without the Write-off
    // line the four printed numbers don't add up (18500−5000−1500 = 12000 ≠
    // the printed 9000). The line must appear AND the math must close.
    await generateInvoicePdf(makeInvoiceData({
      total_amount_cents: 18500,
      paid_amount_cents: 5000,
      prepay_applied_cents: 1500,
      write_off_cents: 3000,
      balance_cents: 9000, // 18500 − 5000 − 1500 − 3000
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('Write-off')).toBe(true);   // the new line label
    expect(has('$185.00')).toBe(true);     // Subtotal
    expect(has('-$50.00')).toBe(true);     // Payments
    expect(has('-$15.00')).toBe(true);     // Prepay Applied
    expect(has('-$30.00')).toBe(true);     // Write-off (was hidden before)
    expect(has('$90.00')).toBe(true);      // Balance Due (now reconciles)
    // 18500 − 5000 − 1500 − 3000 === 9000
    expect(18500 - 5000 - 1500 - 3000).toBe(9000);
  });

  it('omits the Write-off line when write_off_cents is 0', async () => {
    await generateInvoicePdf(makeInvoiceData({ write_off_cents: 0 }));
    const textCalls = mockDoc.text.mock.calls.flat();
    expect(textCalls.some((a: unknown) => typeof a === 'string' && a.includes('Write-off'))).toBe(false);
  });

  // #33: Discount Earned is OWNER-DRIVEN + DISPLAY-ONLY. It must PRINT as an
  // informational line but NEVER reduce the printed Balance Due (no double-count;
  // the real reduction flows through payments/write-off). These tests pin that.
  it('prints an informational Discount Earned line WITHOUT changing Balance Due (current format)', async () => {
    await generateInvoicePdf(makeInvoiceData({
      total_amount_cents: 18500,
      paid_amount_cents: 0,
      prepay_applied_cents: 0,
      write_off_cents: 0,
      discount_earned_cents: 1000, // $10 early-pay discount, recorded only
      balance_cents: 18500,        // UNCHANGED — discount is not deducted
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('Discount earned (if paid early)')).toBe(true); // the line prints
    expect(has('$10.00')).toBe(true);                          // the recorded amount
    expect(has('$185.00')).toBe(true);                         // Balance Due == Subtotal (unreduced)
    // Pin the invariant: discount never enters the balance math.
    expect(18500 - 0 - 0 - 0).toBe(18500);
  });

  it('omits the Discount Earned line when discount_earned_cents is 0/absent', async () => {
    await generateInvoicePdf(makeInvoiceData({ discount_earned_cents: 0 }));
    const noDisc = mockDoc.text.mock.calls.flat();
    expect(noDisc.some((a: unknown) => typeof a === 'string' && /discount earned/i.test(a))).toBe(false);
  });

  it('prints the PO Reference label + value in the current format (#33)', async () => {
    await generateInvoicePdf(makeInvoiceData({ purchase_order_ref: 'PO-7788' }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('Customer PO #')).toBe(true);
    expect(has('PO-7788')).toBe(true);
  });

  it('omits the Customer PO # label when purchase_order_ref is absent', async () => {
    await generateInvoicePdf(makeInvoiceData({ purchase_order_ref: undefined }));
    const textCalls = mockDoc.text.mock.calls.flat();
    expect(textCalls.some((a: unknown) => typeof a === 'string' && a === 'Customer PO #')).toBe(false);
  });

  it('handles customer with null optional fields', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      customer_email: undefined,
      customer_phone: undefined,
      customer_address: undefined,
      customer_city: undefined,
      customer_state: undefined,
      customer_zip: undefined,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles print options (show_shares=false, show_price_per_acre=false, show_epa_registration=false)', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      options: { show_shares: false, show_price_per_acre: false, show_epa_registration: false },
      shares: [
        makeShare({ customer_name: 'Smith Farm' }),
        makeShare({ customer_name: 'Jones Farm' }),
      ],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles chemical_sale with multiple items', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      invoice_type: 'chemical_sale',
      items: [
        makeItem({ product_name: 'Atrazine 4L', extended_cents: 18500 }),
        makeItem({ product_name: 'Roundup PowerMax', extended_cents: 24000, unit_price_cents: 2400 }),
        makeItem({ product_name: 'Liberty 280 SL', extended_cents: 31500, unit_price_cents: 3150 }),
      ],
      total_amount_cents: 74000,
      balance_cents: 74000,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles misc_charge with single item', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      invoice_type: 'misc_charge',
      items: [makeItem({ description: 'Late fee', product_name: 'Late fee', extended_cents: 5000 })],
      total_amount_cents: 5000,
      balance_cents: 5000,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles application fee item', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      items: [makeItem({ is_application_fee: true, description: 'Application Fee', product_name: 'Application Fee' })],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('renders a Fuel Surcharge line as a flat amount (no "/AC") — current layout', async () => {
    // The surcharge line is stored is_application_fee=true, quantity=1,
    // unit_price_cents = the FULL flat/percent amount, acres/rate/total_applied NULL.
    // The generic app-fee branch would print "200.00/AC" + "1.00 AC"; the fuel
    // branch must print a PLAIN $ amount and blank Rate/Total-Applied.
    await generateInvoicePdf(makeInvoiceData({
      options: { show_shares: false, show_price_per_acre: false, show_epa_registration: false },
      items: [makeItem({
        is_application_fee: true,
        description: 'Fuel Surcharge',
        product_name: 'Fuel Surcharge',
        quantity: 1,
        unit_price_cents: 20000,   // $200.00 flat
        extended_cents: 20000,
        rate_per_acre: null,
        rate_unit: null,
        acres: null,
        total_applied: null,
        total_applied_unit: null,
        total_applied_gl_lb: null,
        gl_lb_unit: null,
        epa_registration: null,
      })],
      total_amount_cents: 20000,
      balance_cents: 20000,
    }));
    const autoTable = vi.mocked(await import('jspdf-autotable')).default;
    // The line-item table is the first autoTable call (head[0][0] === 'Product').
    const itemCall = autoTable.mock.calls.find((c: unknown[]) => {
      const opts = c[1] as { head?: unknown[][] };
      return Array.isArray(opts.head) && Array.isArray(opts.head[0]) && opts.head[0][0] === 'Product';
    });
    expect(itemCall).toBeDefined();
    const body = ((itemCall as unknown[])[1] as { body: string[][] }).body;
    const fuelRow = body.find((r) => r.includes('Fuel Surcharge'));
    expect(fuelRow).toBeDefined();
    // No cell may carry the per-acre "/AC" suffix on the surcharge row.
    expect((fuelRow as string[]).some((cell) => /\/AC\b/.test(cell))).toBe(false);
    // No "1.00 AC" Total-Applied mislabel.
    expect((fuelRow as string[]).some((cell) => /\bAC\b/.test(cell))).toBe(false);
    // The Unit Price cell is the plain dollar amount "200.00" (no slash, no unit).
    expect((fuelRow as string[]).includes('200.00')).toBe(true);
  });

  it('renders a Fuel Surcharge line as a flat amount (no "AC") — legacy layout', async () => {
    await generateInvoicePdf(makeInvoiceData({
      options: { show_shares: true, show_price_per_acre: true, show_epa_registration: false, format: 'legacy' },
      items: [makeItem({
        is_application_fee: true,
        description: 'Fuel Surcharge',
        product_name: 'Fuel Surcharge',
        quantity: 1,
        unit_price_cents: 20000,
        extended_cents: 20000,
        rate_per_acre: null,
        rate_unit: null,
        acres: null,
        total_applied: null,
        total_applied_unit: null,
        total_applied_gl_lb: null,
        gl_lb_unit: null,
        epa_registration: null,
      })],
      total_amount_cents: 20000,
      balance_cents: 20000,
    }));
    const autoTable = vi.mocked(await import('jspdf-autotable')).default;
    const itemCall = autoTable.mock.calls.find((c: unknown[]) => {
      const opts = c[1] as { head?: unknown[][] };
      return Array.isArray(opts.head) && Array.isArray(opts.head[0]) && opts.head[0][0] === 'Product';
    });
    expect(itemCall).toBeDefined();
    const body = ((itemCall as unknown[])[1] as { body: string[][] }).body;
    const fuelRow = body.find((r) => r.includes('Fuel Surcharge'));
    expect(fuelRow).toBeDefined();
    // Legacy mislabel was "200.00 AC" in Unit Price + "1.00 AC" in Total Applied.
    expect((fuelRow as string[]).some((cell) => /\bAC\b/.test(cell))).toBe(false);
    expect((fuelRow as string[]).includes('200.00')).toBe(true);
  });

  it('handles field_application with all context fields', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      job_number: 'JOB-2026-0010',
      order_number: 'ORD-2026-0005',
      purchase_order_ref: 'PO-REF-123',
      header_notes: 'Applied per customer request on March 1',
      footer_notes: 'Payment due within 30 days. Thank you for your business.',
    }));
    expect(doc).toBe(mockDoc);
    const textCalls = mockDoc.text.mock.calls.flat(Infinity);
    const hasHeaderNote = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('Applied per customer request'),
    );
    expect(hasHeaderNote).toBe(true);
  });
});

// ── Legacy "Old Print" format (field-app parity #30) ─────────────────────────

describe('generateInvoicePdf — Bill Split payers on a chemical sale', () => {
  const payers = [
    { ...makeShare({ customer_name: 'Farmer', split_percentage: 70.6672, amount_cents: 35588, price_per_acre_cents: null, pricing_note: null }), invoice_number: 'CS-2026-0060-1' },
    { ...makeShare({ customer_name: 'Landlord', split_percentage: 29.3328, amount_cents: 14772, price_per_acre_cents: null, pricing_note: null }), invoice_number: 'CS-2026-0060-2' },
  ];
  const tableBodies = async () => {
    const { default: autoTable } = await import('jspdf-autotable');
    return vi.mocked(autoTable).mock.calls.map(([, opts]) => (opts as { body?: unknown[][] }).body ?? []);
  };

  it('prints each payer with their share and total', async () => {
    const { default: autoTable } = await import('jspdf-autotable');
    vi.mocked(autoTable).mockClear();
    await generateInvoicePdf(makeInvoiceData({ invoice_type: 'chemical_sale', shares: payers }));
    const body = (await tableBodies()).find((b) => JSON.stringify(b).includes('Landlord'));
    expect(body?.[1]).toEqual(['Landlord', 'CS-2026-0060-2', expect.stringContaining('29.3328'), expect.stringContaining('147.72')]);
  });

  it('labels each payer by their real invoice number on Old Print', async () => {
    const { default: autoTable } = await import('jspdf-autotable');
    vi.mocked(autoTable).mockClear();
    await generateInvoicePdf(makeInvoiceData({
      invoice_type: 'chemical_sale',
      invoice_number: 'CS-2026-0060-2',
      shares: payers,
      options: { show_shares: true, show_price_per_acre: false, show_epa_registration: false, format: 'legacy' },
    }));
    const body = (await tableBodies()).find((b) => JSON.stringify(b).includes('Landlord'));
    expect(body?.map((row) => row[0])).toEqual(['CS-2026-0060-1', 'CS-2026-0060-2']);
  });
});

describe('generateInvoicePdf — legacy "Old Print" format', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  const legacyOpts = { show_shares: true, show_price_per_acre: true, show_epa_registration: true, format: 'legacy' as const };

  it('returns a jsPDF document for the legacy field_application layout', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({ options: legacyOpts }));
    expect(doc).toBe(mockDoc);
  });

  it('prints the Settings company details on both layouts', async () => {
    const saved = { name: 'Test Ag Co', phone: '555-0199', email: 'office@testag.test', address: '1 Main St, Town, IL' };
    for (const options of [undefined, legacyOpts]) {
      vi.clearAllMocks();
      companyInfo.load.mockResolvedValueOnce(saved);
      await generateInvoicePdf(makeInvoiceData({ options }));
      const printed = mockDoc.text.mock.calls.flat(2);
      if (options) {
        expect(printed).toContain('TEST AG CO');
        expect(printed).toContain('Agricultural Input Solutions  •  1 Main St, Town, IL  •  555-0199');
      } else {
        // The current layout prints the letterhead as the quote PDF does: the name as saved, one detail per line.
        for (const line of ['Test Ag Co', 'Agricultural Input Solutions', '1 Main St, Town, IL', '555-0199']) expect(printed).toContain(line);
        expect(printed).not.toContain('Crop RX Solutions');
        // The pay note names the legal payee, as the old footer did.
        expect(printed).toContain('Make checks payable to Crop RX Solutions, Inc. and write the invoice number on the check.');
      }
      expect(printed.some((t: unknown) => typeof t === 'string' && t.includes('office@testag.test'))).toBe(true);
      expect(printed).not.toContain('CROP RX SOLUTIONS');
    }
  });

  it('renders the plain-text "INVOICE" header (no green band)', async () => {
    await generateInvoicePdf(makeInvoiceData({ options: legacyOpts }));
    const textCalls = mockDoc.text.mock.calls.flat();
    expect(textCalls.some((a: unknown) => a === 'CROP RX SOLUTIONS')).toBe(true);
    expect(textCalls.some((a: unknown) => a === 'INVOICE')).toBe(true);
    // The legacy header prints the invoice number as "No. <number>".
    expect(textCalls.some((a: unknown) => typeof a === 'string' && a.includes('No. INV-2026-0001'))).toBe(true);
  });

  it('prints the SAME money totals as the data (no recompute)', async () => {
    // Posted invoice WITH a payment: Total 18500, Payments 5000, Prepay 1500 →
    // Balance Due 12000. Total − Payments − Prepay = Balance Due must hold, and
    // the printed strings must be exactly those cents (formatted /100).
    await generateInvoicePdf(makeInvoiceData({
      options: legacyOpts,
      total_amount_cents: 18500,
      paid_amount_cents: 5000,
      prepay_applied_cents: 1500,
      balance_cents: 12000, // 18500 − 5000 − 1500
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('$185.00')).toBe(true);      // Subtotal
    expect(has('-$50.00')).toBe(true);      // Payments
    expect(has('-$15.00')).toBe(true);      // Prepay Applied
    expect(has('$120.00')).toBe(true);      // Balance Due (reconciles)
    expect(has('BALANCE DUE:')).toBe(true);
  });

  it('prints a Write-off line so the legacy-format totals reconcile to Balance Due', async () => {
    // Same hidden-write-off scenario in the legacy "Old Print" layout: without
    // the Write-off line, Subtotal − Payments − Prepay = 12000 ≠ the printed
    // Balance Due 9000. The line must appear AND the four lines must close.
    await generateInvoicePdf(makeInvoiceData({
      options: legacyOpts,
      total_amount_cents: 18500,
      paid_amount_cents: 5000,
      prepay_applied_cents: 1500,
      write_off_cents: 3000,
      balance_cents: 9000, // 18500 − 5000 − 1500 − 3000
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('Write-off:')).toBe(true);  // the new legacy line label
    expect(has('$185.00')).toBe(true);     // Subtotal
    expect(has('-$50.00')).toBe(true);     // Payments
    expect(has('-$15.00')).toBe(true);     // Prepay Applied
    expect(has('-$30.00')).toBe(true);     // Write-off (was hidden before)
    expect(has('$90.00')).toBe(true);      // Balance Due (now reconciles)
    expect(has('BALANCE DUE:')).toBe(true);
    // 18500 − 5000 − 1500 − 3000 === 9000
    expect(18500 - 5000 - 1500 - 3000).toBe(9000);
  });

  it('prints an informational Discount Earned line WITHOUT changing Balance Due (legacy format)', async () => {
    await generateInvoicePdf(makeInvoiceData({
      options: legacyOpts,
      total_amount_cents: 18500,
      paid_amount_cents: 0,
      prepay_applied_cents: 0,
      write_off_cents: 0,
      discount_earned_cents: 1000, // $10 recorded early-pay discount
      balance_cents: 18500,        // UNCHANGED
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('Discount Earned (if paid early):')).toBe(true);
    expect(has('$10.00')).toBe(true);   // recorded discount
    expect(has('$185.00')).toBe(true);  // Balance Due == Subtotal (unreduced)
  });

  it('renders a split with per-customer "Ref" labels that sum to the whole', async () => {
    const shares: InvoicePdfShare[] = [
      makeShare({ customer_name: 'Smith Farm', split_percentage: 33.34, amount_cents: 5000 }),
      makeShare({ customer_name: 'Jones Farm', split_percentage: 66.66, amount_cents: 10010 }),
    ];
    // Per-customer cents (5000 + 10010) must equal the grand total (15010).
    const sum = shares.reduce((s, x) => s + x.amount_cents, 0);
    expect(sum).toBe(15010);
    await generateInvoicePdf(makeInvoiceData({
      options: legacyOpts,
      job_number: '230568',
      shares,
      total_amount_cents: 15010,
      balance_cents: 15010,
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    // deriveSplitRef('230568', idx, true) → 230568-001 / 230568-002
    const autoTableArg = (vi.mocked(await import('jspdf-autotable')).default).mock.calls;
    // The share table is rendered via autoTable; assert its body carries the refs.
    const bodies = autoTableArg.map((c: unknown[]) => (c[1] as { body?: unknown[][] }).body).filter(Boolean) as unknown[][][];
    const flatCells = bodies.flat(2).map(String);
    expect(flatCells.includes('230568-001')).toBe(true);
    expect(flatCells.includes('230568-002')).toBe(true);
    // grand-total still prints from data (no recompute)
    expect(textCalls.some((a: unknown) => typeof a === 'string' && a.includes('$150.10'))).toBe(true);
  });

  it('handles a legacy chemical_sale invoice', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      invoice_type: 'chemical_sale',
      options: legacyOpts,
      items: [makeItem({ product_name: 'Roundup', extended_cents: 24000 })],
      total_amount_cents: 24000,
      balance_cents: 24000,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('current format is unchanged when format is omitted/undefined', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
    }));
    expect(doc).toBe(mockDoc);
    // The current format draws the logo; legacy never does.
    expect(mockDoc.addImage).toHaveBeenCalled();
  });
});

describe('downloadInvoicePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('calls doc.save with filename containing invoice number', async () => {
    await downloadInvoicePdf(makeInvoiceData());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
    expect(mockDoc.save).toHaveBeenCalledWith('INV-2026-0001.pdf');
  });
});

describe('generateBatchInvoicePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  it('processes multiple invoices without throwing', async () => {
    const invoices = [
      makeInvoiceData({ invoice_number: 'INV-2026-0001' }),
      makeInvoiceData({
        invoice_number: 'INV-2026-0002',
        invoice_type: 'chemical_sale',
        customer_name: 'Jones Farm',
        total_amount_cents: 32000,
        balance_cents: 32000,
      }),
    ];
    const { doc, failures } = await generateBatchInvoicePdf(invoices);
    expect(doc).toBeDefined();
    expect(failures).toEqual([]);
    expect(mockDoc.save).toHaveBeenCalled();
  });

  it('reports an invoice whose PDF failed to build instead of counting it as printed', async () => {
    let calls = 0;
    mockDoc.text.mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error('render failed');
    });
    const { failures } = await generateBatchInvoicePdf([
      makeInvoiceData({ invoice_number: 'INV-2026-0001' }),
      makeInvoiceData({ invoice_number: 'INV-2026-0002' }),
    ]);
    mockDoc.text.mockReset();
    expect(failures).toHaveLength(1);
  });

  it('downloads a batch of one invoice (a batch can drop to one after a skip)', async () => {
    await generateBatchInvoicePdf([makeInvoiceData({ invoice_number: 'INV-2026-0003' })]);
    expect(mockDoc.save).toHaveBeenCalledWith('INV-2026-0003.pdf');
  });
});

describe('chemical sale: the standing discount and sales tax lines (billing plan M4a, M4b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('prints them by name and amount in the totals, and keeps quantity and price on a typed charge', async () => {
    const items = [
      makeItem({ quantity: 10, unit_price_cents: 10000, extended_cents: 100000 }),
      makeItem({ description: 'Freight', product_name: 'Freight', product_id: null, quantity: 1, unit_price_cents: 4500, extended_cents: 4500, charge_type: 'freight' }),
      makeItem({ description: 'Standing discount 3%', product_name: 'Standing discount 3%', product_id: null, quantity: 1, unit_price_cents: -3000, extended_cents: -3000, charge_type: 'standing_discount' }),
      makeItem({ description: 'Sales tax 6.25%', product_name: 'Sales tax 6.25%', product_id: null, quantity: 1, unit_price_cents: 6408, extended_cents: 6408, charge_type: 'sales_tax' }),
    ];
    await generateInvoicePdf(makeInvoiceData({ invoice_type: 'chemical_sale', items, total_amount_cents: 107908, balance_cents: 107908 }));
    const autoTable = vi.mocked(await import('jspdf-autotable')).default;
    const body = autoTable.mock.calls
      .map(([, opts]) => (opts as { body?: string[][] }).body ?? [])
      .find((rows) => rows.some((r) => r.includes('Freight')));
    expect(body).toBeDefined();
    // The lines add up to the total, so the discount and tax print once, by name and amount, in the totals.
    expect(body!.some((r) => r.includes('Standing discount 3%') || r.includes('Sales tax 6.25%'))).toBe(false);
    const printed = mockDoc.text.mock.calls.map((c) => c[0]);
    expect(printed[printed.indexOf('Standing discount 3%') + 1]).toBe('-$30.00');
    expect(printed[printed.indexOf('Sales tax 6.25%') + 1]).toBe('$64.08');
    // A charge line someone typed keeps its quantity and price.
    expect(body!.find((r) => r.includes('Freight'))![2]).not.toBe('');
    expect(body!.find((r) => r.includes('Freight'))![3]).not.toBe('');
  });

  it('reads the line type with the lines (email and batch print load them from the database)', () => {
    expect(INVOICE_PDF_ITEM_COLUMNS.split(',').map((c) => c.trim())).toContain('charge_type');
  });

  it('carries the line type from the database row', () => {
    expect(mapInvoicePdfItem({ description: 'Sales tax 6.25%', quantity: 1, unit_price_cents: 6408, extended_cents: 6408, charge_type: 'sales_tax' }).charge_type)
      .toBe('sales_tax');
  });
});

// ── The invoice PDF in the quote style: the money printed must not change ─────
// Pinned on the old layout (f84036aa8) for the same inputs: every amount, price, quantity and
// acreage printed with two decimals, in drawing order. The new layout must print each of them.

const NUMBER = /-?\$?\d[\d,]*\.\d{2}(?!\d)/g;
const cellText = (cell: unknown): unknown => (cell && typeof cell === 'object' && 'content' in cell ? (cell as { content: unknown }).content : cell);

async function printedNumbers(): Promise<string[]> {
  const autoTable = vi.mocked((await import('jspdf-autotable')).default);
  const events = [
    ...mockDoc.text.mock.calls.map((c, i) => ({ at: mockDoc.text.mock.invocationCallOrder[i], strings: [c[0]].flat(Infinity) })),
    ...autoTable.mock.calls.map((c, i) => {
      const opts = c[1] as { head?: unknown[][]; body?: unknown[][] };
      return { at: autoTable.mock.invocationCallOrder[i], strings: [...(opts.head ?? []), ...(opts.body ?? [])].flat().map(cellText) };
    }),
  ].sort((a, b) => a.at - b.at);
  return events.flatMap((e) => e.strings.filter((s): s is string => typeof s === 'string').flatMap((s) => s.match(NUMBER) ?? []));
}

const moneyFixtures: Record<string, InvoicePdfData> = {
  fieldApplication: makeInvoiceData({
    options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
    items: [
      makeItem({ product_name: 'Atrazine 4L', rate_per_acre: 2, total_applied: 240, total_applied_gl_lb: 60, unit_price_cents: 1850, extended_cents: 111000 }),
      makeItem({ product_name: 'Roundup PowerMax', rate_per_acre: 32, rate_unit: 'OZ', total_applied: 3840, total_applied_unit: 'OZ', total_applied_gl_lb: 30, unit_price_cents: 2400, extended_cents: 72000, epa_registration: '524-549' }),
      makeItem({ product_name: 'Application Fee', description: 'Application Fee', is_application_fee: true, quantity: 120, unit_price_cents: 800, extended_cents: 96000, rate_per_acre: null, total_applied: null, total_applied_gl_lb: null, epa_registration: null }),
    ],
    shares: [
      makeShare({ customer_name: 'Maple Hollow Farms', split_percentage: 60, acres: 72, amount_cents: 167400, price_per_acre_cents: 2325, pricing_note: null }),
      makeShare({ customer_name: 'Cedar Ridge Ag', split_percentage: 40, acres: 48, amount_cents: 111600, price_per_acre_cents: 2325, pricing_note: null }),
    ],
    total_amount_cents: 279000,
    paid_amount_cents: 100000,
    prepay_applied_cents: 25000,
    write_off_cents: 1500,
    discount_earned_cents: 2000,
    finance_charge_cents: 1250,
    balance_cents: 152500,
  }),
  chemicalSaleSplit: makeInvoiceData({
    invoice_type: 'chemical_sale',
    invoice_number: 'CS-2026-0005-1',
    customer_name: 'Maple Hollow Farms',
    options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
    items: [
      makeItem({ product_name: 'Glyphosate 5.5 lb ae (2.5 gal)', quantity: 20, unit_size: 'GL', gl_lb_unit: 'GL', unit_price_cents: 1237, extended_cents: 24740, epa_registration: '524-549' }),
      makeItem({ product_name: 'Atrazine 4L (2.5 gal)', quantity: 30, unit_size: 'GL', gl_lb_unit: 'GL', unit_price_cents: 895, extended_cents: 26850 }),
      makeItem({ product_name: 'Crop oil concentrate (2.5 gal)', quantity: 10, unit_size: 'GL', gl_lb_unit: 'GL', unit_price_cents: 1507, extended_cents: 15070, epa_registration: null }),
      makeItem({ product_name: 'Freight', description: 'Freight', product_id: null, quantity: 1, unit_size: undefined, gl_lb_unit: null, unit_price_cents: 4500, extended_cents: 4500, epa_registration: null, charge_type: 'freight' }),
      makeItem({ product_name: 'Standing discount 3%', description: 'Standing discount 3%', product_id: null, quantity: 1, unit_size: undefined, gl_lb_unit: null, unit_price_cents: -2000, extended_cents: -2000, epa_registration: null, charge_type: 'standing_discount' }),
      makeItem({ product_name: 'Sales tax 6.25%', description: 'Sales tax 6.25%', product_id: null, quantity: 1, unit_size: undefined, gl_lb_unit: null, unit_price_cents: 4323, extended_cents: 4323, epa_registration: null, charge_type: 'sales_tax' }),
    ],
    shares: [
      { customer_name: 'Maple Hollow Farms', split_percentage: 50, acres: null, amount_cents: 73483, invoice_id: 'inv-1', invoice_number: 'CS-2026-0005-1' } as InvoicePdfShare,
      { customer_name: 'Cedar Ridge Ag', split_percentage: 50, acres: null, amount_cents: 68701, invoice_id: 'inv-2', invoice_number: 'CS-2026-0005-2' } as InvoicePdfShare,
    ],
    total_amount_cents: 73483,
    paid_amount_cents: 10000,
    prepay_applied_cents: 0,
    write_off_cents: 500,
    balance_cents: 62983,
  }),
  creditMemo: makeInvoiceData({
    invoice_type: 'credit_memo',
    invoice_number: 'CM-2026-0003',
    items: [
      makeItem({ product_name: 'Return credit - Atrazine 4L', quantity: -5, unit_price_cents: 895, extended_cents: -4475 }),
      makeItem({ product_name: 'Restocking', description: 'Restocking', product_id: null, quantity: 1, unit_price_cents: 500, extended_cents: 500, charge_type: 'other' }),
    ],
    total_amount_cents: -3975,
    balance_cents: -3975,
  }),
  miscCharge: makeInvoiceData({
    invoice_type: 'misc_charge',
    invoice_number: 'MC-2026-0009',
    items: [
      makeItem({ product_name: 'Soil sampling', description: 'Soil sampling', product_id: null, quantity: 1, unit_price_cents: 12000, extended_cents: 12000, charge_type: 'service' }),
      makeItem({ product_name: 'Courtesy credit', description: 'Courtesy credit', product_id: null, quantity: 1, unit_price_cents: -1500, extended_cents: -1500, charge_type: 'other' }),
    ],
    total_amount_cents: 10500,
    paid_amount_cents: 10500,
    balance_cents: 0,
  }),
};

// What the old layout printed (captured on f84036aa8 by printedNumbers, drawing order).
const PRINTED_BEFORE: Record<string, string[]> = {
  fieldApplication: ['120.00', '240.00', '18.50', '$1,110.00', '3,840.00', '24.00', '$720.00', '120.00', '8.00', '$960.00', '23.25', '$2,790.00', '$23.25', '60.00', '72.00', '$1,674.00', '$23.25', '40.00', '48.00', '$1,116.00', '$12.50', '$1,537.50', '$2,790.00', '-$1,000.00', '-$250.00', '-$15.00', '$12.50', '$1,525.00', '$20.00'],
  chemicalSaleSplit: ['20.00', '$12.37', '$247.40', '30.00', '$8.95', '$268.50', '10.00', '$15.07', '$150.70', '1.00', '$45.00', '$45.00', '-$20.00', '6.25', '$43.23', '$734.83', '$734.83', '$687.01', '$734.83', '-$100.00', '-$5.00', '$629.83'],
  creditMemo: ['-$44.75', '$5.00', '-$39.75', '-$39.75'],
  miscCharge: ['$120.00', '-$15.00', '$105.00', '-$105.00', '$0.00'],
};

// The new layout's full list, in order, written as the old list with each deliberate change spelled out.
const B = PRINTED_BEFORE;
const PRINTED_AFTER: Record<string, string[]> = {
  fieldApplication: [
    ...B.fieldApplication.slice(0, 22), // the table, price per acre, grower shares, the finance strip: unchanged
    '$2,790.00', // added: the Subtotal row (one row, the lines' sum), above Invoice total
    ...B.fieldApplication.slice(22), // Invoice total (was "Subtotal"), payments, prepay, write-off, finance, balance, discount earned
  ],
  chemicalSaleSplit: [
    ...B.chemicalSaleSplit.slice(0, 12), // three products and the Freight line (quantity, price, amount)
    // removed: the discount and tax rows of the table (B[12..14]) move to the totals below
    // removed: B[15], the "Total: $734.83" line under the table (Invoice total prints it once)
    ...B.chemicalSaleSplit.slice(16, 18), // who pays: the two payers (was the shares table)
    '$1,421.84', // added: Delivery total, the payers' sum
    '$666.60', // added: Products row
    '$45.00', // added: Freight row (the same amount as the Freight line)
    ...B.chemicalSaleSplit.slice(12, 15), // moved: Standing discount 3%, "Sales tax 6.25%" label, its amount
    B.chemicalSaleSplit[18], // Invoice total (was "Subtotal")
    ...B.chemicalSaleSplit.slice(19), // payments, write-off, balance due
  ],
  creditMemo: [
    ...B.creditMemo.slice(0, 2), // the table
    ...B.creditMemo.slice(0, 2), // added: the Products and Other rows, the same amounts as the two lines
    ...B.creditMemo.slice(2), // Invoice total (was "Subtotal"), balance due
  ],
  miscCharge: [
    ...B.miscCharge.slice(0, 2), // the table
    ...B.miscCharge.slice(0, 2), // added: the Service and Other rows, the same amounts as the two lines
    ...B.miscCharge.slice(2), // Invoice total (was "Subtotal"), payments, balance due
  ],
};

/** Every label in the totals and finance strip, with the exact value printed right after it. */
const LABELLED: Record<string, Array<[string, string]>> = {
  fieldApplication: [
    ['Subtotal', '$2,790.00'], ['Invoice total', '$2,790.00'], ['Payments', '-$1,000.00'], ['Prepay applied', '-$250.00'],
    ['Write-off', '-$15.00'], ['Finance charges', '$12.50'], ['Net Due (INV-2026-0001):', '$1,537.50'],
    ['Balance due', '$1,525.00'], ['Discount earned (if paid early)', '$20.00'],
  ],
  chemicalSaleSplit: [
    ['Products', '$666.60'], ['Freight', '$45.00'], ['Standing discount 3%', '-$20.00'], ['Sales tax 6.25%', '$43.23'],
    ['Invoice total', '$734.83'], ['Payments', '-$100.00'], ['Write-off', '-$5.00'], ['Balance due', '$629.83'],
  ],
  creditMemo: [['Products', '-$44.75'], ['Other', '$5.00'], ['Invoice total', '-$39.75'], ['Balance due', '-$39.75']],
  miscCharge: [['Service', '$120.00'], ['Other', '-$15.00'], ['Invoice total', '$105.00'], ['Payments', '-$105.00'], ['Balance due', '$0.00']],
};

const texts = () => mockDoc.text.mock.calls.map((c) => c[0]).flat(Infinity) as unknown[];
/** The text drawn right after a label: the label's value on the same row. */
const valueAfter = (label: string) => {
  const all = texts();
  const at = all.indexOf(label);
  return at < 0 ? undefined : all[at + 1];
};

describe('invoice PDF money is unchanged by the quote-style layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
    mockDoc.getNumberOfPages.mockReturnValue(1);
  });

  it.each(Object.keys(moneyFixtures))('%s prints the old amounts, in order, with only the listed changes', async (name) => {
    await generateInvoicePdf(moneyFixtures[name]);
    expect(await printedNumbers()).toEqual(PRINTED_AFTER[name]);
  });

  it.each(Object.keys(moneyFixtures))('%s prints each amount beside its label', async (name) => {
    await generateInvoicePdf(moneyFixtures[name]);
    expect(LABELLED[name].map(([label]) => [label, valueAfter(label)])).toEqual(LABELLED[name]);
  });

  it('the added amounts are subtotals of the same lines', () => {
    expect(24740 + 26850 + 15070).toBe(66660); // Products $666.60
    expect(73483 + 68701).toBe(142184); // Delivery total $1,421.84
    expect(66660 + 4500 - 2000 + 4323).toBe(73483); // the rows add up to the invoice total
    expect(111000 + 72000 + 96000).toBe(279000); // field application Subtotal $2,790.00
  });
});

describe('invoice PDF in the quote style', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
    mockDoc.getNumberOfPages.mockReturnValue(1);
  });

  const split = () => ({ ...moneyFixtures.chemicalSaleSplit, purchase_order_ref: '4471', account_number: 'C-1042', salesman_name: 'Test Admin' });
  const tables = async () => vi.mocked((await import('jspdf-autotable')).default).mock.calls
    .map(([, opts]) => opts as { head?: unknown[][]; body?: unknown[][] })
    .map((o) => ({ head: (o.head?.[0] ?? []).map(cellText), body: (o.body ?? []).map((r) => r.map(cellText)) }));
  it('heads the first page with the logo, "Invoice" and the invoice details', async () => {
    await generateInvoicePdf(split());
    expect(mockDoc.addImage).toHaveBeenCalledTimes(1);
    expect(mockDoc.addImage.mock.calls[0][1]).toBe('PNG');
    expect(texts()).toContain('Invoice');
    expect(texts()).toContain('BILL TO');
    expect(texts()).toContain('MAPLE HOLLOW FARMS');
    for (const [label, value] of [
      ['Invoice #', 'CS-2026-0005-1'], ['Invoice date', '03/01/2026'], ['Due date', '04/01/2026'], ['Terms', 'Net 30'],
      ['Account #', 'C-1042'], ['Salesperson', 'Test Admin'], ['Customer PO #', '4471'],
    ]) expect(valueAfter(label)).toBe(value);
  });

  it('lists products and typed charges under the quote-style column heads', async () => {
    await generateInvoicePdf(split());
    const products = (await tables()).find((t) => t.head[0] === 'Product')!;
    expect(products.head).toEqual(['Product', 'EPA reg. #', 'Quantity', 'Unit price', 'Amount']);
    expect(products.body.map((r) => r[0])).toEqual(['Glyphosate 5.5 lb ae (2.5 gal)', 'Atrazine 4L (2.5 gal)', 'Crop oil concentrate (2.5 gal)', 'Freight']);
    expect(products.body[0]).toEqual(['Glyphosate 5.5 lb ae (2.5 gal)', '524-549', '20.00 GL', '$12.37 GL', '$247.40']);
  });

  it('drops the EPA column when the print option is off', async () => {
    await generateInvoicePdf({ ...split(), options: { show_shares: true, show_price_per_acre: true, show_epa_registration: false } });
    expect((await tables()).find((t) => t.head[0] === 'Product')!.head).toEqual(['Product', 'Quantity', 'Unit price', 'Amount']);
  });

  it('totals the invoice line by line, then payments and the balance due', async () => {
    await generateInvoicePdf(split());
    for (const [label, value] of [
      ['Products', '$666.60'], ['Freight', '$45.00'], ['Standing discount 3%', '-$20.00'], ['Sales tax 6.25%', '$43.23'],
      ['Invoice total', '$734.83'], ['Payments', '-$100.00'], ['Write-off', '-$5.00'], ['Balance due', '$629.83'],
    ]) expect(valueAfter(label)).toBe(value);
  });

  it('shows who pays for the delivery on a Bill Split invoice', async () => {
    await generateInvoicePdf(split());
    expect(texts()).toContain('WHO PAYS FOR THIS DELIVERY');
    const payers = (await tables()).find((t) => t.head[0] === 'Payer')!;
    expect(payers.head).toEqual(['Payer', 'Invoice', 'Share', 'Amount']);
    expect(payers.body).toEqual([
      ['Maple Hollow Farms (this invoice)', 'CS-2026-0005-1', '50%', '$734.83'],
      ['Cedar Ridge Ag', 'CS-2026-0005-2', '50%', '$687.01'],
      ['Delivery total', '', '100%', '$1,421.84'],
    ]);
    // Attack MED-1: one percentage was false on line-level splits and dollar shares, so the sentences name no number.
    expect(texts()).toContain("This invoice bills this payer's part of the delivery.");
    expect(texts()).toContain("Quantities are this payer's part of each line");
    expect(texts().filter((t) => typeof t === 'string' && /bills \d|payer's \d/.test(t))).toEqual([]);
  });

  // Attack LOW-2: the pay note asks for money only on an invoice that is owed: posted or overdue, balance above 0.
  it.each([
    ['posted', true], ['overdue', true],
    ['draft', false], ['unposted', false], ['voided', false], ['paid', false], ['cancelled', false],
  ])('a %s invoice with a balance prints the pay note: %s', async (status, prints) => {
    await generateInvoicePdf({ ...split(), status });
    expect(texts().includes('Please pay by 04/01/2026.')).toBe(prints);
    expect(texts().some((t) => typeof t === 'string' && t.startsWith('Make checks payable'))).toBe(prints);
    expect(valueAfter('Balance due')).toBe('$629.83');
  });

  it('a posted invoice with nothing owed prints no pay note', async () => {
    await generateInvoicePdf({ ...split(), status: 'posted', balance_cents: 0 });
    expect(texts()).not.toContain('Please pay by 04/01/2026.');
  });

  it('hides who pays when shares are switched off', async () => {
    await generateInvoicePdf({ ...split(), options: { show_shares: false, show_price_per_acre: true, show_epa_registration: true } });
    expect(texts()).not.toContain('WHO PAYS FOR THIS DELIVERY');
    expect((await tables()).some((t) => t.head[0] === 'Payer')).toBe(false);
  });

  it('numbers every page "Page n of m" and draws the logo small from page 2', async () => {
    mockDoc.getNumberOfPages.mockReturnValue(2);
    await generateInvoicePdf(split());
    expect(texts()).toContain('Page 1 of 2');
    expect(texts()).toContain('Page 2 of 2');
    expect(mockDoc.setPage.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(mockDoc.addImage).toHaveBeenCalledTimes(2);
  });

  it('keeps every layout: field application, chemical sale and misc charge', async () => {
    for (const name of ['fieldApplication', 'chemicalSaleSplit', 'miscCharge'] as const) {
      vi.clearAllMocks();
      await generateInvoicePdf(moneyFixtures[name]);
      expect(texts()).toContain('Invoice total');
      expect(texts()).toContain('Page 1 of 1');
    }
    vi.clearAllMocks();
    await generateInvoicePdf(moneyFixtures.fieldApplication);
    expect((await tables()).find((t) => t.head[0] === 'Product')!.head)
      .toEqual(['Product', 'EPA Reg', 'Rate / Acre', 'Total Applied', 'Total Applied GL/LB', 'Unit Price', 'Total Cost']);
  });

  it('prints the database lines in the product table when they do not add up to the invoice total', async () => {
    // A total that is not the sum of its lines: no breakdown rows that would not add up, every line stays in the table.
    await generateInvoicePdf({ ...split(), total_amount_cents: 73000, balance_cents: 62500 });
    expect(texts()).not.toContain('Products');
    const products = (await tables()).find((t) => t.head[0] === 'Product')!;
    expect(products.body.some((r) => r.includes('Sales tax 6.25%'))).toBe(true);
    expect(valueAfter('Invoice total')).toBe('$730.00');
  });

  it('keeps the totals beside Who pays when the payer table runs onto the next page', async () => {
    const autoTable = vi.mocked((await import('jspdf-autotable')).default);
    const original = autoTable.getMockImplementation()!;
    const log: Array<{ text: unknown; page: number; x: number; y: number }> = [];
    let page = 1;
    mockDoc.setPage.mockImplementation((n: number) => { page = n; });
    mockDoc.text.mockImplementation((text: unknown, x: number, y: number) => { log.push({ text, page, x, y }); });
    let payerTable: { startY: number; margin: { right: number } } | undefined;
    autoTable.mockImplementation((doc: unknown, opts: unknown) => {
      const o = opts as { startY: number; head: unknown[][]; margin: { right: number } };
      if (o.head[0][0] === 'Payer') {
        // A long payer list: the table ends on page 2.
        payerTable = o;
        page = 2;
        mockDoc.getNumberOfPages.mockReturnValue(2);
        (doc as typeof mockDoc).lastAutoTable = { finalY: 140 };
      } else {
        (doc as typeof mockDoc).lastAutoTable = { finalY: o.startY + 100 };
      }
    });
    try {
      await generateInvoicePdf(split());
      const at = (text: string) => log.find((l) => l.text === text)!;
      const whoPays = at('WHO PAYS FOR THIS DELIVERY');
      expect(whoPays.page).toBe(1);
      for (const label of ['Products', 'Invoice total', 'Balance due']) {
        expect(at(label).page).toBe(1);
        expect(at(label).y).toBeGreaterThan(whoPays.y - 9);
        // To the right of the payer table, so the two never overlap.
        expect(at(label).x).toBeGreaterThan(612 - payerTable!.margin.right);
      }
      // What follows starts on the last page, below the payer table.
      const note = at('Please pay by 04/01/2026.');
      expect(note.page).toBe(2);
      expect(note.y).toBeGreaterThan(140);
    } finally {
      autoTable.mockImplementation(original);
      mockDoc.text.mockReset();
      mockDoc.setPage.mockReset();
      mockDoc.getNumberOfPages.mockReturnValue(1);
    }
  });

  it('moves the price per acre line to a new page when the table ends at the content bottom', async () => {
    const autoTable = vi.mocked((await import('jspdf-autotable')).default);
    autoTable.mockImplementationOnce((doc: unknown) => { (doc as typeof mockDoc).lastAutoTable = { finalY: 720 }; });
    await generateInvoicePdf(makeInvoiceData({ options: { show_shares: false, show_price_per_acre: true, show_epa_registration: true } }));
    const call = mockDoc.text.mock.calls.findIndex((c) => typeof c[0] === 'string' && c[0].startsWith('Price per acre'));
    expect(mockDoc.addPage).toHaveBeenCalled();
    expect(mockDoc.addPage.mock.invocationCallOrder[0]).toBeLessThan(mockDoc.text.mock.invocationCallOrder[call]);
    expect(mockDoc.text.mock.calls[call][2]).toBeLessThanOrEqual(792 - 66);
  });

  it('labels a field application\'s first totals row "Subtotal" and a chemical sale\'s "Products"', async () => {
    await generateInvoicePdf(moneyFixtures.fieldApplication);
    expect(texts()).toContain('Subtotal');
    expect(texts()).not.toContain('Products');
    vi.clearAllMocks();
    await generateInvoicePdf(moneyFixtures.chemicalSaleSplit);
    expect(texts()).toContain('Products');
    expect(texts()).not.toContain('Subtotal');
  });
});
