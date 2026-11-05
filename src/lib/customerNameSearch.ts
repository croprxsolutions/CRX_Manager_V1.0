type SearchReply = { data: unknown; error: unknown };
type DatedRow = { id: string } & Record<string, unknown>;

/**
 * Search orders or jobs by their own number OR their customer's farm name.
 * PostgREST cannot OR across a join, so this runs two reads and merges them:
 * one matching the number, one matching the customer's name through an inner
 * join (`customer:customers!inner(...)` filtered with `referencedTable`). The
 * database does the name match, so every matching customer counts (KI-32: the
 * old lookup kept only the first 50 customer names). `read` builds each read,
 * already ordered newest first by `dateColumn` then `id` and limited to `limit`;
 * the merge keeps that order, so the top `limit` of the union is exact.
 * Inactive customers count: their orders and jobs still exist.
 */
export async function searchByNumberOrCustomerName(
  read: (match: 'number' | 'customer') => PromiseLike<SearchReply>,
  dateColumn: string,
  limit: number,
): Promise<SearchReply> {
  const [byNumber, byName] = await Promise.all([read('number'), read('customer')]);
  const error = byNumber.error ?? byName.error;
  if (error) return { data: null, error };
  if (!Array.isArray(byNumber.data) || !Array.isArray(byName.data)) {
    return { data: null, error: new Error('Search returned no list') };
  }
  const rows = new Map<string, DatedRow>();
  for (const row of [...byNumber.data, ...byName.data] as DatedRow[]) rows.set(row.id, row);
  const merged = [...rows.values()].sort((a, b) => newestFirst(a, b, dateColumn));
  return { data: merged.slice(0, limit), error: null };
}

// Postgres `ORDER BY <date> DESC, id`: a NULL date sorts first in a DESC sort.
function newestFirst(a: DatedRow, b: DatedRow, dateColumn: string): number {
  const ad = a[dateColumn] == null ? null : String(a[dateColumn]);
  const bd = b[dateColumn] == null ? null : String(b[dateColumn]);
  if (ad !== bd) {
    if (ad === null) return -1;
    if (bd === null) return 1;
    return ad < bd ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
