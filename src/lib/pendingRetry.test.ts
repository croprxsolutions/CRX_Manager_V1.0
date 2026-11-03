import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPendingRetry, loadPendingRetry, savePendingRetry } from './pendingRetry';

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
    expect(loadPendingRetry('draw')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('drops a malformed entry and survives storage that throws', () => {
    sessionStorage.setItem('crx:pending-retry:draw', '{"request":[]}');
    expect(loadPendingRetry('draw')).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => savePendingRetry('draw', 'key-1', [])).not.toThrow();
    expect(loadPendingRetry('draw')).toBeNull();
  });
});
