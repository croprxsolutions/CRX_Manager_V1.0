// Brand PR B-3: the brand notes the delivery receipt PDF and the office resend print under each line, from the
// delivery's current picks (get_delivery_brands), so a correction made after completion shows.
import { supabaseUntyped, assertRpcResult } from './db';
import { receiptBrandInfoFromPicks, type ReceiptBrandInfo } from '../../supabase/functions/_shared/brandNotes.ts';

interface BrandsReadLine {
  delivery_item_id: string;
  quantity: number;
  quantity_delivered: number | null;
  brand_list: unknown[] | null;
  picks: Array<{ brand_name: string; epa_registration: string | null; quantity: number }> | null;
}

/**
 * Receipt brand keys per delivery line id. Before completion nothing is delivered yet, so only picks already made
 * are shown (never "not recorded"); after it, the receipt rule applies.
 */
export async function loadDeliveryBrandInfo(deliveryId: string): Promise<Map<string, ReceiptBrandInfo>> {
  const { data, error } = await supabaseUntyped.rpc('get_delivery_brands', { p_delivery_id: deliveryId });
  if (error) throw error;
  const read = assertRpcResult<{ status: string; lines: BrandsReadLine[] | null }>(data, 'get_delivery_brands');
  const completed = read.status === 'completed';
  return new Map((read.lines ?? []).map((l) => {
    const delivered = Number(l.quantity_delivered ?? l.quantity);
    const info = receiptBrandInfoFromPicks(l.picks ?? [], delivered, completed && delivered > 0 && (l.brand_list?.length ?? 0) > 0);
    // Not delivered yet: no "do not match delivered" note.
    if (!completed) delete info.brand_picked_quantity;
    return [l.delivery_item_id, info];
  }));
}

type PickReviewRead = { lines: Array<{ picks: Array<{ id: string; review_state: string | null }> | null }> | null };

/** Typed picks still waiting for the office's check, across the given deliveries (the invoice Post warnings). */
export async function loadPendingTypedPickIds(deliveryIds: string[]): Promise<Set<string>> {
  const pending = new Set<string>();
  for (const deliveryId of deliveryIds) {
    const { data, error } = await supabaseUntyped.rpc('get_delivery_brands', { p_delivery_id: deliveryId });
    if (error) throw error;
    const read = assertRpcResult<PickReviewRead>(data, 'get_delivery_brands');
    for (const line of read.lines ?? []) for (const pick of line.picks ?? []) if (pick.review_state === 'pending') pending.add(pick.id);
  }
  return pending;
}
