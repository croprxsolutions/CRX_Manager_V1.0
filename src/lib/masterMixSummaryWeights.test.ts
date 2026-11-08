import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchProductWeights = vi.fn();
vi.mock('./productWeights', () => ({ fetchProductWeights: (ids: string[]) => fetchProductWeights(ids) }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./db', () => ({ supabase: {} }));

import { fetchMasterMixWeights } from './masterMixSummaryFetch';
import { buildMasterMixSummaryData, type MasterMixJobInput } from './masterMixSummaryData';
import { masterMixLoadBody } from './masterMixSummaryPdf';
import { buildApplicatorSheetData } from './applicatorSheetData';

const job = (id: string, productIds: string[]): MasterMixJobInput => ({
  job_id: id,
  data: buildApplicatorSheetData({ job_number: id, customers: [], scheduled_date: '2026-11-08', scheduled_time: null, applicator_name: null,
    vehicle_name: null, loader_comment: null, fields: [{ field_id: 'f', field_name: 'F', county: null, state: null, acres: 20, crop: null, pest: null, sort_order: 0 }],
    products: productIds.map((pid) => ({ product_id: pid, product_name: `P ${pid}`, rate_per_acre: null, rate_unit: null, unit: 'gal',
      total_quantity: 4, product_form: 'liquid', rei_hours: null, phi_days: null, epa_registration: null })) }),
  tank_capacity: 100, capacity_unit: 'gal', carrier_rate_gpa: 10, capacity_source: null,
});

describe('fetchMasterMixWeights (DM-2)', () => {
  beforeEach(() => { fetchProductWeights.mockReset(); });

  it('reads every product of the batch in one call, keyed by product', async () => {
    fetchProductWeights.mockResolvedValue({ read_at: 't', units: { factors: {}, ambiguous: [] },
      products: { a: { product_id: 'a', found: true, weight: { kind: 'density', lb_per_unit: 8 } }, b: { product_id: 'b', found: false } } });
    const out = await fetchMasterMixWeights([job('j1', ['a', 'b']), job('j2', ['a'])]);
    expect(fetchProductWeights).toHaveBeenCalledTimes(1);
    expect(fetchProductWeights.mock.calls[0][0]).toEqual(['a', 'b']);
    expect(out).toEqual({ byProductId: { a: { kind: 'density', lb_per_unit: 8 }, b: undefined }, units: { factors: {}, ambiguous: [] } });
  });

  it('a batch over 500 products prints its amounts with the named refusal in the weight rows', async () => {
    fetchProductWeights.mockImplementation(async () => { throw new Error('Too many products to weigh at once'); });
    const jobs = [job('j1', Array.from({ length: 501 }, (_, i) => `p${i}`))];
    const weights = await fetchMasterMixWeights(jobs);
    const mix = buildMasterMixSummaryData(jobs, [], weights);
    expect(mix.rows).toHaveLength(501);
    expect(mix.rows.every((r) => r.total_quantity === 4 && r.weight_text === 'Too many products to weigh at once: select fewer jobs')).toBe(true);
    expect(mix.load_groups[0].worksheet.loads_count).toBe(2);
  });

  it('a failed read says so instead of breaking the summary', async () => {
    fetchProductWeights.mockImplementation(async () => { throw new Error('function get_product_weights does not exist'); });
    expect(await fetchMasterMixWeights([job('j1', ['a'])])).toEqual({ unavailable: 'Product weights not shown: they could not be read. Reprint to include them.' });
  });
});

describe('masterMixLoadBody (DM-2)', () => {
  it('prints each amount with its weight and closes with the product weight row', () => {
    const units = { factors: { gal: { kind: 'volume' as const, factor: 1 } }, ambiguous: [] };
    const mix = buildMasterMixSummaryData([job('j1', ['a'])], [], { byProductId: { a: { kind: 'density', lb_per_unit: 8 } }, units });
    expect(masterMixLoadBody(mix.load_groups[0])).toEqual([
      ['P a (gal)', '2\n16.00 lb', '2\n16.00 lb', '4'],
      ['Product weight', '16.00 lb', '16.00 lb', ''],
    ]);
  });

  it('a refused load keeps the other loads\' weights and withholds only the row total', () => {
    const units = { factors: { gal: { kind: 'volume' as const, factor: 1 } }, ambiguous: [] };
    const mix = buildMasterMixSummaryData([job('j1', ['a'])], [], { byProductId: { a: { kind: 'density', lb_per_unit: 8 } }, units });
    const g = mix.load_groups[0];
    g.weights!.loads[0].cells[0] = { ...g.weights!.loads[0].cells[0], amountCell: 'Not shown: refused' };
    expect(masterMixLoadBody(g)[0]).toEqual(['P a (gal)', 'Not shown: refused', '2\n16.00 lb', '—']);
  });

  it('keeps the old table when no weights are passed', () => {
    const mix = buildMasterMixSummaryData([job('j1', ['a'])]);
    expect(masterMixLoadBody(mix.load_groups[0])).toEqual([['P a (gal)', '2', '2', '4']]);
  });
});
