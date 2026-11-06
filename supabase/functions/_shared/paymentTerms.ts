// Mirrors public.parse_payment_terms_days (migration 20261117100000_field_invoice_due_date_follows_owner_terms).
// Keep the two in step: src/lib/paymentTerms.test.ts and the real-schema proof check the same case table.

export const RECEIPT_TERMS = ['due on receipt', 'due upon receipt', 'receipt', 'immediately'];

/** Days from invoice date to due date: receipt aliases 0; "Net N" wins; else the first number; 1..365, else 30. */
export function paymentTermsDays(terms: string | null | undefined): number {
  const t = terms ?? '';
  if (RECEIPT_TERMS.includes(t.trim().toLowerCase())) return 0;
  const m = /\bnet[\s_-]*(\d+)/i.exec(t) ?? /(\d+)/.exec(t);
  if (!m) return 30;
  const n = Number(m[1]);
  return n >= 1 && n <= 365 ? n : 30;
}

/** invoiceDate (YYYY-MM-DD) plus the terms' days, as YYYY-MM-DD. */
export function dueDateFromTerms(invoiceDate: string, terms: string | null | undefined): string {
  const d = new Date(`${invoiceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + paymentTermsDays(terms));
  return d.toISOString().slice(0, 10);
}
