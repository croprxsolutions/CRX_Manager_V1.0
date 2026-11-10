import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOpenWork } from './productParents';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('./db', () => ({
  supabaseUntyped: { rpc },
  assertRpcResult: <T,>(data: unknown) => data as T,
}));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

describe('loadOpenWork', () => {
  beforeEach(() => rpc.mockReset());

  it('checks every size in batches of 500, so open work on size 501 is still found', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `size-${i}`);
    const order = { product_id: 'size-500', kind: 'order', number: 'SO-1', message: 'Open order' };
    rpc
      .mockResolvedValueOnce({ data: { blockers: [], warnings: [{ product_id: 'size-0', kind: 'stock', number: null, message: 'Stock' }] }, error: null })
      .mockResolvedValueOnce({ data: { blockers: [order], warnings: [] }, error: null });
    const entries = await loadOpenWork(ids);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_product_ids).toHaveLength(500);
    expect(rpc.mock.calls[1][1].p_product_ids).toEqual(['size-500']);
    expect(entries).toEqual([order]);
  });

  it('asks nothing for no sizes', async () => {
    expect(await loadOpenWork([])).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});
