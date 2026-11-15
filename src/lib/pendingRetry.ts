/**
 * A request whose reply never arrived, kept in this browser tab so it survives a reload.
 *
 * useIdempotencyKey keeps its keys in memory, so a reload after a lost reply forgets the key and
 * the next tap mints a new one: if the first request had committed, that makes a second record
 * (S14, KI-11: Partial Order). Keeping the key and the exact request here lets the screen re-send
 * the same request with the same key, so the server answers with what it already did or does it
 * once. Past the server's receipt lifetime (idempotency_keys.expires_at, 24 hours) it is kept but
 * marked expired, so the screen can warn instead of re-sending.
 * Storage may be unavailable (private mode, quota): then this is a no-op and the screen behaves as
 * it did before.
 */
const RECEIPT_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface PendingRetry<T> {
  key: string;
  request: T;
  sentAt: number;
  /** Past the receipt's lifetime, or its receipt was refused: it can no longer be finished safely, only checked by hand. */
  expired?: boolean;
  /** Set when the server refused this key's receipt: the send may have made an order. */
  needsCheck?: boolean;
  /** Local dispatch generation. Never sent to the server. */
  dispatchFence?: string;
}

export type RetryInspection<T> =
  | { kind: 'absent' }
  | { kind: 'valid'; pending: PendingRetry<T> }
  | { kind: 'damaged' }
  | { kind: 'unknown' };

const storageKey = (name: string) => `crx:pending-retry:${name}`;

function hasValidRetryEnvelope<T>(pending: PendingRetry<T>, isValidRequest: (request: unknown) => request is T, actorId?: string) {
  return typeof pending.key === 'string' && pending.key.length > 0 && typeof pending.sentAt === 'number'
    && Number.isFinite(pending.sentAt) && isValidRequest(pending.request)
    && (!('needsCheck' in pending) || typeof pending.needsCheck === 'boolean')
    && (!('dispatchFence' in pending) || (typeof pending.dispatchFence === 'string' && pending.dispatchFence.length > 0))
    && (!('expired' in pending) || typeof pending.expired === 'boolean')
    && (actorId === undefined || (pending.request as { actorId?: unknown })?.actorId === actorId);
}

/** Non-deleting inspection for callers that must preserve corrupt data for a manual check. */
export function inspectPendingRetry<T>(
  name: string,
  isValidRequest: (request: unknown) => request is T,
  actorId?: string,
): RetryInspection<T> {
  try {
    const raw = sessionStorage.getItem(storageKey(name));
    if (raw === null) return { kind: 'absent' };
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return { kind: 'damaged' }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'damaged' };
    const pending = value as PendingRetry<T>;
    if (!hasValidRetryEnvelope(pending, isValidRequest, actorId)) return { kind: 'damaged' };
    const age = Date.now() - pending.sentAt;
    return { kind: 'valid', pending: { ...pending, expired: pending.needsCheck === true || age < 0 || age > RECEIPT_LIFETIME_MS } };
  } catch { return { kind: 'unknown' }; }
}

/** Writes only when the key is still absent in this synchronous read/compare/write step. */
export function createPendingRetryIfAbsent<T>(name: string, pending: PendingRetry<T>): boolean {
  try {
    const key = storageKey(name);
    if (sessionStorage.getItem(key) !== null) return false;
    sessionStorage.setItem(key, JSON.stringify(pending));
    return sessionStorage.getItem(key) === JSON.stringify(pending);
  } catch { return false; }
}

/** Updates a valid matching dispatch without an await between inspection and write. */
export function updatePendingRetryIfMatching<T>(args: {
  name: string;
  isValidRequest: (request: unknown) => request is T;
  key: string;
  actorId: string;
  request: T;
  fence: string | undefined;
  update: (current: PendingRetry<T>) => PendingRetry<T>;
}): boolean {
  try {
    const { name, isValidRequest, key, actorId, request, fence, update } = args;
    const storage = storageKey(name);
    const raw = sessionStorage.getItem(storage);
    if (raw === null) return false;
    const inspected = inspectPendingRetry(name, isValidRequest, actorId);
    if (inspected.kind !== 'valid' || sessionStorage.getItem(storage) !== raw) return false;
    const current = inspected.pending;
    if (current.key !== key || current.dispatchFence !== fence
      || JSON.stringify(current.request) !== JSON.stringify(request)) return false;
    sessionStorage.setItem(storage, JSON.stringify(update(current)));
    return true;
  } catch { return false; }
}

