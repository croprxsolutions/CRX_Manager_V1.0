/** A customer as the farm-group walk needs it. */
export interface FarmGroupNode {
  farm_name: string;
  parent_customer_id: string | null;
}

/**
 * The farm group's TOP parent name for a customer whose direct parent is `parentId` (#1995), matching
 * get_orders_keyset_page / get_deliveries_keyset_page: walk up while the next parent is known; a loop (no top)
 * shows the direct parent; an unknown parent shows nothing.
 */
export function farmGroupTopName(parentId: string | null | undefined, nodes: Record<string, FarmGroupNode>): string | null {
  if (!parentId || !nodes[parentId]) return null;
  const seen = new Set<string>();
  let current = parentId;
  while (!seen.has(current)) {
    seen.add(current);
    const next = nodes[current].parent_customer_id;
    if (!next || !nodes[next]) return nodes[current].farm_name;
    current = next;
  }
  return nodes[parentId].farm_name;
}
