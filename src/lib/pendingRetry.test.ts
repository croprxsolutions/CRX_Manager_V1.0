import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPendingRetry, loadPendingRetry, markPendingRetryForCheck, savePendingRetry } from './pendingRetry';

describe('pendingRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('keeps the key and request across a reload until cleared', () => {
    savePendingRetry('draw', 'key-1', [{ quantity: 1 }]);
    expect(loadPendingRetry('draw')).toMatchObject({ key: 'key-1', request: [{ quantity: 1 }] });
    clearPendingRetry('draw');
    expect(loadPendingRetry('draw')).toBeNull();
  });

  it('drops an entry older than the server keeps its receipt', () => {
    vi.useFakeTimers();
    savePendingRetry('draw', 'key-1', []);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(loadPendingRetry('draw')).toMatchObject({ key: 'key-1', expired: true });
  });

  it('keeps the first send time when the same key is sent again', () => {
    vi.useFakeTimers();
    savePendingRetry('draw', 'key-1', []);
    const first = loadPendingRetry('draw')!.sentAt;
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    savePendingRetry('draw', 'key-1', []);
    expect(loadPendingRetry('draw')!.sentAt).toBe(first);
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(loadPendingRetry('draw')!.expired).toBe(true);
    savePendingRetry('draw', 'key-2', []);
    expect(loadPendingRetry('draw')!.sentAt).toBe(Date.now());
  });

  it('drops an entry whose request is the wrong shape', () => {
    savePendingRetry('draw', 'key-1', { not: 'a list' });
    expect(loadPendingRetry('draw', Array.isArray)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('treats a send time in the future as expired, and drops one that is not a number', () => {
    sessionStorage.setItem('crx:pending-retry:draw', JSON.stringify({ key: 'key-1', request: [], sentAt: Date.now() + 60_000 }));
    expect(loadPendingRetry('draw')).toMatchObject({ key: 'key-1', expired: true });
    sessionStorage.setItem('crx:pending-retry:draw', '{"key":"key-1","request":[],"sentAt":1e999}');
    expect(loadPendingRetry('draw')).toBeNull();
  });

  it('drops a malformed entry and survives storage that throws', () => {
    sessionStorage.setItem('crx:pending-retry:draw', '{"request":[]}');
    expect(loadPendingRetry('draw')).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => savePendingRetry('draw', 'key-1', [])).not.toThrow();
    expect(loadPendingRetry('draw')).toBeNull();
  });

  it('reports a failed save and keeps a flagged entry for a hand check', () => {
    expect(savePendingRetry('draw', 'key-1', [])).toBe(true);
    markPendingRetryForCheck('draw');
    expect(loadPendingRetry('draw')).toMatchObject({ key: 'key-1', expired: true, needsCheck: true });
    markPendingRetryForCheck('other');
    expect(loadPendingRetry('other')).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(savePendingRetry('draw', 'key-2', [])).toBe(false);
  });
});
