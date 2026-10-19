import { chunkIds } from './dispatchDisplay';

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

const PAGE_SIZE = 1000;

/**
 * Read every row of a query, page by page. One request is silently cut off at
 * the PostgREST row cap, so a list or a ledger recompute over a single read
 * hides rows without saying so. Each page must be ordered on a unique column
 * (add `.order('id')` as the last sort key); the loop advances by the rows
 * actually returned, so a server cap below the requested page size still reads
 * everything. Any failed page returns the error, never a partial list.
 *
 * Pages are separate requests, so a row inserted ahead of the read position
 * between two pages pushes the boundary row onto the next page as well. Rows
 * with an `id` are kept once, so that shift never shows or counts a record
 * twice. (A row deleted mid-read can still shift one row past the read; it
 * reappears on the next load.)
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
    for (const row of page) {
      const id = rowId(row);
      if (id !== undefined) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      rows.push(row);
    }
    from += page.length;
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
    rows.push(...(result.data ?? []));
  }
  return { data: rows, error: null };
}
