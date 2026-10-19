import { chunkIds } from './dispatchDisplay';

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

const PAGE_SIZE = 1000;
// Rows re-read at each page seam when every row has an id (see fetchAllRows).
const SEAM_OVERLAP = 50;

/**
 * Read every row of a query, page by page. One request is silently cut off at
 * the PostgREST row cap, so a list or a ledger recompute over a single read
 * hides rows without saying so. Each page must be ordered on a unique column
 * (add `.order('id')` as the last sort key); the loop advances by the rows
 * actually returned, so a server cap below the requested page size still reads
 * everything. Any failed page returns the error, never a partial list.
 *
 * Pages are separate requests, so the rows can move between them:
 * - a row inserted ahead of the read position pushes the seam row onto the
 *   next page as well; rows with an `id` are kept once, so it is never shown
 *   or counted twice;
 * - a row deleted ahead of the read position pulls the seam row back onto the
 *   page already read, where a plain offset read would skip it. When every row
 *   has an `id`, each page after the first starts SEAM_OVERLAP rows early, so
 *   up to that many deletions between two pages still miss nothing.
 * Rows without an `id` (an RPC's computed rows) are read without the overlap.
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<PageResult<T>> {
  const rows: T[] = [];
  const seenIds = new Set<unknown>();
  for (let from = 0; ;) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    const page = data ?? [];
    if (page.length === 0) break;
    let newRows = 0;
    let everyRowHasId = true;
    for (const row of page) {
      const id = rowId(row);
      if (id === undefined) {
        everyRowHasId = false;
      } else {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      rows.push(row);
      newRows += 1;
    }
    // Only the overlap came back: the read has reached the end.
    if (newRows === 0) break;
    from += everyRowHasId && page.length > SEAM_OVERLAP ? page.length - SEAM_OVERLAP : page.length;
  }
  return { data: rows, error: null };
}

function rowId(row: unknown): unknown {
  if (row === null || typeof row !== 'object' || !('id' in row)) return undefined;
  const id = (row as { id: unknown }).id;
  return id === null ? undefined : id;
}

/**
 * Read every row matching a list of ids. The ids are sent in chunks so a long
 * list never overflows the request URL, and each chunk is paged with
 * fetchAllRows so a chunk whose rows pass the row cap is still read in full.
 */
export async function fetchAllRowsForIds<T, Id>(
  ids: Id[],
  fetchPage: (idChunk: Id[], from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<PageResult<T>> {
  const rows: T[] = [];
  for (const idChunk of chunkIds([...new Set(ids)])) {
    const result = await fetchAllRows<T>((from, to) => fetchPage(idChunk, from, to));
    if (result.error) return result;
    // A loop, not push(...rows): one chunk can hold more rows than a call may
    // take as arguments.
    for (const row of result.data ?? []) rows.push(row);
  }
  return { data: rows, error: null };
}
