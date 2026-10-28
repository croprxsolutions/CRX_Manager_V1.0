import { supabase } from './db';
import { ORDER_COLUMNS, ORDER_ITEM_COLUMNS, withAdminCost, withAdminCosts } from './costFields';
import { readRowVersion } from './recordVersionConcurrency';
import type { Order, OrderItem } from '../types';

/** Confirm separate header/line reads belong to one database version before adopting a draft. */
export async function readOrderEditSnapshot(orderId: string, isAdmin: boolean) {
  // Keep the editor-only candidate column out of shared lists that mirror the live registry.
  const header = await supabase.from('orders').select(`${ORDER_COLUMNS}, row_version`).eq('id', orderId).maybeSingle();
  if (header.error) throw header.error;
  let order = header.data as Order | null;
  let orderCostError: unknown = null;
  let itemCostError: unknown = null;
  if (!order) return { order: null, items: [], orderCostError, itemCostError };
  try {
    order = await withAdminCost('orders', order, isAdmin);
  } catch (error) { orderCostError = error; }
  const lines = await supabase.from('order_items').select(ORDER_ITEM_COLUMNS)
    .eq('order_id', orderId).order('section_name');
  if (lines.error || !Array.isArray(lines.data)) {
    throw lines.error ?? new Error('The order line items could not be checked, try again.');
  }
  let items = lines.data as OrderItem[];
  try {
    items = await withAdminCosts('order_items', items, isAdmin);
  } catch (error) { itemCostError = error; }
  const confirmation = await supabase.from('orders').select('row_version').eq('id', orderId).maybeSingle();
  const rowVersion = readRowVersion(order?.row_version);
  if (confirmation.error || rowVersion === null
    || readRowVersion(confirmation.data?.row_version) !== rowVersion) {
    throw confirmation.error ?? new Error('The order version could not be confirmed. Try again.');
  }
  return { order, items, orderCostError, itemCostError };
}
