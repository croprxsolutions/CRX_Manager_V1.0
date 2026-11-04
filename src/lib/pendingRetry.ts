/**
 * A request whose reply never arrived, kept in this browser tab so it survives a reload.
 *
 * useIdempotencyKey keeps its keys in memory, so a reload after a lost reply forgets the key and
 * the next tap mints a new one: if the first request had committed, that makes a second record
 * (S14, KI-11: Partial Order). Keeping the key and the exact request here lets the screen re-send
 * the same request with the same key, so the server answers with what it already did or does it
 * once. Kept no longer than the server keeps its receipts (idempotency_keys.expires_at, 24 hours).
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
}

const storageKey = (name: string) => `crx:pending-retry:${name}`;

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
