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
  const line = (name: string, id: string | null, rei: number | null, phi: number | null) => ({ product_name: name, product_id: id,
    rate_per_acre: 1, rate_unit: 'pt', total_applied: 1, total_unit: 'pt', total_gl_lb: null, product_form: null,
    rei_hours: rei, phi_days: phi, epa_registration: null });
  const data = {
    job_number: 'JOB-1', customers: [], scheduled_date: '2026-07-11', scheduled_time: null, applicator_name: null,
    vehicle_name: null, fields: [], total_acres: 0, loader_comment: null,
    products: [line('TEST Same', 'p-1', 12, 7), line('TEST Same', 'p-2', 48, null), line('TEST Old', null, null, 3)],
    safety: [{ product_name: 'TEST stale', signal_word: 'Danger', rei_hours: 1, phi_days: 1 }],
  };
  const options = { mapPages: 'none' as const, includePreviousApplications: false, previousApplicationsPerField: 3,
    blankSections: 0, includeBillingSplits: false, showBanner: true };
  const reply = (result: unknown) => mockFrom.mockReturnValue({ select: () => ({ in: async () => result }) });

  it('leaves safety off, even if the input carried some, and reads nothing extra when not chosen', async () => {
    const result = await prepareApplicatorSheetPrintData('job-1', data, { ...options, includeSafetySheet: false });
    expect(result.safety).toBeUndefined();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('lists exactly the job order lines, each with its own product signal word, even when names repeat', async () => {
    reply({ data: [{ id: 'p-1', signal_word: 'Caution' }, { id: 'p-2', signal_word: 'Danger' }], error: null });
    const result = await prepareApplicatorSheetPrintData('job-1', data, { ...options, includeSafetySheet: true });
    expect(mockFrom).toHaveBeenCalledWith('products');
    expect(result.safety).toEqual([
      { product_name: 'TEST Same', signal_word: 'Caution', rei_hours: 12, phi_days: 7 },
      { product_name: 'TEST Same', signal_word: 'Danger', rei_hours: 48, phi_days: null },
      { product_name: 'TEST Old', signal_word: null, rei_hours: null, phi_days: 3 },
    ]);
  });

  it('marks safety as not loaded (null) when the read fails', async () => {
    reply({ data: null, error: { message: 'permission denied' } });
    expect((await prepareApplicatorSheetPrintData('job-1', data, { ...options, includeSafetySheet: true })).safety).toBeNull();
  });

  it('marks safety as not loaded when a line product record cannot be read', async () => {
    reply({ data: [{ id: 'p-1', signal_word: 'Caution' }], error: null });
    expect((await prepareApplicatorSheetPrintData('job-1', data, { ...options, includeSafetySheet: true })).safety).toBeNull();
  });
});
