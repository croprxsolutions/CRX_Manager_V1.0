/**
 * "Next draft" on a chemical invoice's page. The Invoices list hands the invoice it opens the drafts that
 * come after it in the order on screen (its filters, search and sort), so the bookkeeper can post one and
 * open the next without going back to the list. Navigation only: nothing here posts or changes an invoice.
 */

/** Statuses the Invoices list's "Ready to post" counts: not yet posted. */
const DRAFT_STATUSES: readonly string[] = ['draft', 'unposted'];

export interface InvoiceDraftQueueState {
  /** Ids of the unposted invoices after the open one, in list order. */
  nextDrafts: string[];
}

/** The router state for opening `id` from a list showing `rows` in this order. */
export function draftQueueState(rows: ReadonlyArray<{ id: string; status: string }>, id: string): InvoiceDraftQueueState {
  const at = rows.findIndex((row) => row.id === id);
  if (at < 0) return { nextDrafts: [] };
  return { nextDrafts: rows.slice(at + 1).filter((row) => DRAFT_STATUSES.includes(row.status)).map((row) => row.id) };
}

/** The drafts queued after the open invoice, from its router state; none when it was opened another way. */
export function readDraftQueue(state: unknown, currentId: string | undefined): string[] {
  const ids = (state as Partial<InvoiceDraftQueueState> | null)?.nextDrafts;
  if (!Array.isArray(ids)) return [];
  return ids.filter((value): value is string => typeof value === 'string' && value !== currentId);
}
