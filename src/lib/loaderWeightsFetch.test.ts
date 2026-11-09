import { describe, expect, it, vi } from 'vitest';
import * as db from './db';

import { buildLoaderWorksheetPdfPlan, loaderPdfMixBody, type LoaderWorksheetPdfData } from './loaderWorksheetPdf';
import { fetchLoaderJobWeights, loaderJobInputs, type LoaderGetterJob } from './loaderWeightsFetch';
import { fetchLoaderWorksheetData } from './loaderWorksheetFetch';
import { computeLoaderWorksheet } from './loaderWorksheet';
import { loaderPanelProducts, selectedLoaderWeights } from '../components/jobs/loaderPanelWeights';
import type { JobLoaderWorksheet, JobLoaderWorksheetWeight, WeightUnitFactors } from '../types';

vi.mock('./billedCustomersResolver', () => ({ resolveBilledCustomers: () => Promise.resolve({ customers: [], complete: true }) }));

const units: WeightUnitFactors = { factors: { lb: { kind: 'weight', factor: 1 }, gal: { kind: 'volume', factor: 1 } }, ambiguous: [] };
const worksheet = { id: 'w', capacity_gal: 100, carrier_rate_gpa: 10, load_balance_mode: 'proportional', per_load_acres: null,
  loads_done: [], comment: null } as unknown as JobLoaderWorksheet;
const saved = (lb: number) => ({ product_id: 'p1', product_form: 'liquid', weight_kind: 'density', lb_per_unit: lb, per_unit: 'Gal',
  none_reason: null, unit_factors: units }) as unknown as JobLoaderWorksheetWeight;
const job = (id: string, lb: number, quantity: unknown = 20): LoaderGetterJob => ({
  job_id: id, found: true, acres: 20,
  job: { job_number: id, job_date: '2026-11-07', scheduled_time: null, applicator_id: null, carrier_rate_gpa: 10, loader_tank_capacity: null, loader_comment: null, vehicle: null },
  lines: [{ id: `${id}-l1`, product_id: 'p1', quantity, unit: 'Gal', product_name: 'TEST Liquid', product_form: 'liquid' }],
  current: { p1: { kind: 'density', lb_per_unit: 9, per_unit: 'Gal' } as never },
  worksheet: { id: `${id}-w`, worksheet, vehicle_name: 'Manual', saved: { p1: saved(lb) } },
});

function page(entry: LoaderGetterJob, savedPlan = true, condensed = false): ReturnType<typeof loaderPdfMixBody> {
  const inputs = loaderJobInputs(entry);
  const data: LoaderWorksheetPdfData = {
    job_number: entry.job_id, customers: [], scheduled_date: '2026-11-07', scheduled_time: null, applicator_name: null, vehicle_name: 'Manual',
    total_acres: entry.acres ?? 0, carrier_rate_gpa: 10, tank_capacity: 100, capacity_unit: 'gal', products: inputs.products, loader_comment: null,
    weights: { byProductId: inputs.weights, currentUnits: units, sourceLines: inputs.sourceLines, saved: savedPlan },
  };
  if (condensed) data.display_mode = 'condensed';
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
    // Condensed: the two equal loads share one column, and its weights say "each".
    const c = page(job('C', 8), true, true);
    expect(c.body[0][1]).toBe('10 each\n80.00 lb');
    expect(c.body[c.body.length - 1]).toEqual(['Product weight', '80.00 lb each', '']);
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

  it('with the read failed, a negative job amount still prints its reason (the job lines go along), never a number', () => {
    const data: LoaderWorksheetPdfData = {
      job_number: 'A', customers: [], scheduled_date: '2026-11-07', scheduled_time: null, applicator_name: null, vehicle_name: null,
      total_acres: 20, carrier_rate_gpa: 10, tank_capacity: 100, capacity_unit: 'gal', loader_comment: null,
      products: [{ product_name: 'TEST Liquid', total_quantity: -2, unit: 'Gal', product_id: 'p1', source_line_id: 'l1' }],
      weights: { byProductId: {}, currentUnits: units, sourceLines: [{ id: 'l1', product_id: 'p1', quantity: -2, unit: 'Gal' }], saved: false,
        unavailable: 'Product weights not shown: they could not be read. Reprint to include them.' },
    };
    const { body } = loaderPdfMixBody(data, buildLoaderWorksheetPdfPlan(data));
    expect(body[0].slice(1, 3).every((cell) => /TEST Liquid/.test(cell) && !/^-?\d/.test(cell))).toBe(true);
  });
});

