// Bulk "Email" on the Invoices list (To-Do 9.6). Each invoice goes through the same
// send-email path as the single-invoice Email button; these helpers decide which
// selected invoices can go and give each send its retry key.

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
 * The retry key comes from the record (To-Do 9.8): the invoice id plus the time it last
 * changed. Retrying a lost or failed send reuses it, so the server never mails the same
 * version twice; once the invoice changes (a payment, an edit), it can be sent again.
 */
export function bulkInvoiceEmailKey(inv: { id: string; updated_at: string }): string {
  return `invoice-email-${inv.id}-v${inv.updated_at}`;
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
