import { supabase, supabaseUntyped, assertRpcResult } from './db';

// KI-25 office list: needs_check receipts, plus owed ones still waiting after an hour. No age cut-off: an unsent
// receipt stays listed until it is sent or marked handled, so a long sender outage cannot hide one (Sol, PR #1647).
export const RECEIPTS_TO_CHECK_PAGE = 50;

export function receiptsToCheckFilter(now: Date) {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  return `status.eq.needs_check,and(status.in.(pending,sending),created_at.lt."${hourAgo}")`;
}

// close_delivery_receipt (20261221100000): 'manual_send' pauses a queued receipt on the office list before Email
// Confirmation sends it by hand; 'handled' closes it so the server sender never emails it.
export type ReceiptCloseReason = 'handled' | 'manual_send';
export interface ReceiptCloseResult {
  delivery_id: string;
  outcome: 'closed' | 'paused' | 'sent' | 'none';
  previous_status: string | null;
  sent_at: string | null;
  send_authorized_at: string | null;
  queued_at: string | null; // which receipt the answer is about (NULL: none queued)
}

// The key comes from useIdempotencyKey, scoped by receiptCloseScope, and is reset only after a confirmed answer.
export const receiptCloseScope = (deliveryId: string, reason: ReceiptCloseReason) => `${deliveryId}:${reason}`;

export async function closeDeliveryReceipt(deliveryId: string, reason: ReceiptCloseReason, idempotencyKey: string) {
  const { data, error } = await supabaseUntyped.rpc('close_delivery_receipt', {
    p_delivery_id: deliveryId,
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
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

// When this delivery's queue row was (re)queued, or null when it has none. Read right before the 'handled' close so a
// receipt queued again during a hand send is never closed by it (Sol HIGH). shortcut: a client-side re-check, so a
// re-queue in the milliseconds between this read and the close is not caught; closing it fully needs the RPC to take
// the expected queued_at (a migration, #2251).
export async function receiptQueuedAt(deliveryId: string): Promise<string | null> {
  const { data, error } = await supabase.from('delivery_receipt_queue').select('created_at').eq('delivery_id', deliveryId).maybeSingle();
  if (error) throw error;
  return data?.created_at ?? null;
}

export function sameReceipt(a: string | null, b: string | null) {
  return a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));
}
