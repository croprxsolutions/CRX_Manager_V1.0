import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, calls, driverFarms } = vi.hoisted(() => ({
  query: { result: { data: [] as unknown[], error: null as unknown } },
  calls: [] as { method: string; args: unknown[] }[],
  driverFarms: vi.fn(),
}));

vi.mock('./db', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'is', 'in', 'eq', 'gte', 'order']) {
    chain[method] = (...args: unknown[]) => { calls.push({ method, args }); return chain; };
  }
  chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(query.result).then(ok, bad);
  return { supabase: { from: () => chain } };
});
vi.mock('./driverFarms', () => ({ fetchDriverFarms: driverFarms }));
vi.mock('./dateUtils', async () => {
  const actual = await vi.importActual<typeof import('./dateUtils')>('./dateUtils');
  return { ...actual, todayInBusinessTz: () => '2026-11-24' };
});

import { fetchDoneTodayStops, fetchNextRouteStopId, sortRouteStops } from './routeStops';

const stop = (id: string, status: string, scheduled_date: string | null) => ({ id, status, scheduled_date, scheduled_time: null });

beforeEach(() => {
  calls.length = 0;
  query.result = { data: [], error: null };
  driverFarms.mockReset();
});

describe('sortRouteStops (My Route order)', () => {
  it('puts in-progress stops first, then sorts by date, keeping query order within a date', () => {
    const rows = [stop('a', 'scheduled', '2026-11-25'), stop('b', 'scheduled', '2026-11-24'), stop('c', 'in_progress', '2026-11-26'), stop('d', 'scheduled', '2026-11-24')];
    expect(sortRouteStops(rows).map((r) => r.id)).toEqual(['c', 'b', 'd', 'a']);
  });
});

describe('fetchNextRouteStopId (Next Stop)', () => {
  it('opens the first remaining stop on today\'s route in My Route order, skipping the current stop', async () => {
    query.result = { data: [stop('done', 'in_progress', '2026-11-24'), stop('later', 'scheduled', '2026-11-24'), stop('next', 'in_progress', '2026-11-24')], error: null };
    await expect(fetchNextRouteStopId('done')).resolves.toBe('next');
    expect(calls).toContainEqual({ method: 'in', args: ['status', ['scheduled', 'in_progress']] });
  });

  it('counts overdue stops as today\'s but leaves future days and undated stops on My Route', async () => {
    query.result = { data: [stop('overdue', 'scheduled', '2026-11-20')], error: null };
    await expect(fetchNextRouteStopId('x')).resolves.toBe('overdue');
    query.result = { data: [stop('tomorrow', 'scheduled', '2026-11-25'), stop('undated', 'scheduled', null)], error: null };
    await expect(fetchNextRouteStopId('x')).resolves.toBeNull();
  });

  it('throws on a failed read so the caller can fall back to My Route', async () => {
    query.result = { data: null as unknown as unknown[], error: new Error('offline') };
    await expect(fetchNextRouteStopId('x')).rejects.toThrow('offline');
  });
});

describe('fetchDoneTodayStops (Done today)', () => {
  it('reads only completed stops since the start of today, newest first, with the joined farm for the office', async () => {
    query.result = { data: [{ id: 'd1', delivery_number: 'DEL-1', customer_id: 'c1', completed_at: '2026-11-24T15:00:00Z', signed_by: 'Pat', customer: { farm_name: 'Wells Farm' } }], error: null };
    const rows = await fetchDoneTodayStops(false);
    expect(rows).toEqual([{ id: 'd1', delivery_number: 'DEL-1', completed_at: '2026-11-24T15:00:00Z', signed_by: 'Pat', farm_name: 'Wells Farm' }]);
    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'completed'] });
    // Chicago midnight on 2026-11-24 (standard time) is 06:00 UTC.
    expect(calls).toContainEqual({ method: 'gte', args: ['completed_at', '2026-11-24T06:00:00.000Z'] });
    expect(calls).toContainEqual({ method: 'order', args: ['completed_at', { ascending: false }] });
    expect(driverFarms).not.toHaveBeenCalled();
  });

  it('gives a driver farm names from the driver lookup, never the customers join', async () => {
    query.result = { data: [{ id: 'd1', delivery_number: 'DEL-1', customer_id: 'c1', completed_at: null, signed_by: null }], error: null };
    driverFarms.mockResolvedValue(new Map([['c1', { id: 'c1', farm_name: 'Driver View Farm' }]]));
    const rows = await fetchDoneTodayStops(true);
    expect(rows[0].farm_name).toBe('Driver View Farm');
    const select = calls.find((c) => c.method === 'select');
    expect(String(select?.args[0])).not.toContain('customers');
  });
});
