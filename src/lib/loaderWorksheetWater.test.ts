import { describe, expect, it } from 'vitest';
import { computeLoaderWorksheet } from './loaderWorksheet';
import { fmtLoaderGallons, loaderWater } from './loaderWorksheetWater';

const p = (product_name: string, amount: number, unit: string, product_form: string | null = 'liquid') =>
  ({ product_name, amount, unit, product_form });

describe('loaderWater', () => {
  it('subtracts liquid product gallons; dry products add no volume', () => {
    const w = loaderWater(300, [p('L1', 2, 'gal'), p('L2', 64, 'fl oz'), p('D1', 50, 'lb', 'dry'), p('S1', 3, 'each', 'each')]);
    expect(w).toEqual({ finished_gal: 300, water_gal: 297.5, over: false, unsized: [], missing: [] });
  });

  it('never prints water below 0 and warns when the recipe is over the finished gallons', () => {
    expect(loaderWater(10, [p('L1', 12, 'gal')])).toMatchObject({ water_gal: 0, over: true });
    // A sliver over still warns (Terra LOW: rounding first hid it).
    expect(loaderWater(10, [p('L1', 10.0001, 'gal')])).toMatchObject({ water_gal: 0, over: true });
    expect(loaderWater(10, [p('L1', 10, 'gal')])).toMatchObject({ water_gal: 0, over: false });
  });

  it('flags a product it cannot size instead of guessing', () => {
    // Form unknown: ounces (fluid or weight?) and pounds (a liquid can be sold by weight) are never "no volume".
    expect(loaderWater(100, [p('X', 32, 'oz', null), p('Y', 50, 'lb', null), p('Z', 1, 'gal', null)]))
      .toEqual({ finished_gal: 100, water_gal: 99, over: false, unsized: ['X', 'Y'], missing: [] });
    // A known liquid measured by weight cannot be sized without its density either.
    expect(loaderWater(100, [p('W', 50, 'lb', 'liquid')]).unsized).toEqual(['W']);
    expect(loaderWater(100, [p('Bad', 3, 'bag', 'liquid'), p('NoAmount', NaN, 'gal'), p('DryNoAmount', NaN, 'lb', 'dry')]))
      .toMatchObject({ unsized: ['Bad'], missing: ['NoAmount'] });
  });

  it('sizes every load in both tank modes and the batch', () => {
    for (const mode of ['proportional', 'full_loads_remainder'] as const) {
      const ws = computeLoaderWorksheet({ total_acres: 100, carrier_rate_gpa: 10, tank_capacity: 300, mode,
        products: [{ product_name: 'L', total_quantity: 40, unit: 'gal', product_form: 'liquid' },
          { product_name: 'D', total_quantity: 100, unit: 'lb', product_form: 'dry' }] });
      const waters = ws.loads.map((load) => loaderWater(load.volume, load.products));
      const total = waters.reduce((s, w) => s + w.water_gal, 0);
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
