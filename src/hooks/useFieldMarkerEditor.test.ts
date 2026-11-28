import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { checkPendingMarker, createFieldMarker, deleteFieldMarker, MarkerAccessDenied, type MarkerPlacement } from '../lib/fieldMarkerData';
import { clearPendingMarker, PendingMarkerStorageError, readPendingMarker } from '../lib/fieldMarkerPending';
import type { FieldMarkerState, FieldObstacle } from '../types';
import { useFieldMarkerEditor } from './useFieldMarkerEditor';

vi.mock('../lib/fieldMarkerData', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/fieldMarkerData')>(),
  checkPendingMarker: vi.fn(),
  createFieldMarker: vi.fn(),
  deleteFieldMarker: vi.fn(),
}));

let pending: MarkerPlacement | null;
vi.mock('../lib/fieldMarkerPending', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/fieldMarkerPending')>(),
  readPendingMarker: vi.fn(async () => pending),
  reservePendingMarker: async (_actor: string, placement: MarkerPlacement) => pending ??= placement,
  clearPendingMarker: vi.fn(async () => { pending = null; }),
  startReservedMarkerWrite: async <T>(_actor: string, pin: MarkerPlacement, current: () => boolean, send: (sessionSignal: AbortSignal) => Promise<T>) => {
    if (pending?.id !== pin.id || !current()) throw new Error('The pending marker is no longer active.');
    return send(new AbortController().signal);
  },
}));

beforeEach(() => {
  pending = null;
  vi.mocked(createFieldMarker).mockReset();
  vi.mocked(checkPendingMarker).mockReset().mockResolvedValue('missing');
});

const complete: FieldMarkerState = { status: 'complete', markers: [], authors: new Map() };
const field = { id: 'field-a', name: 'Field A' };

it('keeps an unsent draft when another tab reserved a different marker', async () => {
  const { result } = renderHook(() => useFieldMarkerEditor('crew', false, () => complete, vi.fn()));
  await act(async () => result.current.begin(field));
  act(() => result.current.place(-89, 40));
  act(() => result.current.patch({ note: 'New pin in this tab' }));
  const draft = result.current.draft;
  pending = {
    id: 'other-tab', field_id: field.id, kind: 'gate', label: 'First pin',
    point_geojson: { type: 'Point', coordinates: [-88, 41] },
  };

  await act(async () => result.current.save());

  expect(result.current.draft).toEqual(draft);
  expect(result.current.message).toMatch(/Another tab has a pending save/);
  expect(createFieldMarker).not.toHaveBeenCalled();

  pending = null;
  vi.mocked(createFieldMarker).mockResolvedValueOnce('saved');
  await act(async () => result.current.save());
  expect(createFieldMarker).toHaveBeenCalledWith(expect.objectContaining({
    id: draft?.id, label: 'New pin in this tab',
  }), 'crew', expect.any(Function));
});

it('tells the crew to inspect the field when the local pending marker is damaged', async () => {
  vi.mocked(readPendingMarker).mockRejectedValueOnce(new PendingMarkerStorageError('Inspect the pins before adding another.'));
  const { result } = renderHook(() => useFieldMarkerEditor('crew', false, () => complete, vi.fn()));
  await act(async () => result.current.begin(field));
  expect(result.current.message).toBe('Inspect the pins before adding another.');
  expect(result.current.draft).toBeNull();
  expect(checkPendingMarker).not.toHaveBeenCalled();
});

it('refuses to send the marker after the auth session clears the pending reservation', async () => {
  let resume: () => void = () => {};
  const send = vi.fn();
  vi.mocked(createFieldMarker).mockImplementationOnce(async (_pin, _actor, startReservedWrite) => {
    await new Promise<void>((resolve) => { resume = resolve; });
    return startReservedWrite(async () => { send(); return 'saved' as const; });
  });
  const { result } = renderHook(() => useFieldMarkerEditor('crew', false, () => complete, vi.fn()));
  await act(async () => result.current.begin(field));
  act(() => result.current.place(-89, 40));
  let write = Promise.resolve();
  act(() => { write = result.current.save(); });
  await waitFor(() => expect(createFieldMarker).toHaveBeenCalledTimes(1));
  pending = null;
  await act(async () => { resume(); await write; });
  expect(send).not.toHaveBeenCalled();
});

