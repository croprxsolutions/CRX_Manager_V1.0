import { describe, expect, it } from 'vitest';
import { computeLoaderWorksheet, type LoaderProductInput } from './loaderWorksheet';
import { loaderGroupWeightText, loaderLoadWeights, loaderWeightCaption, sourceAmount, type LoaderProductWeights, type LoaderSourceLine } from './loaderWeights';
import type { JobLoaderWorksheetWeight, WeightUnitFactors } from '../types';

// Hand-checked values from the DM-2 build sheet, section 4.3.
const units: WeightUnitFactors = {
  factors: { lb: { kind: 'weight', factor: 1 }, gal: { kind: 'volume', factor: 1 }, qt: { kind: 'volume', factor: 0.25 } },
  ambiguous: [],
};
const density = (lb: number) => ({ kind: 'density' as const, lb_per_unit: lb, per_unit: 'Gal' });
const savedRow = (over: Partial<JobLoaderWorksheetWeight>) => ({
  worksheet_id: 'w1', product_id: 'p1', job_id: 'j1', product_name: 'TEST Liquid', product_form: 'liquid', weight_kind: 'density',
  value_id: 'v1', value_reviewed_at: 't', value_reviewed_by: 'u', lb_per_unit: 8, per_unit: 'Gal', unit_factors: units, source: 'sds',
  value_basis: {}, none_reason: null, pack_generation: null, member_generation: 0, identity_generation: 0, captured_at: 't', ...over,
}) as JobLoaderWorksheetWeight;

interface Line { id: string; product_id: string | null; name?: string; quantity: unknown; unit: string; form?: string }
const plan = (lines: Line[], over: { acres?: number; capacity?: number; perLoadAcres?: number[] } = {}) => {
  const products: LoaderProductInput[] = lines.map((line) => {
    const amount = sourceAmount(line.name ?? 'TEST Liquid', line.quantity);
    return { product_name: line.name ?? 'TEST Liquid', total_quantity: 'value' in amount ? amount.value : null, unit: line.unit,
      product_id: line.product_id, product_form: line.form ?? 'liquid', source_line_id: line.id };
  });
  const ws = computeLoaderWorksheet({ total_acres: over.acres ?? 30, carrier_rate_gpa: 10, tank_capacity: over.capacity ?? 100,
    perLoadAcresOverride: over.perLoadAcres, products });
  const sources: LoaderSourceLine[] = lines.map(({ id, product_id, quantity, unit }) => ({ id, product_id, quantity, unit }));
  return { ws, sources };
};
const weigh = (lines: Line[], weights: Record<string, LoaderProductWeights>, over = {}) => {
  const { ws, sources } = plan(lines, over);
  return { ws, result: loaderLoadWeights(ws, weights, units, sources) };
};
const lbOf = (cell: { weight: unknown }) => (cell.weight as { lb: number }).lb;

