import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MARKER_REQUEST_TIMEOUT_MS, MarkerSignalError, readFieldMarkers, readMarkerAuthors } from '../lib/fieldMarkerData';
import { Sentry } from '../lib/sentry';
import type { FieldMarkerState } from '../types';

const loading: FieldMarkerState = { status: 'loading', markers: [], authors: new Map() };
const unavailable: FieldMarkerState = { ...loading, status: 'unavailable' };
type MarkerRead = { state: FieldMarkerState; attempt: number; fieldKey: string; refreshKey?: number };

async function loadMarkers(field: string, scopeSignal: AbortSignal): Promise<FieldMarkerState> {
  const request = new AbortController();
  const cancel = () => request.abort();
  scopeSignal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, MARKER_REQUEST_TIMEOUT_MS);
  try {
    const snapshot = await readFieldMarkers(field, request.signal);
    if (snapshot.available === false) return { ...unavailable, accessDenied: true };
    if (snapshot.available !== true || !Array.isArray(snapshot.markers)) {
      return { ...loading, status: 'incomplete' };
    }
    const markers = snapshot.markers.filter((marker) => marker.field_id === field);
    const complete = snapshot.count === markers.length && snapshot.markers.length === markers.length;
    return {
      status: complete ? 'complete' : 'incomplete',
      markers,
      ...await readMarkerAuthors(markers, request.signal),
      checkedAt: Date.now(),
    };
  } finally {
    clearTimeout(timeout);
    scopeSignal.removeEventListener('abort', cancel);
  }
}

function preserveOnSignalLoss(previous: FieldMarkerState | undefined, error: unknown): FieldMarkerState {
  if (!(error instanceof MarkerSignalError) || !previous) return unavailable;
  if (previous.status === 'incomplete') return previous;
  return previous.checkedAt ? { ...previous, status: 'stale' } : unavailable;
}

export function useFieldMarkers(actorId: string | undefined, fieldIds: string[], refreshKey?: number, enabled = true) {
  const fieldKey = [...new Set(fieldIds)].sort().join(',');
  const [attempt, setAttempt] = useState(0);
  const [stored, setStored] = useState<{ actorId?: string; entries: Map<string, MarkerRead> }>();
  const activeRead = useRef<AbortController | null>(null);
  const refresh = useCallback(() => setAttempt((current) => current + 1), []);
  const replaceFieldState = useCallback((id: string, next: (state: FieldMarkerState) => FieldMarkerState) => {
    activeRead.current?.abort();
    setStored((prior) => {
      const entry = prior?.entries.get(id);
      if (!prior || prior.actorId !== actorId || !entry) return prior;
      const entries = new Map(prior.entries);
      entries.set(id, { ...entry, state: next(entry.state) });
      return { actorId, entries };
    });
  }, [actorId]);
  const revokeField = useCallback((id: string) => {
    replaceFieldState(id, () => ({ ...unavailable, accessDenied: true }));
    refresh();
  }, [replaceFieldState, refresh]);
  const forgetDeletedMarker = useCallback((fieldId: string, markerId: string) => {
    replaceFieldState(fieldId, (state) => ({ ...state, markers: state.markers.filter((marker) => marker.id !== markerId) }));
  }, [replaceFieldState]);

  useLayoutEffect(() => {
    const ids = fieldKey.split(',');
    setStored((prior) => ({
      actorId,
      entries: actorId && prior?.actorId === actorId
        ? new Map([...prior.entries].filter(([id]) => ids.includes(id)))
        : new Map(),
    }));
  }, [actorId, fieldKey]);

  useEffect(() => {
    if (!enabled) return;
    function onVisible() {
      if (document.visibilityState === 'visible') refresh();
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !actorId || !fieldKey) return;
    const abort = new AbortController();
    activeRead.current = abort;
    const ids = fieldKey.split(',');
    async function run() {
      for (let index = 0; index < ids.length && !abort.signal.aborted; index += 6) {
        await Promise.all(ids.slice(index, index + 6).map(async (id) => {
          try {
            const state = await loadMarkers(id, abort.signal);
            if (!abort.signal.aborted) record(id, () => state);
          } catch (error) {
            if (abort.signal.aborted) return;
            if (!(error instanceof MarkerSignalError)) {
              Sentry.captureException(new Error('Could not read field markers'), { tags: { action: 'read_field_markers' } });
            }
            record(id, (previous) => preserveOnSignalLoss(previous, error));
          }
        }));
      }
    }
    function record(id: string, next: (previous?: FieldMarkerState) => FieldMarkerState) {
      setStored((prior) => {
        const entries = prior?.actorId === actorId ? new Map(prior?.entries) : new Map<string, MarkerRead>();
        entries.set(id, { state: next(entries.get(id)?.state), attempt, fieldKey, refreshKey });
        return { actorId, entries };
      });
    }
    void run();
    return () => abort.abort();
  }, [actorId, fieldKey, attempt, refreshKey, enabled]);

  const forField = useCallback((id: string): FieldMarkerState => {
    if (!actorId || stored?.actorId !== actorId || !fieldKey.split(',').includes(id)) return loading;
    const entry = stored.entries.get(id);
    if (!entry || entry.refreshKey !== refreshKey) return loading;
    if (entry.attempt === attempt && entry.fieldKey === fieldKey) return entry.state;
    if (entry.state.status === 'stale' || entry.state.status === 'incomplete') return { ...entry.state, checking: true };
    return { ...entry.state, status: 'loading', checking: true };
  }, [actorId, fieldKey, stored, attempt, refreshKey]);

  return { forField, refresh, revokeField, forgetDeletedMarker };
}
