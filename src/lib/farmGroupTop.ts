export type FarmParentRow = { farm_name: string; parent_customer_id: string | null };

/**
 * #1995: the farm group shown for a customer is its TOP parent (groups can be several levels deep),
 * matching get_orders_keyset_page / get_deliveries_keyset_page. An ancestor missing from `rows`
 * (not visible to the caller) ends the walk at the highest visible one; a loop has no top, so the
 * direct parent is shown, as the list functions do.
 */
export function topFarmGroupName(parentId: string, rows: Record<string, FarmParentRow>): string | null {
  const seen = new Set<string>();
  let id: string | null = parentId;
  let top: string | null = null;
  while (id && rows[id]) {
    if (seen.has(id)) return rows[parentId]?.farm_name ?? null;
    seen.add(id);
    top = rows[id].farm_name;
    id = rows[id].parent_customer_id;
  }
  return top;
}
