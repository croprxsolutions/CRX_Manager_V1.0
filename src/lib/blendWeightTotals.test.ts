import { describe, expect, it } from 'vitest';
import { validateBlendMath } from './blendMathValidator';
import type { MappedLine, WeightTotalOptions } from './blendWeightTotals';
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

  it('still flags overfill from a left-out row whose gallons are known (30 Gal unlinked in a 20 Gal tank)', () => {
    expect(check(20, 'Gal', [liquid({ product_name: 'TEST U', product_id: null, quantity: 30 })])).toEqual([{ level: 'mismatch',
      message: "The products add up to at least 30.00 gal, which is more than the total volume of 20 gal. A tank can't hold more product than its total. Counted by volume only, or left out: TEST U is not linked to a product." }]);
  });

  it('says a zero total in a unit it cannot use is not checked', () => {
    expect(check(0, 'Ea', [liquid({ quantity: 10 })])[0].message).toBe('Total not checked: ea is a count, not a weight or volume');
  });
});

describe('blank header unit with a map', () => {
  it('stops the legacy comparison when a line amount is unusable', () => {
    expect(validateBlendMath(header(10, ''), [{ product_name: 'TEST A', quantity: Number.NaN, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null }],
      { headerUnits: units, lines: [line({ quantity: Number.NaN })] })).toEqual([{ level: 'unchecked', message: 'Total not checked: TEST A has an invalid amount' }]);
  });

  it('otherwise keeps the legacy comparison', () => {
    const products = [{ product_name: 'TEST A', quantity: 10, unit: null, rate_per_acre: null, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null }];
    expect(validateBlendMath(header(30, ''), products, { headerUnits: units, lines: [line({})] })[0].level).toBe('mismatch');
  });
});

describe('weights unavailable or still loading', () => {
  const lbLine = { product_name: 'TEST A', quantity: 90, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null,
    product_form: 'dry', product_rate_unit: null, product_inventory_unit: null };

  it('never reports a weight total as checked when weights are unavailable', () => {
    expect(validateBlendMath(header(100, 'Lb'), [lbLine], { unavailable: true, lines: [line({ quantity: 90 })] }))
      .toEqual([{ level: 'unchecked', message: 'Total weight not checked: weights unavailable' }]);
    expect(validateBlendMath(header(100, 'MG'), [lbLine], { unavailable: true, lines: [line({ quantity: 90 })] })[0].message)
      .toBe('Total weight not checked: weights unavailable');
  });

  it('keeps the spray-tank check and still refuses a bad amount when weights are unavailable', () => {
    const gal = { ...lbLine, quantity: 20, unit: 'Gal', product_form: 'liquid' };
    expect(validateBlendMath(header(10, 'Gal'), [gal], { unavailable: true, lines: [line({ quantity: 20, unit: 'Gal' })] }))
      .toEqual(validateBlendMath(header(10, 'Gal'), [gal]));
    expect(validateBlendMath(header(8, ''), [], { unavailable: true, lines: [line({ quantity: 10 }), line({ product_name: 'TEST B', quantity: -2 })] }))
      .toEqual([{ level: 'unchecked', message: 'Total not checked: TEST B has a negative amount' }]);
  });

  it('runs the existing checks unchanged while weights load, so a tank overfill still warns', () => {
    const gal = { ...lbLine, quantity: 200, unit: 'Gal', product_form: 'liquid' };
    const legacy = validateBlendMath(header(100, 'Gal'), [gal]);
    expect(legacy.length).toBeGreaterThan(0);
    expect(validateBlendMath(header(100, 'Gal'), [gal], { loading: true })).toEqual(legacy);
  });
});

