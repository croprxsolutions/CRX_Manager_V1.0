import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom, mockRpc } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('./db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T>(data: unknown, rpcName: string): T => {
    if (data === null || data === undefined) throw new Error(`${rpcName} returned no data`);
    return data as T;
  },
}));

vi.mock('./jobMapImages', () => ({ fetchJobMapImages: vi.fn() }));

import { fetchApplicatorSheetBillingSplits, prepareApplicatorSheetPrintData } from './applicatorSheetPrintData';

describe('fetchApplicatorSheetBillingSplits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits billing splits when saved job shares cannot be read', async () => {
    mockRpc.mockResolvedValue({
      data: [{ customer_id: 'customer-1', farm_name: 'North Farm', account_number: null, is_primary: true }],
      error: null,
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'job_fields') {
        return { select: () => ({ eq: () => ({ data: [{ field_id: 'field-1', acres_to_treat: 40 }], error: null }) }) };
      }
      if (table === 'job_field_shares') {
        return { select: () => ({ eq: () => ({ data: null, error: { message: 'permission denied for table job_field_shares' } }) }) };
      }
      if (table === 'customers') {
        return { select: () => ({ in: () => ({ data: [{ id: 'customer-1', phone: '555-0100' }], error: null }) }) };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(fetchApplicatorSheetBillingSplits('job-1', 40)).resolves.toEqual([]);
    expect(mockFrom).not.toHaveBeenCalledWith('field_billing_defaults');
  });
});

describe('prepareApplicatorSheetPrintData safety sheet', () => {
  beforeEach(() => vi.clearAllMocks());
  const data = {
    job_number: 'JOB-1', customers: [], scheduled_date: '2026-07-11', scheduled_time: null, applicator_name: null,
    vehicle_name: null, fields: [], total_acres: 0, loader_comment: null,
    products: [
      { product_name: 'TEST A', rate_per_acre: 1, rate_unit: 'pt', total_applied: 1, total_unit: 'pt', total_gl_lb: null, product_form: null, rei_hours: 12, phi_days: 7, epa_registration: null },
      { product_name: 'TEST B', rate_per_acre: 1, rate_unit: 'pt', total_applied: 1, total_unit: 'pt', total_gl_lb: null, product_form: null, rei_hours: null, phi_days: null, epa_registration: null },
    ],
  };
  const options = { mapPages: 'none' as const, includePreviousApplications: false, previousApplicationsPerField: 3,
    blankSections: 0, includeBillingSplits: false, showBanner: true };

  it('leaves safety off and reads nothing extra when the sheet was not chosen', async () => {
    const result = await prepareApplicatorSheetPrintData('job-1', data, { ...options, includeSafetySheet: false });
    expect(result.safety).toBeUndefined();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('adds one safety row per product line with its signal word; a name with two words stays unknown', async () => {
    const rows = [
      { product: { product_name: 'TEST A', signal_word: 'Warning' } },
      { product: { product_name: 'TEST B', signal_word: 'Caution' } },
      { product: { product_name: 'TEST B', signal_word: 'Danger' } },
    ];
    mockFrom.mockReturnValue({ select: () => ({ eq: () => ({ not: async () => ({ data: rows, error: null }) }) }) });
    const result = await prepareApplicatorSheetPrintData('job-1', data, { ...options, includeSafetySheet: true });
    expect(result.safety).toEqual([
      { product_name: 'TEST A', signal_word: 'Warning', rei_hours: 12, phi_days: 7 },
      { product_name: 'TEST B', signal_word: null, rei_hours: null, phi_days: null },
    ]);
  });
});
