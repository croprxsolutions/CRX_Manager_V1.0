import { describe, expect, it, vi } from 'vitest';
import type { UseTimingOption } from '../types';

const H = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('./db', () => ({ supabase: { from: H.from } }));
import { listProductUseTimingOptions, visibleProductUseTimingOptions } from './productUseTimings';

const options: UseTimingOption[] = [
  { code: 'pre_emerge_corn', label: 'Pre-Emerge Corn', timing_code: 'pre_emergence', crop: 'corn', category: 'Herbicide', sort_order: 20, is_active: true },
  { code: 'post_emerge_soybeans', label: 'Post-Emerge Soybeans', timing_code: 'post_emergence', crop: 'soybeans', category: 'Herbicide', sort_order: 60, is_active: true },
  { code: 'retired', label: 'Retired', timing_code: 'retired', crop: null, category: 'Herbicide', sort_order: 70, is_active: false },
  { code: 'foliar', label: 'Foliar', timing_code: 'foliar', crop: null, category: 'Foliar Fertilizer', sort_order: 90, is_active: true },
];

describe('product use timing options', () => {
  it('loads ordered options and exposes selected retired entries', async () => {
    const order = vi.fn().mockReturnThis();
    H.from.mockReturnValue({ select: vi.fn().mockReturnValue({ order: order.mockReturnValueOnce({ order: vi.fn().mockResolvedValue({ data: options, error: null }) }) }) });
    expect(await listProductUseTimingOptions()).toEqual(options);
    expect(H.from).toHaveBeenCalledWith('product_use_timing_options');
    expect(visibleProductUseTimingOptions(options, 'Herbicide', ['retired']).map((option) => option.code))
      .toEqual(['pre_emerge_corn', 'post_emerge_soybeans', 'retired']);
    expect(visibleProductUseTimingOptions(options, 'Foliar Fertilizer', []).map((option) => option.code))
      .toEqual(['foliar']);
  });

  it('surfaces a database load error', async () => {
    const error = new Error('read failed');
    H.from.mockReturnValue({ select: () => ({ order: () => ({ order: async () => ({ data: null, error }) }) }) });
    await expect(listProductUseTimingOptions()).rejects.toBe(error);
  });
});
