import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { DeliveryBrands } from '../../lib/deliveryBrands';
import { useDeliveryBrands } from './useDeliveryBrands';
import { supabaseUntyped } from '../../lib/db';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'driver-1' } }) }));
const toast = vi.fn();
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('../../lib/connectivity', () => ({ hasSignal: async () => true }));

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

describe('useDeliveryBrands completion save', () => {
  it('leaves out a half-filled split instead of refusing, so completion is never blocked by brands', async () => {
    getDeliveryBrands.mockResolvedValueOnce(brands(3));
    const { result } = renderHook(() => useDeliveryBrands('D1', true));
    await waitFor(() => expect(result.current.brands?.event_seq).toBe(3));
    act(() => result.current.setLineDraft('L1', [{ ...pick, quantity: '5' }, { ...pick, brandId: '', quantity: '' }]));

    let seq: number | null = null;
    await act(async () => { seq = await result.current.save(); });
    expect(seq).toBeNull(); // an ordinary save still refuses and says why

    await act(async () => { seq = await result.current.save({ skipIncomplete: true }); });
    expect(seq).toBe(3); // completion goes ahead against the saved picks
  });
});

describe('useDeliveryBrands after a delivery edit', () => {
  it('drops unsaved choices on lines the edit cleared, so they are never saved against the changed line', async () => {
    getDeliveryBrands.mockResolvedValueOnce(brands(1));
    const { result } = renderHook(() => useDeliveryBrands('D1', true));
    await waitFor(() => expect(result.current.brands?.event_seq).toBe(1));
    act(() => { result.current.setLineDraft('L1', [pick]); result.current.setLineDraft('L2', [pick]); });

    getDeliveryBrands.mockResolvedValueOnce(brands(2));
    await act(async () => { await result.current.reload({ discard: ['L1'] }); });
    expect(result.current.drafts.L1).toEqual([]);
    expect(result.current.drafts.L2).toEqual([pick]);
  });
});

describe('useDeliveryBrands when the database refuses the choices at completion', () => {
  it('completes on the saved picks and tells the driver, but an ordinary save still refuses', async () => {
    getDeliveryBrands.mockResolvedValueOnce(brands(7));
    const { result } = renderHook(() => useDeliveryBrands('D1', true));
    await waitFor(() => expect(result.current.brands?.event_seq).toBe(7));
    act(() => result.current.setLineDraft('L1', [pick]));
    const refused = { data: null, error: { message: 'BRAND_NOT_ON_LIST: that brand is no longer listed for this product' } };
    const rpc = vi.spyOn(supabaseUntyped, 'rpc').mockResolvedValue(refused as never);

    let seq: number | null = 0;
    await act(async () => { seq = await result.current.save(); });
    expect(seq).toBeNull();

    toast.mockClear();
    await act(async () => { seq = await result.current.save({ skipIncomplete: true }); });
    expect(seq).toBe(7);
    expect(toast).toHaveBeenCalledWith('warning', expect.stringContaining('Completing without these brand choices'));

    rpc.mockResolvedValue({ data: null, error: { message: 'BRAND_PICKS_CHANGED: someone else saved' } } as never);
    getDeliveryBrands.mockResolvedValueOnce(brands(8));
    await act(async () => { seq = await result.current.save({ skipIncomplete: true }); });
    expect(seq).toBeNull(); // someone else saving first still stops it, and reloads
    rpc.mockRestore();
  });
});
