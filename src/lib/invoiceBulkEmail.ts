// Invoice email (To-Do 9.6 bulk, 9.8 record key). The list's bulk Email and the invoice page's
// Email button share these rules: which invoices can go and each send's retry key. The server
// dedupes that key exactly, so it alone decides whether this version already went to this address.

export type BulkEmailOutcome = 'sent' | 'already_sent' | 'failed' | 'skipped';

export interface BulkEmailResult {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  outcome: BulkEmailOutcome;
  detail?: string;
}

/** Same rule as the invoice page's Email button: a posted (or overdue) chemical or misc invoice, not a suppressed $0 split. */
export function isBulkEmailable(inv: { status?: string | null; send_disposition?: string | null; deleted_at?: string | null }): boolean {
  return (inv.status === 'posted' || inv.status === 'overdue')
    && inv.send_disposition !== 'suppressed_zero_total'
    && !inv.deleted_at;
}

/**
 * The retry key comes from the record (To-Do 9.8): the invoice id, the time it last changed,
 * and a short code for the address. Both screens use it, so the server never mails the same
 * version to the same address twice; an edit, a payment or a corrected address sends again.
 * The address is hashed so a long one cannot push the key past the server's 256 characters.
 */
export async function invoiceEmailKey(inv: { id: string; updated_at: string }, to: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(to.trim().toLowerCase()));
  const code = Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  return `invoice-email-${inv.id}-v${inv.updated_at}-to-${code}`;
}

/** The server's hourly cap (50 per user): later sends in the batch would be refused too. */
export function isEmailRateLimit(message: string): boolean {
  return message.startsWith('Rate limit:');
}

export function summarizeBulkEmail(results: BulkEmailResult[]): { type: 'success' | 'warning' | 'error'; message: string } {
  const count = (o: BulkEmailOutcome) => results.filter((r) => r.outcome === o).length;
  const sent = count('sent');
  const already = count('already_sent');
  const failed = count('failed') + count('skipped');
  const parts = [`${sent} emailed`];
  if (already) parts.push(`${already} already emailed (not sent again)`);
  if (failed) parts.push(`${failed} not sent`);
  const message = parts.join(', ');
  if (failed === 0) return { type: 'success', message };
  return { type: sent + already > 0 ? 'warning' : 'error', message };
}
