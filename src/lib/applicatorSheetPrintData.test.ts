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

vi.mock('./jobMapImages', () => ({ fetchJobMapImages: vi.fn(), fetchJobFieldLocations: vi.fn(async () => new Map()) }));
vi.mock('./fieldMarkerData', () => ({ MARKER_REQUEST_TIMEOUT_MS: 15_000, readFieldMarkers: vi.fn() }));

import { fetchApplicatorSheetBillingSplits, prepareApplicatorSheetPrintData } from './applicatorSheetPrintData';
import { DEFAULT_APPLICATOR_PRINT_OPTIONS } from './applicatorPrintOptions';
import { readFieldMarkers } from './fieldMarkerData';
import { fetchJobMapImages } from './jobMapImages';
import type { ApplicatorSheetData } from './applicatorSheetData';
import type { FieldObstacle } from '../types';

it('attaches unfiltered hazards by saved field and only treats a verified empty read as none', async () => {
  const data: ApplicatorSheetData = {
    job_number: 'JOB-HAZARD', customers: [], scheduled_date: '', scheduled_time: null, applicator_name: null,
    vehicle_name: null, total_acres: 3, loader_comment: null, products: [],
    fields: ['a', 'b', 'c'].map((field_id, index) => ({
      field_id, stop: index + 1, field_name: field_id, county: null, state: null, acres: 1, crop: null, pest: null,
    })),
  };
  const marker: FieldObstacle = {
    id: 'marker-a', field_id: 'a', kind: 'washout', label: 'Check after rain', point_geojson: { type: 'Point', coordinates: [-89, 39] },
    created_at: '', updated_at: '', created_by: null, entrance_number: null,
  };
  vi.mocked(readFieldMarkers).mockImplementation(async (id) => {
    if (id === 'a') return { available: true, count: 2, markers: [marker, { ...marker, id: 'wrong-field', field_id: 'not-this-job' }] };
    if (id === 'b') return { available: true, count: 0, markers: [] };
    return { available: false };
  });

  vi.mocked(fetchJobMapImages).mockResolvedValue(null);
  const result = await prepareApplicatorSheetPrintData('job-1', data, {
    ...DEFAULT_APPLICATOR_PRINT_OPTIONS, mapPages: 'both', includeBillingSplits: false,
  });

  expect(vi.mocked(readFieldMarkers).mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
  const [jobId, options] = vi.mocked(fetchJobMapImages).mock.calls[0];
  expect(jobId).toBe('job-1');
  expect([...(await options?.hazards ?? new Map())]).toEqual([
    ['a', { complete: false, markers: [marker] }],
    ['b', { complete: true, markers: [] }],
  ]);
  expect(result.fields.map(({ hazards }) => hazards)).toEqual([
    { complete: false, markers: [{ name: 'Washout', note: 'Check after rain', pinIdentity: JSON.stringify(['marker-a', -89, 39]) }] },
    { complete: true, markers: [] },
    { complete: false, markers: [] },
  ]);
  expect(result.maps).toBeNull();

  vi.useFakeTimers();
  try {
    vi.mocked(readFieldMarkers).mockClear();
    vi.mocked(readFieldMarkers).mockImplementation((id) => id === 'd'
      ? Promise.resolve({ available: true, count: 1, markers: [{ ...marker, field_id: 'd' }] })
      : new Promise(() => undefined));
    const pending = prepareApplicatorSheetPrintData('job-1', {
      ...data, fields: [...data.fields, { ...data.fields[0], field_id: 'd', stop: 4 }],
    }, {
      ...DEFAULT_APPLICATOR_PRINT_OPTIONS, mapPages: 'none', includeBillingSplits: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const timedOut = await pending;
    for (const field of timedOut.fields.slice(0, 3)) expect(field.hazards).toEqual({ complete: false, markers: [] });
    expect(timedOut.fields[3].hazards?.markers[0].note).toBe('Check after rain');
    const stalled = vi.mocked(readFieldMarkers).mock.calls.slice(0, 3);
    expect(stalled.every(([, signal]) => signal.aborted)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

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
    safety: [{ product_name: 'TEST stale', epa_registration: null, signal_word: 'Danger', rei_hours: 1, phi_days: 1 }],
  };
  const options = { mapPages: 'none' as const, includePreviousApplications: false, previousApplicationsPerField: 3,
    blankSections: 0, includeBillingSplits: false, showBanner: true };
  const reply = (result: unknown) => mockFrom.mockReturnValue({ select: () => ({ in: async () => result }) });

  it('leaves safety off, even if the input carried some, and reads nothing extra when not chosen', async () => {
    const result = await prepareApplicatorSheetPrintData('job-1', data, { ...options, includeSafetySheet: false });
    expect(result.safety).toBeUndefined();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('ignores saved billing-split preferences for crew and retains only the payer list', async () => {
    const customers = [
      { customer_name: 'North Farm', account_number: 'NF-100' },
      { customer_name: 'West Farm', account_number: 'WF-200' },
    ];
    const result = await prepareApplicatorSheetPrintData(
      'job-1', { ...data, customers }, { ...options, includeSafetySheet: false, includeBillingSplits: true }, false,
    );
    expect(result.customers).toEqual(customers);
    expect(result.billingSplits).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('lists exactly the job order lines, each with its own product signal word, even when names repeat', async () => {
    reply({ data: [{ id: 'p-1', epa_registration: '100-1', signal_word: 'Caution', rei_hours: 24, phi_days: 7 }, { id: 'p-2', epa_registration: null, signal_word: 'Danger', rei_hours: 48, phi_days: null }], error: null });
    const result = await prepareApplicatorSheetPrintData('job-1', data, { ...options, includeSafetySheet: true });
    expect(mockFrom).toHaveBeenCalledWith('products');
    expect(result.safety).toEqual([
      // Every value from today's product record, never the line's saved REI/PHI (Mason: "Yes, today's records").
      { product_name: 'TEST Same', epa_registration: '100-1', signal_word: 'Caution', rei_hours: 24, phi_days: 7 },
      { product_name: 'TEST Same', epa_registration: null, signal_word: 'Danger', rei_hours: 48, phi_days: null },
      { product_name: 'TEST Old', epa_registration: null, signal_word: null, rei_hours: null, phi_days: null },
    ]);
  });

  it('marks safety as not loaded (null) when the read fails', async () => {
    reply({ data: null, error: { message: 'permission denied' } });
    expect((await prepareApplicatorSheetPrintData('job-1', data, { ...options, includeSafetySheet: true })).safety).toBeNull();
  });

  it('marks safety as not loaded when a line product record cannot be read', async () => {
    reply({ data: [{ id: 'p-1', epa_registration: null, signal_word: 'Caution', rei_hours: 24, phi_days: 7 }], error: null });
    expect((await prepareApplicatorSheetPrintData('job-1', data, { ...options, includeSafetySheet: true })).safety).toBeNull();
  });
});