describe('selectedLoaderWeights (job page)', () => {
  const shownPlan = (quantity: number, productId = 'p1') => computeLoaderWorksheet({ total_acres: 20, carrier_rate_gpa: 10, tank_capacity: 100,
    products: [{ product_name: 'TEST Liquid', total_quantity: quantity, unit: 'Gal', product_id: productId, product_form: 'liquid', source_line_id: 'A-l1' }] });
  const read = { status: 'ready' as const, entry: job('A', 8), units };
  const selected = { ...worksheet, id: 'A-w' } as JobLoaderWorksheet;

  it('shows the weights when the fresh read matches the plan on screen', () => {
    const result = selectedLoaderWeights(read, selected, shownPlan(20));
    expect('weights' in result && result.weights.loads[0].totalText).toBe('Product weight: 80.00 lb');
  });

  it('shows the weights for the plan the job page builds from its own chemical rows', () => {
    const rows = [{ product_id: 'p1', product_name: 'TEST Liquid', quantity: '20', unit: 'Gal' }, { product_id: null, product_name: 'TEST Note', quantity: '', unit: null }];
    const shown = computeLoaderWorksheet({ total_acres: 20, carrier_rate_gpa: 10, tank_capacity: 100, products: loaderPanelProducts(rows) });
    const result = selectedLoaderWeights(read, selected, shown);
    expect('weights' in result && result.weights.loads[0].totalText).toBe('Product weight: 80.00 lb');
  });

  it('matches when the job page lists the same chemicals in a different order than the getter', () => {
    const two = job('B', 8);
    two.lines = [...two.lines!, { id: 'B-l2', product_id: 'p2', quantity: 10, unit: 'Gal', product_name: 'TEST Second', product_form: 'liquid' }];
    const rows = [{ product_id: 'p2', product_name: 'TEST Second', quantity: '10', unit: 'Gal' }, { product_id: 'p1', product_name: 'TEST Liquid', quantity: '20', unit: 'Gal' }];
    const shown = computeLoaderWorksheet({ total_acres: 20, carrier_rate_gpa: 10, tank_capacity: 100, products: loaderPanelProducts(rows) });
    expect('weights' in selectedLoaderWeights({ status: 'ready', entry: two, units }, { ...worksheet, id: 'B-w' } as JobLoaderWorksheet, shown)).toBe(true);
  });

  it('matches a job that also has an unlinked line with an amount, but withholds the load total as the PDF does', () => {
    const mixed = job('C', 8);
    mixed.lines = [...mixed.lines!, { id: 'C-l2', product_id: null, quantity: 5, unit: 'Gal', product_name: 'TEST Unlinked', product_form: null }];
    const rows = [{ product_id: 'p1', product_name: 'TEST Liquid', quantity: '20', unit: 'Gal' }, { product_id: null, product_name: 'TEST Unlinked', quantity: '5', unit: 'Gal' }];
    const shown = computeLoaderWorksheet({ total_acres: 20, carrier_rate_gpa: 10, tank_capacity: 100, products: loaderPanelProducts(rows) });
    const result = selectedLoaderWeights({ status: 'ready', entry: mixed, units }, { ...worksheet, id: 'C-w' } as JobLoaderWorksheet, shown);
    if (!('weights' in result)) throw new Error('expected a plan match');
    expect(result.weights.loads[0].cells[0].weightText).toBe('80.00 lb');
    expect(result.weights.loads[0].totalText).toMatch(/^Product weight not shown: .*TEST Unlinked/);
  });

  it('does not match a plan whose product fields only join to the same text', () => {
    const tricky = job('D', 8);
    tricky.lines = [{ id: 'D-l1', product_id: 'p1', quantity: 20, unit: 'Gal,p2:TEST Q=10 Gal', product_name: 'TEST Liquid', product_form: 'liquid' }];
    const shown = computeLoaderWorksheet({ total_acres: 20, carrier_rate_gpa: 10, tank_capacity: 100, products: [
      { product_name: 'TEST Liquid', total_quantity: 20, unit: 'Gal', product_id: 'p1' }, { product_name: 'TEST Q', total_quantity: 20, unit: 'Gal', product_id: 'p2' }] });
    expect('reason' in selectedLoaderWeights({ status: 'ready', entry: tricky, units }, { ...worksheet, id: 'D-w' } as JobLoaderWorksheet, shown)).toBe(true);
  });

  it('withholds them when a product amount changed but the tank volumes did not', () => {
    expect(selectedLoaderWeights(read, selected, shownPlan(10))).toEqual({
      reason: 'Product weights not shown: the job or worksheet changed since this page loaded. Reload to see them.' });
  });

  it('withholds them when the line now points at a different product with the same name and amount', () => {
    expect(selectedLoaderWeights(read, selected, shownPlan(20, 'p2'))).toEqual({
      reason: 'Product weights not shown: the job or worksheet changed since this page loaded. Reload to see them.' });
  });
});

