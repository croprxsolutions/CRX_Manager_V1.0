import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropAllSnapshots, dropTodaySnapshot, readTodaySnapshot, saveTodaySnapshot, savedCopyMessage } from './todaySnapshot';

const MORNING = new Date('2026-11-24T14:14:00Z'); // 8:14 AM in the business time zone (America/Chicago)
const NEXT_DAY = new Date('2026-11-25T14:00:00Z');

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('todaySnapshot', () => {
  it('reads back today’s copy for the same person and screen only', () => {
    saveTodaySnapshot('route', 'u1', [{ id: 'd1' }], MORNING);
    expect(readTodaySnapshot('route', 'u1', MORNING)).toEqual({ savedAt: MORNING.toISOString(), data: [{ id: 'd1' }] });
    expect(readTodaySnapshot('route', 'u2', MORNING)).toBeNull();
    expect(readTodaySnapshot('stop:d1', 'u1', MORNING)).toBeNull();
    expect(readTodaySnapshot('route', null, MORNING)).toBeNull();
  });

  it('does not show yesterday’s copy, and the next save removes it', () => {
    saveTodaySnapshot('route', 'u1', ['old'], MORNING);
    expect(readTodaySnapshot('route', 'u1', NEXT_DAY)).toBeNull();
    saveTodaySnapshot('stop:d2', 'u1', 'new', NEXT_DAY);
    expect(window.localStorage.length).toBe(1);
    expect(readTodaySnapshot('stop:d2', 'u1', NEXT_DAY)?.data).toBe('new');
  });

  it('keeps only the signed-in person’s copies on the phone', () => {
    saveTodaySnapshot('route', 'u1', ['a'], MORNING);
    saveTodaySnapshot('route', 'u2', ['b'], MORNING);
    expect(readTodaySnapshot('route', 'u1', MORNING)).toBeNull();
    expect(readTodaySnapshot('route', 'u2', MORNING)?.data).toEqual(['b']);
  });

  it('leaves other app storage alone', () => {
    window.localStorage.setItem('sb-auth-token', 'keep');
    saveTodaySnapshot('route', 'u1', ['a'], MORNING);
    expect(window.localStorage.getItem('sb-auth-token')).toBe('keep');
  });

  it('sign-out drops every saved copy and leaves other app storage alone', () => {
    saveTodaySnapshot('route', 'user-1', { gate: '1234' });
    saveTodaySnapshot('stop:s1', 'user-1', { phone: '555' });
    localStorage.setItem('other-app-key', 'keep');
    dropAllSnapshots();
    expect(readTodaySnapshot('route', 'user-1')).toBeNull();
    expect(readTodaySnapshot('stop:s1', 'user-1')).toBeNull();
    expect(localStorage.getItem('other-app-key')).toBe('keep');
  });

  it('drops one screen’s copy', () => {
    saveTodaySnapshot('stop:d1', 'u1', 'x', MORNING);
    dropTodaySnapshot('stop:d1', 'u1', MORNING);
    expect(readTodaySnapshot('stop:d1', 'u1', MORNING)).toBeNull();
  });

  it('works without storage: a blocked or full store just means no saved copy', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(() => saveTodaySnapshot('route', 'u1', ['a'], MORNING)).not.toThrow();
    expect(readTodaySnapshot('route', 'u1', MORNING)).toBeNull();
  });

  it('ignores a copy that is not in the saved shape', () => {
    window.localStorage.setItem(`crx:today-snapshot:v1:u1:2026-11-24:route`, '{not json');
    expect(readTodaySnapshot('route', 'u1', MORNING)).toBeNull();
  });

  it('says when the copy is from', () => {
    expect(savedCopyMessage('your route', MORNING.toISOString())).toMatch(/^No signal — showing your route as of \d{1,2}:14/);
  });
});
