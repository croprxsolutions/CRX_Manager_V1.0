import { useCallback, useEffect, useRef, useState } from 'react';
import { assertRpcResult, supabase } from '../lib/db';
import { generateIdempotencyKey, isDefinitiveRpcRejection } from '../lib/idempotency';
import { useLatestRef } from './useLatestRef';

export type MutationFailureDisposition = 'definitive' | 'resolved' | 'uncertain';

export type DurableMutationIntentOptions<T> = {
  operation: string;
  userId: string;
  surface: string;
  scope?: string;
  getIntentIdentity?: (intent: T) => unknown;
};

type DurableMutationIntentRecord<T> = {
  version: 4;
  status: 'pending' | 'resolved';
  requestVersion: string;
  claimTabIds: string[];
  resolvedAtMs: number | null;
  operation: string;
  userId: string;
  surface: string;
  scope: string;
  idempotencyKey: string;
  intentIdentity: string | null;
  intent: T;
  createdAtMs: number;
  retryNotAfterMs: number;
};

type LegacyDurableMutationIntentCandidate<T> = {
  version?: 1 | 2;
  operation?: string;
  userId?: string;
  surface?: string;
  scope?: string;
  idempotencyKey?: string;
  intent?: T;
  createdAtMs?: number;
  retryNotAfterMs?: number;
};

// What staff need to identify a locked request before clearing it (KI-27).
export type LockedRequestDetails = {
  surface: string;
  scope: string;
  idempotencyKey: string;
  createdAtMs: number;
  retryNotAfterMs: number;
};

// A legacy or damaged request has no known deadline (stored as 0), so it is
// never treated as expired and never clearable.
function hasKnownRetryDeadline(record: LockedRequestDetails) {
  return record.surface !== '__reconciliation_required__' && record.retryNotAfterMs > record.createdAtMs;
}

const DURABLE_INTENT_PREFIX = 'crx:uncertain-mutation:v4:';
const LEGACY_SESSION_PREFIX = 'crx:uncertain-mutation:v1:';
const ACKNOWLEDGMENT_PREFIX = 'crx:uncertain-mutation-ack:v1:';
// The server time of the first clear check, per request key (KI-27).
const CLEAR_CHECK_PREFIX = 'crx:uncertain-mutation-clear-check:v2:';
// Fallback when localStorage refuses the token, so this tab's wait still counts down.
const clearCheckTokens = new Map<string, string>();
const DURABLE_INTENT_TAB_ID = 'crx:durable-mutation:tab-id';
const DURABLE_INTENT_LIVE_CLAIM_PREFIX = 'crx:durable-mutation:live-claim:';
const DURABLE_INTENT_DB = 'crx_durable_mutation_intents';
const DURABLE_INTENT_STORE = 'intents';
const SAFE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
// A live claim is a renewable lease, not a permanent marker. Release runs from
// `pagehide` and effect cleanup, and neither survives a browser crash, a force
// quit, or an OS kill. A marker with no expiry would then keep a dead claimant
// in claimTabIds forever, deleteCoordinatedRecord could never delete the
// record, and once SAFE_RETRY_WINDOW_MS passed getIdempotencyKey() would throw
// UNCERTAIN_MUTATION_RETRY_EXPIRED on every attempt. Because storage is keyed
// by [operation, userId] only, one crash would lock that user out of every
// vendor payment or receiving attempt for that operation permanently. The TTL
// caps that outage instead of eliminating it: long enough that a mounted page
// keeps renewing through background-tab timer throttling (Chrome's intensive
// throttling still fires roughly once a minute), short enough that a crash
// self-heals in minutes rather than never.
const DURABLE_INTENT_LIVE_CLAIM_TTL_MS = 15 * 60 * 1000;
const DURABLE_INTENT_LIVE_CLAIM_HEARTBEAT_MS = 60 * 1000;
export const UNCERTAIN_MUTATION_RETRY_EXPIRED = 'DURABLE_MUTATION_INTENT_RETRY_EXPIRED';
export const UNCERTAIN_MUTATION_INTENT_CONFLICT = 'DURABLE_MUTATION_INTENT_CONFLICT';
const UNCERTAIN_MUTATION_CLEAR_NOT_YET = 'DURABLE_MUTATION_INTENT_CLEAR_NOT_YET';

// KI-27: the server refused a clear because the request might still save.
// reason is the server's ('in_progress', 'first_check' or 'waiting'); waitUntil is
// the server time after which a second check can succeed, when it gave one.
export class UncertainClearNotYetError extends Error {
  readonly reason: string;
  readonly waitUntil: string | null;
  constructor(reason: string, waitUntil: string | null) {
    super(UNCERTAIN_MUTATION_CLEAR_NOT_YET);
    this.reason = reason;
    this.waitUntil = waitUntil;
  }
}

type ClearCheckVerdict = {
  safe: boolean;
  reason: string;
  checked_at: string;
  wait_until?: string;
  first_check_token?: string;
};

// KI-27: resolves only when the server says the request can be cleared (and retires it
// there), returning the stored first-check token's key; otherwise throws
// UncertainClearNotYetError. Never trusts this device's clock.
async function confirmClearWithServer(expectedIdempotencyKey: string): Promise<string> {
  // Safe only when the server says the request saved, or it was unsaved on two
  // checks 15+ minutes apart by server time (it can no longer commit). The first
  // check's time comes back as a token the server signed; it is stored as-is.
  const checkKey = `${CLEAR_CHECK_PREFIX}${expectedIdempotencyKey}`;
  let firstCheckToken: string | null = clearCheckTokens.get(checkKey) ?? null;
  try {
    firstCheckToken = window.localStorage.getItem(checkKey) ?? firstCheckToken;
  } catch {
    // Without the token the server simply starts the wait again.
  }
  // A safe answer also retires the request in the database, so a late copy of it, or of
  // any batch row sent under "<key>:<row id>", is refused from any tab after this clear.
  const { data, error } = await supabase.rpc('retire_uncertain_request', {
    p_request_key: expectedIdempotencyKey,
    p_idempotency_key: expectedIdempotencyKey,
    ...(firstCheckToken ? { p_first_check_token: firstCheckToken } : {}),
  });
  if (error) throw error;
  const verdict = assertRpcResult<ClearCheckVerdict>(data, 'retire_uncertain_request');
  if (verdict.safe !== true) {
    if (verdict.reason === 'first_check' && verdict.first_check_token) {
      clearCheckTokens.set(checkKey, verdict.first_check_token);
      try {
        window.localStorage.setItem(checkKey, verdict.first_check_token);
      } catch {
        // The next try starts the wait again.
      }
    }
    throw new UncertainClearNotYetError(verdict.reason, verdict.wait_until ?? null);
  }
  return checkKey;
}

