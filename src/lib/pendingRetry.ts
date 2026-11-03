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
}

const storageKey = (name: string) => `crx:pending-retry:${name}`;

export function loadPendingRetry<T>(name: string): PendingRetry<T> | null {
  try {
    const raw = sessionStorage.getItem(storageKey(name));
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingRetry<T>;
    if (typeof pending?.key !== 'string' || typeof pending.sentAt !== 'number'
        || Date.now() - pending.sentAt > RECEIPT_LIFETIME_MS) {
      sessionStorage.removeItem(storageKey(name));
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export function savePendingRetry<T>(name: string, key: string, request: T): void {
  try {
    sessionStorage.setItem(storageKey(name), JSON.stringify({ key, request, sentAt: Date.now() }));
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
