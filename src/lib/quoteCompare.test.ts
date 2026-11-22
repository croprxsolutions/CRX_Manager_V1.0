/**
 * quoteCompare.test.ts — KI-201. Quote Compare matched lines by product only, so a
 * product on two sections showed as one row. Lines now match by the saved line.
 */
import { describe, expect, it } from 'vitest';
import { pairCompareLines, type CompareLine } from './quoteCompare';

const line = (o: Partial<CompareLine>): CompareLine => ({
  product_id: 'p1', product_name: 'Roundup', section: 'Field A', price_per_unit: 24, total_price: 240, ...o,
});

describe('pairCompareLines (KI-201)', () => {
  it('keeps both rows when one product is on two sections and one line changes', () => {
    const version = [
      line({ line_id: 'q1', section: 'Field A', price_per_unit: 24 }),
      line({ line_id: 'q2', section: 'Field B', price_per_unit: 24 }),
    ];
    const current = [
      line({ line_id: 'q1', section: 'Field A', price_per_unit: 24 }),
      line({ line_id: 'q2', section: 'Field B', price_per_unit: 26 }),
    ];
    const rows = pairCompareLines(version, current);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.version?.section, r.current?.section])).toEqual([['Field A', 'Field A'], ['Field B', 'Field B']]);
    expect(rows[0].current?.price_per_unit).toBe(24);
    expect(rows[1].current?.price_per_unit).toBe(26);
  });

  it('shows a new line as added and a deleted one as removed', () => {
    const rows = pairCompareLines(
      [line({ line_id: 'q1' }), line({ line_id: 'q2', product_id: 'p2', product_name: 'Atrazine' })],
      [line({ line_id: 'q1' }), line({ line_id: 'new-1', section: 'Field B' })],
    );
    expect(rows.filter((r) => r.version && !r.current).map((r) => r.version?.product_name)).toEqual(['Atrazine']);
    expect(rows.filter((r) => !r.version && r.current).map((r) => r.current?.section)).toEqual(['Field B']);
  });

  it('pairs older versions (no saved line ids) by section and product, in order', () => {
    const version = [
      line({ section: 'Field A' }), line({ section: 'Field B' }), line({ section: 'Field B', total_price: 100 }),
    ];
    const current = [
      line({ line_id: 'q1', section: 'Field A' }), line({ line_id: 'q2', section: 'Field B' }), line({ line_id: 'q3', section: 'Field B', total_price: 100 }),
    ];
    const rows = pairCompareLines(version, current);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.version && r.current)).toBe(true);
    expect(rows[2].version?.total_price).toBe(100);
    expect(rows[2].current?.total_price).toBe(100);
  });
});
