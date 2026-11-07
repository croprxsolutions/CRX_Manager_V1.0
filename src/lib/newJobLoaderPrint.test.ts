import { describe, expect, it } from 'vitest';
import { newJobLoaderLines } from './newJobLoaderPrint';
import { computeLoaderWorksheet } from './loaderWorksheet';
import { loaderLoadWeights } from './loaderWeights';
import type { WeightUnitFactors } from '../types';

const units: WeightUnitFactors = { factors: { gal: { kind: 'volume', factor: 1 } }, ambiguous: [] };
const row = (product_id: string, quantity: string, product_name = 'TEST Liquid') => ({ product_id, product_name, quantity, unit: 'Gal' });

function weigh(rows: ReturnType<typeof row>[]) {
  const { products, sourceLines } = newJobLoaderLines(rows, { read_at: '', units, products: { p1: { product_id: 'p1', found: true, product_form: 'liquid' } } });
  const ws = computeLoaderWorksheet({ total_acres: 10, carrier_rate_gpa: 10, tank_capacity: 100, products });
  return { products, cells: loaderLoadWeights(ws, { p1: { current: { kind: 'density', lb_per_unit: 8, per_unit: 'Gal' } as never } }, units, sourceLines).loads[0].cells };
}

describe('newJobLoaderLines', () => {
  it('keeps a row with a quantity but no product, printing its amount with its weight refused', () => {
    const { cells } = weigh([row('', '3', 'Product')]);
    expect(cells[0].amountCell).toBe('3');
    expect(cells[0].weightText).toBe('Product is not linked to a product, so it has no weight');
  });

  it('refuses 2abc by name instead of reading it as 2, and weighs a second row of the same product on its own', () => {
    const { cells } = weigh([row('p1', '2abc'), row('p1', '2')]);
    expect(cells[0].amountCell).toBe("TEST Liquid's amount is not a number");
    expect(cells[1].weightText).toBe('16.00 lb');
  });

  it('skips a row with neither product nor quantity, keeping the others\' original row ids', () => {
    const { products } = weigh([row('', ''), row('p1', '2')]);
    expect(products.map((product) => product.source_line_id)).toEqual(['row-1']);
  });
});
