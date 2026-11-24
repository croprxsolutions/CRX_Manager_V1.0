import { describe, expect, it } from 'vitest';
import { computeLoaderWorksheet } from './loaderWorksheet';
import { fmtLoaderGallons, fmtLoaderWater, loaderPanelTankWater, loaderWater, loaderWaterNotes } from './loaderWorksheetWater';

const p = (product_name: string, amount: number, unit: string, product_form: string | null = 'liquid') =>
  ({ product_name, amount, unit, product_form });

describe('loaderWater', () => {
  it('subtracts liquid product gallons; dry products add no volume', () => {
    const w = loaderWater(300, [p('L1', 2, 'gal'), p('L2', 64, 'fl oz'), p('D1', 50, 'lb', 'dry'), p('S1', 3, 'each', 'each')]);
    expect(w).toEqual({ finished_gal: 300, water_gal: 297.5, over: false, unknown: [], unsized: [], missing: [], dry: true });
    expect(loaderWaterNotes(w)).toEqual(['Dry products are not counted as volume in water to add.']);
  });

  it('never prints water below 0 and warns when the recipe is over the finished gallons', () => {
    expect(loaderWater(10, [p('L1', 12, 'gal')])).toMatchObject({ water_gal: 0, over: true });
    // A sliver over still warns (Terra LOW: rounding first hid it).
    expect(loaderWater(10, [p('L1', 10.0001, 'gal')])).toMatchObject({ water_gal: 0, over: true });
    expect(loaderWater(10, [p('L1', 10, 'gal')])).toMatchObject({ water_gal: 0, over: false });
  });

  it('shows water only when known: never guesses liquid or dry from the unit (Mason, 2026-11-24)', () => {
    // Form not on file, even with a gallon unit: not known.
    expect(loaderWater(100, [p('X', 32, 'oz', null), p('Z', 1, 'gal', null), p('L', 1, 'gal')]))
      .toEqual({ finished_gal: 100, water_gal: null, over: false, unknown: ['X', 'Z'], unsized: [], missing: [], dry: false });
    // No form AND no amount: both reported at once (Terra LOW).
    expect(loaderWater(100, [p('Q', NaN, 'gal', null)])).toMatchObject({ unknown: ['Q'], missing: ['Q'] });
    // A known liquid measured by weight cannot be sized without its density.
    expect(loaderWater(100, [p('W', 50, 'lb', 'liquid')])).toMatchObject({ water_gal: null, unsized: ['W'] });
    expect(loaderWater(100, [p('Bad', 3, 'bag', 'liquid'), p('NoAmount', NaN, 'gal'), p('DryNoAmount', NaN, 'lb', 'dry')]))
      .toMatchObject({ water_gal: null, unsized: ['Bad'], missing: ['NoAmount'] });
    expect(loaderWaterNotes(loaderWater(100, [p('X', 1, 'gal', null)]))).toEqual(['Water to add not shown: set liquid/dry on the product for X.']);
    expect(fmtLoaderWater({ water_gal: null })).toBe('—');
    // Known liquids already over the tank still warn, even with water unknown (Terra HIGH).
    expect(loaderWater(100, [p('L', 120, 'gal'), p('X', 1, 'gal', null)])).toMatchObject({ water_gal: null, over: true, unknown: ['X'] });
  });

  it('sizes every load in both tank modes and the batch', () => {
    for (const mode of ['proportional', 'full_loads_remainder'] as const) {
      const ws = computeLoaderWorksheet({ total_acres: 100, carrier_rate_gpa: 10, tank_capacity: 300, mode,
        products: [{ product_name: 'L', total_quantity: 40, unit: 'gal', product_form: 'liquid' },
          { product_name: 'D', total_quantity: 100, unit: 'lb', product_form: 'dry' }] });
      const waters = ws.loads.map((load) => loaderWater(load.volume, load.products));
      const total = waters.reduce((s, w) => s + (w.water_gal ?? NaN), 0);
      expect(Math.round(total * 10000) / 10000).toBe(960); // 1000 finished − 40 liquid
      waters.forEach((w, i) => expect(w.water_gal).toBeCloseTo(ws.loads[i].volume * 0.96, 4));
    }
  });
});

describe('fmtLoaderGallons', () => {
  it('prints whole gallons and fluid ounces', () => {
    expect(fmtLoaderGallons(58.06)).toBe('58 GL 7.68 FL OZ');
    expect(fmtLoaderGallons(300)).toBe('300 GL');
    expect(fmtLoaderGallons(0.5)).toBe('64 FL OZ');
    expect(fmtLoaderGallons(0)).toBe('0 GL');
  });
});

describe('loaderPanelTankWater (job page)', () => {
  const linked = { product_name: 'TEST Liquid', total_quantity: 2, unit: 'Gal', product_id: 'p1' };
  const unlinked = { product_name: 'TEST Unlinked', total_quantity: 5, unit: 'Gal', product_id: null };
  const plan = (products: object[]) => computeLoaderWorksheet({ total_acres: 10, carrier_rate_gpa: 10, tank_capacity: 100, products: products as never });
  const shown = plan([linked]);
  const read = (products: object[]) => plan(products.map((x) => ({ ...x, product_form: 'liquid' }))).loads[0];

  it('uses the read for each product form', () => {
    expect(loaderPanelTankWater(shown.loads[0], [linked], read([linked]))).toMatchObject({ water_gal: 98, unknown: [] });
  });

  it('withholds water when the job also has an unlinked line (Codex P2)', () => {
    const w = loaderPanelTankWater(shown.loads[0], [linked], read([linked, unlinked]));
    expect(w).toMatchObject({ water_gal: null, unknown: ['TEST Unlinked'] });
  });

  it('withholds water until the read is there, even with no products listed', () => {
    expect(loaderPanelTankWater(plan([]).loads[0], [], null)).toMatchObject({ water_gal: null, finished_gal: 100 });
  });
});
