// Brand PR B-3: the brand notes the delivery receipt PDF and the office resend print under each line, from the
// delivery's current picks (get_delivery_brands), so a correction made after completion shows.
import { supabaseUntyped, assertRpcResult } from './db';
import { receiptBrandInfoFromPicks, type ReceiptBrandInfo } from '../../supabase/functions/_shared/brandNotes.ts';
import type { DeliveryPickLine } from './invoiceBrandWarnings';

interface BrandsReadLine {
  delivery_item_id: string;
  order_item_id: string | null;
  product_id: string | null;
  quantity: number;
  quantity_delivered: number | null;
  picks: Array<{ id: string; brand_name: string; epa_registration: string | null; quantity: number; review_state: string | null }> | null;
}
type BrandsRead = { status: string; lines: BrandsReadLine[] | null };

/** The completion and correction events, as delivery_brand_events stores them (20270104120000). */
export interface BrandPaperEvent {
  seq: number;
  event_type: string;
  details: { picks_confirmed?: boolean | null; lines?: Array<{ delivery_item_id: string; brand_list_size?: number | null }> } | null;
  before_rows: unknown;
  after_rows: unknown;
}

async function readDeliveryBrands(deliveryId: string): Promise<BrandsRead> {
  const { data, error } = await supabaseUntyped.rpc('get_delivery_brands', { p_delivery_id: deliveryId });
  if (error) throw error;
  return assertRpcResult<BrandsRead>(data, 'get_delivery_brands');
}

const touches = (rows: unknown, itemId: string) =>
  Array.isArray(rows) && rows.some((r) => (r as { delivery_item_id?: unknown })?.delivery_item_id === itemId);

/**
 * Receipt brand keys per delivery line id, by the receipt's own rule (20270109100000): a line completed from an
 * out-of-date screen and not corrected since prints no brand, and "not recorded" uses the brand list the line had at
 * completion. Before completion nothing is delivered yet, so only picks already made are shown.
 */
export function paperBrandInfo(read: BrandsRead, events: BrandPaperEvent[]): Map<string, ReceiptBrandInfo> {
  const completed = read.status === 'completed';
  const done = completed ? [...events].reverse().find((e) => e.event_type === 'completed') : undefined;
  return new Map((read.lines ?? []).map((l) => {
    const id = l.delivery_item_id;
    const corrected = events.some((e) => e.event_type === 'corrected' && (!done || e.seq > done.seq)
      && (touches(e.before_rows, id) || touches(e.after_rows, id)));
    if (done?.details?.picks_confirmed === false && !corrected) return [id, {}];
    const delivered = Number(l.quantity_delivered ?? l.quantity);
    const listSize = done?.details?.lines?.find((x) => x.delivery_item_id === id)?.brand_list_size ?? 0;
    const info = receiptBrandInfoFromPicks(l.picks ?? [], delivered, !!done && delivered > 0 && listSize > 0);
    // Not delivered yet: no "do not match delivered" note.
    if (!completed) delete info.brand_picked_quantity;
    return [id, info];
  }));
}

export async function loadDeliveryBrandInfo(deliveryId: string): Promise<Map<string, ReceiptBrandInfo>> {
  const read = await readDeliveryBrands(deliveryId);
  let events: BrandPaperEvent[] = [];
  if (read.status === 'completed') {
    const { data, error } = await supabaseUntyped
      .from('delivery_brand_events')
      .select('seq, event_type, details, before_rows, after_rows')
      .eq('delivery_id', deliveryId)
      .in('event_type', ['completed', 'corrected'])
      .order('seq');
    if (error) throw error;
    events = (data ?? []) as BrandPaperEvent[];
  }
  return paperBrandInfo(read, events);
}

/** Every delivery line's current picks across the given deliveries (the invoice Post warnings). */
export async function loadDeliveryPicks(deliveryIds: string[]): Promise<DeliveryPickLine[]> {
  const out: DeliveryPickLine[] = [];
  for (const deliveryId of deliveryIds) {
    const read = await readDeliveryBrands(deliveryId);
    for (const l of read.lines ?? []) {
      out.push({
        delivery_id: deliveryId,
        delivery_item_id: l.delivery_item_id,
        order_item_id: l.order_item_id,
        product_id: l.product_id,
        picks: (l.picks ?? []).map((p) => ({ id: p.id, quantity: p.quantity, review_state: p.review_state })),
      });
    }
  }
  return out;
}
