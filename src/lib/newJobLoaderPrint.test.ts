import { describe, expect, it, vi } from 'vitest';
import { newJobLoaderLines, newJobLoaderPrint } from './newJobLoaderPrint';
import * as productWeights from './productWeights';
import { buildLoaderWorksheetPdfPlan, loaderPdfMixBody, type LoaderWorksheetPdfData } from './loaderWorksheetPdf';
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

describe('newJobLoaderPrint when weights cannot be read', () => {
  it('still prints a bad amount\'s reason (never 0) and leaves the weights off', async () => {
    vi.spyOn(productWeights, 'fetchProductWeights').mockRejectedValueOnce(new Error('offline'));
    const { products, weights } = await newJobLoaderPrint([row('p1', '-2'), row('p1', '2')]);
    const data: LoaderWorksheetPdfData = {
      job_number: 'NEW', customers: [], scheduled_date: '2026-11-07', scheduled_time: null, applicator_name: null, vehicle_name: 'Manual',
      total_acres: 10, carrier_rate_gpa: 10, tank_capacity: 100, capacity_unit: 'gal', products, loader_comment: null, weights,
    };
    const { body, caption } = loaderPdfMixBody(data, buildLoaderWorksheetPdfPlan(data));
    expect(body[0].slice(1)).toEqual(['TEST Liquid has a negative amount', '—']);
    expect(body[1].slice(1)).toEqual(['2', '2']);
    expect(body.some((cells) => cells[0] === 'Product weight')).toBe(false);
    expect(caption).toBe('Product weights not shown: they could not be read. Reprint to include them.');
  });
});
