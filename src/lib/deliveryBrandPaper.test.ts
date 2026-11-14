import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pages, read } = vi.hoisted(() => ({
  pages: { rows: [] as Array<Record<string, unknown>>, failFrom: -1, ranges: [] as number[] },
  read: {
    status: 'completed',
    lines: [{ delivery_item_id: 'di1', order_item_id: 'oi1', product_id: 'p1', quantity: 5,
      quantity_delivered: 5, picks: [{ id: 'pk1', brand_name: 'Alpha', epa_registration: '1-1', quantity: 5, review_state: null }] }],
  },
}));

vi.mock('./db', () => ({
  assertRpcResult: (data: unknown) => data,
  supabaseUntyped: {
    rpc: () => Promise.resolve({ data: read, error: null }),
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        order: () => query,
        range: (from: number, to: number) => {
          pages.ranges.push(from);
          return Promise.resolve(from === pages.failFrom
            ? { data: null, error: { message: 'event page unavailable' }, count: null }
            : { data: pages.rows.slice(from, to + 1), error: null, count: pages.rows.length });
        },
      };
      return query;
    },
  },
}));

import { loadDeliveryBrandInfo } from './deliveryBrandPaper';

describe('delivery brand paper event read', () => {
  beforeEach(() => {
    pages.ranges = [];
    pages.failFrom = -1;
    pages.rows = [
      { seq: 1, event_type: 'completed', details: { picks_confirmed: false }, before_rows: [], after_rows: [] },
      ...Array.from({ length: 999 }, (_, i) => ({ seq: i + 2, event_type: 'corrected', details: null, before_rows: [], after_rows: [] })),
      { seq: 1001, event_type: 'corrected', details: null, before_rows: [], after_rows: [{ delivery_item_id: 'di1' }] },
    ];
  });

  it('includes a correction after the first capped page', async () => {
    const info = await loadDeliveryBrandInfo('d1');
    expect(pages.ranges).toContain(1000);
    expect(info.get('di1')?.brands).toEqual([{ name: 'Alpha', epa_registration: '1-1', quantity: 5 }]);
  });

  it('fails the paper when a later event page fails', async () => {
    pages.failFrom = 1000;
    await expect(loadDeliveryBrandInfo('d1')).rejects.toMatchObject({ message: 'event page unavailable' });
  });
});
