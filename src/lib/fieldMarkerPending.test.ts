import { IDBFactory } from 'fake-indexeddb';
import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPendingMarker, readPendingMarker, reservePendingMarker, startReservedMarkerWrite, syncPendingMarkerSession } from './fieldMarkerPending';
import type { MarkerPlacement } from './fieldMarkerData';

const placement: MarkerPlacement = {
  id: '11111111-1111-4111-8111-111111111111',
  field_id: 'field-a',
  kind: 'gate',
  label: 'Use this gate',
  point_geojson: { type: 'Point', coordinates: [-89, 40] },
};
const second = { ...placement, id: '22222222-2222-4222-8222-222222222222', label: 'Different gate' };
const sessionA = '33333333-3333-4333-8333-333333333333';
const sessionB = '44444444-4444-4444-8444-444444444444';

function auth(actorId: string, id = sessionA): Session {
  return { user: { id: actorId }, access_token: 'header.' + btoa(JSON.stringify({ session_id: id })) + '.signature' } as Session;
}

describe('pending pin storage', () => {
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await syncPendingMarkerSession(null);
    expect(await syncPendingMarkerSession(auth('crew-a'))).toBe(true);
  });

  it('allows concurrent reservations to recover one frozen record', async () => {
    const first = reservePendingMarker('crew-a', placement);
    const next = reservePendingMarker('crew-a', second);
    const [a, b] = await Promise.all([first, next]);
    expect(a).toEqual(b);
    await clearPendingMarker('crew-a', a.id === placement.id ? second : placement);
    expect(await readPendingMarker('crew-a', placement.field_id)).toEqual(a);
    await clearPendingMarker('crew-a', a);
    expect(await readPendingMarker('crew-a', placement.field_id)).toBeNull();
  });

  it('recovers a 500-character note containing surrogate pairs', async () => {
    const fullNote = { ...placement, label: String.fromCodePoint(0x1F6AA).repeat(500) };
    await reservePendingMarker('crew-a', fullNote);
    expect(await readPendingMarker('crew-a', fullNote.field_id)).toEqual(fullNote);
  });

  it('keeps the pending record when the same browser session is loaded again', async () => {
    await reservePendingMarker('crew-a', placement);
    vi.resetModules();
    const reloaded = await import('./fieldMarkerPending');
    await reloaded.syncPendingMarkerSession(auth('crew-a'));
    expect(await reloaded.readPendingMarker('crew-a', placement.field_id)).toEqual(placement);
  });

  it('clears pending records at sign-out and rejects old-account writes', async () => {
    await reservePendingMarker('crew-a', placement);
    const race = reservePendingMarker('crew-a', { ...placement, field_id: 'field-b' });
    const signOut = syncPendingMarkerSession(null);
    await expect(race).rejects.toThrow();
    expect(await signOut).toBe(true);
    await syncPendingMarkerSession(auth('crew-b', sessionB));
    await expect(readPendingMarker('crew-a', placement.field_id)).rejects.toThrow();
    expect(await readPendingMarker('crew-b', placement.field_id)).toBeNull();
  });

  it('rejects a still-open tab after another tab clears the shared session', async () => {
    vi.resetModules();
    const otherTab = await import('./fieldMarkerPending');
    await otherTab.syncPendingMarkerSession(auth('crew-a'));
    await reservePendingMarker('crew-a', placement);
    await otherTab.syncPendingMarkerSession(null);
    await expect(reservePendingMarker('crew-a', placement)).rejects.toThrow();
    await otherTab.syncPendingMarkerSession(auth('crew-a', sessionB));
    expect(await otherTab.readPendingMarker('crew-a', placement.field_id)).toBeNull();
  });

  it('blocks a reserved write when another tab finishes sign-out first', async () => {
    await reservePendingMarker('crew-a', placement);
    vi.resetModules();
    const otherTab = await import('./fieldMarkerPending');
    await otherTab.syncPendingMarkerSession(auth('crew-a'));
    const send = vi.fn(async () => 'saved');
    await expect(startReservedMarkerWrite('crew-a', second, () => true, send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(await startReservedMarkerWrite('crew-a', placement, () => true, send)).toBe('saved');
    await otherTab.syncPendingMarkerSession(null);
    await expect(startReservedMarkerWrite('crew-a', placement, () => true, send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight insert request when the current session signs out', async () => {
    await reservePendingMarker('crew-a', placement);
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const insert = startReservedMarkerWrite('crew-a', placement, () => true, (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Session signed out')), { once: true });
      notifyStarted();
    }));
    const outcome = expect(insert).rejects.toThrow('Session signed out');
    await started;
    await syncPendingMarkerSession(null);
    await outcome;
  });

  it('clears an earlier session when the same person signs in again', async () => {
    await reservePendingMarker('crew-a', placement);
    await syncPendingMarkerSession(auth('crew-a', sessionB));
    expect(await readPendingMarker('crew-a', placement.field_id)).toBeNull();
  });

  it('reports damaged records without discarding or replacing them', async () => {
    const damaged = { ...placement, kind: 'unsupported' } as unknown as MarkerPlacement;
    await reservePendingMarker('crew-a', damaged);
    await expect(readPendingMarker('crew-a', placement.field_id)).rejects.toThrow('Signing out clears pending saves on this device.');
    await expect(reservePendingMarker('crew-a', placement)).rejects.toThrow('Signing out clears pending saves on this device.');
  });

  it('clears a pending record when reload restores the same session after a failed storage clear', async () => {
    await reservePendingMarker('crew-a', placement);
    const device = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', undefined);
    expect(await syncPendingMarkerSession(null)).toBe(false);
    vi.stubGlobal('indexedDB', device);
    vi.resetModules();
    const reloaded = await import('./fieldMarkerPending');
    expect(await reloaded.syncPendingMarkerSession(auth('crew-a'))).toBe(true);
    expect(await reloaded.readPendingMarker('crew-a', placement.field_id)).toBeNull();
  });

  it('directs a failed session startup to reload instead of recreating the session in a stale tab', async () => {
    await syncPendingMarkerSession(null);
    const device = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', undefined);
    expect(await syncPendingMarkerSession(auth('crew-a'))).toBe(false);
    vi.stubGlobal('indexedDB', device);
    await expect(readPendingMarker('crew-a', placement.field_id)).rejects.toThrow('Reload this page and try again');
  });

  it('refuses to reserve a pin when browser storage is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(reservePendingMarker('crew-a', placement)).rejects.toThrow();
  });
});
