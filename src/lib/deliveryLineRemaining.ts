import { supabase } from './db';
import { Sentry } from './sentry';

/**
 * Figures for one line of the delivery page's Products table (F05).
 *
 * `orderDelivered` is the order line's delivered total now, which already includes this load once it is
 * completed. `otherOpen` is what the order's other scheduled or in-progress loads hold. "Remaining after"
 * follows the F05 rule (delivered + open loads <= ordered): what is still neither delivered nor on a load.
 */
export function deliveryLineFigures(input: {
  status: string;
  ordered: number;
  orderDelivered: number;
  otherOpen: number;
  scheduled: number;
  actual: number;
}): { prevDelivered: number; remainingAfter: number } {
  const { status, ordered, orderDelivered, otherOpen, scheduled, actual } = input;
  const countedDelivered = status === 'completed' ? actual : 0;
  const stillHeld = status === 'scheduled' || status === 'in_progress' ? scheduled : 0;
  return {
    prevDelivered: Math.max(0, orderDelivered - countedDelivered),
    remainingAfter: Math.max(0, ordered - orderDelivered - otherOpen - stillHeld),
  };
}

/**
 * Units each order line has on the order's OTHER scheduled or in-progress loads (F05).
 * shortcut: a reader whose RLS hides other loads sees them as 0, as before this read existed.
 */
export async function fetchOtherOpenByOrderLine(
  orderId: string,
  deliveryId: string,
): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('delivery_items')
    .select('order_item_id, quantity, delivery:deliveries!inner(order_id, status, deleted_at)')
    .eq('delivery.order_id', orderId)
    .is('delivery.deleted_at', null)
    .in('delivery.status', ['scheduled', 'in_progress'])
    .neq('delivery_id', deliveryId);
  const byOrderLine: Record<string, number> = {};
  for (const di of (data ?? []) as Array<{ order_item_id: string | null; quantity: number | null }>) {
    if (di.order_item_id) byOrderLine[di.order_item_id] = (byOrderLine[di.order_item_id] ?? 0) + Number(di.quantity ?? 0);
  }
  // Fail open: the column falls back to the old figure; the server still enforces the rule.
  if (error) Sentry.captureException(error, { extra: { context: 'load_delivery_other_open_loads', deliveryId } });
  return byOrderLine;
}
