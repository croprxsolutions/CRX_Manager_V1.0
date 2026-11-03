import { describe, expect, it } from 'vitest';
import { applyLabelCorrections, findLabelCorrections, type LabelCorrectionRow, type ProductLabelValues } from './jobLabelCorrections';

const row: LabelCorrectionRow = {
  product_id: 'product-1', product_name: 'Atrazine 4L', rei_hours: '12', phi_days: '30',
};

function labels(rei_hours: number | null, phi_days: number | null) {
  return new Map<string, ProductLabelValues>([['product-1', { rei_hours, phi_days }]]);
}

describe('findLabelCorrections', () => {
  it('offers nothing when both values match', () => {
    expect(findLabelCorrections([row], labels(12, 30))).toEqual([]);
  });

  it('offers one correction for a different REI', () => {
    expect(findLabelCorrections([row], labels(24, 30))).toEqual([
      { rowIndex: 0, product_name: 'Atrazine 4L', field: 'rei_hours', jobValue: '12', productValue: 24 },
    ]);
  });

  it('orders both corrections by row then REI before PHI', () => {
    expect(findLabelCorrections([row, { ...row, rei_hours: '10' }], labels(24, 45))).toEqual([
      { rowIndex: 0, product_name: 'Atrazine 4L', field: 'rei_hours', jobValue: '12', productValue: 24 },
      { rowIndex: 0, product_name: 'Atrazine 4L', field: 'phi_days', jobValue: '30', productValue: 45 },
      { rowIndex: 1, product_name: 'Atrazine 4L', field: 'rei_hours', jobValue: '10', productValue: 24 },
      { rowIndex: 1, product_name: 'Atrazine 4L', field: 'phi_days', jobValue: '30', productValue: 45 },
    ]);
  });

  it('skips blank job values and keeps filled-in text as entered after trimming', () => {
    expect(findLabelCorrections([{ ...row, rei_hours: '  ', phi_days: ' invalid ' }], labels(12, 30)))
      .toMatchObject([{ field: 'phi_days', jobValue: 'invalid' }]);
  });

  it('does not offer a blank product value', () => {
    expect(findLabelCorrections([row], labels(null, 30))).toEqual([]);
  });

  it('does not offer a product missing from the map', () => {
    expect(findLabelCorrections([row], new Map())).toEqual([]);
  });

  it('does not offer an empty product id', () => {
    expect(findLabelCorrections([{ ...row, product_id: '' }], labels(24, 45))).toEqual([]);
  });

  it.each(['12.0', '1.2e1', '12abc'])('offers %s against the exact integer text 12', (rei_hours) => {
    expect(findLabelCorrections([{ ...row, rei_hours }], labels(12, 30)))
      .toMatchObject([{ field: 'rei_hours', jobValue: rei_hours, productValue: 12 }]);
  });

  it('does not offer 12 against 12', () => {
    expect(findLabelCorrections([{ ...row, rei_hours: '12' }], labels(12, 30))).toEqual([]);
  });

  it('ignores non-finite product values', () => {
    expect(findLabelCorrections([row], labels(Number.NaN, Number.POSITIVE_INFINITY))).toEqual([]);
  });
});

describe('applyLabelCorrections', () => {
  it('changes only listed fields and keeps untouched rows by identity', () => {
    const first = { ...row, quantity: '8' };
    const second = { ...row, product_id: 'product-2', quantity: '5' };
    const rows = [first, second];
    const corrections = findLabelCorrections(rows, labels(24, 30));
    const next = applyLabelCorrections(rows, corrections);

    expect(next).not.toBe(rows);
    expect(next[0]).toEqual({ ...first, rei_hours: '24' });
    expect(next[0]).not.toBe(first);
    expect(next[1]).toBe(second);
    expect(rows[0]).toBe(first);
    expect(first.rei_hours).toBe('12');
  });
});
