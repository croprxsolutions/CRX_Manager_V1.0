/**
 * After the first Save on /invoices/field-app/new creates the invoice, the page address becomes
 * /invoices/field-app/new?created=<invoice id> (same page, typed values kept). The created id then
 * lives in the address itself, so a refresh or Back of that page opens the created invoice instead
 * of a blank form whose Save would create a SECOND invoice (CodeRabbit, PR #893). A plain
 * /invoices/field-app/new has no id and is always a new invoice.
 */
export const CREATED_INVOICE_PARAM = 'created';

// Any UUID layout (any version), so a valid invoice id is never mistaken for "no id".
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The created invoice's id from the address, or null when absent or not an invoice id. */
export function createdInvoiceIdFromAddress(searchParams: URLSearchParams): string | null {
  const value = searchParams.get(CREATED_INVOICE_PARAM);
  return value && UUID_PATTERN.test(value) ? value : null;
}
