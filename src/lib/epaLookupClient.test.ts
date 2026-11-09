import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ supabase: { functions: { invoke: vi.fn() } } }));

import { isEpaLookupResult } from './epaLookupClient';

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