describe('loaderLoadWeights', () => {
  it('weighs each load\'s printed amount: 0.3 Gal over three loads prints 0.1 and weighs 0.83454 lb each', () => {
    const { result } = weigh([{ id: 'l1', product_id: 'p1', quantity: 0.3, unit: 'Gal' }], { p1: { current: density(8.3454) } });
    for (const load of result.loads) {
      expect(load.cells[0].amountCell).toBe('0.1');
      expect(lbOf(load.cells[0])).toBeCloseTo(0.83454, 10);
    }
  });

  it('splits 100 acres as 49.995 and 50.005 with weights that follow the printed amounts, unflagged', () => {
    const { result } = weigh([{ id: 'l1', product_id: 'p1', quantity: 100, unit: 'Lb', form: 'dry' }],
      { p1: { current: { kind: 'none', none_reason: 'no_approved_weight' } } }, { acres: 100, capacity: 600, perLoadAcres: [49.995, 50.005] });
    expect(result.loads.map((load) => lbOf(load.cells[0]))).toEqual([49.995, 50.005]);
    expect(result.loads[1].totalText).toBe('Product weight: 50.01 lb');
  });

  it('flags rounding that moves a load more than 1%, on every load, and withholds every load total', () => {
    const lines: Line[] = [{ id: 'l1', product_id: 'p1', quantity: 0.0002, unit: 'Gal' }, { id: 'l2', product_id: 'p2', name: 'TEST Dry', quantity: 10, unit: 'Lb', form: 'dry' }];
    const { ws, result } = weigh(lines, { p1: { current: density(8) }, p2: { current: { kind: 'none', none_reason: 'no_approved_weight' } } });
    expect(ws.loads.map((load) => load.products[0].amount)).toEqual([0.0001, 0.0001, 0]);
    for (const load of result.loads) {
      expect(load.cells[0].amountCell).toBe('TEST Liquid: amount too small to print accurately per load (job total 0.0002)');
      expect(load.totalText).toBe('Product weight not shown: TEST Liquid: amount too small to print accurately per load');
    }
  });

  it('flags a tiny amount on one load, rounded up or to zero', () => {
    for (const quantity of [0.00005, 0.00004]) {
      const { result } = weigh([{ id: 'l1', product_id: 'p1', quantity, unit: 'Gal' }], { p1: { current: density(8) } }, { acres: 10 });
      expect(result.loads[0].cells[0].amountCell).toMatch(/amount too small to print accurately per load/);
    }
  });

  it('refuses bad source amounts by name in the amount cell, never printing 0, a negative or Infinity', () => {
    const cases: Array<[unknown, string]> = [
      [Number.NaN, 'TEST Liquid has an invalid amount'], [Infinity, "TEST Liquid's amount is too large to weigh"],
      [-2, 'TEST Liquid has a negative amount'], ['2abc', "TEST Liquid's amount is not a number"],
      [1e308, "TEST Liquid's amount is too large to print"],
    ];
    for (const [quantity, reason] of cases) {
      const { result } = weigh([{ id: 'l1', product_id: 'p1', quantity, unit: 'Lb' }], { p1: { current: density(8) } });
      expect(result.loads.map((load) => load.cells[0].amountCell)).toEqual([reason, reason, reason]);
      expect(result.loads[2].totalText).toBe(`Product weight not shown: ${reason}`);
    }
  });

  it('refuses and weighs two lines of one product line by line', () => {
    const { result } = weigh([{ id: 'l1', product_id: 'p1', quantity: 3, unit: 'Gal' }, { id: 'l2', product_id: 'p1', quantity: 'x', unit: 'Gal' }],
      { p1: { current: density(8) } });
    expect(lbOf(result.loads[0].cells[0])).toBe(8);
    expect(result.loads[0].cells[1].amountCell).toBe("TEST Liquid's amount is not a number");
  });

  it('refuses an unlinked line\'s weight but still prints its amount', () => {
    const { result } = weigh([{ id: 'l1', product_id: null, name: 'Product', quantity: 3, unit: 'Gal' }], {});
    expect(result.loads[0].cells[0].amountCell).toBe('1');
    expect(result.loads[0].cells[0].weightText).toBe('Product is not linked to a product, so it has no weight');
  });

  it('uses the saved weight, marks a product weighed at its current weight, and keeps a none row for its unit map', () => {
    const lines: Line[] = [{ id: 'l1', product_id: 'p1', quantity: 3, unit: 'Gal' }, { id: 'l2', product_id: 'p2', name: 'TEST New', quantity: 3, unit: 'Gal' },
      { id: 'l3', product_id: 'p3', name: 'TEST Lb', quantity: 6, unit: 'Lb' }];
    const { result } = weigh(lines, {
      p1: { saved: savedRow({}), current: density(10) },
      p2: { current: density(9) },
      p3: { saved: savedRow({ product_id: 'p3', weight_kind: 'none', none_reason: 'no_parent', value_id: null, lb_per_unit: null, per_unit: null }), current: density(9) },
    });
    const [saved, current, noneRow] = result.loads[0].cells;
    expect([lbOf(saved), saved.mark]).toEqual([8, 'saved']);
    expect([lbOf(current), current.mark]).toEqual([9, 'current']);
    expect([lbOf(noneRow), noneRow.mark]).toEqual([2, 'saved']);
    expect(result.anyCurrent).toBe(true);
    expect(loaderWeightCaption(true, result.anyCurrent)).toBe('Weights saved with this worksheet, except lines marked current');
  });

  it('accepts plain decimals written as .5 or 1.', () => {
    expect(sourceAmount('TEST Liquid', '.5')).toEqual({ value: 0.5 });
    expect(sourceAmount('TEST Liquid', '1.')).toEqual({ value: 1 });
    expect(sourceAmount('TEST Liquid', '.')).toEqual({ reason: "TEST Liquid's amount is not a number" });
  });

  it('weighs the last load residual as printed (4 decimals), not its unrounded value', () => {
    const { result } = weigh([{ id: 'l1', product_id: 'p1', quantity: 100.00004, unit: 'Gal' }], { p1: { current: density(10) } });
    const last = result.loads[2].cells[0];
    expect(lbOf(last)).toBeCloseTo(Number(last.amountCell.replace(/,/g, '')) * 10, 10);
  });

  it('says so when a current weight could not be read', () => {
    const { result } = weigh([{ id: 'l1', product_id: 'p1', quantity: 3, unit: 'Gal' }], {});
    expect(result.loads[0].cells[0].weightText).toBe('TEST Liquid: weights unavailable');
    expect(result.loads[0].cells[0].mark).toBeNull();
    expect(result.anyCurrent).toBe(false);
  });
});

describe('loaderGroupWeightText', () => {
  const cell = (lb: number) => ({ amountCell: '10', weight: { lb }, weightText: `${lb.toFixed(2)} lb`, mark: null });
  const load = (lb: number) => ({ cells: [cell(lb)], totalText: `Product weight: ${lb.toFixed(2)} lb`, totalLb: lb });
  const weights = { loads: [load(80), load(80.01), load(80)], anyCurrent: false };

  it('shows one weight when every load in a condensed group weighs the same', () => {
    expect(loaderGroupWeightText(weights, [0, 2], 0)).toBe('80.00 lb');
    expect(loaderGroupWeightText(weights, [0, 2], 'total')).toBe('Product weight: 80.00 lb');
  });

  it('shows lowest to highest when grouped loads differ, never the first load\'s weight for all', () => {
    expect(loaderGroupWeightText(weights, [1, 0, 2], 0)).toBe('80.00–80.01 lb');
    expect(loaderGroupWeightText(weights, [0, 1, 2], 'total')).toBe('Product weight: 80.00–80.01 lb');
  });

  it('lists differing reasons instead of a range when a load has no weight', () => {
    const withheld = { loads: [load(80), { cells: [cell(80)], totalText: 'Product weight not shown: X', totalLb: null }], anyCurrent: false };
    expect(loaderGroupWeightText(withheld, [0, 1], 'total')).toBe('Product weight: 80.00 lb; Product weight not shown: X');
  });
});
