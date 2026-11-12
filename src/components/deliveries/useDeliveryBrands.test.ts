import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BRANDS_NOT_CONFIRMED, type DeliveryBrands } from '../../lib/deliveryBrands';
import { useDeliveryBrands } from './useDeliveryBrands';
import { supabaseUntyped } from '../../lib/db';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'driver-1' } }) }));
const toast = vi.fn();
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast }) }));
let signal: () => Promise<boolean> = async () => true;
vi.mock('../../lib/connectivity', () => ({ hasSignal: () => signal() }));

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

    await act(async () => { seq = await result.current.saveForCompletion(); });
    // Completion goes ahead, but not as confirmed: the driver's choice differs from the saved picks.
    expect(seq).toBe(BRANDS_NOT_CONFIRMED);
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
  it('completes unconfirmed and tells the driver, but an ordinary save still refuses', async () => {
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
    await act(async () => { seq = await result.current.saveForCompletion(); });
    expect(seq).toBe(BRANDS_NOT_CONFIRMED);
    expect(toast).toHaveBeenCalledWith('warning', expect.stringContaining('Completing without these brand choices'));

    rpc.mockResolvedValue({ data: null, error: { message: 'BRAND_PICKS_CHANGED: someone else saved' } } as never);
    getDeliveryBrands.mockResolvedValueOnce(brands(8));
    await act(async () => { seq = await result.current.saveForCompletion(); });
    expect(seq).toBe(BRANDS_NOT_CONFIRMED); // someone else saving first: completes unconfirmed, office follows up
    // The driver's choice stays on screen over the reloaded picks.
    await waitFor(() => expect(result.current.brands?.event_seq).toBe(8));
    expect(result.current.drafts.L1).toEqual([pick]);

    rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } } as never);
    await act(async () => { seq = await result.current.saveForCompletion(); });
    expect(seq).toBe(BRANDS_NOT_CONFIRMED); // any failed brand save still completes
    rpc.mockRestore();
  });

  it('completes unconfirmed when the brands never loaded, and confirmed when nothing changed', async () => {
    getDeliveryBrands.mockRejectedValueOnce(new Error('down'));
    const failed = renderHook(() => useDeliveryBrands('D1', true));
    await waitFor(() => expect(failed.result.current.loadFailed).toBe(true));
    let seq = 0;
    await act(async () => { seq = await failed.result.current.saveForCompletion(); });
    expect(seq).toBe(BRANDS_NOT_CONFIRMED);

    getDeliveryBrands.mockResolvedValueOnce(brands(4));
    const ok = renderHook(() => useDeliveryBrands('D1', true));
    await waitFor(() => expect(ok.result.current.brands?.event_seq).toBe(4));
    await act(async () => { seq = await ok.result.current.saveForCompletion(); });
    expect(seq).toBe(4);
  });
});

describe('useDeliveryBrands when the stop changes while a save is in flight', () => {
  it('ignores the old stop’s late conflict, so its brands never replace the new stop’s', async () => {
    getDeliveryBrands.mockReset();
    getDeliveryBrands.mockImplementation(async (id: string) => ({ ...brands(id === 'D1' ? 1 : 20), delivery_id: id }));
    const { result, rerender } = renderHook(({ id }) => useDeliveryBrands(id, true), { initialProps: { id: 'D1' } });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D1'));
    act(() => result.current.setLineDraft('L1', [pick]));

    let refuse!: (v: unknown) => void;
    const rpc = vi.spyOn(supabaseUntyped, 'rpc').mockReturnValue(new Promise((resolve) => { refuse = resolve; }) as never);
    let saving!: Promise<number | null>;
    act(() => { saving = result.current.save(); });
    await waitFor(() => expect(rpc).toHaveBeenCalled());

    rerender({ id: 'D2' });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D2'));
    getDeliveryBrands.mockClear();
    await act(async () => { refuse({ data: null, error: { message: 'BRAND_PICKS_CHANGED: someone else saved' } }); await saving; });

    expect(getDeliveryBrands).not.toHaveBeenCalledWith('D1');
    expect(result.current.brands?.delivery_id).toBe('D2');
    expect(result.current.brands?.event_seq).toBe(20);
    rpc.mockRestore();
    getDeliveryBrands.mockReset();
  });
});

