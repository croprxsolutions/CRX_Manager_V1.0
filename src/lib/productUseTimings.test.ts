import { describe, expect, it, vi } from 'vitest';
import type { CropOption, UseTimingOption } from '../types';

const H = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('./db', () => ({
  supabaseUntyped: { from: H.from, rpc: H.rpc },
  assertRpcResult: (data: unknown, name: string) => {
    if (data == null) throw new Error(`${name} returned no data`);
    return data;
  },
}));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
import {
  addUseTimingOption, groupUseTimingOptionsByCrop, listProductUseTimingOptions, replacementFor,
  setUseTimingOptionActive, visibleProductUseTimingOptions,
} from './productUseTimings';
import { Sentry } from './sentry';

const options: UseTimingOption[] = [
  { code: 'pre_emerge_corn', label: 'Pre-Emerge Corn', timing_code: 'pre_emergence', crop: 'corn', category: 'Herbicide', sort_order: 20, is_active: true },
  { code: 'post_emerge_soybeans', label: 'Post-Emerge Soybeans', timing_code: 'post_emergence', crop: 'soybeans', category: 'Herbicide', sort_order: 60, is_active: true },
  { code: 'retired', label: 'Retired', timing_code: 'retired', crop: null, category: 'Herbicide', sort_order: 70, is_active: false },
  { code: 'foliar', label: 'Foliar', timing_code: 'foliar', crop: null, category: 'Foliar Fertilizer', sort_order: 90, is_active: true },
];
// A misspelled label turned off and replaced by an active one with the same crop + timing.
const oldWheat: UseTimingOption = { code: 'post_emerge_wheet', label: 'Post-Emerge Wheet', timing_code: 'post_emergence', crop: 'wheat', category: 'Herbicide', sort_order: 80, is_active: false };
const newWheat: UseTimingOption = { code: 'post_emerge_wheat', label: 'Post-Emerge Wheat', timing_code: 'post_emergence', crop: 'wheat', category: 'Herbicide', sort_order: 90, is_active: true };
const crops: CropOption[] = [
  { code: 'corn', label: 'Corn', sort_order: 10, is_active: true },
  { code: 'soybeans', label: 'Soybeans', sort_order: 20, is_active: true },
  { code: 'wheat', label: 'Wheat', sort_order: 30, is_active: true },
];
const codes = (list: UseTimingOption[]) => list.map((option) => option.code);

describe('product use timing options', () => {
  it('loads ordered options and shows a turned-off option only while held', async () => {
    const order = vi.fn().mockReturnThis();
    H.from.mockReturnValue({ select: vi.fn().mockReturnValue({ order: order.mockReturnValueOnce({ order: vi.fn().mockResolvedValue({ data: options, error: null }) }) }) });
    expect(await listProductUseTimingOptions()).toEqual(options);
    expect(H.from).toHaveBeenCalledWith('product_use_timing_options');
    expect(codes(visibleProductUseTimingOptions(options, 'Herbicide', ['retired']))).toEqual(['pre_emerge_corn', 'post_emerge_soybeans', 'retired']);
    expect(codes(visibleProductUseTimingOptions(options, 'Herbicide', []))).toEqual(['pre_emerge_corn', 'post_emerge_soybeans']);
    // Saved on the product but unticked before saving: still shown, so the untick can be undone.
    expect(codes(visibleProductUseTimingOptions(options, 'Herbicide', [], ['retired']))).toContain('retired');
    expect(codes(visibleProductUseTimingOptions(options, 'Foliar Fertilizer', []))).toEqual(['foliar']);
  });

  it('never offers the same crop + timing twice: the ticked turned-off one offers Switch instead', () => {
    const all = [...options, oldWheat, newWheat];
    expect(codes(visibleProductUseTimingOptions(all, 'Herbicide', ['post_emerge_wheet']))).not.toContain('post_emerge_wheat');
    expect(replacementFor(all, oldWheat)?.code).toBe('post_emerge_wheat');
    expect(replacementFor(all, newWheat)).toBeUndefined();
    // After the switch the new one is ticked and the old one is still visible, unticked, because it was saved.
    expect(codes(visibleProductUseTimingOptions(all, 'Herbicide', ['post_emerge_wheat'], ['post_emerge_wheet'])))
      .toEqual(expect.arrayContaining(['post_emerge_wheat', 'post_emerge_wheet']));
    // Nobody holds the old one: only the new one is offered.
    expect(codes(visibleProductUseTimingOptions(all, 'Herbicide', []))).toEqual(['pre_emerge_corn', 'post_emerge_soybeans', 'post_emerge_wheat']);
  });

  it('groups by crop with Any crop first and unknown crops by code', () => {
    const grouped = groupUseTimingOptionsByCrop([...options, newWheat, { ...newWheat, code: 'x', crop: 'milo' }], crops);
    expect(grouped.map((group) => group.label)).toEqual(['Any crop', 'Corn', 'Soybeans', 'Wheat', 'milo']);
  });

  it('sends the exact RPC arguments with the retry key', async () => {
    H.rpc.mockResolvedValueOnce({ data: newWheat, error: null });
    await addUseTimingOption({ category: 'Herbicide', timingCode: 'post_emergence', crop: 'wheat', label: 'Post-Emerge Wheat', key: 'k1' });
    expect(H.rpc).toHaveBeenLastCalledWith('add_use_timing_option', {
      p_category: 'Herbicide', p_timing_code: 'post_emergence', p_crop: 'wheat', p_label: 'Post-Emerge Wheat', p_idempotency_key: 'k1',
    });
    H.rpc.mockResolvedValueOnce({ data: { ...oldWheat, sizes_holding: 2, parents_holding: 0 }, error: null });
    await setUseTimingOptionActive({ code: 'post_emerge_wheet', isActive: false, expectedVersion: 3, key: 'k2' });
    expect(H.rpc).toHaveBeenLastCalledWith('set_use_timing_option_active', {
      p_code: 'post_emerge_wheet', p_is_active: false, p_expected_option_version: 3, p_idempotency_key: 'k2',
    });
    H.rpc.mockResolvedValueOnce({ data: null, error: { message: 'USE_TIMING_STALE: "x" changed' } });
    await expect(setUseTimingOptionActive({ code: 'x', isActive: true, expectedVersion: 1, key: 'k3' })).rejects.toMatchObject({ message: expect.stringMatching(/^USE_TIMING_STALE/) });
    H.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(setUseTimingOptionActive({ code: 'x', isActive: true, expectedVersion: 1, key: 'k4' })).rejects.toThrow('returned no data');
  });

  it('surfaces a database load error', async () => {
    const error = new Error('read failed');
    H.from.mockReturnValue({ select: () => ({ order: () => ({ order: async () => ({ data: null, error }) }) }) });
    await expect(listProductUseTimingOptions()).rejects.toThrow('read failed');
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: 'fetch', action: 'load_use_timing_options' },
    });
  });
});
