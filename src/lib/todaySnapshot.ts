/**
 * A read-only copy of what a field screen showed today, kept on the phone so a dead spot does not blank the
 * screen (My Route, a stop, the applicator's day). Only what the screen displays is saved, never a sign-in
 * token or anything to write back: a screen showing a saved copy keeps every save button off.
 *
 * One copy per screen, person and business day. Saving removes every other day's and every other person's
 * copies, so at most today's copies of the person signed in on this phone stay. Every storage call is wrapped:
 * a private window or full storage just means there is no saved copy.
 */
import { todayInBusinessTz } from './dateUtils';

const PREFIX = 'crx:today-snapshot:v1:';

/** The saved copy of one delivery stop (My Route links to it, so a route refresh can drop stops that left). */
export const stopSnapshotKey = (stopId: string) => `stop:${stopId}`;

export interface TodaySnapshot<T> {
  /** When the screen last loaded this copy from the server (ISO time). */
  savedAt: string;
  data: T;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function ownerPrefix(userId: string, now: Date): string {
  return `${PREFIX}${userId}:${todayInBusinessTz(now)}:`;
}

/** Saves today's copy of a screen for this person, and drops every copy that is not this person's today. */
export function saveTodaySnapshot<T>(screen: string, userId: string, data: T, now: Date = new Date()): void {
  const store = storage();
  if (!store || !userId) return;
  const keep = ownerPrefix(userId, now);
  try {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX) && !key.startsWith(keep)) stale.push(key);
    }
    stale.forEach((key) => store.removeItem(key));
    const snapshot: TodaySnapshot<T> = { savedAt: now.toISOString(), data };
    store.setItem(`${keep}${screen}`, JSON.stringify(snapshot));
  } catch {
    // Storage full or blocked: the screen works without a saved copy.
  }
}

/** Today's saved copy of a screen for this person, or null (none, another day's, or unreadable). */
export function readTodaySnapshot<T>(screen: string, userId: string | null | undefined, now: Date = new Date()): TodaySnapshot<T> | null {
  const store = storage();
  if (!store || !userId) return null;
  try {
    const raw = store.getItem(`${ownerPrefix(userId, now)}${screen}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TodaySnapshot<T>>;
    if (typeof parsed?.savedAt !== 'string' || parsed.data === undefined) return null;
    return { savedAt: parsed.savedAt, data: parsed.data as T };
  } catch {
    return null;
  }
}

/** Removes one screen's saved copy for this person (for example a stop that is no longer open). */
export function dropTodaySnapshot(screen: string, userId: string | null | undefined, now: Date = new Date()): void {
  const store = storage();
  if (!store || !userId) return;
  try {
    store.removeItem(`${ownerPrefix(userId, now)}${screen}`);
  } catch {
    // Nothing to do: an unreadable store holds nothing this screen can show.
  }
}

/**
 * After a failed read: only a lost connection may show the saved copy. Any answer from the server (no row, access
 * denied) means the copy is no longer the person's to see, so it is removed and null returned.
 */
export function savedCopyAfterFailure<T>(screen: string, userId: string | null | undefined, signalLost: boolean): TodaySnapshot<T> | null {
  if (signalLost) return readTodaySnapshot<T>(screen, userId);
  dropTodaySnapshot(screen, userId);
  return null;
}

/** Removes every saved copy on this device (sign-out): gate codes and phone numbers must not outlive the session. */
export function dropAllSnapshots(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    keys.forEach((key) => store.removeItem(key));
  } catch {
    // Unreadable store: nothing the app could show from it either.
  }
}

/** "8:14 AM": the time a saved copy was loaded, for the no-signal banner. */
function snapshotTimeLabel(savedAt: string): string {
  const d = new Date(savedAt);
  return Number.isNaN(d.getTime()) ? 'earlier today' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The banner a screen shows over a saved copy. */
export function savedCopyMessage(what: string, savedAt: string): string {
  return `No signal — showing ${what} as of ${snapshotTimeLabel(savedAt)}.`;
}
