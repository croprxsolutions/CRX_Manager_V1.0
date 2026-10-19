import { describe, expect, it } from 'vitest';
import { fetchAllRows, fetchAllRowsForIds } from './pagedRead';

describe('fetchAllRows', () => {
  it('reads every row past the 1,000-row cap', async () => {
    const all = Array.from({ length: 2500 }, (_, i) => i);
    const result = await fetchAllRows(async (from, to) => ({ data: all.slice(from, to + 1), error: null }));
    expect(result.data).toEqual(all);
  });

  it('keeps a record once when an insert between pages shifts it onto the next page', async () => {
    // Newest-first list of 1,001 rows; a new row arrives after page one is read.
    let rows = Array.from({ length: 1001 }, (_, i) => ({ id: `r${1001 - i}` }));
    let call = 0;
    const result = await fetchAllRows<{ id: string }>(async (from, to) => {
      call += 1;
      if (call === 2) rows = [{ id: 'r1002' }, ...rows];
      return { data: rows.slice(from, to + 1), error: null };
    });
    const ids = (result.data ?? []).map((r) => r.id);
    expect(ids).toHaveLength(1001);
    expect(new Set(ids).size).toBe(1001);
  });

  it('misses nothing when rows are deleted ahead of the read between pages', async () => {
    let rows = Array.from({ length: 2500 }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}` }));
    let call = 0;
    const result = await fetchAllRows<{ id: string }>(async (from, to) => {
      call += 1;
      // After each page, three already-read rows near the top are deleted.
      if (call > 1) rows = rows.filter((_, i) => i < 10 || i >= 13);
      return { data: rows.slice(from, to + 1), error: null };
    });
    const ids = new Set((result.data ?? []).map((r) => r.id));
    // Every row still present at the end was read.
    for (const r of rows) expect(ids.has(r.id)).toBe(true);
  });

  it('stops after the overlap-only page at the end', async () => {
    const all = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1 }));
    const ranges: Array<[number, number]> = [];
    const result = await fetchAllRows<{ id: number }>(async (from, to) => {
      ranges.push([from, to]);
      return { data: all.slice(from, to + 1), error: null };
    });
    expect(result.data).toHaveLength(1500);
    expect(ranges).toEqual([[0, 999], [950, 1949], [1450, 2449]]);
  });

  it('keeps rows without an id as they are', async () => {
    const pages = [[{ n: 1 }, { n: 1 }], []];
    let call = 0;
    const result = await fetchAllRows(async () => ({ data: pages[call++], error: null }));
    expect(result.data).toEqual([{ n: 1 }, { n: 1 }]);
  });
});

describe('fetchAllRowsForIds', () => {
  it('sends ids in chunks of 200 and reads each chunk past the row cap', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const chunkSizes: number[] = [];
    // Each id owns 5 rows, so a 200-id chunk returns 1,000 rows and needs a second page.
    const result = await fetchAllRowsForIds(ids, async (chunk, from, to) => {
      if (from === 0) chunkSizes.push(chunk.length);
      const rows = chunk.flatMap((id) => [1, 2, 3, 4, 5].map((n) => `${id}:${n}`));
      return { data: rows.slice(from, to + 1), error: null };
    });
    expect(chunkSizes).toEqual([200, 200, 50]);
    expect(result.data).toHaveLength(450 * 5);
    expect(new Set(result.data).size).toBe(450 * 5);
  });

  it('reads a repeated id once', async () => {
    const seen: string[][] = [];
    await fetchAllRowsForIds(['a', 'b', 'a'], async (chunk) => {
      seen.push(chunk);
      return { data: [], error: null };
    });
    expect(seen).toEqual([['a', 'b']]);
  });

  it('returns the error instead of the chunks read so far', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => i);
    let call = 0;
    const result = await fetchAllRowsForIds(ids, async (chunk, from) => {
      call += 1;
      if (call > 2) return { data: null, error: { message: 'boom' } };
      return { data: from === 0 ? chunk.slice(0, 1) : [], error: null };
    });
    expect(result).toEqual({ data: null, error: { message: 'boom' } });
  });

  it('makes no request for an empty id list', async () => {
    let calls = 0;
    const result = await fetchAllRowsForIds([], async () => {
      calls += 1;
      return { data: [], error: null };
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ data: [], error: null });
  });
});
