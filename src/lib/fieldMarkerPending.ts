import type { Session } from '@supabase/supabase-js';
import { MARKER_NOTE_LIMIT, type MarkerPlacement } from './fieldMarkerData';
import { isFieldObstacleKind } from './fieldObstacles';

const DATABASE = 'crx_field_marker_pending';
const STORE = 'creations';
const SESSION_KEY = 'session';
const CLEAR_REQUIRED_KEY = 'crx_field_marker_clear_required';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class PendingMarkerStorageError extends Error {}

type LocalSession = { actorId: string; id: string };
let current: { session: LocalSession | null; ready: Promise<boolean>; writes: AbortController } | undefined;

function sessionIdentity(session: Session | null): LocalSession | null {
  if (!session) return null;
  try {
    const encoded = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(encoded)) as { session_id?: unknown };
    return typeof claims.session_id === 'string' && UUID.test(claims.session_id)
      ? { actorId: session.user.id, id: claims.session_id } : null;
  } catch {
    return null;
  }
}

function sameSession(left: LocalSession | null | undefined, right: LocalSession | null) {
  return left?.actorId === right?.actorId && left?.id === right?.id;
}

async function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Pending marker storage is blocked by another tab'));
    };
  });
}

async function changeStore<T>(work: (
  store: IDBObjectStore,
  result: (value: T) => void,
  abort: (cause: unknown) => void,
) => void): Promise<T> {
  const db = await openStore();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      let value: T;
      tx.oncomplete = () => resolve(value);
      let abortCause: unknown;
      tx.onabort = () => reject(abortCause ?? tx.error ?? new Error('Pending marker storage was canceled'));
      work(tx.objectStore(STORE), (next) => { value = next; }, (cause) => {
        abortCause = cause;
        tx.abort();
      });
    });
  } finally {
    db.close();
  }
}

function cleanupToken() {
  try { return localStorage.getItem(CLEAR_REQUIRED_KEY); } catch { return undefined; }
}

function requestCleanup() {
  try { localStorage.setItem(CLEAR_REQUIRED_KEY, crypto.randomUUID()); } catch { /* Try the IndexedDB clear anyway. */ }
}

function finishCleanup(token: string | null | undefined) {
  try {
    if (token && cleanupToken() === token) localStorage.removeItem(CLEAR_REQUIRED_KEY);
  } catch { /* A later sign-in will retry the clear. */ }
}

export function syncPendingMarkerSession(session: Session | null) {
  const owner = sessionIdentity(session);
  if (current && sameSession(current.session, owner)) return current.ready;
  const previous = current;
  previous?.writes.abort();
  if (!owner) requestCleanup();
  const next = { session: owner, ready: Promise.resolve(false), writes: new AbortController() };
  current = next;
  next.ready = (async () => {
    await previous?.ready;
    let required: ReturnType<typeof cleanupToken>;
    const ready = await changeStore<boolean>((store, done) => {
      const request = store.get(SESSION_KEY);
      request.onsuccess = () => {
        required = cleanupToken();
        if (current !== next || (owner && required === undefined)) { done(false); return; }
        if (!owner || required || !sameSession(request.result, owner)) {
          store.clear();
          if (owner) store.add(owner, SESSION_KEY);
        }
        done(true);
      };
    });
    if (ready && current === next) finishCleanup(required);
    return ready;
  })().catch(() => false);
  return next.ready;
}

function validPoint(point: MarkerPlacement['point_geojson'] | undefined) {
  if (point?.type !== 'Point' || !Array.isArray(point.coordinates) || point.coordinates.length !== 2) return false;
  const [longitude, latitude] = point.coordinates;
  return Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90;
}

function pendingPlacement(value: unknown, fieldId: string): MarkerPlacement {
  const record = value as { version?: unknown; placement?: Partial<MarkerPlacement> } | null;
  const row = record?.version === 1 ? record.placement : undefined;
  const label = row?.label;
  if (typeof row?.id !== 'string' || !UUID.test(row.id) || row.field_id !== fieldId
    || typeof row.kind !== 'string' || !isFieldObstacleKind(row.kind)
    || (label !== null && (typeof label !== 'string' || [...label].length > MARKER_NOTE_LIMIT))
    || !validPoint(row.point_geojson)) {
    throw new PendingMarkerStorageError('This device could not read its pending marker. Check which pins already saved before signing out and back in. Signing out clears pending saves on this device.');
  }
  return row as MarkerPlacement;
}

async function withPending<T>(
  actorId: string,
  fieldId: string,
  act: (store: IDBObjectStore, key: string[], placement: MarkerPlacement | null, result: (value: T) => void) => void,
): Promise<T> {
  const active = current;
  if (!active?.session || active.session.actorId !== actorId) {
    throw new PendingMarkerStorageError('Sign in again to check pending markers for this account.');
  }
  // Only auth can establish the shared session. A stale tab must not recreate it after sign-out.
  if (!await active.ready) {
    throw new PendingMarkerStorageError('Could not open this device’s pending marker saves. Reload this page and try again.');
  }
  const owner = active.session;
  const key = [actorId, fieldId];
  return changeStore<T>((store, done, abort) => {
    const sessionChanged = () => abort(new PendingMarkerStorageError('Your session changed. Sign in again to check pending markers.'));
    const storedSession = store.get(SESSION_KEY);
    storedSession.onsuccess = () => {
      if (current !== active || !sameSession(storedSession.result, owner)) {
        sessionChanged();
        return;
      }
      const request = store.get(key);
      request.onsuccess = () => {
        if (current !== active || cleanupToken() !== null) { sessionChanged(); return; }
        try {
          const placement = request.result === undefined ? null : pendingPlacement(request.result, fieldId);
          act(store, key, placement, done);
        } catch (error) {
          abort(error);
        }
      };
    };
  });
}

export function readPendingMarker(actorId: string, fieldId: string) {
  return withPending<MarkerPlacement | null>(actorId, fieldId, (_store, _key, placement, done) => done(placement));
}

export function reservePendingMarker(actorId: string, placement: MarkerPlacement) {
  return withPending<MarkerPlacement>(actorId, placement.field_id, (store, key, existing, done) => {
    if (!existing) store.add({ version: 1, placement }, key);
    done(existing ?? placement);
  });
}

export async function startReservedMarkerWrite<T>(
  actorId: string,
  placement: Pick<MarkerPlacement, 'field_id' | 'id'>,
  inSameView: () => boolean,
  send: (sessionSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const active = current;
  const { response } = await withPending<{ response: Promise<T> }>(actorId, placement.field_id, (_store, _key, existing, done) => {
    if (!active || existing?.id !== placement.id || !inSameView()) throw new Error('The pending marker is no longer active.');
    // Authorize the handoff under the shared storage lock. The session signal covers a later local sign-out.
    const response = send(active.writes.signal);
    void response.catch(() => {});
    done({ response });
  });
  return response;
}

export function clearPendingMarker(actorId: string, placement: Pick<MarkerPlacement, 'field_id' | 'id'>) {
  return withPending<void>(actorId, placement.field_id, (store, key, existing, done) => {
    if (existing?.id === placement.id) store.delete(key);
    done();
  });
}
