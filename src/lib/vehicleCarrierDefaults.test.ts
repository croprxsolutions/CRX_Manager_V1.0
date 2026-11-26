import { describe, expect, it, vi } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock('./db', () => ({ supabaseUntyped: { from: mockFrom } }));

import {
  VEHICLE_CARRIER_DEFAULT_DB_READY,
  applyRigCarrierDefault,
  carrierRateSourceLabel,
  loadVehicleCarrierDefault,
} from './vehicleCarrierDefaults';

function resultChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const method = () => chain;
  for (const name of ['select', 'eq', 'maybeSingle']) chain[name] = method;
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  return chain;
}

describe('rig carrier defaults', () => {
  it('keeps the feature disabled until the database lane is ready', () => {
    expect(VEHICLE_CARRIER_DEFAULT_DB_READY).toBe(false);
  });

  it('reports an unavailable default when the new column is missing', async () => {
    mockFrom.mockReturnValue(resultChain({ data: null, error: { message: 'column default_carrier_gpa does not exist' } }));
    await expect(loadVehicleCarrierDefault('vehicle-1')).resolves.toEqual({ available: false, defaultGpa: null });
  });

  it('fills a blank or auto-filled value and protects a manual value', () => {
    expect(applyRigCarrierDefault('', false, 15)).toEqual({ value: '15', autoFilled: true, origin: 'rig_default' });
    expect(applyRigCarrierDefault('12', true, 15)).toEqual({ value: '15', autoFilled: true, origin: 'rig_default' });
    expect(applyRigCarrierDefault('12', false, 15)).toEqual({ value: '12', autoFilled: false, origin: 'manual' });
  });

  it('clears a previous rig default when the selected rig has no valid default', () => {
    expect(applyRigCarrierDefault('15', true, null)).toEqual({ value: '', autoFilled: false, origin: null });
    expect(applyRigCarrierDefault('12', false, null)).toEqual({ value: '12', autoFilled: false, origin: 'manual' });
    expect(applyRigCarrierDefault('', false, -1)).toEqual({ value: '', autoFilled: false, origin: null });
  });

  it('labels a loaded rate as the rig default when it matches, without inferring overwrite permission', () => {
    expect(carrierRateSourceLabel('15', 'loaded', 15)).toBe('(rig default)');
    expect(carrierRateSourceLabel('12', 'loaded', 15)).toBe('(changed for this job)');
    expect(carrierRateSourceLabel('15', 'manual', 15)).toBe('(changed for this job)');
    expect(carrierRateSourceLabel('', null, 15)).toBeNull();
  });
});
