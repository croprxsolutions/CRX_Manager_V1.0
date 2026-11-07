import { describe, expect, it } from 'vitest';
import { buildLoaderWorksheetPdfPlan, loaderPdfMixBody, type LoaderWorksheetPdfData } from './loaderWorksheetPdf';
import { loaderJobInputs, type LoaderGetterJob } from './loaderWeightsFetch';
import type { JobLoaderWorksheet, JobLoaderWorksheetWeight, WeightUnitFactors } from '../types';

const units: WeightUnitFactors = { factors: { lb: { kind: 'weight', factor: 1 }, gal: { kind: 'volume', factor: 1 } }, ambiguous: [] };
const worksheet = { id: 'w', capacity_gal: 100, carrier_rate_gpa: 10, load_balance_mode: 'proportional', per_load_acres: null,
  loads_done: [], comment: null } as unknown as JobLoaderWorksheet;
const saved = (lb: number) => ({ product_id: 'p1', product_form: 'liquid', weight_kind: 'density', lb_per_unit: lb, per_unit: 'Gal',
  none_reason: null, unit_factors: units }) as unknown as JobLoaderWorksheetWeight;
const job = (id: string, lb: number, quantity: unknown = 20): LoaderGetterJob => ({
  job_id: id, found: true, acres: 20,
  job: { job_number: id, carrier_rate_gpa: 10, loader_tank_capacity: null, loader_comment: null, vehicle: null },
  lines: [{ id: `${id}-l1`, product_id: 'p1', quantity, unit: 'Gal', product_name: 'TEST Liquid', product_form: 'liquid' }],
  current: { p1: { kind: 'density', lb_per_unit: 9, per_unit: 'Gal' } as never },
  worksheet: { id: `${id}-w`, worksheet, vehicle_name: 'Manual', saved: { p1: saved(lb) } },
});

function page(entry: LoaderGetterJob, savedPlan = true): ReturnType<typeof loaderPdfMixBody> {
  const inputs = loaderJobInputs(entry);
  const data: LoaderWorksheetPdfData = {
    job_number: entry.job_id, customers: [], scheduled_date: '2026-11-07', scheduled_time: null, applicator_name: null, vehicle_name: 'Manual',
    total_acres: entry.acres ?? 0, carrier_rate_gpa: 10, tank_capacity: 100, capacity_unit: 'gal', products: inputs.products, loader_comment: null,
    weights: { byProductId: inputs.weights, currentUnits: units, sourceLines: inputs.sourceLines, saved: savedPlan },
  };
  return loaderPdfMixBody(data, buildLoaderWorksheetPdfPlan(data));
}

describe('loader worksheet weights from the getter', () => {
  it('prints each job page with its own worksheet\'s saved weight for the same product', () => {
    const a = page(job('A', 8));
    const b = page(job('B', 10));
    // 20 acres x 10 gal/ac = 200 gal in two 100-gal loads; 20 Gal of product = 10 Gal per load.
    expect(a.body[0][1]).toBe('10\n80.00 lb');
    expect(b.body[0][1]).toBe('10\n100.00 lb');
    expect(a.body[a.body.length - 1]).toEqual(['Product weight', '80.00 lb', '80.00 lb', '']);
    expect(a.caption).toBe('Weights saved with this worksheet');
  });

  it('prints a bad job amount\'s reason in every amount cell and withholds the load weights, never 0', () => {
    const { body } = page(job('A', 8, 'abc'));
    expect(body[0].slice(1)).toEqual(["TEST Liquid's amount is not a number", "TEST Liquid's amount is not a number", '—']);
    expect(body[body.length - 1][1]).toBe("Product weight not shown: TEST Liquid's amount is not a number");
  });

  it('marks a line weighed at its current weight on a saved worksheet and names it in the caption', () => {
    const entry = { ...job('A', 8), worksheet: { ...job('A', 8).worksheet!, saved: {} } };
    const { body, caption } = page(entry);
    expect(body[0][1]).toBe('10\n90.00 lb (current)');
    expect(caption).toBe('Weights saved with this worksheet, except lines marked current');
  });

  it('prints the reason in place of the caption, and no weights, when the read failed', () => {
    const data: LoaderWorksheetPdfData = {
      job_number: 'A', customers: [], scheduled_date: '2026-11-07', scheduled_time: null, applicator_name: null, vehicle_name: null,
      total_acres: 20, carrier_rate_gpa: 10, tank_capacity: 100, capacity_unit: 'gal', loader_comment: null,
      products: [{ product_name: 'TEST Liquid', total_quantity: 20, unit: 'Gal' }],
      weights: { byProductId: {}, currentUnits: units, sourceLines: [], saved: false, unavailable: 'Product weights not shown: they could not be read. Reprint to include them.' },
    };
    const { body, caption } = loaderPdfMixBody(data, buildLoaderWorksheetPdfPlan(data));
    expect(body).toEqual([['TEST Liquid (Gal)', '10', '10', '20']]);
    expect(caption).toMatch(/could not be read/);
  });
});
