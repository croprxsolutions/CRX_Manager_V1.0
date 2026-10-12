/**
 * The address of a new field-application invoice, /invoices/field-app/new, carries two ids
 * that must survive a page refresh (CodeRabbit, PR #893):
 *
 * - draft=<token>: written just BEFORE the first Save sends its create. The create's
 *   idempotency key is built from it, so if the database created the invoice but the reply was
 *   lost and the page is then refreshed, saving again reuses the same key and the database
 *   returns the invoice it already created instead of creating a second one.
 * - created=<invoice id>: written once the create has answered (same page, typed values kept).
 *   A refresh or Back of that address opens the created invoice.
 *
 * A plain /invoices/field-app/new has neither and is always a new invoice.
 */
export const CREATED_INVOICE_PARAM = 'created';
export const DRAFT_TOKEN_PARAM = 'draft';

// Any UUID layout (any version), so a valid id is never mistaken for "no id".
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(searchParams: URLSearchParams, name: string): string | null {
  const value = searchParams.get(name);
  return value && UUID_PATTERN.test(value) ? value : null;
}

/** The created invoice's id from the address, or null when absent or not an invoice id. */
export function createdInvoiceIdFromAddress(searchParams: URLSearchParams): string | null {
  return uuidParam(searchParams, CREATED_INVOICE_PARAM);
}

/** The new invoice's draft token from the address, or null when absent or malformed. */
export function draftTokenFromAddress(searchParams: URLSearchParams): string | null {
  return uuidParam(searchParams, DRAFT_TOKEN_PARAM);
}

/** The query string for a new invoice's address. */
export function newInvoiceAddressSearch(ids: { draft: string | null; created?: string | null }): string {
  const params = new URLSearchParams();
  if (ids.draft) params.set(DRAFT_TOKEN_PARAM, ids.draft);
  if (ids.created) params.set(CREATED_INVOICE_PARAM, ids.created);
  const search = params.toString();
  return search ? `?${search}` : '';
}

/**
 * The idempotency key of a new invoice's create: one per draft and user, so the same draft
 * saved again (even after a refresh) replays the database's stored answer for that create.
 */
export function draftCreateIdempotencyKey(userId: string, draftToken: string): string {
  return `save_field_app_invoice:${userId}:${draftToken}`;
}