export const UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE =
  'The safe automatic retry window expired. Do not submit this mutation again. Verify the authoritative record and reconcile it manually.';
export const UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE =
  'A saved request for this operation needs reconciliation. If another page or tab owns it, return there to retry it unchanged. Otherwise verify the authoritative record and reconcile it manually before starting another request.';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function fingerprintIntent<T>(
  intent: T,
  getIntentIdentity: ((candidate: T) => unknown) | undefined,
): string {
  return JSON.stringify(canonicalize(getIntentIdentity ? getIntentIdentity(intent) : intent));
}

function durableStorageKey<T>(options: DurableMutationIntentOptions<T> | undefined): string | null {
  if (!options || !options.operation || !options.userId || !options.surface) return null;
  // Surface and route scope deliberately do not participate in the key. One
  // actor cannot mint a second key for the same operation merely by opening a
  // new tab or using a different receiving screen.
  return `${DURABLE_INTENT_PREFIX}${JSON.stringify([options.operation, options.userId])}`;
}

function currentTabId(): string {
  try {
    const existing = window.sessionStorage.getItem(DURABLE_INTENT_TAB_ID);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(DURABLE_INTENT_TAB_ID, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function currentPageClaimId(): string {
  // sessionStorage is copied when a browser tab is duplicated. A fresh UUID
  // suffix makes each mounted page claimant distinct even when both pages
  // inherit the same tab ID.
  return `${currentTabId()}:${crypto.randomUUID()}`;
}

function writeClaimLease(claimId: string): void {
  window.localStorage.setItem(
    `${DURABLE_INTENT_LIVE_CLAIM_PREFIX}${claimId}`,
    String(Date.now()),
  );
}

function markClaimLive(claimId: string): void {
  try {
    writeClaimLease(claimId);
  } catch {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
}

function renewLiveClaim(claimId: string): void {
  // Heartbeat. Only an existing lease is refreshed: a page that never started a
  // mutation must not mint a claim, and a released claim must stay released.
  try {
    if (window.localStorage.getItem(`${DURABLE_INTENT_LIVE_CLAIM_PREFIX}${claimId}`) === null) {
      return;
    }
    writeClaimLease(claimId);
  } catch {
    // A missed heartbeat only ages the lease. Peers keep treating the claim as
    // live until the TTL passes, which is the safe direction.
  }
}

function releaseLiveClaim(claimId: string): void {
  try {
    window.localStorage.removeItem(`${DURABLE_INTENT_LIVE_CLAIM_PREFIX}${claimId}`);
  } catch {
    // A failed release leaves the lease in place, so peers keep treating this
    // claimant as live rather than pretending it is gone. The lease still
    // expires on its own, so a release failure delays reconciliation by at most
    // DURABLE_INTENT_LIVE_CLAIM_TTL_MS instead of stranding the record.
  }
}

function isClaimLive(claimId: string): boolean {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(`${DURABLE_INTENT_LIVE_CLAIM_PREFIX}${claimId}`);
  } catch {
    // Liveness could not be READ. Treat the claim as live: reporting a
    // peer as dead on a storage error would let a second request delete the
    // record and mint a new idempotency key while the first is still in flight.
    return true;
  }
  // An absent lease means the claimant released it, or never held one.
  if (raw === null) return false;
  const renewedAtMs = Number(raw);
  if (!Number.isFinite(renewedAtMs)) {
    // A lease of unknown age (corrupt, or written by an older build that stored
    // a static marker). Treat it as live now, and stamp it so it acquires a
    // bounded expiry instead of surviving forever.
    try {
      writeClaimLease(claimId);
    } catch {
      // Best effort. The claim stays live either way.
    }
    return true;
  }
  return Date.now() - renewedAtMs < DURABLE_INTENT_LIVE_CLAIM_TTL_MS;
}

function retainLiveClaims(claimIds: string[], currentClaimId: string): string[] {
  return claimIds.filter(
    (claimId) => claimId === currentClaimId || isClaimLive(claimId),
  );
}

function isValidRecord<T>(
  candidate: Partial<DurableMutationIntentRecord<T>>,
  options: DurableMutationIntentOptions<T>,
): candidate is DurableMutationIntentRecord<T> {
  return candidate.version === 4
    && (candidate.status === 'pending' || candidate.status === 'resolved')
    && typeof candidate.requestVersion === 'string'
    && candidate.requestVersion.length > 0
    && Array.isArray(candidate.claimTabIds)
    && candidate.claimTabIds.every((tabId) => typeof tabId === 'string' && tabId.length > 0)
    && (candidate.resolvedAtMs === null
      || (typeof candidate.resolvedAtMs === 'number' && Number.isFinite(candidate.resolvedAtMs)))
    && candidate.operation === options.operation
    && candidate.userId === options.userId
    && typeof candidate.surface === 'string'
    && typeof candidate.scope === 'string'
    && typeof candidate.idempotencyKey === 'string'
    && candidate.idempotencyKey.startsWith(`${options.operation}:${options.userId}:`)
    && (typeof candidate.intentIdentity === 'string' || candidate.intentIdentity === null)
    && candidate.intent !== null
    && typeof candidate.intent === 'object'
    && typeof candidate.createdAtMs === 'number'
    && Number.isFinite(candidate.createdAtMs)
    && typeof candidate.retryNotAfterMs === 'number'
    && Number.isFinite(candidate.retryNotAfterMs)
    && candidate.retryNotAfterMs >= candidate.createdAtMs;
}

function blockedDurableRecord<T>(
  options: DurableMutationIntentOptions<T>,
): DurableMutationIntentRecord<T> {
  return {
    version: 4,
    status: 'pending',
    requestVersion: `${options.operation}:${options.userId}:blocked`,
    claimTabIds: [],
    resolvedAtMs: null,
    operation: options.operation,
    userId: options.userId,
    surface: '__reconciliation_required__',
    scope: '',
    idempotencyKey: `${options.operation}:${options.userId}:blocked`,
    intentIdentity: null,
    intent: {} as T,
    createdAtMs: 0,
    retryNotAfterMs: 0,
  };
}

function migrateLegacySessionRecord<T>(
  storageKey: string,
  options: DurableMutationIntentOptions<T>,
): DurableMutationIntentRecord<T> | null {
  try {
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const legacyKey = window.sessionStorage.key(index);
      if (!legacyKey?.startsWith(LEGACY_SESSION_PREFIX)) continue;
      const raw = window.sessionStorage.getItem(legacyKey);
      if (!raw) continue;
      const candidate = JSON.parse(raw) as LegacyDurableMutationIntentCandidate<T>;
      if (
        (candidate.version !== 1 && candidate.version !== 2)
        || candidate.operation !== options.operation
        || candidate.userId !== options.userId
        || typeof candidate.surface !== 'string'
        || typeof candidate.scope !== 'string'
        || typeof candidate.idempotencyKey !== 'string'
        || !candidate.idempotencyKey.startsWith(`${options.operation}:${options.userId}:`)
        || candidate.intent === null
        || typeof candidate.intent !== 'object'
      ) continue;

      const ownedByCurrentSurface = candidate.surface === options.surface
        && candidate.scope === (options.scope || '');
      const canRetainDeadline = candidate.version === 2
        && ownedByCurrentSurface
        && typeof candidate.createdAtMs === 'number'
        && Number.isFinite(candidate.createdAtMs)
        && typeof candidate.retryNotAfterMs === 'number'
        && Number.isFinite(candidate.retryNotAfterMs)
        && candidate.retryNotAfterMs > candidate.createdAtMs;
      const migrated: DurableMutationIntentRecord<T> = {
        version: 4,
        status: 'pending',
        requestVersion: candidate.idempotencyKey,
        claimTabIds: [currentPageClaimId()],
        resolvedAtMs: null,
        operation: options.operation,
        userId: options.userId,
        surface: candidate.surface,
        scope: candidate.scope,
        idempotencyKey: candidate.idempotencyKey,
        intentIdentity: canRetainDeadline
          ? fingerprintIntent(candidate.intent, options.getIntentIdentity)
          : null,
        intent: candidate.intent,
        createdAtMs: canRetainDeadline ? candidate.createdAtMs! : 0,
        retryNotAfterMs: canRetainDeadline ? candidate.retryNotAfterMs! : 0,
      };
      window.localStorage.setItem(storageKey, JSON.stringify(migrated));
      window.sessionStorage.removeItem(legacyKey);
      return migrated;
    }
  } catch {
    // A legacy record that cannot be migrated stays in sessionStorage. A new
    // mutation will still fail closed when localStorage cannot be written.
  }
  return null;
}

function readDurableRecord<T>(
  storageKey: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
): DurableMutationIntentRecord<T> | null {
  if (!storageKey || !options || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return migrateLegacySessionRecord(storageKey, options);
    const candidate = JSON.parse(raw) as Partial<DurableMutationIntentRecord<T>>;
    return isValidRecord(candidate, options) ? candidate : blockedDurableRecord(options);
  } catch {
    return blockedDurableRecord(options);
  }
}

function writeDurableRecord<T>(storageKey: string, record: DurableMutationIntentRecord<T>): void {
  if (typeof window === 'undefined') {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(record));
  } catch {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
}

function readAcknowledgmentRecord<T>(
  key: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
): DurableMutationIntentRecord<T> | null {
  if (!key || !options || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<DurableMutationIntentRecord<T>>;
    return isValidRecord(record, options) && record.status === 'pending'
      && record.surface === options.surface && record.scope === (options.scope || '')
      ? record : blockedDurableRecord(options);
  } catch {
    return blockedDurableRecord(options);
  }
}

function writeAcknowledgmentRecord<T>(key: string | null, record: DurableMutationIntentRecord<T>): void {
  if (!key) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(record));
  } catch {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
}

function clearAcknowledgmentRecord<T>(
  key: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
  expectedVersion: string | null,
): void {
  if (!key) return;
  const record = readAcknowledgmentRecord(key, options);
  if (record?.surface === '__reconciliation_required__') {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
  if (!record || record.requestVersion !== expectedVersion) return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
}

function removeDurableRecord(storageKey: string | null): void {
  if (!storageKey || typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // The in-memory lock still clears after a definitive result. Storage
    // failures before a mutation fail closed in writeDurableRecord().
  }
}

function openDurableIntentDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'));
      return;
    }
    const request = indexedDB.open(DURABLE_INTENT_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DURABLE_INTENT_STORE)) {
        request.result.createObjectStore(DURABLE_INTENT_STORE, { keyPath: 'storageKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
    );
    request.onblocked = () => reject(new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'));
  });
}

