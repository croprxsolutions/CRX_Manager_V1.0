/**
 * The address of a new field-application invoice, /invoices/field-app/new, carries two ids
 * that must survive a page refresh (CodeRabbit, PR #893):
 *
 * - draft=<token>: written just BEFORE the first Save sends its create. The create's
 *   idempotency key is built from it, so if the database created the invoice but the reply was
 *   lost and the page is then refreshed, saving again reuses the same key and the database
 *   returns the invoice it already created instead of creating a second one. That stored answer
 *   only lasts 24 hours and holds the FIRST submission, so a page reopened at a draft address
 *   (no created id) first looks for invoices this user created since the draft started (Codex
 *   review, PR #893); the token carries that start time (a UUIDv7 layout).
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

/** A new draft token: a UUIDv7 layout whose first 48 bits are the time it was minted (ms). */
export function mintDraftToken(nowMs: number = Date.now()): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, '0')).join('');
  const time = Math.max(0, Math.floor(nowMs)).toString(16).padStart(12, '0').slice(-12);
  const variant = (8 + (parseInt(random[3], 16) % 4)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(8, 20)}`;
}

/** When a draft token was minted (ms), or null for a token that does not carry its time. */
export function draftTokenStartedAt(token: string): number | null {
  if (!UUID_PATTERN.test(token) || token[14] !== '7') return null;
  return parseInt(token.slice(0, 8) + token.slice(9, 13), 16);
}
