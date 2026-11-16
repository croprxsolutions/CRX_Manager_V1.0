import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDamagedPendingRetryIfUnchanged, clearPendingRetry, clearPendingRetryIfMatching, createPendingRetryIfAbsent, inspectPendingRetry, loadPendingRetry, markPendingRetryForCheck, savePendingRetry, updatePendingRetryIfMatching } from './pendingRetry';

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

  it('distinguishes absent, valid, damaged, wrong actor, and storage unknown without deleting bytes', () => {
    const valid = (value: unknown): value is { actorId: string } => !!value && typeof value === 'object' && 'actorId' in value;
    expect(inspectPendingRetry('review', valid, 'u1').kind).toBe('absent');
    sessionStorage.setItem('crx:pending-retry:review', '{broken secret rate data');
    expect(inspectPendingRetry('review', valid, 'u1').kind).toBe('damaged');
    expect(sessionStorage.getItem('crx:pending-retry:review')).toBe('{broken secret rate data');
    sessionStorage.setItem('crx:pending-retry:review', JSON.stringify({ key: 'k', sentAt: Date.now(), request: { actorId: 'u2' } }));
    expect(inspectPendingRetry('review', valid, 'u1').kind).toBe('damaged');
    expect(inspectPendingRetry('review', valid, 'u2').kind).toBe('valid');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(inspectPendingRetry('review', valid, 'u1').kind).toBe('unknown');
  });

  it('creates only into verified absence, updates only the matching fence, and conditionally clears damaged bytes', () => {
    const valid = (value: unknown): value is { actorId: string } => !!value && typeof value === 'object' && 'actorId' in value;
    const pending = { key: 'k', request: { actorId: 'u1' }, sentAt: 42, dispatchFence: 'a' };
    expect(createPendingRetryIfAbsent('review', pending)).toBe(true);
    expect(createPendingRetryIfAbsent('review', { ...pending, key: 'other' })).toBe(false);
    expect(updatePendingRetryIfMatching({ name: 'review', isValidRequest: valid, key: 'k', actorId: 'u1', request: pending.request,
      fence: 'a', update: (value) => ({ ...value, dispatchFence: 'b' }) })).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('crx:pending-retry:review')!)).toMatchObject({ key: 'k', sentAt: 42, dispatchFence: 'b' });
    expect(updatePendingRetryIfMatching({ name: 'review', isValidRequest: valid, key: 'k', actorId: 'u1', request: pending.request,
      fence: 'a', update: (value) => value })).toBe(false);
    const newerRaw = sessionStorage.getItem('crx:pending-retry:review');
    expect(clearPendingRetryIfMatching({ name: 'review', isValidRequest: valid, key: 'k', actorId: 'u1', request: pending.request, fence: 'a' })).toBe(false);
    expect(sessionStorage.getItem('crx:pending-retry:review')).toBe(newerRaw);
    // A validated success for the exact operation is authoritative even when its dispatch fence is older.
    expect(clearPendingRetryIfMatching({ name: 'review', isValidRequest: valid, key: 'k', actorId: 'u1', request: pending.request })).toBe(true);
    sessionStorage.setItem('crx:pending-retry:review', '{damaged}');
    expect(clearDamagedPendingRetryIfUnchanged('review', valid, 'u1')).toBe(true);
    expect(sessionStorage.getItem('crx:pending-retry:review')).toBeNull();
  });

  it('does not claim a damaged reminder was cleared if removal or read-back fails', () => {
    const valid = (value: unknown): value is { actorId: string } => !!value && typeof value === 'object' && 'actorId' in value;
    sessionStorage.setItem('crx:pending-retry:review', '{damaged}');
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(clearDamagedPendingRetryIfUnchanged('review', valid, 'u1')).toBe(false);
    expect(sessionStorage.getItem('crx:pending-retry:review')).toBe('{damaged}');
    vi.restoreAllMocks();
    const get = Storage.prototype.getItem;
    let reads = 0;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      reads += key === 'crx:pending-retry:review' ? 1 : 0;
      if (reads === 4) throw new Error('read-back failed');
      return get.call(this, key);
    });
    expect(clearDamagedPendingRetryIfUnchanged('review', valid, 'u1')).toBe(false);
  });

  it.each([
    { sentAt: 'not-a-time', dispatchFence: 'a' },
    { sentAt: 42, dispatchFence: 9 },
    { sentAt: 42, dispatchFence: 'a', needsCheck: 'yes' },
    { sentAt: 42, dispatchFence: 'a', expired: 'yes' },
  ])('refuses conditional callback mutation when valid JSON has a damaged envelope: %j', (metadata) => {
    const valid = (value: unknown): value is { actorId: string } => !!value && typeof value === 'object' && 'actorId' in value;
    const raw = JSON.stringify({ key: 'k', request: { actorId: 'u1' }, ...metadata });
    sessionStorage.setItem('crx:pending-retry:review', raw);
    expect(inspectPendingRetry('review', valid, 'u1').kind).toBe('damaged');
    expect(updatePendingRetryIfMatching({ name: 'review', isValidRequest: valid, key: 'k', actorId: 'u1', request: { actorId: 'u1' },
      fence: typeof metadata.dispatchFence === 'string' ? metadata.dispatchFence : undefined,
      update: (current) => ({ ...current, needsCheck: true }) })).toBe(false);
    expect(clearPendingRetryIfMatching({ name: 'review', isValidRequest: valid, key: 'k', actorId: 'u1', request: { actorId: 'u1' } })).toBe(false);
    expect(sessionStorage.getItem('crx:pending-retry:review')).toBe(raw);
  });
});
