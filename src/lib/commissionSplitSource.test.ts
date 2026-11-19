import { describe, expect, it } from 'vitest';
import { customerSplit, sameSplit } from './commissionSplitSource';
import type { CommissionSplit } from '../types';

const s = (...rows: Array<[string, number]>): CommissionSplit => ({ splits: rows.map(([recipient, percentage]) => ({ recipient, percentage })) });

describe('customerSplit', () => {
  it('takes a well-formed split, and an empty one as "no commission"', () => {
    expect(customerSplit(s(['A', 60], ['B', 40]))).toEqual(s(['A', 60], ['B', 40]));
    expect(customerSplit({ splits: [] })).toEqual({ splits: [] });
  });

  it('treats a damaged stored split as never set, so picking the customer cannot throw (Sol HIGH, 19 Nov)', () => {
    for (const bad of [
      { splits: [null] },
      { splits: ['A'] },
      { splits: [{ recipient: 'A' }] },
      { splits: [{ recipient: 7, percentage: 100 }] },
      { splits: [{ recipient: 'A', percentage: Number.NaN }] },
      { splits: [{ recipient: 'A', percentage: '100' }] },
      { splits: [{ recipient: 'A', percentage: -10 }, { recipient: 'B', percentage: 110 }] },
      { splits: [{ recipient: 'A', percentage: 60 }, { recipient: 'B', percentage: 30 }] },
      { splits: [{ recipient: ' ', percentage: 100 }] },
      { splits: [{ recipient: 'A', percentage: 60 }, { recipient: 'B', percentage: 40.004 }] },
      { splits: 'A' },
      null,
      undefined,
    ]) {
      expect(customerSplit(bad as unknown as CommissionSplit)).toBeNull();
    }
  });
});

describe('sameSplit', () => {
  it('ignores row order: the same people at the same percentages is the same split (Sol LOW)', () => {
    expect(sameSplit(s(['A', 60], ['B', 40]), s(['B', 40], ['A', 60]))).toBe(true);
  });

  it('differs on any recipient or percentage', () => {
    expect(sameSplit(s(['A', 60], ['B', 40]), s(['A', 61], ['B', 39]))).toBe(false);
    expect(sameSplit(s(['A', 60], ['B', 40]), s(['A', 60], ['C', 40]))).toBe(false);
    expect(sameSplit(s(['A', 100]), s(['A', 100], ['B', 0]))).toBe(false);
  });
});
