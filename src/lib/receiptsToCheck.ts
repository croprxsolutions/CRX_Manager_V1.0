import { supabaseUntyped, assertRpcResult } from './db';

// KI-25 office list: needs_check receipts, plus owed ones still waiting after an hour. No age cut-off: an unsent
// receipt stays listed until it is sent or marked handled, so a long sender outage cannot hide one (Sol, PR #1647).
export const RECEIPTS_TO_CHECK_PAGE = 50;

export function receiptsToCheckFilter(now: Date) {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  return `status.eq.needs_check,and(status.in.(pending,sending),created_at.lt."${hourAgo}")`;
}

// close_delivery_receipt (20261221100000, 20270223120000): 'manual_send' pauses a queued receipt on the office list
// before Email Confirmation sends it by hand; 'handled' closes it so the server sender never emails it. With
// expectedQueuedAt (the receipt's created_at, exactly as the server sent it) the server acts on that receipt only.
export type ReceiptCloseReason = 'handled' | 'manual_send';
export interface ReceiptCloseResult {
  delivery_id: string;
  outcome: 'closed' | 'paused' | 'sent' | 'none';
  previous_status: string | null;
  sent_at: string | null;
  send_authorized_at: string | null;
  queued_at: string | null; // which receipt the answer is about (NULL: none queued)
}

// The key comes from useIdempotencyKey, scoped by receiptCloseScope, and is reset only after a confirmed answer. The
// receipt is in the scope, so a newer receipt gets its own key and a retry of the same one reuses its key (#2251).
export const receiptCloseScope = (deliveryId: string, reason: ReceiptCloseReason, expectedQueuedAt?: string) =>
  `${deliveryId}:${reason}:${expectedQueuedAt ?? ''}`;

export async function closeDeliveryReceipt(
  deliveryId: string, reason: ReceiptCloseReason, idempotencyKey: string, expectedQueuedAt?: string,
) {
  const { data, error } = await supabaseUntyped.rpc('close_delivery_receipt', {
    p_delivery_id: deliveryId,
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
    ...(expectedQueuedAt ? { p_expected_queued_at: expectedQueuedAt } : {}),
  });
  if (error) throw error;
  return assertRpcResult<ReceiptCloseResult>(data, 'close_delivery_receipt');
}

// The server sent this receipt, or was told to and may have: ask before the office emails another copy.
export function receiptMayAlreadyBeSent(result: ReceiptCloseResult) {
  return result.outcome === 'sent' || Boolean(result.sent_at || result.send_authorized_at);
}

export function isReceiptSendingNow(error: unknown) {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message.includes('DELIVERY_RECEIPT_SENDING');
}

export const RECEIPT_SENDING_NOW_MESSAGE = 'The server is emailing this receipt right now. Try again in a minute.';

// The server refused because the delivery's receipt is not the one the screen named (queued again, or gone).
export function isReceiptChanged(error: unknown) {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message.includes('DELIVERY_RECEIPT_CHANGED');
}