async function coordinateDurableRecord<T>(
  storageKey: string,
  proposed: DurableMutationIntentRecord<T>,
  candidateIntent: T,
  options: DurableMutationIntentOptions<T>,
  tabId: string,
  localMirror: DurableMutationIntentRecord<T> | null = null,
  ownAttemptRequestVersion: string | null = null,
  expectedIdempotencyKey?: string,
): Promise<{ record: DurableMutationIntentRecord<T>; conflict: boolean }> {
  const db = await openDurableIntentDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DURABLE_INTENT_STORE, 'readwrite');
      const store = transaction.objectStore(DURABLE_INTENT_STORE);
      const request = store.get(storageKey);
      let result: { record: DurableMutationIntentRecord<T>; conflict: boolean } | null = null;

      request.onsuccess = () => {
        const stored = request.result as { storageKey?: string; record?: unknown } | undefined;
        const existingCandidate = stored?.record as Partial<DurableMutationIntentRecord<T>> | undefined;
        // With NO coordinator row, the local mirror is the only evidence
        // that an earlier request may have committed (IndexedDB evicted or
        // cleared). Decide it like an authoritative pending record rather than
        // letting the fresh candidate mint a second key for the same work. A
        // resolved mirror counts too: it still names the key a peer committed.
        const existing = existingCandidate && isValidRecord(existingCandidate, options)
          ? existingCandidate
          : stored
            ? blockedDurableRecord(options)
            : localMirror ?? proposed;
        if (
          expectedIdempotencyKey !== undefined
          && (existing.status !== 'pending' || existing.idempotencyKey !== expectedIdempotencyKey)
        ) {
          // The caller is retrying one specific request that was resolved or
          // replaced after the caller read it. Claiming or minting a record here
          // would send that request again under a different key, so nothing is
          // written. If IndexedDB lost its row, the local mirror must still
          // identify the pending request and its required key.
          result = { record: existing, conflict: true };
          return;
        }
        if (ownAttemptRequestVersion !== null && existing.requestVersion !== ownAttemptRequestVersion) {
          // A newer shared request cannot acknowledge this tab's older one.
          // Keep reconciliation locked instead of minting another receipt.
          result = { record: existing, conflict: true };
          if (!stored) store.put({ storageKey, record: existing });
          return;
        }
        const owned = existing.surface === options.surface
          && existing.scope === (options.scope || '');
        const candidateIdentity = fingerprintIntent(candidateIntent, options.getIntentIdentity);
        const sameIntent = existing.intentIdentity !== null
          && existing.intentIdentity === candidateIdentity;
        const intentExpired = Date.now() >= existing.retryNotAfterMs;
        const sameActiveIntent = sameIntent && !intentExpired;
        if (existing.status === 'resolved') {
          if (ownAttemptRequestVersion !== null && intentExpired) {
            result = { record: existing, conflict: true };
            if (!stored) store.put({ storageKey, record: existing });
            return;
          }
          // A peer tab can finish this tab's uncertain attempt under the same
          // key before, or without, the storage event reaching this tab. A
          // retry of that same request must keep the committed key so the
          // server replays its saved receipt; a fresh key would apply the
          // work a second time. Any other request starts fresh.
          const reopensOwnAttempt = sameActiveIntent
            && ownAttemptRequestVersion !== null
            && ownAttemptRequestVersion === existing.requestVersion;
          const record = reopensOwnAttempt
            ? {
              ...proposed,
              requestVersion: existing.requestVersion,
              idempotencyKey: existing.idempotencyKey,
              createdAtMs: existing.createdAtMs,
              retryNotAfterMs: existing.retryNotAfterMs,
            }
            : proposed;
          result = { record, conflict: false };
          store.put({ storageKey, record });
        } else if (owned && (sameIntent || intentExpired)) {
          const liveClaimTabIds = retainLiveClaims(existing.claimTabIds, tabId);
          const claimed = {
            ...existing,
            claimTabIds: liveClaimTabIds.includes(tabId)
              ? liveClaimTabIds
              : [...liveClaimTabIds, tabId],
          };
          result = { record: claimed, conflict: false };
          store.put({ storageKey, record: claimed });
        } else {
          if (sameActiveIntent) {
            const liveClaimTabIds = retainLiveClaims(existing.claimTabIds, tabId);
            const transferred = {
              ...existing,
              surface: options.surface,
              scope: options.scope || '',
              claimTabIds: liveClaimTabIds.includes(tabId)
                ? liveClaimTabIds
                : [...liveClaimTabIds, tabId],
              intent: candidateIntent,
            };
            result = { record: transferred, conflict: false };
            store.put({ storageKey, record: transferred });
          } else {
            result = { record: existing, conflict: true };
          }
        }
        if (!stored) store.put({ storageKey, record: result.record });
      };
      request.onerror = () => reject(
        request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.oncomplete = () => {
        if (result) resolve(result);
        else reject(new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'));
      };
      transaction.onerror = () => reject(
        transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
    });
  } finally {
    db.close();
  }
}