describe('fetchLoaderJobWeights', () => {
  it('keeps each job with the unit map of the read that returned it', async () => {
    const ids = Array.from({ length: 201 }, (_, index) => `job-${index}`);
    const chunkUnits = [units, { factors: { gal: { kind: 'volume', factor: 1 } }, ambiguous: [] }];
    let call = 0;
    const rpc = vi.spyOn(db.supabaseUntyped, 'rpc').mockImplementation(((_name: string, args: { p_job_ids: string[] }) => {
      const unit_factors = chunkUnits[call++];
      return Promise.resolve({ data: { read_at: 't', unit_factors, jobs: args.p_job_ids.map((job_id) => ({ job_id, found: true })) }, error: null });
    }) as never);
    const { unitsByJob } = await fetchLoaderJobWeights(ids);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(unitsByJob.get('job-0')).toBe(chunkUnits[0]);
    expect(unitsByJob.get('job-200')).toBe(chunkUnits[1]);
    rpc.mockRestore();
  });
});

describe('fetchLoaderWorksheetData', () => {
  // Runs the PDF fetch with a jobs read (applicator 'old') and a getter read that differs from it.
  const fetchWith = async (getterJob: { job_date: string; scheduled_time: string | null; applicator_id: string | null }) => {
    const profiles = [{ id: 'old', full_name: 'TEST Old Applicator' }, { id: 'new', full_name: 'TEST New Applicator' }];
    // A query builder that resolves to `rows` however it is chained, honouring .in('id', ids).
    const query = (rows: Array<{ id: string }>) => {
      let ids: string[] | null = null;
      const chain: Record<string, unknown> = {
        then: (resolve: (v: unknown) => void) => resolve({ data: ids ? rows.filter((row) => ids!.includes(row.id)) : rows, error: null }),
        in: (column: string, values: string[]) => { if (column === 'id') ids = values; return chain; },
      };
      for (const name of ['select', 'eq']) chain[name] = () => chain;
      return chain;
    };
    const jobsRead = [{ id: 'A', job_number: 'A', job_date: '2026-11-01', scheduled_time: '07:00:00', applicator_id: 'old',
      carrier_rate_gpa: 10, loader_tank_capacity: null, loader_comment: null, vehicle: null, job_fields: [], job_chemicals: [] }];
    const tables: Record<string, Array<{ id: string }>> = { jobs: jobsRead, job_loader_worksheets: [], profile_public_view: profiles };
    const fake = ((table: string) => query(tables[table])) as never;
    const from = vi.spyOn(db.supabase, 'from').mockImplementation(fake);
    const fromUntyped = vi.spyOn(db.supabaseUntyped, 'from').mockImplementation(fake);
    const getter = { ...job('A', 8), job: { ...job('A', 8).job!, ...getterJob } };
    const rpc = vi.spyOn(db.supabaseUntyped, 'rpc').mockImplementation((() =>
      Promise.resolve({ data: { read_at: 't', unit_factors: units, jobs: [getter] }, error: null })) as never);
    try {
      const [pageData] = await fetchLoaderWorksheetData(['A']);
      return [pageData.scheduled_date, pageData.scheduled_time, pageData.applicator_name];
    } finally {
      from.mockRestore(); fromUntyped.mockRestore(); rpc.mockRestore();
    }
  };

  it('prints the date, time and applicator of the getter read that gave the lines, not the earlier jobs read', async () => {
    expect(await fetchWith({ job_date: '2026-11-09', scheduled_time: '08:30:00', applicator_id: 'new' }))
      .toEqual(['2026-11-09', '08:30:00', 'TEST New Applicator']);
  });

  it('prints a time or applicator the getter read cleared as blank, not the earlier value', async () => {
    expect(await fetchWith({ job_date: '2026-11-09', scheduled_time: null, applicator_id: null }))
      .toEqual(['2026-11-09', null, null]);
  });
});
