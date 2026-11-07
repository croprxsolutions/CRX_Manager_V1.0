import { describe, expect, it } from 'vitest';
import { formatLb, lbToUnit, lineWeightLb, sumWeights, type WeighLine } from './weightMath';
import type { WeightUnitFactors } from '../types';

// Hand-checked values from the DM-2 build sheet, section 4.1.
const units: WeightUnitFactors = {
  factors: {
    lb: { kind: 'weight', factor: 1 }, 'dry oz': { kind: 'weight', factor: 0.0625 },
    g: { kind: 'weight', factor: 0.0022046225 }, mg: { kind: 'weight', factor: 0.0000022046225 },
    gal: { kind: 'volume', factor: 1 }, qt: { kind: 'volume', factor: 0.25 }, oz: { kind: 'volume', factor: 0.0078125 },
    ea: { kind: 'count', factor: 1 }, unit: { kind: 'count', factor: 1 },
  },
  ambiguous: ['fl'],
};
const density = { kind: 'density' as const, lb_per_unit: 8.3454, per_unit: 'Gal' };
const pack = { kind: 'net_weight' as const, lb_per_unit: 5, per_unit: 'Ea' };
const line = (over: Partial<WeighLine>): WeighLine => ({ name: 'TEST Prod', quantity: 1, unit: 'Lb', form: 'liquid', weight: density, ...over });
const lb = (over: Partial<WeighLine>) => {
  const result = lineWeightLb(line(over), units);
  if (!('lb' in result)) throw new Error(result.reason);
  return result.lb;
};
const reason = (over: Partial<WeighLine>) => {
  const result = lineWeightLb(line(over), units);
  return 'reason' in result ? result.reason : `weighed ${result.lb}`;
};

describe('lineWeightLb', () => {
  it('weighs volume lines of a liquid through its density', () => {
    expect(lb({ quantity: 2.5, unit: 'Gal' })).toBeCloseTo(20.8635, 10);
    expect(lb({ quantity: 32, unit: 'Oz' })).toBeCloseTo(2.08635, 10);
  });

  it('reads weight units directly, whatever the case, with no stored weight', () => {
    for (const unit of ['LB', 'Lb', 'lb']) expect(lb({ unit })).toBe(1);
    expect(lb({ quantity: 5, weight: { kind: 'none', none_reason: 'no_parent' } })).toBe(5);
    expect(lb({ quantity: 50, form: 'dry', weight: null })).toBe(50);
    expect(lb({ quantity: 24, unit: 'Dry oz', form: 'dry' })).toBe(1.5);
    expect(lb({ quantity: 1_000_000, unit: 'MG', form: 'dry' })).toBeCloseTo(2.2046225, 10);
  });

  it('weighs count lines of a dry pack by its net weight', () => {
    expect(lb({ quantity: 3, unit: 'Ea', form: 'dry', weight: pack })).toBe(15);
    expect(lb({ quantity: 2, unit: 'Unit', form: 'dry', weight: pack })).toBe(10);
  });

  it('refuses, by name, every line it cannot weigh', () => {
    expect(reason({ unit: 'Oz', form: 'dry', weight: pack })).toBe('TEST Prod is dry but recorded in Oz, a volume unit');
    expect(reason({ unit: 'Ea', form: 'dry', weight: { kind: 'unit_weight', lb_per_unit: 1, per_unit: 'Lb' } }))
      .toBe('TEST Prod is stocked in Lb; record it in Lb');
    expect(reason({ unit: 'Ea' })).toBe('TEST Prod is a liquid recorded in Ea; record it in a volume unit');
    expect(reason({ unit: 'Gal', weight: { kind: 'none', none_reason: 'no_approved_weight' } })).toBe('TEST Prod has no approved weight yet');
    expect(reason({ unit: 'Gal', weight: { kind: 'none', none_reason: 'no_parent' } })).toBe('put TEST Prod in a parent to record its weight');
    expect(reason({ unit: 'Bushel' })).toBe("TEST Prod's unit Bushel isn't in the unit table");
    expect(reason({ unit: 'fl' })).toBe("TEST Prod's unit fl has conflicting entries in the unit table");
    expect(reason({ unit: ' ' })).toBe('TEST Prod has no unit recorded');
  });

  it('refuses before the unit for seed, unlinked, not recorded and blank-form lines', () => {
    expect(reason({ form: 'seed' })).toBe("weight isn't tracked for seed or each products");
    expect(reason({ weight: { kind: 'none', none_reason: 'unlinked' } })).toBe('TEST Prod is not linked to a product, so it has no weight');
    expect(reason({ weight: { kind: 'none', none_reason: 'not_recorded' } })).toBe("TEST Prod's weight was not recorded for this ticket");
    expect(reason({ quantity: 5, form: null })).toBe('TEST Prod has no form set');
  });

  it('refuses bad amounts instead of counting them', () => {
    expect(reason({ quantity: Number.NaN })).toBe('TEST Prod has an invalid amount');
    expect(reason({ quantity: '2' })).toBe('TEST Prod has an invalid amount');
    expect(reason({ quantity: -2 })).toBe('TEST Prod has a negative amount');
    expect(reason({ quantity: Infinity })).toBe("TEST Prod's amount is too large to weigh");
    expect(reason({ quantity: 1e308, unit: 'Gal' })).toBe("TEST Prod's amount is too large to weigh");
  });
});

describe('sumWeights, lbToUnit and formatLb', () => {
  it('sums only contributing lines and never gives a partial total', () => {
    expect(sumWeights([])).toEqual({ lb: 0, contributing: 0 });
    expect(sumWeights([{ quantity: 2, weight: { lb: 2 } }, { quantity: 0, weight: { refused: true, reason: 'x' } }])).toEqual({ lb: 2, contributing: 1 });
    expect(sumWeights([{ quantity: 2, weight: { lb: 2 } }, { quantity: 1, weight: { refused: true, reason: 'B has no weight' } }]))
      .toEqual({ refused: true, reasons: ['B has no weight'] });
    expect(sumWeights([{ quantity: 1, weight: { lb: 1e308 } }, { quantity: 1, weight: { lb: 1e308 } }]))
      .toEqual({ refused: true, reasons: ['the total is too large to weigh'] });
  });

  it('converts pounds only to a weight unit, never to Infinity', () => {
    expect(lbToUnit(1.5, 'Dry oz', units)).toEqual({ value: 24 });
    expect(lbToUnit(1, 'Gal', units)).toEqual({ refused: true, reason: 'Gal is not a weight unit' });
    expect(lbToUnit(1e308, 'MG', units)).toEqual({ refused: true, reason: 'the total is too large to check' });
  });

  it('never shows a real weight as 0.00', () => {
    expect(formatLb(2.2046225)).toBe('2.20 lb');
    expect(formatLb(1000 * 0.0000022046225)).toBe('0.00220 lb');
    expect(formatLb(1234.5)).toBe('1,234.50 lb');
    expect(formatLb(0)).toBe('0 lb');
  });
});