async function readCoordinatedRecord<T>(
  storageKey: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
): Promise<DurableMutationIntentRecord<T> | null> {
  if (!storageKey || !options) return null;
  const db = await openDurableIntentDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DURABLE_INTENT_STORE, 'readonly');
      const request = transaction.objectStore(DURABLE_INTENT_STORE).get(storageKey);
      request.onsuccess = () => {
        const stored = request.result as { record?: unknown } | undefined;
        const candidate = stored?.record as Partial<DurableMutationIntentRecord<T>> | undefined;
        resolve(candidate && isValidRecord(candidate, options)
          ? candidate
          : stored
            ? blockedDurableRecord(options)
            : null);
      };
      request.onerror = () => reject(
        request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
    });
  } finally {
    db.close();
  }
}

async function resolveCoordinatedRecord<T>(
  storageKey: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
  requestVersion: string | null,
): Promise<DurableMutationIntentRecord<T> | null> {
  if (!storageKey || !options || !requestVersion) return null;
  const db = await openDurableIntentDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DURABLE_INTENT_STORE, 'readwrite');
      const store = transaction.objectStore(DURABLE_INTENT_STORE);
      const request = store.get(storageKey);
      let result: DurableMutationIntentRecord<T> | null = null;
      request.onsuccess = () => {
        const stored = request.result as { record?: unknown } | undefined;
        const candidate = stored?.record as Partial<DurableMutationIntentRecord<T>> | undefined;
        if (!candidate || !isValidRecord(candidate, options)) return;
        if (candidate.requestVersion !== requestVersion) {
          result = candidate;
          return;
        }
        result = {
          ...candidate,
          status: 'resolved',
          resolvedAtMs: Date.now(),
        };
        store.put({ storageKey, record: result });
      };
      request.onerror = () => reject(
        request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(
        transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
    });
  } finally {
    db.close();
  }
}

async function deleteCoordinatedRecord<T>(
  storageKey: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
  requestVersion: string | null,
  tabId: string | null,
): Promise<{ deleted: boolean; current: DurableMutationIntentRecord<T> | null }> {
  if (!storageKey || !options || !requestVersion || !tabId) {
    return { deleted: false, current: null };
  }
  const db = await openDurableIntentDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DURABLE_INTENT_STORE, 'readwrite');
      const store = transaction.objectStore(DURABLE_INTENT_STORE);
      const request = store.get(storageKey);
      let outcome: { deleted: boolean; current: DurableMutationIntentRecord<T> | null } = {
        deleted: false,
        current: null,
      };
      request.onsuccess = () => {
        const stored = request.result as { record?: unknown } | undefined;
        const candidate = stored?.record as Partial<DurableMutationIntentRecord<T>> | undefined;
        if (!candidate || !isValidRecord(candidate, options)) return;
        if (candidate.requestVersion === requestVersion) {
          if (candidate.status === 'resolved') {
            // A definitive response from one claimant must never erase proof
            // that an identical peer request already committed.
            outcome = { deleted: false, current: candidate };
            return;
          }
          const remainingClaimTabIds = candidate.claimTabIds.filter(
            (claimTabId) => claimTabId !== tabId && isClaimLive(claimTabId),
          );
          if (remainingClaimTabIds.length === 0) {
            store.delete(storageKey);
            outcome = { deleted: true, current: null };
          } else {
            const current = { ...candidate, claimTabIds: remainingClaimTabIds };
            store.put({ storageKey, record: current });
            outcome = { deleted: false, current };
          }
        } else {
          outcome = { deleted: false, current: candidate };
        }
      };
      request.onerror = () => reject(
        request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.oncomplete = () => resolve(outcome);
      transaction.onerror = () => reject(
        transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
    });
  } finally {
    db.close();
  }
}

// One prepare at a time per operation and user in this page. Two prepares share this page's claim ID, so without
// this a failing one's cleanup could delete a record a concurrent one (a double click) had already handed out.
const prepareTurns = new Map<string, Promise<unknown>>();

function inPrepareTurn<R>(storageKey: string | null, run: () => Promise<R>): Promise<R> {
  if (!storageKey) return run();
  const previous = prepareTurns.get(storageKey) ?? Promise.resolve();
  const mine = previous.catch(() => undefined).then(run);
  const settled = mine.catch(() => undefined);
  prepareTurns.set(storageKey, settled);
  void settled.then(() => {
    if (prepareTurns.get(storageKey) === settled) prepareTurns.delete(storageKey);
  });
  return mine;
}

