import { describe, expect, it } from 'vitest';
import { invoiceRowPdfFields, type InvoiceRowPdfSource } from './invoiceRowPdfFields';

const row = (over: Partial<InvoiceRowPdfSource> = {}) => ({
  invoice_number: 'CS-2026-0126-1', invoice_date: '2026-11-01', invoice_type: 'chemical_sale', status: 'posted',
  customer_name: 'Test Farm', salesman_name: null, total_amount_cents: 73483, total_cost_cents: 0,
  paid_amount_cents: 0, prepay_applied_cents: 0, write_off_cents: 333, credit_applied_cents: 4444, balance_cents: 68706,
  order_id: null, delivery_id: null, blend_ticket_id: null, ...over,
}) as unknown as InvoiceRowPdfSource;

describe('invoiceRowPdfFields (batch Print from the Invoices list)', () => {
  it('carries the write-off and the credit applied, so the printed rows add up to the balance', () => {
    const f = invoiceRowPdfFields(row());
    expect(f.write_off_cents).toBe(333);
    expect(f.credit_applied_cents).toBe(4444);
    expect(f.total_amount_cents - f.paid_amount_cents - f.prepay_applied_cents - f.write_off_cents - f.credit_applied_cents).toBe(f.balance_cents);
  });

  it('flags charge lines as the invoice page does: a from-scratch chemical sale takes them, a blend-backed one does not', () => {
    expect(invoiceRowPdfFields(row()).takes_charge_lines).toBe(true);
    expect(invoiceRowPdfFields(row({ order_id: 'o-1', blend_ticket_id: 'b-1' } as Partial<InvoiceRowPdfSource>)).takes_charge_lines).toBe(false);
  });
});
