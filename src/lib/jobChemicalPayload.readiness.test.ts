import { describe, expect, it, vi } from 'vitest';

vi.mock('./jobSourcedFrom', () => ({ FIELD_SOURCED_FROM_DB_READY: true }));

import { buildJobChemicalsPayload, type JobChemicalPayloadSource } from './jobChemicalPayload';

const payloadRow: JobChemicalPayloadSource = {
  product_id: 'product-1',
  quantity: '1',
  unit: 'gal',
  rate_per_acre: '1',
  rate_unit: 'gal/ac',
  cost_per_unit_cents: '100',
  price_per_unit_cents: '150',
  diluent_rate: '',
  rei_hours: '',
  phi_days: '',
  warehouse: '',
  vendor: '',
  customer_supplied: false,
  source_vendor_id: 'vendor-1',
};

describe('source vendor readiness', () => {
  it('adds the source vendor key when the readiness flag is enabled', () => {
    expect(buildJobChemicalsPayload([payloadRow])[0].source_vendor_id).toBe('vendor-1');
  });

  it('sends a null source vendor key for CRX-stock lines when enabled', () => {
    expect(buildJobChemicalsPayload([{ ...payloadRow, source_vendor_id: null }])[0].source_vendor_id).toBeNull();
  });
});