it('counts Unicode characters when enforcing the marker note limit', async () => {
  vi.mocked(createFieldMarker).mockResolvedValueOnce('saved');
  const { result } = renderHook(() => useFieldMarkerEditor('crew', false, () => complete, vi.fn()));
  await act(async () => result.current.begin(field));
  const markerEmoji = String.fromCodePoint(0x1F6AA);
  act(() => result.current.place(-89, 40));
  act(() => result.current.patch({ note: markerEmoji.repeat(501) }));
  await act(async () => { await result.current.save(); });
  expect(result.current.message).toBe('Keep the marker note at 500 characters or fewer.');
  expect(createFieldMarker).not.toHaveBeenCalled();
  act(() => result.current.patch({ note: markerEmoji.repeat(500) }));
  await act(async () => { await result.current.save(); });
  expect(createFieldMarker).toHaveBeenCalledWith(expect.objectContaining({ label: markerEmoji.repeat(500) }), 'crew', expect.any(Function));
  expect(result.current.message).toBe('Marker added.');
});

it('confirms a saved marker even when the device pending record could not be removed', async () => {
  vi.mocked(createFieldMarker).mockResolvedValueOnce('saved');
  vi.mocked(clearPendingMarker).mockRejectedValueOnce(new Error('Local storage unavailable'));
  const { result } = renderHook(() => useFieldMarkerEditor('crew', false, () => complete, vi.fn()));
  await act(async () => result.current.begin(field));
  act(() => result.current.place(-89, 40));
  await act(async () => { await result.current.save(); });
  expect(result.current.message).toMatch(/^Marker added\. This device will check the pending save again/);
  expect(result.current.draft).toBeNull();
  expect(pending?.field_id).toBe(field.id);
});

it('clears a definitively rejected placement and tells the user to correct it', async () => {
  vi.mocked(createFieldMarker).mockResolvedValueOnce('rejected');
  const { result } = renderHook(() => useFieldMarkerEditor('crew', false, () => complete, vi.fn()));
  await act(async () => result.current.begin(field));
  act(() => result.current.place(-89, 40));
  await act(async () => result.current.save());
  expect(result.current.message).toMatch(/The marker was rejected/);
  expect(result.current.draft).toBeNull();
  expect(pending).toBeNull();
});

it('closes the delete confirmation with guidance if the field cannot be checked', async () => {
  const marker: FieldObstacle = {
    id: 'pin', field_id: field.id, kind: 'gate', label: null, entrance_number: null,
    point_geojson: { type: 'Point', coordinates: [-89, 40] },
    created_by: 'crew', created_at: '2026-11-25T12:00:00Z', updated_at: '2026-11-25T12:00:00Z',
  };
  const { result, rerender } = renderHook(({ available }) => useFieldMarkerEditor('crew', false,
    () => available ? complete : { ...complete, status: 'unavailable' }, vi.fn()), { initialProps: { available: true } });
  act(() => result.current.setTarget(marker));
  rerender({ available: false });
  await act(async () => { await result.current.remove(); });
  expect(deleteFieldMarker).not.toHaveBeenCalled();
  expect(result.current.target).toBeNull();
  expect(result.current.message).toBe('Check this field again before deleting its marker.');
});

it('clears the previous job draft and ignores its late receipt without starting another write', async () => {
  let finish = () => {};
  vi.mocked(createFieldMarker).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve('saved'); }));
  const refresh = vi.fn();
  const { result, rerender } = renderHook(({ scope }) =>
    useFieldMarkerEditor('crew', false, () => complete, refresh, { scope }),
  { initialProps: { scope: 'job-a:field-a' } });

  await act(async () => { result.current.begin(field); });
  act(() => result.current.place(-89, 40));
  let saving = Promise.resolve();
  act(() => { saving = result.current.save(); });
  await waitFor(() => expect(createFieldMarker).toHaveBeenCalledTimes(1));
  expect(result.current.saving).toBe(true);

  rerender({ scope: 'job-b:field-a' });
  rerender({ scope: 'job-a:field-a' });
  act(() => result.current.begin(field));
  expect(result.current.draft).toBeNull();
  expect(result.current.saving).toBe(true);

  await act(async () => { finish(); await saving; });
  expect(result.current.message).toBe('');
  expect(result.current.saving).toBe(false);
  expect(createFieldMarker).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();
});

it('clears the draft only when the field read confirms lost access', async () => {
  const refresh = vi.fn();
  const { result, rerender } = renderHook(({ read }: { read: FieldMarkerState }) =>
    useFieldMarkerEditor('crew', false, () => read, refresh),
  { initialProps: { read: complete } });

  await act(async () => { result.current.begin(field); });
  act(() => result.current.patch({ note: 'Keep until access is checked' }));
  rerender({ read: { ...complete, status: 'unavailable' } });
  expect(result.current.draft?.note).toBe('Keep until access is checked');

  rerender({ read: { ...complete, status: 'unavailable', accessDenied: true } });
  expect(result.current.draft).toBeNull();
  expect(result.current.placing).toBe(false);
  expect(result.current.message).toMatch(/The unsaved marker draft closed/);
});

