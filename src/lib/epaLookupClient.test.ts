import { describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./db', () => ({ supabase: { functions: { invoke } } }));
vi.mock('./epaRequestThrottle', () => ({ waitForEpaRequestSlot: async () => true }));

import { isEpaLookupResult, runRecordedEpaLookup } from './epaLookupClient';

const base = {
  found: true,
  regType: 'section3',
  eparegno: '264-849',
  productname: 'ABSOLUTE 500 SC FUNGICIDE',
  signalWordCanonical: 'Caution',
  needsManual: false,
  manufacturer: null,
  rupYn: 'No',
  productStatus: 'Active',
  isCancelled: false,
  activeIngredients: [],
  latestLabelPdfUrl: null,
  labelPdfs: [],
};

describe('isEpaLookupResult', () => {
  it('accepts replies with and without the moved-registration field', () => {
    expect(isEpaLookupResult(base)).toBe(true);
    expect(isEpaLookupResult({ ...base, transferredTo: null })).toBe(true);
    expect(isEpaLookupResult({ ...base, found: false, eparegno: '105211-77', transferredTo: '105211-77' })).toBe(true);
  });

  it('refuses a reply that claims a match and a move at once', () => {
    expect(isEpaLookupResult({ ...base, transferredTo: '105211-77' })).toBe(false);
    expect(isEpaLookupResult({ ...base, found: false, transferredTo: 7 })).toBe(false);
  });
});

describe('runRecordedEpaLookup (DM-4)', () => {
  const lookupId = '5a0c2c34-4a5c-4a1e-9a0e-2f3b9d1c7e11';

  it('sends only the lookup ID, never an EPA answer or number', async () => {
    invoke.mockResolvedValueOnce({ data: { ...base, record: { lookup_id: lookupId, outcome: 'proposal', proposal_id: 'p1' } }, error: null });
    const record = await runRecordedEpaLookup(lookupId);
    expect(invoke).toHaveBeenCalledWith('epa-lookup', { body: { lookupId } });
    expect(record).toEqual({ lookup_id: lookupId, outcome: 'proposal', proposal_id: 'p1' });
  });

  it('refuses a reply recorded for another lookup, and passes refusals through', async () => {
    invoke.mockResolvedValueOnce({ data: { record: { lookup_id: 'other', outcome: 'proposal' } }, error: null });
    await expect(runRecordedEpaLookup(lookupId)).rejects.toThrow('invalid response');
    invoke.mockResolvedValueOnce({ data: { error: 'Only the admin who started this EPA lookup can run it.' }, error: null });
    await expect(runRecordedEpaLookup(lookupId)).rejects.toThrow('Only the admin');
  });
});
