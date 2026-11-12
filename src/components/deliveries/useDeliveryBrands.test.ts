import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { DeliveryBrands } from '../../lib/deliveryBrands';
import { useDeliveryBrands } from './useDeliveryBrands';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'driver-1' } }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const getDeliveryBrands = vi.fn();
vi.mock('../../lib/deliveryBrands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/deliveryBrands')>()),
  getDeliveryBrands: (id: string) => getDeliveryBrands(id),
}));

const brands = (seq: number): DeliveryBrands => ({
  delivery_id: 'D1', status: 'in_progress', event_seq: seq,
  lines: ['L1', 'L2'].map((id) => ({
    delivery_item_id: id, product_id: 'P', product_name: id, quantity: 5, quantity_delivered: null, unit_size: 'gal',
    brand_list: [{ source: 'size' as const, parent_id: null, brand_id: 'b1', brand_name: 'A', epa_registration: null, manufacturer: null, is_currently_sourced: true }],
    picks: [],
  })),
});
const pick = { brandId: 'b1', typedName: '', typedEpa: '', typedManufacturer: '', quantity: '' };

describe('useDeliveryBrands', () => {
  it('keeps a choice made while a reload was in flight, still unsaved', async () => {
    getDeliveryBrands.mockResolvedValueOnce(brands(1));
    const { result } = renderHook(() => useDeliveryBrands('D1', true));
    await waitFor(() => expect(result.current.brands?.event_seq).toBe(1));

    let reply!: (b: DeliveryBrands) => void;
    getDeliveryBrands.mockReturnValueOnce(new Promise((resolve) => { reply = resolve; }));
    let reload!: Promise<void>;
    act(() => { reload = result.current.reload(); });
    act(() => result.current.setLineDraft('L1', [pick]));
    await act(async () => { reply(brands(2)); await reload; });

    expect(result.current.brands?.event_seq).toBe(2);
    expect(result.current.drafts.L1).toEqual([pick]);
    expect(result.current.drafts.L2).toEqual([]);
    expect(result.current.dirty).toBe(true);
  });
});