/** Clears a valid exact operation; success receipts may settle any dispatch fence for that operation. */
export function clearPendingRetryIfMatching<T>(args: {
  name: string;
  isValidRequest: (request: unknown) => request is T;
  key: string;
  actorId: string;
  request: T;
  fence?: string;
}): boolean {
  try {
    const { name, isValidRequest, key, actorId, request, fence } = args;
    const storage = storageKey(name);
    const raw = sessionStorage.getItem(storage);
    if (raw === null) return true;
    const inspected = inspectPendingRetry(name, isValidRequest, actorId);
    if (inspected.kind !== 'valid' || sessionStorage.getItem(storage) !== raw) return false;
    const current = inspected.pending;
    if (current.key !== key || (fence !== undefined && current.dispatchFence !== fence)
      || JSON.stringify(current.request) !== JSON.stringify(request)) return false;
    sessionStorage.removeItem(storage);
    return sessionStorage.getItem(storage) === null;
  } catch { return false; }
}

/** Clears damaged bytes only if the same damaged value remains; raw bytes never leave this helper. */
export function clearDamagedPendingRetryIfUnchanged<T>(
  name: string,
  isValidRequest: (request: unknown) => request is T,
  actorId?: string,
): boolean {
  try {
    const storage = storageKey(name);
    const first = sessionStorage.getItem(storage);
    if (first === null) return true;
    const inspected = inspectPendingRetry(name, isValidRequest, actorId);
    if (inspected.kind !== 'damaged' || sessionStorage.getItem(storage) !== first) return false;
    sessionStorage.removeItem(storage);
    return sessionStorage.getItem(storage) === null;
  } catch { return false; }
}

export function loadPendingRetry<T>(
  name: string,
  isValidRequest: (request: unknown) => request is T = (_request): _request is T => true,
): PendingRetry<T> | null {
  try {
    const raw = sessionStorage.getItem(storageKey(name));
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingRetry<T>;
    if (typeof pending?.key !== 'string' || typeof pending.sentAt !== 'number'
        || !isValidRequest(pending.request)
        || !Number.isFinite(pending.sentAt)) {
      sessionStorage.removeItem(storageKey(name));
      return null;
    }
    // An expired entry is kept, so the screen can warn before another send instead of forgetting it.
    // A send time in the future (the clock moved back) leaves its age unknown: treat it as expired.
    const age = Date.now() - pending.sentAt;
    return { ...pending, expired: pending.needsCheck === true || age < 0 || age > RECEIPT_LIFETIME_MS };
  } catch {
    return null;
  }
}

/** False when the note could not be stored: the caller must not send, or a lost reply could not be finished after a reload. */
export function savePendingRetry<T>(name: string, key: string, request: T): boolean {
  try {
    // A retry of the same key keeps the first send time: the server's receipt expires from then.
    const kept = loadPendingRetry<T>(name);
    const sentAt = kept?.key === key ? kept.sentAt : Date.now();
    sessionStorage.setItem(storageKey(name), JSON.stringify({ key, request, sentAt }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Flags the kept entry for a hand check, keeping it; a no-op when nothing is kept. Best effort: if the
 * write fails, the unflagged entry still re-sends only its own key, and draw_down_quote answers a key
 * with a receipt from that receipt (replaying it, or refusing it again as IDEMPOTENCY_RESULT_INVALID)
 * while IDEMPOTENCY_RECEIPT_MISSING rolls back its own draw, so finishing it cannot make a second order.
 */
export function markPendingRetryForCheck(name: string): void {
  try {
    const raw = sessionStorage.getItem(storageKey(name));
    if (raw) sessionStorage.setItem(storageKey(name), JSON.stringify({ ...JSON.parse(raw), needsCheck: true }));
  } catch {
    // Nothing kept, or no storage.
  }
}

export function clearPendingRetry(name: string): void {
  try {
    sessionStorage.removeItem(storageKey(name));
  } catch {
    // Nothing stored.
  }
}
