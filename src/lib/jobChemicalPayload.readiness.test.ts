import { describe, expect, it, vi } from 'vitest';

vi.mock('./jobSourcedFrom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jobSourcedFrom')>()),
  FIELD_SOURCED_FROM_DB_READY: true,
}));

import { buildJobChemicalsPayload, type JobChemicalPayloadSource } from './jobChemicalPayload';
import { jobSupportsVendorSourcing } from './jobSourcedFrom';

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
  it('omits source_vendor_id on an at-completion job and includes it on a batch job', () => {
    const atCompletion = { available: true, path: 'at_completion' } as const;
    const batch = { available: true, path: 'batch' } as const;
    const oldPathPayload = buildJobChemicalsPayload(
      [payloadRow],
      jobSupportsVendorSourcing(true, true, atCompletion),
    )[0];
    const batchPayload = buildJobChemicalsPayload(
      [payloadRow],
      jobSupportsVendorSourcing(true, true, batch),
    )[0];

    expect(oldPathPayload).not.toHaveProperty('source_vendor_id');
    expect(batchPayload.source_vendor_id).toBe('vendor-1');
  });

  it('sends a null source vendor key for CRX-stock lines when enabled', () => {
    expect(buildJobChemicalsPayload([{ ...payloadRow, source_vendor_id: null }], true)[0].source_vendor_id).toBeNull();
  });
});
