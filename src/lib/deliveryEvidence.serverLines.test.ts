import { describe, it, expect, vi, beforeEach } from 'vitest';

const result = vi.hoisted(() => ({ data: null as unknown, error: null as unknown }));
vi.mock('./db', () => ({
  supabase: { from: () => ({ select: () => ({ eq: async () => result }) }) },
  assertRpcResult: vi.fn(),
  checkMutationResult: vi.fn(),
}));

import { isLoadProofRefusal, linesChangedOnServer } from './deliveryEvidence';

// Sol on #2614, HIGH 1: proof taken for the screen's lines must not complete lines the office changed since.
describe('linesChangedOnServer', () => {
  const onScreen = [
    { id: 'd1', order_item_id: 'oi-1', product_id: 'p-1', quantity: 6 },
    { id: 'd2', order_item_id: 'oi-2', product_id: 'p-2', quantity: 2.5 },
  ];
  beforeEach(() => { result.data = null; result.error = null; });

  it('is false when the server has the same lines, in any order, quantities as text', async () => {
    result.data = [{ id: 'd2', order_item_id: 'oi-2', product_id: 'p-2', quantity: '2.500' }, { id: 'd1', order_item_id: 'oi-1', product_id: 'p-1', quantity: 6 }];
    await expect(linesChangedOnServer('del', onScreen)).resolves.toBe(false);
  });

  it('is true when a quantity was raised, a line added or removed, or a line replaced', async () => {
    result.data = [{ ...onScreen[0], quantity: 10 }, onScreen[1]];
    await expect(linesChangedOnServer('del', onScreen)).resolves.toBe(true);
    result.data = [...onScreen, { id: 'd3', order_item_id: 'oi-3', product_id: 'p-3', quantity: 1 }];
    await expect(linesChangedOnServer('del', onScreen)).resolves.toBe(true);
    result.data = [onScreen[0]];
    await expect(linesChangedOnServer('del', onScreen)).resolves.toBe(true);
    result.data = [onScreen[0], { ...onScreen[1], id: 'd9' }];
    await expect(linesChangedOnServer('del', onScreen)).resolves.toBe(true);
  });

  it('throws when the read fails, so the caller does not complete', async () => {
    result.error = new Error('offline');
    await expect(linesChangedOnServer('del', onScreen)).rejects.toThrow('offline');
  });

  it('treats a stale-quantities refusal as a reload, like a load-proof refusal', () => {
    expect(isLoadProofRefusal({ message: 'DELIVERY_QUANTITIES_STALE: this delivery' })).toBe(true);
  });
});
