import { describe, expect, it } from 'vitest';
import { buildApplicatorSheetData, type RawSheetProduct } from './applicatorSheetData';
import { buildChemicalSummaryReportData } from './chemicalSummaryReportData';

describe('seed and each chemical summary', () => {
  it('shows no gallon or pound equivalent for either form', () => {
    const product = (product_name: string, unit: string, total_quantity: number, product_form: 'seed' | 'each'): RawSheetProduct => ({
      product_name, unit, total_quantity, product_form, rate_per_acre: null, rate_unit: null,
      rei_hours: null, phi_days: null, epa_registration: null,
    });
    const data = buildApplicatorSheetData({
      job_number: 'JOB', customers: [{ customer_name: 'Acme', account_number: 'A1' }],
      scheduled_date: '2026-06-25', scheduled_time: null, applicator_name: null,
      vehicle_name: null, fields: [], loader_comment: null,
      products: [product('Seed', 'Lb', 50, 'seed'), product('Each', 'Ea', 2, 'each')],
    });
    const out = buildChemicalSummaryReportData([{ job_id: 'j1', data }]);
    expect(out.rows.map((row) => [row.product_name, row.gl_lb_display])).toEqual([
      ['Each', '—'], ['Seed', '—'],
    ]);
  });
});
