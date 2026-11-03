import { describe, expect, it } from 'vitest';
import {
  buildInvoiceEmail,
  formatUsdCents,
  parseInvoiceEmailSnapshot,
  wrapEmailHtml,
  type InvoiceEmailRow,
} from '../../supabase/functions/_shared/invoiceEmailGate';
import { attachmentProblem, emailContentProblem } from '../../supabase/functions/_shared/emailContentGate';
import { buildEmailHtml, invoiceEmailSnapshot } from './emailService';
import type { InvoicePdfData } from './invoicePdf';

// A saved invoice as PostgREST returns it: $1,250.07 total, $200.00 paid, $50.00 prepaid.
const invoice: InvoiceEmailRow = {
  invoice_number: 'INV-1001',
  invoice_type: 'chemical_sale',
  invoice_date: '2026-11-02',
  due_date: '2026-12-02',
  total_amount_cents: 125_007,
  paid_amount_cents: 20_000,
  prepay_applied_cents: 5_000,
  balance_cents: 100_007,
};
const lines = [100_000, 25_007];

// What the app's PDF data for that invoice holds; the snapshot is taken from it.
const pdf = {
  invoice_number: 'INV-1001',
  total_amount_cents: 125_007,
  paid_amount_cents: 20_000,
  prepay_applied_cents: 5_000,
  balance_cents: 100_007,
  items: [{ extended_cents: 100_000 }, { extended_cents: 25_007 }],
} as InvoicePdfData;
const snapshot = parseInvoiceEmailSnapshot(invoiceEmailSnapshot(pdf))!;

describe('invoice email built from the saved invoice (KI-97)', () => {
  it('the app snapshot of a PDF that matches the invoice is accepted', () => {
    expect(snapshot).not.toBeNull();
    const built = buildInvoiceEmail(invoice, lines, snapshot);
    expect(built.ok).toBe(true);
  });

  it('states the saved balance in exact cents, never an amount the browser sent', () => {
    const built = buildInvoiceEmail(invoice, lines, snapshot);
    if (!built.ok) throw new Error(built.error);
    expect(built.html).toContain('Amount Due: <strong>$1,000.07</strong>');
    expect(built.html).toContain('Invoice Date: 2026-11-02');
    expect(built.html).toContain('Due Date: 2026-12-02');
    expect(built.subject).toBe('Invoice INV-1001 from Crop RX Solutions');
    expect(built.filename).toBe('Invoice-INV-1001.pdf');
    // The server's email must pass the same content gate every other email passes.
    expect(emailContentProblem(built.subject, built.html)).toBeNull();
    expect(attachmentProblem(built.filename, 'JVBERi0x')).toBeNull();
  });

  it('refuses when the PDF prints different money from the saved invoice', () => {
    for (const change of [
      { balance_cents: 1 },
      { total_amount_cents: 125_008 },
      { paid_amount_cents: 0 },
      { prepay_applied_cents: 0 },
      { lines_total_cents: 125_006 },
      { invoice_number: 'INV-1002' },
    ]) {
      const built = buildInvoiceEmail(invoice, lines, { ...snapshot, ...change });
      expect(built).toEqual({ ok: false, status: 409, error: expect.stringContaining('Reload it and send again') });
    }
  });

  it('refuses when a line changed after the PDF was built', () => {
    expect(buildInvoiceEmail(invoice, [100_000, 25_008], snapshot).ok).toBe(false);
    expect(buildInvoiceEmail(invoice, [100_000], snapshot).ok).toBe(false);
  });

  it('refuses a missing invoice and amounts that are not whole cents', () => {
    expect(buildInvoiceEmail(null, lines, snapshot)).toMatchObject({ ok: false, status: 404 });
    expect(buildInvoiceEmail({ ...invoice, balance_cents: 100_007.5 }, lines, snapshot)).toMatchObject({ ok: false, status: 503 });
    expect(buildInvoiceEmail({ ...invoice, total_amount_cents: null }, lines, snapshot)).toMatchObject({ ok: false, status: 503 });
    expect(buildInvoiceEmail(invoice, [100_000, 'abc'], snapshot)).toMatchObject({ ok: false, status: 503 });
  });

  it('adds line amounts exactly even past the safe-integer range mid-sum', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const twoCents = { ...snapshot, lines_total_cents: 2 };
    expect(buildInvoiceEmail(invoice, [max, 2, -max], twoCents).ok).toBe(true);
  });

  it('reads bigint cents that arrive as strings', () => {
    const asStrings = { ...invoice, total_amount_cents: '125007', balance_cents: '100007' };
    expect(buildInvoiceEmail(asStrings, ['100000', '25007'], snapshot).ok).toBe(true);
  });

  it('escapes the invoice number and keeps a credit balance negative', () => {
    const credit = { ...invoice, invoice_number: 'CM<1>/2', invoice_type: 'credit_memo', due_date: null,
      total_amount_cents: -5_000, paid_amount_cents: 0, prepay_applied_cents: 0, balance_cents: -5_000 };
    const built = buildInvoiceEmail(credit, [-5_000], { invoice_number: 'CM<1>/2', total_amount_cents: -5_000,
      paid_amount_cents: 0, prepay_applied_cents: 0, balance_cents: -5_000, lines_total_cents: -5_000 });
    if (!built.ok) throw new Error(built.error);
    expect(built.html).toContain('Invoice CM&lt;1&gt;/2');
    expect(built.html).toContain('-$50.00');
    expect(built.html).not.toContain('Due Date');
    expect(built.filename).toBe('Invoice-CM-1--2.pdf');
    expect(emailContentProblem(built.subject, built.html)).toBeNull();
    expect(attachmentProblem(built.filename, 'JVBERi0x')).toBeNull();
  });

  it('labels a field application invoice as the app did', () => {
    const built = buildInvoiceEmail({ ...invoice, invoice_type: 'field_application' }, lines, snapshot);
    expect(built.ok && built.html).toContain('Field Application Invoice INV-1001');
  });

  it('an unsaved invoice is named DRAFT, as its PDF is', () => {
    const built = buildInvoiceEmail({ ...invoice, invoice_number: null }, lines, { ...snapshot, invoice_number: 'DRAFT' });
    expect(built.ok && built.filename).toBe('Invoice-DRAFT.pdf');
  });

  it('rejects a missing or fractional snapshot', () => {
    expect(parseInvoiceEmailSnapshot(undefined)).toBeNull();
    expect(parseInvoiceEmailSnapshot({ ...snapshot, balance_cents: 1.5 })).toBeNull();
    expect(parseInvoiceEmailSnapshot({ ...snapshot, lines_total_cents: '1' })).toBeNull();
    expect(parseInvoiceEmailSnapshot({ ...snapshot, invoice_number: 7 })).toBeNull();
  });

  it('formats whole cents exactly', () => {
    expect(formatUsdCents(0)).toBe('$0.00');
    expect(formatUsdCents(5)).toBe('$0.05');
    expect(formatUsdCents(123_456_789)).toBe('$1,234,567.89');
    expect(formatUsdCents(-1)).toBe('-$0.01');
  });

  it('server email frame stays identical to the app one', () => {
    expect(wrapEmailHtml('<p>x</p>')).toBe(buildEmailHtml('<p>x</p>'));
  });
});
