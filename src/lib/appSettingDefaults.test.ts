import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ supabase: {} }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { loadDefaultTier, loadQuoteValidDays, parseDefaultTier, parseQuoteValidDays, pickedExpiryStart } from './appSettingDefaults';

describe('appSettingDefaults', () => {
  it('reads Default Tier as 1, 2 or 3 only', () => {
    expect(parseDefaultTier('2')).toBe(2);
    expect(parseDefaultTier('3')).toBe(3);
    for (const raw of ['1', '4', '0', '', 'abc', null]) expect(parseDefaultTier(raw)).toBe(1);
  });

  it('reads Valid Days as a whole number of days or null', () => {
    expect(parseQuoteValidDays('30')).toBe(30);
    for (const raw of ['0', '-5', '2.5', '', 'x', null, '9999']) expect(parseQuoteValidDays(raw)).toBeNull();
  });

  it('starts a picked expiry at today + Valid Days, capped at season end', () => {
    expect(pickedExpiryStart('2026-11-03', 30, '2027-09-30')).toBe('2026-12-03');
    expect(pickedExpiryStart('2026-12-15', 30, '2027-09-30')).toBe('2027-01-14');
    expect(pickedExpiryStart('2027-09-15', 30, '2027-09-30')).toBe('2027-09-30');
    expect(pickedExpiryStart('2026-11-03', null, '2027-09-30')).toBe('2027-09-30');
  });

  it('falls back when the Settings read throws (the mocked client has no .from)', async () => {
    await expect(loadDefaultTier()).resolves.toBe(1);
    await expect(loadQuoteValidDays()).resolves.toBeNull();
  });
});