describe('useDeliveryBrands when the stop changes during the signal check', () => {
  it('never sends the old stop’s save, so its reply cannot replace the new stop’s brands', async () => {
    getDeliveryBrands.mockImplementation(async (id: string) => ({ ...brands(id === 'D1' ? 1 : 20), delivery_id: id }));
    const { result, rerender } = renderHook(({ id }) => useDeliveryBrands(id, true), { initialProps: { id: 'D1' } });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D1'));
    act(() => result.current.setLineDraft('L1', [pick]));

    let answer!: (v: boolean) => void;
    signal = () => new Promise((resolve) => { answer = resolve; });
    const rpc = vi.spyOn(supabaseUntyped, 'rpc');
    let saving!: Promise<number | null>;
    let completing!: Promise<number>;
    act(() => { saving = result.current.save(); });
    rerender({ id: 'D2' });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D2'));
    signal = async () => true;
    await act(async () => { answer(true); expect(await saving).toBeNull(); });

    // Completion's save is bound the same way.
    act(() => result.current.setLineDraft('L1', [pick]));
    signal = () => new Promise((resolve) => { answer = resolve; });
    act(() => { completing = result.current.saveForCompletion(); });
    rerender({ id: 'D1' });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D1'));
    await act(async () => { answer(true); expect(await completing).toBe(BRANDS_NOT_CONFIRMED); });

    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.brands?.event_seq).toBe(1);
    rpc.mockRestore();
    signal = async () => true;
    getDeliveryBrands.mockReset();
  });
});

describe('useDeliveryBrands when a caller saves for a stop no longer on screen', () => {
  it('refuses the old stop’s completion save, so it never replaces the new stop’s brands', async () => {
    getDeliveryBrands.mockImplementation(async (id: string) => ({ ...brands(id === 'D1' ? 1 : 20), delivery_id: id }));
    const { result, rerender } = renderHook(({ id }) => useDeliveryBrands(id, true), { initialProps: { id: 'D1' } });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D1'));
    act(() => result.current.setLineDraft('L1', [pick]));
    await waitFor(() => expect(result.current.dirty).toBe(true));
    // The completion handler captured this render's function, then awaited its own signal check.
    const oldSaveForCompletion = result.current.saveForCompletion;
    const rpc = vi.spyOn(supabaseUntyped, 'rpc');

    rerender({ id: 'D2' });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D2'));
    let seq = 0;
    await act(async () => { seq = await oldSaveForCompletion(); });

    expect(seq).toBe(BRANDS_NOT_CONFIRMED);
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.brands?.event_seq).toBe(20);
    rpc.mockRestore();
    getDeliveryBrands.mockReset();
  });
});

describe('useDeliveryBrands: every reply is tied to the stop that sent it', () => {
  const twoStops = () => getDeliveryBrands.mockImplementation(async (id: string) => ({ ...brands(id === 'D1' ? 1 : 20), delivery_id: id }));

  it('drops the old stop’s late successful save', async () => {
    twoStops();
    const { result, rerender } = renderHook(({ id }) => useDeliveryBrands(id, true), { initialProps: { id: 'D1' } });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D1'));
    act(() => result.current.setLineDraft('L1', [pick]));
    let reply!: (v: unknown) => void;
    const rpc = vi.spyOn(supabaseUntyped, 'rpc').mockReturnValue(new Promise((resolve) => { reply = resolve; }) as never);
    let saving!: Promise<number | null>;
    act(() => { saving = result.current.save(); });
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    rerender({ id: 'D2' });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D2'));
    await act(async () => { reply({ data: { delivery_id: 'D1', event_seq: 2, picks: [] }, error: null }); expect(await saving).toBeNull(); });
    expect(result.current.brands?.delivery_id).toBe('D2');
    expect(result.current.brands?.event_seq).toBe(20);
    expect(result.current.savedAt).toBeNull();
    rpc.mockRestore();
    getDeliveryBrands.mockReset();
  });

  it('ignores a reload the old stop asked for after an edit that finished late', async () => {
    twoStops();
    const { result, rerender } = renderHook(({ id }) => useDeliveryBrands(id, true), { initialProps: { id: 'D1' } });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D1'));
    const oldReload = result.current.reload;
    rerender({ id: 'D2' });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D2'));
    getDeliveryBrands.mockClear();
    await act(async () => { await oldReload({ discard: ['L1'] }); });
    expect(getDeliveryBrands).not.toHaveBeenCalled();
    expect(result.current.brands?.delivery_id).toBe('D2');
    getDeliveryBrands.mockReset();
  });

  it('drops the old stop’s late load reply', async () => {
    let answerD1!: (b: DeliveryBrands) => void;
    getDeliveryBrands.mockImplementation((id: string) => (id === 'D1'
      ? new Promise((resolve) => { answerD1 = resolve; })
      : Promise.resolve({ ...brands(20), delivery_id: id })));
    const { result, rerender } = renderHook(({ id }) => useDeliveryBrands(id, true), { initialProps: { id: 'D1' } });
    rerender({ id: 'D2' });
    await waitFor(() => expect(result.current.brands?.delivery_id).toBe('D2'));
    await act(async () => { answerD1({ ...brands(1), delivery_id: 'D1' }); });
    expect(result.current.brands?.delivery_id).toBe('D2');
    getDeliveryBrands.mockReset();
  });
});
