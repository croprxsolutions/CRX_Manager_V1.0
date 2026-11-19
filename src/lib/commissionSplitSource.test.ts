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
      { splits: [{ recipient: 'A', percentage: 0 }, { recipient: 'B', percentage: 100 }] },
      { splits: [{ recipient: 'A', percentage: 60 }, { recipient: 'B', percentage: 40.02 }] },
      { splits: [{ recipient: 'A', percentage: 60 }, { recipient: 'B', percentage: 40.0100000005 }] },
      // eslint-disable-next-line no-sparse-arrays
      { splits: [, { recipient: 'A', percentage: 100 }] },
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

  it('tells NaN and Infinity apart (Sol LOW)', () => {
    expect(sameSplit(s(['A', Number.NaN]), s(['A', Number.POSITIVE_INFINITY]))).toBe(false);
  });

  it('accepts exactly what the database accepts: each share above 0 and up to 100, totalling 100 within 0.01 (Sol MED)', () => {
    expect(customerSplit(s(['A', 33.333], ['B', 66.667]))).not.toBeNull();
    expect(customerSplit(s(['A', 33.33], ['B', 33.33], ['C', 33.33]))).not.toBeNull();
    expect(customerSplit(s(['A', 60], ['B', 40.004]))).not.toBeNull();
    expect(customerSplit(s(['A', 60], ['B', 40.01]))).not.toBeNull();
  });

  it('a recipient name can\'t fake another split through separators (Sol LOW)', () => {
    expect(sameSplit(s(['A', 0], ['B', 100]), s(['A\u00000\u0001B', 100]))).toBe(false);
  });

  it('differs on any recipient or percentage', () => {
    expect(sameSplit(s(['A', 60], ['B', 40]), s(['A', 61], ['B', 39]))).toBe(false);
    expect(sameSplit(s(['A', 60], ['B', 40]), s(['A', 60], ['C', 40]))).toBe(false);
    expect(sameSplit(s(['A', 100]), s(['A', 100], ['B', 0]))).toBe(false);
  });
});
