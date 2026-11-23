import { describe, it, expect, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./db', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  assertRpcResult: <T,>(data: unknown) => data as T,
}));

import { fetchDriverFarms, fetchDeliveryFarm } from './driverFarms';

describe('fetchDriverFarms', () => {
  it('asks for at most 500 farms per call and merges the answers', async () => {
    rpc.mockImplementation((_name: string, { p_customer_ids }: { p_customer_ids: string[] }) =>
      Promise.resolve({ data: { rows: p_customer_ids.map((id) => ({ id, farm_name: id })) }, error: null }));
    const ids = Array.from({ length: 1001 }, (_, i) => `f${i}`);
    const farms = await fetchDriverFarms([...ids, 'f0', null]);
    expect(rpc.mock.calls.map(([, args]) => (args as { p_customer_ids: string[] }).p_customer_ids.length)).toEqual([500, 500, 1]);
    expect(farms.size).toBe(1001);
  });

  it('reports a malformed reply instead of reading it as no farms (#2167)', async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    await expect(fetchDriverFarms(['f1'])).rejects.toThrow(/unexpected result/);
    rpc.mockResolvedValue({ data: { rows: 'invalid' }, error: null });
    await expect(fetchDriverFarms(['f1'])).rejects.toThrow(/unexpected result/);
  });

  it('treats an email of only spaces as no email (#2167)', async () => {
    rpc.mockResolvedValue({ data: { rows: [{ id: 'f1', farm_name: 'F', email: '   ' }, { id: 'f2', farm_name: 'G', email: ' a@b.c ' }] }, error: null });
    const farms = await fetchDriverFarms(['f1', 'f2']);
    expect(farms.get('f1')?.email).toBeNull();
    expect(farms.get('f2')?.email).toBe('a@b.c');
  });
});

describe('fetchDeliveryFarm (driver)', () => {
  it('keeps billing and shipping apart, so a no-site delivery can go shipping first', async () => {
    rpc.mockResolvedValue({ data: { rows: [{ id: 'f1', farm_name: 'F', phone: null, email: null, address: 'SHIP', billing_address: 'BILL', shipping_address: 'SHIP' }] }, error: null });
    const { data } = await fetchDeliveryFarm('f1', true);
    expect(data?.billing_address).toBe('BILL');
    expect(data?.shipping_address).toBe('SHIP');
  });
});
