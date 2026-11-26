import { describe, expect, it, vi } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock('./db', () => ({ supabaseUntyped: { from: mockFrom } }));

import {
  FIELD_SOURCED_FROM_DB_READY,
  batchCustomerSuppliedLineNeedsVendor,
  loadSavedJobSourceVendors,
  loadJobChemicalSources,
  loadJobStockPath,
  sourceReadBlocksJobSave,
} from './jobSourcedFrom';

function resultChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const method = () => chain;
  for (const name of ['select', 'eq', 'in', 'limit', 'maybeSingle']) chain[name] = method;
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  return chain;
}

describe('job sourced-from readiness', () => {
  it('keeps the feature disabled until the database lane is ready', () => {
    expect(FIELD_SOURCED_FROM_DB_READY).toBe(false);
  });

  it('blocks only a known batch customer-supplied line without a vendor', () => {
    expect(batchCustomerSuppliedLineNeedsVendor({ available: false, path: null }, true, null)).toBe(false);
    expect(batchCustomerSuppliedLineNeedsVendor({ available: true, path: 'at_completion' }, true, null)).toBe(false);
    expect(batchCustomerSuppliedLineNeedsVendor({ available: true, path: 'batch' }, true, null)).toBe(true);
    expect(batchCustomerSuppliedLineNeedsVendor({ available: true, path: 'batch' }, true, 'vendor-1')).toBe(false);
  });

  it('blocks save when office source data could not be read, but leaves disabled/crew paths alone', () => {
    expect(sourceReadBlocksJobSave(true, true, false)).toBe(true);
    expect(sourceReadBlocksJobSave(true, true, true)).toBe(false);
    expect(sourceReadBlocksJobSave(false, true, false)).toBe(false);
    expect(sourceReadBlocksJobSave(true, false, false)).toBe(false);
  });

  it('reports an unavailable stock path when the column read fails', async () => {
    mockFrom.mockReturnValue(resultChain({ data: null, error: { message: 'column stock_path does not exist' } }));
    await expect(loadJobStockPath('job-1')).resolves.toEqual({ available: false, path: null });
  });

  it('reports chemical source data unavailable when the new column is missing', async () => {
    mockFrom.mockReturnValue(resultChain({ data: null, error: { message: 'column source_vendor_id does not exist' } }));
    await expect(loadJobChemicalSources('job-1')).resolves.toEqual({ available: false, sourcesByChemicalId: {} });
  });

  it('loads source IDs for existing lines and keeps null distinct from an unavailable read', async () => {
    mockFrom.mockReturnValue(resultChain({
      data: [
        { id: 'chemical-1', source_vendor_id: 'vendor-1' },
        { id: 'chemical-2', source_vendor_id: null },
      ],
      error: null,
    }));
    await expect(loadJobChemicalSources('job-1')).resolves.toEqual({
      available: true,
      sourcesByChemicalId: { 'chemical-1': 'vendor-1', 'chemical-2': null },
    });
  });

  it('marks a saved vendor inactive without discarding its ID', async () => {
    mockFrom.mockReturnValue(resultChain({
      data: [{ id: 'vendor-1', name: 'Old Supplier', deleted_at: '2026-11-01T00:00:00Z' }],
      error: null,
    }));
    await expect(loadSavedJobSourceVendors(['vendor-1'])).resolves.toEqual([
      { id: 'vendor-1', name: 'Old Supplier', inactive: true },
    ]);
  });
});