// Invariant (Sol HIGHs on #1627, twice): a spray tank the legacy check flags as overfilled stays flagged when a
// screen passes weights, in every weights situation. A new situation is one row.
describe('invariant: a legacy tank overfill is never dropped by the weights check', () => {
  const liquid = (over: Partial<MappedLine>) => line({ form: 'liquid', unit: 'Gal', quantity: 30, ...over });
  const current: WeightUnitFactors = { factors: { ...units.factors }, ambiguous: [] }; // knows no Pt
  const snapshot: WeightUnitFactors = { factors: { ...units.factors, pt: { kind: 'volume', factor: 0.125 } }, ambiguous: [] };
  type Row = [situation: string, lines: MappedLine[], weights: (lines: MappedLine[]) => WeightTotalOptions];
  const mapped = (headerUnits: WeightUnitFactors | null) => (lines: MappedLine[]) => ({ headerUnits, lines });
  const rows: Row[] = [
    ['loading', [liquid({})], () => ({ loading: true })],
    ['unavailable', [liquid({})], (lines) => ({ unavailable: true, lines })],
    ['mapped, linked liquid line', [liquid({})], mapped(units)],
    ['unlinked line', [liquid({ product_id: null })], mapped(units)],
    ['dry Lb line beside an overfilling liquid line', [line({ product_name: 'TEST Dry' }), liquid({})], mapped(units)],
    ['formless line', [liquid({ form: null })], mapped(units)],
    ['line read through its saved snapshot map', [liquid({ quantity: 200, unit: 'Pt', rowUnits: snapshot })], mapped(current)],
    ['saved ticket whose unit basis was never recorded', [liquid({})], mapped(null)],
    ['saved line with no recorded weight (empty line map)', [liquid({ rowUnits: { factors: {}, ambiguous: [] } })], mapped(units)],
    ['a weights mismatch that is not the overfill (map reads gal as a weight)', [liquid({})],
      mapped({ factors: { ...units.factors, gal: { kind: 'weight', factor: 1 } }, ambiguous: [] })],
  ];
  // 30 Gal (or 200 Pt = 25 Gal) of product in a 20 Gal (80 Qt) tank.
  const headers: [total: number, unit: string][] = [[20, 'Gal'], [80, 'Qt']];

  it.each(rows.flatMap(([situation, lines, weights]) => headers.map(([total, unit]) => [situation, unit, total, lines, weights] as const)))(
    '%s, %s header', (_situation, unit, total, lines, weights) => {
      const products = lines.map((l) => ({ product_name: l.product_name, quantity: l.quantity as number, unit: l.unit,
        rate_per_acre: null, rate_per_acre_unit: null, product_form: l.form, product_rate_unit: null, product_inventory_unit: null }));
      const overfill = (w: { level: string; message: string }[]) =>
        w.some((x) => x.level === 'mismatch' && x.message.includes("A tank can't hold more product"));
      expect(overfill(validateBlendMath(header(total, unit), products))).toBe(true); // the legacy check flags it
      expect(overfill(validateBlendMath(header(total, unit), products, weights(lines)))).toBe(true);
    });
});

describe('plain oz total with weights', () => {
  it('keeps the mapped result and adds no legacy overfill for a dry line (oz may be a weight)', () => {
    const oz: WeightUnitFactors = { factors: { ...units.factors, oz: { kind: 'volume', factor: 0.0078125 } }, ambiguous: [] };
    const products = [{ product_name: 'TEST A', quantity: 1, unit: 'Lb', rate_per_acre: null, rate_per_acre_unit: null,
      product_form: 'dry', product_rate_unit: null, product_inventory_unit: null }];
    const result = validateBlendMath(header(10, 'oz'), products, { headerUnits: oz, lines: [line({ quantity: 1 })] });
    expect(result.some((w) => w.message.includes("A tank can't hold more product"))).toBe(false);
  });
});

describe('per-acre total unit with weights', () => {
  it('adds no legacy overfill when the total unit is a rate (Gal/ac)', () => {
    const products = [{ product_name: 'TEST A', quantity: 30, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null,
      product_form: 'liquid', product_rate_unit: null, product_inventory_unit: null }];
    const result = validateBlendMath({ ...header(20, 'Gal/ac'), total_acres: 10 }, products,
      { headerUnits: units, lines: [line({ form: 'liquid', unit: 'Gal', quantity: 30 })] });
    expect(result.some((w) => w.message.includes("A tank can't hold more product"))).toBe(false);
  });
});
