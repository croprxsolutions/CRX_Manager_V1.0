import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { beforeEach, expect, it, vi } from 'vitest';
import { checkPendingMarker, createFieldMarker, deleteFieldMarker, MarkerSignalError, type MarkerPlacement } from './fieldMarkerData';

const { rpc, from, getSession } = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(),
  getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'crew' }, access_token: 'token' } }, error: null }),
}));
vi.mock('./db', async (importOriginal) => ({
  ...await importOriginal<typeof import('./db')>(),
  supabase: {
    rpc, from,
    auth: { getSession },
  },
  assertRpcResult: (data: unknown) => data,
}));

const marker: MarkerPlacement = {
  id: 'pin-a', field_id: 'field-a', kind: 'gate', label: null,
  point_geojson: { type: 'Point', coordinates: [-89, 40] },
};

beforeEach(() => from.mockClear());

const sendReserved = <T>(send: (signal: AbortSignal) => Promise<T>) => send(new AbortController().signal);
const receipt = (state: string) => ({ setHeader: () => ({ abortSignal: async () => ({ data: { state }, error: null }) }) });
const insertReply = (response: unknown) => ({ insert: () => ({ select: () => ({ setHeader: () => ({
  abortSignal: () => ({ single: async () => response }),
}) }) }) });

it.each(['saved', 'removed'] as const)('checks the receipt again when the original pin ID already exists (%s)', async (state) => {
  rpc.mockReturnValueOnce(receipt('missing')).mockReturnValueOnce(receipt(state));
  from.mockReturnValueOnce(insertReply({ data: null, error: { code: '23505' } }));
  await expect(createFieldMarker(marker, 'crew', sendReserved)).resolves.toBe(state);
});

it.each([
  { receiptState: 'missing', expected: 'rejected' },
  { receiptState: 'saved', expected: 'saved' },
])('uses the receipt after the database rejects the placement ($receiptState)', async ({ receiptState, expected }) => {
  rpc.mockReturnValueOnce(receipt('missing')).mockReturnValueOnce(receipt(receiptState));
  from.mockReturnValueOnce(insertReply({ data: null, error: { code: '22023', message: 'FIELD_MARKER_POINT_INVALID' } }));
  await expect(createFieldMarker(marker, 'crew', sendReserved)).resolves.toBe(expected);
});

it.each([{ field_id: 'other-field' }, { created_by: 'other-user' }])('rejects a mismatched insert confirmation (%o)', async (wrong) => {
  rpc.mockReturnValueOnce(receipt('missing'));
  from.mockReturnValueOnce(insertReply({ data: { ...marker, created_by: 'crew', ...wrong }, error: null }));
  await expect(createFieldMarker(marker, 'crew', sendReserved)).rejects.toThrow('Marker confirmation did not match');
});

it('rejects a stale delete and sends the exact version and field', async () => {
  const updatedAt = '2026-11-25T09:00:00.123456Z';
  const chain = {
    eq: vi.fn().mockReturnThis(),
    select: () => ({ setHeader: () => ({ abortSignal: async () => ({ data: [], error: null }) }) }),
  };
  from.mockReturnValueOnce({ delete: () => chain });
  await expect(deleteFieldMarker({
    ...marker, entrance_number: null, created_by: 'crew', created_at: updatedAt, updated_at: updatedAt,
  }, 'crew')).rejects.toThrow('Delete field marker failed: no rows were affected');
  expect(chain.eq.mock.calls).toEqual([['id', marker.id], ['field_id', marker.field_id], ['updated_at', updatedAt]]);
});

it('waits for a delayed receipt before asking the reservation to start the insert', async () => {
  let finishReceipt = () => {};
  const ready = new Promise<void>((resolve) => {
    rpc.mockReturnValue({ setHeader: () => ({ abortSignal: () => new Promise((finish) => {
      finishReceipt = () => finish({ data: { state: 'missing' }, error: null });
      resolve();
    }) }) });
  });
  const startReservedWrite = vi.fn().mockRejectedValue(new Error('The pending marker is no longer active.'));
  const saved = createFieldMarker(marker, 'crew', startReservedWrite);
  await ready;
  expect(startReservedWrite).not.toHaveBeenCalled();
  finishReceipt();
  await expect(saved).rejects.toThrow('The pending marker is no longer active.');
  expect(startReservedWrite).toHaveBeenCalledTimes(1);
  expect(from).not.toHaveBeenCalled();
});

it('cancels a real insert request signal on sign-out without relying on AbortSignal.any', async () => {
  vi.stubGlobal('AbortSignal', {});
  try {
    const session = new AbortController();
    rpc.mockReturnValue({ setHeader: () => ({ abortSignal: async () => ({ data: { state: 'missing' }, error: null }) }) });
    let started = () => {};
    const sending = new Promise<void>((resolve) => { started = resolve; });
    from.mockReturnValue({ insert: () => ({ select: () => ({ setHeader: () => ({
      abortSignal: (signal: AbortSignal) => ({ single: () => new Promise((_resolve, reject) => {
        expect(signal.aborted).toBe(false);
        signal.addEventListener('abort', () => reject(new Error('Insert aborted')), { once: true });
        started();
      }) }),
    }) }) }) });
    const save = createFieldMarker(marker, 'crew', (send) => send(session.signal));
    const failed = expect(save).rejects.toThrow('Insert aborted');
    await sending;
    session.abort();
    await failed;
  } finally {
    vi.unstubAllGlobals();
  }
});

it('identifies a lost connection during the receipt lookup', async () => {
  rpc.mockReturnValue({ setHeader: () => ({ abortSignal: async () => ({ data: null, error: { message: 'Failed to fetch' }, status: 0 }) }) });
  await expect(checkPendingMarker(marker, 'crew')).rejects.toBeInstanceOf(MarkerSignalError);
});

it('identifies a lost connection while refreshing the auth session', async () => {
  getSession.mockResolvedValueOnce({ data: { session: null }, error: new AuthRetryableFetchError('Offline', 0) });
  await expect(checkPendingMarker(marker, 'crew')).rejects.toBeInstanceOf(MarkerSignalError);
});