/**
 * A mirror write failed after IndexedDB took a record that beginIntent had just minted, and the caller never got
 * a key, so nothing was sent. Left in place, that hidden record would block the next request with no visible lock
 * to clear. Only that exact version is removed: an earlier request's record may have committed and is kept.
 * A record that could not be removed is shown as a lock rather than left hidden.
 */
async function discardUnsentRecord<T>({ storageKey, options, proposed, coordinated, tabId, showLock }: {
  storageKey: string;
  options: DurableMutationIntentOptions<T>;
  proposed: DurableMutationIntentRecord<T>;
  coordinated: { record: DurableMutationIntentRecord<T>; conflict: boolean } | null;
  tabId: string;
  showLock: (record: DurableMutationIntentRecord<T>) => void;
}): Promise<void> {
  // Only a record this call minted: not a conflict, and not an earlier request it restored or reopened.
  if (!coordinated || coordinated.conflict || coordinated.record.requestVersion !== proposed.requestVersion) return;
  const cleanup = await deleteSoleClaimRecord(storageKey, options, proposed.requestVersion, tabId).catch(() => null);
  if (!cleanup?.deleted) {
    // Kept: another tab joined it (and may have sent it), or the delete failed. Keep the mirror so a reload shows it too.
    showLock(cleanup?.current ?? proposed);
    return;
  }
  if (readDurableRecord(storageKey, options)?.requestVersion === proposed.requestVersion) removeDurableRecord(storageKey);
}

/**
 * Deletes a pending record only while this tab is its sole claimant. Unlike deleteCoordinatedRecord, a tab that
 * joined and has since closed still counts: it may have sent the request before closing.
 */
async function deleteSoleClaimRecord<T>(
  storageKey: string,
  options: DurableMutationIntentOptions<T>,
  requestVersion: string,
  tabId: string,
): Promise<{ deleted: boolean; current: DurableMutationIntentRecord<T> | null }> {
  const db = await openDurableIntentDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DURABLE_INTENT_STORE, 'readwrite');
      const store = transaction.objectStore(DURABLE_INTENT_STORE);
      const request = store.get(storageKey);
      let outcome: { deleted: boolean; current: DurableMutationIntentRecord<T> | null } = { deleted: false, current: null };
      request.onsuccess = () => {
        const stored = request.result as { record?: unknown } | undefined;
        if (!stored) { outcome = { deleted: true, current: null }; return; }
        const candidate = stored.record as Partial<DurableMutationIntentRecord<T>> | undefined;
        if (!candidate || !isValidRecord(candidate, options)) return;
        const sole = candidate.status === 'pending' && candidate.requestVersion === requestVersion
          && candidate.claimTabIds.length === 1 && candidate.claimTabIds[0] === tabId;
        if (!sole) { outcome = { deleted: false, current: candidate }; return; }
        store.delete(storageKey);
        outcome = { deleted: true, current: null };
      };
      request.onerror = () => reject(request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'));
      transaction.oncomplete = () => resolve(outcome);
      transaction.onerror = () => reject(transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'));
      transaction.onabort = () => reject(transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'));
    });
  } finally {
    db.close();
  }
}

/**
 * Freezes the exact payload of a mutation whose outcome is not yet known.
 *
 * A transport failure can arrive after PostgreSQL committed. Until an exact
 * retry replays that receipt (or the server proves it rejected the request),
 * callers must not accept edited input or mint a new idempotency key.
 */
