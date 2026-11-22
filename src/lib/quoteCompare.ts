/**
 * Quote Compare (KI-201): pair a sent version's lines with the current quote's lines.
 * Lines match by the saved quote line (versions record `quote_item_id` since
 * 20261027040000). Older versions have no line ids, so both sides then pair by
 * section + product, in order. Never by product alone: one product can sit on
 * several sections.
 */
export interface CompareLine {
  line_id?: string | null;
  product_id: string;
  product_name: string;
  section: string;
  price_per_unit: number;
  total_price: number;
}

export interface CompareRow {
  key: string;
  version?: CompareLine;
  current?: CompareLine;
}

function keyed(lines: CompareLine[], byId: boolean): Array<[string, CompareLine]> {
  const seen = new Map<string, number>();
  return lines.map((l, i) => {
    if (byId) return [l.line_id ? `id:${l.line_id}` : `new:${i}`, l];
    const base = `${l.section}\u0000${l.product_id}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return [`sp:${base}\u0000${n}`, l];
  });
}

export function pairCompareLines(version: CompareLine[], current: CompareLine[]): CompareRow[] {
  const byId = version.some((l) => l.line_id);
  const rows = new Map<string, CompareRow>();
  for (const [key, l] of keyed(version, byId)) rows.set(key, { key, version: l });
  for (const [key, l] of keyed(current, byId)) {
    const row = rows.get(key);
    if (row) row.current = l;
    else rows.set(key, { key, current: l });
  }
  return [...rows.values()];
}
