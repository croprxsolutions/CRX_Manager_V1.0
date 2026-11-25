import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFieldMarkers } from './useFieldMarkers';
import { MarkerSignalError, readFieldMarkers } from '../lib/fieldMarkerData';
import type { FieldObstacle } from '../types';

vi.mock('../lib/fieldMarkerData', () => ({
  MARKER_REQUEST_TIMEOUT_MS: 15_000,
  MarkerSignalError: class extends Error {},
  readFieldMarkers: vi.fn(),
  readMarkerAuthors: vi.fn().mockResolvedValue({ authors: new Map(), authorsUnavailable: false }),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const marker: FieldObstacle = {
  id: 'washout', field_id: 'field-a', kind: 'washout', label: 'Deep ditch',
  point_geojson: { type: 'Point', coordinates: [-89, 40] },
  entrance_number: null,
  created_by: 'crew', created_at: '2026-11-24T15:00:00Z', updated_at: '2026-11-24T15:00:00Z',
};

describe('field marker reads', () => {
  beforeEach(() => { vi.mocked(readFieldMarkers).mockReset(); });

  it('keeps pins with a stale status on signal loss and clears them when access ends', async () => {
    const read = vi.mocked(readFieldMarkers)
      .mockResolvedValueOnce({ available: true, count: 1, markers: [marker] })
      .mockRejectedValueOnce(new MarkerSignalError())
      .mockResolvedValueOnce({ available: false });
    const hook = renderHook(() => useFieldMarkers('crew', ['field-a']));
    await waitFor(() => expect(hook.result.current.forField('field-a').status).toBe('complete'));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.forField('field-a')).toMatchObject({
      status: 'stale', markers: [marker], checkedAt: expect.any(Number),
    }));
    act(() => hook.result.current.refresh());
    expect(hook.result.current.forField('field-a')).toMatchObject({ status: 'stale', checking: true });
    await waitFor(() => expect(hook.result.current.forField('field-a')).toMatchObject({ status: 'unavailable', accessDenied: true, markers: [] }));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps pins visible with a checking status during a routine refresh', async () => {
    let finish: (row: Awaited<ReturnType<typeof readFieldMarkers>>) => void = () => {};
    vi.mocked(readFieldMarkers)
      .mockResolvedValueOnce({ available: true, count: 1, markers: [marker] })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const hook = renderHook(() => useFieldMarkers('crew', ['field-a']));
    await waitFor(() => expect(hook.result.current.forField('field-a').status).toBe('complete'));
    act(() => hook.result.current.refresh());
    expect(hook.result.current.forField('field-a')).toMatchObject({ status: 'loading', markers: [marker] });
    await act(async () => finish({ available: true, count: 1, markers: [marker] }));
    expect(hook.result.current.forField('field-a').status).toBe('complete');
  });

  it('pauses background checks while hidden and refreshes on reopening', async () => {
    const read = vi.mocked(readFieldMarkers).mockResolvedValue({ available: true, count: 1, markers: [marker] });
    const hook = renderHook(({ active, opened }) => useFieldMarkers('crew', ['field-a'], opened, active), {
      initialProps: { active: true, opened: 1 },
    });
    await waitFor(() => expect(hook.result.current.forField('field-a').status).toBe('complete'));
    hook.rerender({ active: false, opened: 1 });
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(read).toHaveBeenCalledTimes(1);
    hook.rerender({ active: true, opened: 2 });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('hides cached pins during a resumed access check and restores them only on signal loss', async () => {
    let fail = () => {};
    vi.mocked(readFieldMarkers)
      .mockResolvedValueOnce({ available: true, count: 1, markers: [marker] })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new MarkerSignalError()); }))
      .mockResolvedValueOnce({ available: false });
    const hook = renderHook(({ opened }) => useFieldMarkers('crew', ['field-a'], opened), { initialProps: { opened: 1 } });
    await waitFor(() => expect(hook.result.current.forField('field-a').markers).toEqual([marker]));

    hook.rerender({ opened: 2 });
    expect(hook.result.current.forField('field-a')).toMatchObject({ status: 'loading', markers: [] });
    await act(async () => fail());
    expect(hook.result.current.forField('field-a')).toMatchObject({ status: 'stale', markers: [marker] });

    hook.rerender({ opened: 3 });
    await waitFor(() => expect(hook.result.current.forField('field-a')).toMatchObject({
      status: 'unavailable', accessDenied: true, markers: [],
    }));
  });

  it('does not restore a confirmed deleted pin from an in-flight read or the stale cache', async () => {
    let finish: (row: Awaited<ReturnType<typeof readFieldMarkers>>) => void = () => {};
    const prior = { available: true, count: 1, markers: [marker] };
    vi.mocked(readFieldMarkers).mockResolvedValueOnce(prior)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockRejectedValueOnce(new MarkerSignalError());
    const hook = renderHook(() => useFieldMarkers('crew', ['field-a']));
    await waitFor(() => expect(hook.result.current.forField('field-a').markers).toEqual([marker]));
    act(() => hook.result.current.refresh());
    await act(async () => {
      hook.result.current.forgetDeletedMarker('field-a', marker.id);
      finish(prior);
      hook.result.current.refresh();
    });
    await waitFor(() => expect(hook.result.current.forField('field-a')).toMatchObject({ status: 'stale', markers: [] }));
  });

  it('drops late results from the previous account and reports count mismatches', async () => {
    let finishFirst: (result: Awaited<ReturnType<typeof readFieldMarkers>>) => void = () => {};
    vi.mocked(readFieldMarkers)
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ available: true, count: 1, markers: [] });
    const hook = renderHook(({ actor }) => useFieldMarkers(actor, ['field-a']), { initialProps: { actor: 'crew' } });
    hook.rerender({ actor: 'other' });
    await waitFor(() => expect(hook.result.current.forField('field-a')).toMatchObject({ status: 'incomplete', markers: [] }));
    await act(async () => finishFirst({ available: true, count: 1, markers: [marker] }));
    expect(hook.result.current.forField('field-a')).toMatchObject({ status: 'incomplete', markers: [] });
  });

  it('keeps the last good read for retained fields when another assignment appears offline', async () => {
    vi.mocked(readFieldMarkers)
      .mockResolvedValueOnce({ available: true, count: 1, markers: [marker] })
      .mockRejectedValue(new MarkerSignalError());
    const hook = renderHook(({ ids }) => useFieldMarkers('crew', ids), { initialProps: { ids: ['field-a'] } });
    await waitFor(() => expect(hook.result.current.forField('field-a').status).toBe('complete'));
    hook.rerender({ ids: ['field-a', 'field-b'] });
    await waitFor(() => {
      expect(hook.result.current.forField('field-a')).toMatchObject({ status: 'stale', markers: [marker] });
      expect(hook.result.current.forField('field-b')).toMatchObject({ status: 'unavailable', markers: [] });
    });
    hook.rerender({ ids: ['field-b'] });
    expect(hook.result.current.forField('field-a').markers).toEqual([]);
  });

  it('keeps an incomplete marker read labelled incomplete if the next check loses signal', async () => {
    vi.mocked(readFieldMarkers)
      .mockResolvedValueOnce({ available: true, count: 2, markers: [marker] })
      .mockRejectedValueOnce(new MarkerSignalError());
    const hook = renderHook(() => useFieldMarkers('crew', ['field-a']));
    await waitFor(() => expect(hook.result.current.forField('field-a').status).toBe('incomplete'));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.forField('field-a')).toMatchObject({
      status: 'incomplete', markers: [marker],
    }));
  });

  it('forgets loaded pins immediately after another marker request confirms access loss', async () => {
    vi.mocked(readFieldMarkers)
      .mockResolvedValueOnce({ available: true, count: 1, markers: [marker] })
      .mockRejectedValue(new MarkerSignalError());
    const hook = renderHook(() => useFieldMarkers('crew', ['field-a']));
    await waitFor(() => expect(hook.result.current.forField('field-a').markers).toEqual([marker]));
    act(() => hook.result.current.revokeField('field-a'));
    expect(hook.result.current.forField('field-a').markers).toEqual([]);
    await waitFor(() => expect(hook.result.current.forField('field-a').status).toBe('unavailable'));
    expect(hook.result.current.forField('field-a').markers).toEqual([]);
  });

  it('settles a hung field lookup so the user can retry', async () => {
    vi.useFakeTimers();
    vi.mocked(readFieldMarkers).mockImplementation((_field, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new MarkerSignalError()), { once: true });
    }));
    const hook = renderHook(() => useFieldMarkers('crew', ['field-a']));
    try {
      expect(hook.result.current.forField('field-a').status).toBe('loading');
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(hook.result.current.forField('field-a')).toMatchObject({ status: 'unavailable', markers: [] });
    } finally {
      hook.unmount();
      vi.useRealTimers();
    }
  });
});
