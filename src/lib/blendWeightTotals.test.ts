import { describe, expect, it } from 'vitest';
import { validateBlendMath } from './blendMathValidator';
import type { MappedLine } from './blendWeightTotals';
import type { WeightUnitFactors } from '../types';

// DM-2 sheet 4.1/4.4: the ticket total checked through the unit map and line weights.
const units: WeightUnitFactors = {
  factors: { lb: { kind: 'weight', factor: 1 }, mg: { kind: 'weight', factor: 0.0000022046225 },
    gal: { kind: 'volume', factor: 1 }, qt: { kind: 'volume', factor: 0.25 }, ea: { kind: 'count', factor: 1 } },
  ambiguous: ['fl'],
};
const header = (total: number | null, unit: string) => ({ total_acres: null, total_volume: total, total_volume_unit: unit, application_rate: null });
const line = (over: Partial<MappedLine>): MappedLine => ({ product_name: 'TEST A', product_id: 'p1', quantity: 10, unit: 'Lb', form: 'dry',
  weightLb: { lb: 10 }, rowUnits: units, ...over });
const check = (total: number | null, unit: string, lines: MappedLine[], headerUnits: WeightUnitFactors | null = units) =>
  validateBlendMath(header(total, unit), [], { headerUnits, lines });

describe('mapped ticket total (weight header)', () => {
  it('passes when the line weights add up, and flags a mismatch', () => {
    expect(check(10, 'Lb', [line({})])).toEqual([]);
    expect(check(20, 'Lb', [line({})])).toEqual([{ level: 'mismatch',
      message: "Total weight (20 lb) doesn't match the products, which add up to 10.00 lb" }]);
  });

  it('checks a zero header instead of skipping it', () => {
    expect(check(0, 'Lb', [line({})])[0].level).toBe('mismatch');
  });

  it('says so when there is nothing to add up', () => {
    expect(check(100, 'Lb', [])).toEqual([{ level: 'unchecked', message: 'Total weight not checked: no product amounts to add up' }]);
  });

  it('withholds the check, by name, for a line with no weight', () => {
    expect(check(10, 'Lb', [line({}), line({ product_name: 'TEST B', weightLb: { refused: true, reason: 'TEST B has no approved weight yet' } })]))
      .toEqual([{ level: 'unchecked', message: 'Total weight not checked: TEST B has no approved weight yet' }]);
  });

  it('refuses a negative or non-number total and an overflowing sum', () => {
    expect(check(-5, 'Lb', [line({})])[0].message).toBe('Total weight not checked: the total is negative');
    expect(check(Number.NaN, 'Lb', [line({})])[0].message).toBe('Total weight not checked: the total is not a number');
    expect(check(10, 'Lb', [line({ weightLb: { lb: 1e308 } }), line({ weightLb: { lb: 1e308 } })])[0].message)
      .toBe('Total weight not checked: the total is too large to weigh');
  });

  it('names a header unit the map cannot use', () => {
    expect(check(10, 'fl', [line({})])[0].message).toBe('Total not checked: fl has conflicting entries in the unit table');
    expect(check(10, 'Ea', [line({})])[0].message).toBe('Total not checked: ea is a count, not a weight or volume');
    expect(check(10, 'kg', [line({})])[0].message).toBe('Total weight not checked: kg is not in the unit table');
    expect(check(10, 'Lb', [line({})], null)[0].message).toBe("Total weight not checked: this ticket's unit basis was not recorded");
  });
});

describe('mapped ticket total (spray tank)', () => {
  const liquid = (over: Partial<MappedLine>) => line({ form: 'liquid', unit: 'Gal', ...over });

  it('passes under the tank and flags products over it, in the header unit', () => {
    expect(check(100, 'Gal', [liquid({ quantity: 10 }), liquid({ quantity: 8, unit: 'Qt' })])).toEqual([]);
    expect(check(1, 'Gal', [liquid({ quantity: 8, unit: 'Qt' })])[0]).toEqual({ level: 'mismatch',
      message: "The products add up to 2.00 gal, which is more than the total volume of 1 gal. A tank can't hold more product than its total." });
  });

  it('refuses a negative liquid line instead of subtracting it', () => {
    expect(check(100, 'Gal', [liquid({ quantity: -2 })])).toEqual([{ level: 'unchecked', message: 'Total volume not checked: TEST A has a negative amount' }]);
  });

  it('names dry and unlinked rows it could not count', () => {
    expect(check(100, 'Gal', [liquid({}), line({ product_name: 'TEST Dry' }), liquid({ product_name: 'TEST U', product_id: null })]))
      .toEqual([{ level: 'unchecked', message: 'Total volume not checked: TEST Dry is dry; TEST U is not linked to a product' }]);
  });
});

describe('blank header unit with a map', () => {
  it('stops the legacy comparison when a line amount is unusable', () => {
    expect(validateBlendMath(header(10, ''), [{ product_name: 'TEST A', quantity: Number.NaN, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null }],
      { headerUnits: units, lines: [line({ quantity: Number.NaN })] })).toEqual([{ level: 'unchecked', message: 'Total not checked: TEST A has an invalid amount' }]);
  });

  it('otherwise keeps the legacy comparison', () => {
    const products = [{ product_name: 'TEST A', quantity: 10, unit: null, rate_per_acre: null, rate_per_acre_unit: null }];
    expect(validateBlendMath(header(30, ''), products, { headerUnits: units, lines: [line({})] })[0].level).toBe('mismatch');
  });
});
