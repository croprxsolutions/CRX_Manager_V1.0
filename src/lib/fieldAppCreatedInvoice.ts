/**
 * Remembers, for one browser tab, the invoice that the FIRST Save on
 * /invoices/field-app/new created.
 *
 * The page keeps that id in a ref so a repeat Save updates the same invoice. A page
 * refresh loses the ref: the reloaded /new page would send p_invoice_id = null again and
 * create a SECOND invoice for the same application (CodeRabbit, PR #893). The id is
 * therefore also kept in sessionStorage (this tab only, gone when the tab closes); the
 * reloaded /new page opens that invoice instead. Same shape as the uncertain-ticket record
 * in ManualTicketCreate: versioned, bound to the user, UUID-checked, and short-lived.
 */

interface CreatedFieldAppInvoiceRecord {
  version: 1;
  userId: string;
  invoiceId: string;
  expiresAt: number;
}

const CREATED_FIELD_APP_INVOICE_TTL_MS = 2 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const createdFieldAppInvoiceStorageKey = (userId: string) =>
  `crx:field-app-invoice:created:v1:${userId}`;

/** Record the invoice the first Save created, before any later save step can fail. */
export function rememberCreatedFieldAppInvoice(userId: string, invoiceId: string): void {
  if (!UUID_PATTERN.test(invoiceId)) return;
  const record: CreatedFieldAppInvoiceRecord = {
    version: 1,
    userId,
    invoiceId,
    expiresAt: Date.now() + CREATED_FIELD_APP_INVOICE_TTL_MS,
  };
  try {
    window.sessionStorage.setItem(createdFieldAppInvoiceStorageKey(userId), JSON.stringify(record));
  } catch {
    /* best effort: storage blocked or full — the in-page ref still covers a repeat Save */
  }
}

export function forgetCreatedFieldAppInvoice(userId: string): void {
  try {
    window.sessionStorage.removeItem(createdFieldAppInvoiceStorageKey(userId));
  } catch {
    /* best effort */
  }
}

/**
 * Read and clear the remembered invoice id. Returns null (and clears the entry) when there
 * is none, or it is malformed, expired, or belongs to another user.
 */
export function takeCreatedFieldAppInvoice(userId: string): string | null {
  const key = createdFieldAppInvoiceStorageKey(userId);
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    window.sessionStorage.removeItem(key);
    if (raw.length > 1024) return null;
    const value = JSON.parse(raw) as Partial<CreatedFieldAppInvoiceRecord>;
    const valid = value.version === 1
      && value.userId === userId
      && typeof value.invoiceId === 'string'
      && UUID_PATTERN.test(value.invoiceId)
      && typeof value.expiresAt === 'number'
      && value.expiresAt > Date.now();
    return valid ? (value.invoiceId as string) : null;
  } catch {
    forgetCreatedFieldAppInvoice(userId);
    return null;
  }
}