export function useUncertainMutationIntent<T>(options?: DurableMutationIntentOptions<T>) {
  const storageKey = durableStorageKey(options);
  const surface = options?.surface || '';
  const scope = options?.scope || '';
  const identityToken = `${storageKey || ''}:${JSON.stringify([surface, scope])}`;
  // Latest committed fingerprint callback, read only inside beginIntent (an event handler).
  const getIntentIdentityRef = useLatestRef(options?.getIntentIdentity);
  /* eslint-disable react-hooks/refs -- Guarded one-time initialization, reviewed 2026-10-14:
     tabIdRef is lazily set once per mount; the key below uses only its tab prefix (before the
     last ':'), which is stable while sessionStorage is available, so a discarded render's
     different UUID suffix cannot change acknowledgmentKey. Without storage there is no receipt
     to preserve across reloads anyway, and effects run only for the committed render. */
  const tabIdRef = useRef<string | null>(null);
  if (tabIdRef.current === null && typeof window !== 'undefined') tabIdRef.current = currentPageClaimId();
  // The stable tab prefix preserves an unacknowledged receipt across reload.
  // Duplicating a tab copies its sessionStorage snapshot: the copied attempt
  // must still replay the old receipt, never become a fresh key. If newer shared
  // work conflicts with that snapshot, keep it locked for staff reconciliation.
  // The separate page claim UUID distinguishes live claimants, not receipts.
  const acknowledgmentKey = storageKey && options && tabIdRef.current
    ? `${ACKNOWLEDGMENT_PREFIX}${JSON.stringify([options.operation, options.userId,
      surface, scope, tabIdRef.current.slice(0, tabIdRef.current.lastIndexOf(':'))])}`
    : null;
  /* eslint-enable react-hooks/refs */
  const initialRecord = readDurableRecord<T>(storageKey, options);
  const savedAttempt = readAcknowledgmentRecord<T>(acknowledgmentKey, options);
  const initialVisible = savedAttempt ?? initialRecord;
  const initialPending = initialVisible?.status === 'pending';
  const initialOwned = initialPending
    && initialVisible.surface === surface
    && initialVisible.scope === scope;
  const activeIdentityRef = useRef(identityToken);
  const recordRef = useRef<DurableMutationIntentRecord<T> | null>(
    savedAttempt?.surface === '__reconciliation_required__' ? savedAttempt : initialRecord ?? initialVisible,
  );
  const attemptRecordRef = useRef<DurableMutationIntentRecord<T> | null>(savedAttempt ?? (initialOwned ? initialVisible : null));
  const persistedAcknowledgmentIdentityRef = useRef<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(initialPending ? initialVisible.idempotencyKey : null);
  const intentRef = useRef<T | null>(initialOwned ? initialVisible.intent : null);
  const retryNotAfterRef = useRef<number | null>(initialPending ? initialVisible.retryNotAfterMs : null);
  const [unresolvedIntent, setUnresolvedIntent] = useState<T | null>(initialOwned ? initialVisible.intent : null);
  const [hasUnresolvedRecord, setHasUnresolvedRecord] = useState(initialPending);
  const [isIntentResolved, setIsIntentResolved] = useState(initialRecord?.status === 'resolved'
    && (!savedAttempt || initialRecord.requestVersion === savedAttempt.requestVersion));
  const [isForeignIntentLocked, setIsForeignIntentLocked] = useState(Boolean(initialPending && !initialOwned));
  const [retryNotAfterMs, setRetryNotAfterMs] = useState<number | null>(
    initialPending ? initialVisible.retryNotAfterMs : null,
  );
  // Only the screen that saved the request can clear it: that screen shows the
  // saved values staff need to find the real record.
  const [lockedRequest, setLockedRequest] = useState<DurableMutationIntentRecord<T> | null>(
    initialOwned ? initialVisible : null,
  );
  const [, setExpiryRevision] = useState(0);

  const applyRecord = useCallback((record: DurableMutationIntentRecord<T> | null) => {
    // A peer completion is still this tab's retry until its handler acknowledges
    // the result. Unlocking early would present identical new work while
    // beginIntent still correctly replays this attempt's committed receipt.
    const attempt = attemptRecordRef.current;
    const visible = attempt?.surface === '__reconciliation_required__'
      || (attempt?.status === 'pending' && attempt.surface === surface && attempt.scope === scope)
      ? attempt : record;
    const pending = visible?.status === 'pending';
    const owned = pending && visible.surface === surface && visible.scope === scope;
    recordRef.current = attempt?.surface === '__reconciliation_required__' ? attempt : record ?? attempt;
    setIsIntentResolved(recordRef.current?.status === 'resolved'
      && (!attempt || recordRef.current.requestVersion === attempt.requestVersion));
    idempotencyKeyRef.current = pending ? visible.idempotencyKey : null;
    intentRef.current = owned ? visible.intent : null;
    retryNotAfterRef.current = pending ? visible.retryNotAfterMs : null;
    setUnresolvedIntent(owned ? visible.intent : null);
    setHasUnresolvedRecord(pending);
    setIsForeignIntentLocked(Boolean(pending && !owned));
    setRetryNotAfterMs(pending ? visible.retryNotAfterMs : null);
    setLockedRequest(owned ? visible : null);
  }, [scope, surface]);

  const activateCurrentIdentity = useCallback((force = false) => {
    if (!storageKey) return;
    if (!force && activeIdentityRef.current === identityToken) return;
    if (activeIdentityRef.current !== identityToken) {
      persistedAcknowledgmentIdentityRef.current = null;
      attemptRecordRef.current = readAcknowledgmentRecord<T>(acknowledgmentKey, options);
    }
    activeIdentityRef.current = identityToken;
    applyRecord(readDurableRecord<T>(storageKey, options));
  }, [acknowledgmentKey, applyRecord, identityToken, options, storageKey]);

  useEffect(() => {
    activateCurrentIdentity();
  }, [activateCurrentIdentity]);

  useEffect(() => {
    const attempt = attemptRecordRef.current;
    if (!attempt || attempt.status !== 'pending'
      || attempt.surface !== surface || attempt.scope !== scope) return;
    const acknowledgmentIdentity = JSON.stringify([acknowledgmentKey, surface, scope, attempt.requestVersion]);
    if (persistedAcknowledgmentIdentityRef.current === acknowledgmentIdentity) return;
    try {
      // Restored pending requests need the same per-tab acknowledgment record
      // before a peer can resolve their shared durable tombstone.
      writeAcknowledgmentRecord(acknowledgmentKey, attempt);
      persistedAcknowledgmentIdentityRef.current = acknowledgmentIdentity;
    } catch {
      if (options) {
        const blocked = blockedDurableRecord<T>(options);
        attemptRecordRef.current = blocked;
        applyRecord(blocked);
      }
    }
  }, [acknowledgmentKey, applyRecord, options, scope, surface]);

  useEffect(() => {
    const claimId = tabIdRef.current;
    if (!claimId) return;
    const release = () => releaseLiveClaim(claimId);
    // Renew this page's lease for as long as it is mounted. Without the
    // heartbeat the lease would expire under a page that is still running and a
    // peer could delete a record whose request is genuinely in flight.
    const heartbeat = window.setInterval(
      () => renewLiveClaim(claimId),
      DURABLE_INTENT_LIVE_CLAIM_HEARTBEAT_MS,
    );
    window.addEventListener('pagehide', release);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener('pagehide', release);
      release();
    };
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && event.key === storageKey) {
        activateCurrentIdentity(true);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [activateCurrentIdentity, storageKey]);

  useEffect(() => {
    if (retryNotAfterMs === null) return;
    const remainingMs = retryNotAfterMs - Date.now();
    if (remainingMs <= 0) {
      setExpiryRevision((revision) => revision + 1);
      return;
    }
    const timer = window.setTimeout(
      () => setExpiryRevision((revision) => revision + 1),
      remainingMs + 1,
    );
    return () => window.clearTimeout(timer);
  }, [retryNotAfterMs]);

  // `requireIdempotencyKey` is for retrying a request the caller has already
  // shown as unresolved: the retry proceeds only while that exact request is
  // still pending under that key, checked again inside the durable transaction.
  // If another tab resolved or replaced it in the meantime, this throws
  // UNCERTAIN_MUTATION_INTENT_CONFLICT without starting a new request, because a
  // new request would carry a new key and could apply the mutation twice.
  const beginIntentNow = useCallback(async (
    intent: T,
    beginOptions?: { requireIdempotencyKey?: string },
  ): Promise<T> => {
    activateCurrentIdentity(true);
    const requiredKey = beginOptions?.requireIdempotencyKey;
    const mirrorRecord = recordRef.current;
    if (
      requiredKey !== undefined
      && (!options || mirrorRecord?.status !== 'pending' || mirrorRecord.idempotencyKey !== requiredKey)
    ) {
      throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
    }
    if (!options && intentRef.current !== null) return intentRef.current;
    if (options) {
      if (!storageKey) throw new Error('DURABLE_MUTATION_INTENT_IDENTITY_MISSING');
      // A malformed mirror cannot establish whether it represented a pending
      // request before the local failure. Do not let an absent IndexedDB record
      // turn that uncertainty into permission for a new mutation.
      if (mirrorRecord?.surface === '__reconciliation_required__') {
        writeDurableRecord(storageKey, mirrorRecord);
        throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
      }
      const currentClaimId = tabIdRef.current ?? currentPageClaimId();
      tabIdRef.current = currentClaimId;
      markClaimLive(currentClaimId);
      const idempotencyKey = generateIdempotencyKey(options.operation, options.userId);
      const createdAtMs = Date.now();
      const retryNotAfterMs = createdAtMs + SAFE_RETRY_WINDOW_MS;
      // localStorage is only a UI mirror. It can lag behind IndexedDB when a
      // response resolves between the two writes, so a coordinator record
      // always wins: a pending one is restored (including conflict and expiry
      // refusal) and a resolved one receives a fresh candidate unless it is
      // this tab's own uncertain attempt, which keeps its committed key.
      // Only when the coordinator has no record at all is the local mirror
      // offered in its place, because then it is the sole evidence that an
      // earlier request may have committed.
      const proposed: DurableMutationIntentRecord<T> = {
        version: 4,
        status: 'pending',
        requestVersion: crypto.randomUUID(),
        claimTabIds: [currentClaimId],
        resolvedAtMs: null,
        operation: options.operation,
        userId: options.userId,
        surface,
        scope,
        idempotencyKey,
        intentIdentity: fingerprintIntent(intent, getIntentIdentityRef.current),
        intent,
        createdAtMs,
        retryNotAfterMs,
      };
      let coordinated: { record: DurableMutationIntentRecord<T>; conflict: boolean } | null = null;
      try {
        coordinated = await coordinateDurableRecord(
          storageKey,
          proposed,
          intent,
          options,
          currentClaimId,
          mirrorRecord,
          attemptRecordRef.current?.requestVersion ?? null,
          requiredKey,
        );
        writeDurableRecord(storageKey, coordinated.record);
        if (coordinated.conflict) {
          applyRecord(coordinated.record);
          throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
        }
        writeAcknowledgmentRecord(acknowledgmentKey, coordinated.record);
        persistedAcknowledgmentIdentityRef.current = JSON.stringify([
          acknowledgmentKey, surface, scope, coordinated.record.requestVersion,
        ]);
        attemptRecordRef.current = coordinated.record;
        applyRecord(coordinated.record);
        return coordinated.record.intent;
      } catch (error) {
        await discardUnsentRecord({ storageKey, options, proposed, coordinated, tabId: currentClaimId, showLock: applyRecord });
        releaseLiveClaim(currentClaimId);
        throw error;
      }
    }

    intentRef.current = intent;
    setUnresolvedIntent(intent);
    setHasUnresolvedRecord(true);
    return intent;
  }, [acknowledgmentKey, activateCurrentIdentity, applyRecord, getIntentIdentityRef, options, scope, storageKey, surface]);

  const beginIntent = useCallback(
    (intent: T, beginOptions?: { requireIdempotencyKey?: string }): Promise<T> =>
      inPrepareTurn(storageKey, () => beginIntentNow(intent, beginOptions)),
    [beginIntentNow, storageKey],
  );

  const getIdempotencyKey = useCallback((): string => {
    activateCurrentIdentity(true);
    if (
      recordRef.current
      && (recordRef.current.status !== 'pending'
        || recordRef.current.surface !== surface
        || recordRef.current.scope !== scope)
    ) {
      throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
    }
    if (
      recordRef.current
      && attemptRecordRef.current?.requestVersion !== recordRef.current.requestVersion
    ) {
      throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
    }
    if (intentRef.current === null || idempotencyKeyRef.current === null) {
      throw new Error('DURABLE_MUTATION_INTENT_NOT_STARTED');
    }
    if (retryNotAfterRef.current === null || Date.now() >= retryNotAfterRef.current) {
      throw new Error(UNCERTAIN_MUTATION_RETRY_EXPIRED);
    }
    return idempotencyKeyRef.current;
  }, [activateCurrentIdentity, scope, surface]);

  const resolveIntent = useCallback(async () => {
    if (!options) {
      attemptRecordRef.current = null;
      applyRecord(null);
      return;
    }
    const attempt = attemptRecordRef.current;
    const resolved = await resolveCoordinatedRecord(
      storageKey,
      options,
      attempt?.requestVersion ?? null,
    );
    if (resolved) {
      if (storageKey) writeDurableRecord(storageKey, resolved);
      clearAcknowledgmentRecord(acknowledgmentKey, options, attempt?.requestVersion ?? null);
      attemptRecordRef.current = null;
      applyRecord(resolved);
    } else if (attempt && storageKey) {
      // No coordinator row was left to resolve (IndexedDB lost it). This request
      // is known to have committed, so retire its pending mirror; beginIntent
      // would otherwise restore it as unresolved. A mirror that now belongs to a
      // different request is left alone.
      const mirror = readDurableRecord<T>(storageKey, options);
      let visibleRecord = mirror;
      if (!mirror || mirror.requestVersion === attempt.requestVersion) {
        const retired: DurableMutationIntentRecord<T> = {
          ...attempt,
          status: 'resolved',
          resolvedAtMs: Date.now(),
        };
        writeDurableRecord(storageKey, retired);
        visibleRecord = retired;
      }
      // This exact attempt is confirmed complete even if a newer mirror must
      // remain untouched. Retire only its acknowledgement, then show the newer
      // durable lock; otherwise a reload restores an already completed attempt.
      clearAcknowledgmentRecord(acknowledgmentKey, options, attempt.requestVersion);
      attemptRecordRef.current = null;
      applyRecord(visibleRecord);
    }
    attemptRecordRef.current = null;
  }, [acknowledgmentKey, applyRecord, options, storageKey]);

  const classifyFailure = useCallback(async (error: unknown): Promise<MutationFailureDisposition> => {
    const attempt = attemptRecordRef.current;
    if (
      error instanceof Error
      && (error.message === UNCERTAIN_MUTATION_RETRY_EXPIRED
        || error.message === UNCERTAIN_MUTATION_INTENT_CONFLICT)
    ) {
      return 'uncertain';
    }
    try {
      if (isDefinitiveRpcRejection(error)) {
        if (!options) {
          attemptRecordRef.current = null;
          applyRecord(null);
          return 'definitive';
        }
        const outcome = await deleteCoordinatedRecord(
          storageKey,
          options,
          attempt?.requestVersion ?? null,
          tabIdRef.current,
        );
        if (outcome.deleted) {
          clearAcknowledgmentRecord(acknowledgmentKey, options, attempt?.requestVersion ?? null);
          attemptRecordRef.current = null;
          removeDurableRecord(storageKey);
          applyRecord(null);
        } else if (outcome.current) {
          if (storageKey) writeDurableRecord(storageKey, outcome.current);
          if (outcome.current.status === 'resolved') {
            clearAcknowledgmentRecord(acknowledgmentKey, options, attempt?.requestVersion ?? null);
            attemptRecordRef.current = null;
          }
          applyRecord(outcome.current);
          if (outcome.current.status === 'resolved') {
            attemptRecordRef.current = null;
            return 'resolved';
          }
          // A peer still owns this pending request. Keep this tab's attempt and
          // acknowledgment so its eventual receipt remains an exact-key retry.
          return 'definitive';
        }
        clearAcknowledgmentRecord(acknowledgmentKey, options, attempt?.requestVersion ?? null);
        attemptRecordRef.current = null;
        return 'definitive';
      }
      const current = await readCoordinatedRecord(storageKey, options);
      if (current) {
        if (storageKey) writeDurableRecord(storageKey, current);
        if (
          attempt
          && current.requestVersion === attempt.requestVersion
          && current.status === 'resolved'
        ) {
          clearAcknowledgmentRecord(acknowledgmentKey, options, attempt.requestVersion);
          attemptRecordRef.current = null;
          applyRecord(current);
          return 'resolved';
        }
        applyRecord(current);
        return 'uncertain';
      }
      if (attempt && options && storageKey && attempt.status === 'pending') {
        const restored = await coordinateDurableRecord(
          storageKey,
          attempt,
          attempt.intent,
          options,
          tabIdRef.current ?? currentPageClaimId(),
        );
        writeDurableRecord(storageKey, restored.record);
        applyRecord(restored.record);
      }
      return 'uncertain';
    } catch {
      // Failure classification runs inside mutation catch paths. If durable
      // coordination is unavailable here, preserve the in-memory lock and
      // report an uncertain outcome instead of throwing past the caller.
      return 'uncertain';
    }
  }, [acknowledgmentKey, applyRecord, options, storageKey]);

  // KI-27: once the safe retry window has passed, the saved request can never be
  // retried and would lock this operation in this browser forever. After staff
  // verify the authoritative record, this drops the expired request from every
  // store this tab can reach. It refuses while any copy could still be retried.
  // expectedIdempotencyKey is the request staff reviewed; any other request is refused.
  const clearExpiredIntent = useCallback(async (expectedIdempotencyKey: string) => {
    if (!options || !storageKey) throw new Error('DURABLE_MUTATION_INTENT_IDENTITY_MISSING');
    // Only an intact request past a known deadline is clearable; damaged or
    // legacy state proves nothing about its deadline, so it stays locked. This
    // device's clock only decides when to offer the clear; the server check below
    // decides whether the request could still save.
    const isClearable = (record: DurableMutationIntentRecord<T> | null) => !record
      || record.status === 'resolved'
      || (record.idempotencyKey === expectedIdempotencyKey
        && record.surface === surface
        && record.scope === scope
        && hasKnownRetryDeadline(record)
        && Date.now() >= record.retryNotAfterMs);
    const mirror = readDurableRecord<T>(storageKey, options);
    const attempt = readAcknowledgmentRecord<T>(acknowledgmentKey, options);
    if (!isClearable(mirror) || !isClearable(attempt)) throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
    const checkKey = await confirmClearWithServer(expectedIdempotencyKey);
    const db = await openDurableIntentDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(DURABLE_INTENT_STORE, 'readwrite');
        const store = transaction.objectStore(DURABLE_INTENT_STORE);
        const request = store.get(storageKey);
        let refused = false;
        request.onsuccess = () => {
          const stored = request.result as { record?: unknown } | undefined;
          if (!stored) return;
          const candidate = stored.record as Partial<DurableMutationIntentRecord<T>> | undefined;
          const record = candidate && isValidRecord(candidate, options) ? candidate : blockedDurableRecord(options);
          // A resolved tombstone never locks anything; keep it as receipt proof.
          if (record.status === 'resolved') return;
          if (!isClearable(record)) {
            refused = true;
            return;
          }
          store.delete(storageKey);
        };
        request.onerror = () => reject(
          request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
        );
        transaction.oncomplete = () => (refused
          ? reject(new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT))
          : resolve());
        transaction.onerror = () => reject(
          transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
        );
        transaction.onabort = () => reject(
          transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
        );
      });
    } finally {
      db.close();
    }
    clearCheckTokens.delete(checkKey);
    try {
      // Another tab may have started a new request since the read above; keep its mirror.
      const current = readDurableRecord<T>(storageKey, options);
      if (current && current.status !== 'resolved' && current.requestVersion === mirror?.requestVersion) {
        window.localStorage.removeItem(storageKey);
      }
      if (acknowledgmentKey) window.sessionStorage.removeItem(acknowledgmentKey);
      window.localStorage.removeItem(checkKey);
    } catch {
      throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
    }
    attemptRecordRef.current = null;
    persistedAcknowledgmentIdentityRef.current = null;
    applyRecord(readDurableRecord<T>(storageKey, options));
  }, [acknowledgmentKey, applyRecord, options, scope, storageKey, surface]);

  // Same value as `unresolvedIntent`, read from the ref instead of state.
  // `unresolvedIntent` is React state, so a caller that awaits classifyFailure()
  // and then reads it in the SAME tick still sees the render-time value — which
  // is null on the first failure, silently skipping any "an intent survived"
  // branch. applyRecord() writes intentRef synchronously, so this accessor is
  // correct immediately after classifyFailure()/beginIntent() resolve. Use the
  // state field for rendering; use this when branching inside an async handler.
  const getUnresolvedIntent = useCallback(() => intentRef.current, []);
  // A known resolved record cannot satisfy an opt-in pending-key retry, even
  // while this tab retains its original attempt for receipt reconciliation.
  // This accessor does not start or claim anything.
  const getPendingIdempotencyKey = useCallback(
    () => (intentRef.current !== null && recordRef.current?.status === 'pending'
      ? idempotencyKeyRef.current : null),
    [],
  );
  const getIsIntentResolved = useCallback(() => {
    const record = recordRef.current;
    const attempt = attemptRecordRef.current;
    return record?.status === 'resolved'
      && (!attempt || record.requestVersion === attempt.requestVersion);
  }, []);

  return {
    beginIntent,
    getIdempotencyKey,
    resolveIntent,
    classifyFailure,
    clearExpiredIntent,
    unresolvedIntent,
    getUnresolvedIntent,
    getPendingIdempotencyKey,
    isIntentResolved,
    getIsIntentResolved,
    isIntentLocked: hasUnresolvedRecord,
    isForeignIntentLocked,
    // eslint-disable-next-line react-hooks/purity -- the retryNotAfterMs effect above re-renders exactly when the window expires, so this clock read cannot go stale
    isRetryExpired: retryNotAfterMs !== null && Date.now() >= retryNotAfterMs,
    // Set only when the signed-in staff member may clear the locked request: its known deadline has passed.
    clearableExpiredRequest: lockedRequest
      && hasKnownRetryDeadline(lockedRequest)
      // eslint-disable-next-line react-hooks/purity -- same expiry re-render as isRetryExpired
      && Date.now() >= lockedRequest.retryNotAfterMs
      ? {
        surface: lockedRequest.surface,
        scope: lockedRequest.scope,
        idempotencyKey: lockedRequest.idempotencyKey,
        createdAtMs: lockedRequest.createdAtMs,
        retryNotAfterMs: lockedRequest.retryNotAfterMs,
      } satisfies LockedRequestDetails
      : null,
  };
}
