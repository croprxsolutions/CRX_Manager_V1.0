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
  /** Past the receipt's lifetime: it can no longer be finished safely, only checked by hand. */
  expired?: boolean;
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
    return { ...pending, expired: age < 0 || age > RECEIPT_LIFETIME_MS };
  } catch {
    return null;
  }
}

export function savePendingRetry<T>(name: string, key: string, request: T): void {
  try {
    // A retry of the same key keeps the first send time: the server's receipt expires from then.
    const kept = loadPendingRetry<T>(name);
    const sentAt = kept?.key === key ? kept.sentAt : Date.now();
    sessionStorage.setItem(storageKey(name), JSON.stringify({ key, request, sentAt }));
  } catch {
    // No storage: the in-memory key still covers retries until a reload.
  }
}

export function clearPendingRetry(name: string): void {
  try {
    sessionStorage.removeItem(storageKey(name));
  } catch {
    // Nothing stored.
  }
}