it('recovers one submitted placement when the field returns after a lost response', async () => {
  vi.mocked(createFieldMarker).mockClear();
  let loseResponse = () => {};
  vi.mocked(createFieldMarker)
    .mockImplementationOnce(() => new Promise((_resolve, reject) => {
      loseResponse = () => reject(new Error('Response lost'));
    }))
    .mockResolvedValueOnce('saved');
  const refresh = vi.fn();
  const { result, rerender } = renderHook(({ scope }) =>
    useFieldMarkerEditor('crew', false, () => complete, refresh, { scope }),
  { initialProps: { scope: 'job-1' } });
  await act(async () => { result.current.begin(field); });
  act(() => result.current.place(-89, 40));
  act(() => result.current.patch({ note: 'Use the east gate' }));
  let saving = Promise.resolve();
  act(() => { saving = result.current.save(); });
  await waitFor(() => expect(createFieldMarker).toHaveBeenCalledTimes(1));
  rerender({ scope: 'job-2' });
  expect(result.current.draft).toBeNull();
  await act(async () => { loseResponse(); await saving; });
  await act(async () => { result.current.begin(field); });
  expect(result.current.draft?.submitted).toBe(true);
  expect(result.current.draft?.note).toBe('Use the east gate');
  await act(async () => { await result.current.save(); });
  expect(vi.mocked(createFieldMarker).mock.calls).toEqual([
    [expect.objectContaining({ label: 'Use the east gate' }), 'crew', expect.any(Function)],
    [vi.mocked(createFieldMarker).mock.calls[0][0], 'crew', expect.any(Function)],
  ]);
  expect(result.current.message).toBe('Marker added.');
});

it('clears a confirmed pending save without showing a late message on a different view', async () => {
  vi.mocked(createFieldMarker).mockClear();
  let finish = () => {};
  vi.mocked(createFieldMarker).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve('saved'); }));
  const denied: FieldMarkerState = { status: 'unavailable', markers: [], authors: new Map(), accessDenied: true };
  const refresh = vi.fn();
  const { result, rerender } = renderHook(({ read }: { read: FieldMarkerState }) =>
    useFieldMarkerEditor('crew', false, () => read, refresh),
  { initialProps: { read: complete } });
  await act(async () => { result.current.begin(field); });
  act(() => result.current.place(-89, 40));
  let saving = Promise.resolve();
  act(() => { saving = result.current.save(); });
  await waitFor(() => expect(createFieldMarker).toHaveBeenCalledTimes(1));

  rerender({ read: denied });
  expect(result.current.draft).toBeNull();
  await act(async () => { finish(); await saving; });
  expect(result.current.message).toBe('');
  rerender({ read: complete });
  expect(pending).toBeNull();
  expect(createFieldMarker).toHaveBeenCalledTimes(1);
});

it('keeps a stored placement hidden when a fresh field check fails', async () => {
  pending = {
    id: '11111111-1111-4111-8111-111111111111', field_id: field.id, kind: 'gate',
    label: 'Keep this private', point_geojson: { type: 'Point', coordinates: [-89, 40] },
  };
  vi.mocked(checkPendingMarker).mockRejectedValueOnce(new MarkerAccessDenied('Field no longer available'));
  const onAccessDenied = vi.fn();
  const { result } = renderHook(() => useFieldMarkerEditor('crew', false, () => complete, vi.fn(), { onAccessDenied }));
  await act(async () => { result.current.begin(field); });
  expect(result.current.draft).toBeNull();
  expect(result.current.preview).toBeNull();
  expect(result.current.message).toMatch(/markers are no longer available/);
  expect(onAccessDenied).toHaveBeenCalledWith(field.id);
  expect(pending.label).toBe('Keep this private');
  expect(createFieldMarker).not.toHaveBeenCalled();
});

it('does not open a marker draft if drawing starts while checking device storage', async () => {
  let finish = () => {};
  vi.mocked(readPendingMarker).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(null); }));
  const { result, rerender } = renderHook(({ placementAllowed }) =>
    useFieldMarkerEditor('crew', false, () => complete, vi.fn(), { placementAllowed }),
  { initialProps: { placementAllowed: true } });
  act(() => result.current.begin(field));
  rerender({ placementAllowed: false });
  await act(async () => { finish(); });
  expect(result.current.draft).toBeNull();
  expect(result.current.saving).toBe(false);
});
