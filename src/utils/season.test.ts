import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeSeason, seasonStartDate, seasonEndDate, getSeasonDates } from './season';

describe('computeSeason', () => {
  it('returns next year for Oct-Dec (season = end-year)', () => {
    expect(computeSeason(new Date(2025, 9, 1))).toBe(2026);   // Oct 1, 2025
    expect(computeSeason(new Date(2025, 10, 15))).toBe(2026);  // Nov 15, 2025
    expect(computeSeason(new Date(2025, 11, 31))).toBe(2026);  // Dec 31, 2025
  });

  it('returns same year for Jan-Sep', () => {
    expect(computeSeason(new Date(2026, 0, 1))).toBe(2026);   // Jan 1, 2026
    expect(computeSeason(new Date(2026, 5, 15))).toBe(2026);  // Jun 15, 2026
    expect(computeSeason(new Date(2026, 8, 30))).toBe(2026);  // Sep 30, 2026
  });

  it('boundary: Sep 30 is last day of season', () => {
    expect(computeSeason(new Date(2026, 8, 30))).toBe(2026);
  });

  it('boundary: Oct 1 is first day of NEW season', () => {
    expect(computeSeason(new Date(2026, 9, 1))).toBe(2027);
  });

  it('defaults to current date when no arg', () => {
    const result = computeSeason();
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(2020);
  });
});

describe('seasonStartDate', () => {
  it('returns Oct 1 of previous year', () => {
    expect(seasonStartDate(2026)).toBe('2025-10-01');
    expect(seasonStartDate(2027)).toBe('2026-10-01');
  });
});

describe('seasonEndDate', () => {
  it('returns Sep 30 of season year', () => {
    expect(seasonEndDate(2026)).toBe('2026-09-30');
    expect(seasonEndDate(2027)).toBe('2027-09-30');
  });
});

describe('getSeasonDates', () => {
  it('returns start and end for date in Oct-Dec', () => {
    const result = getSeasonDates(new Date(2025, 10, 15)); // Nov 2025
    expect(result).toEqual({ start: '2025-10-01', end: '2026-09-30' });
  });

  it('returns start and end for date in Jan-Sep', () => {
    const result = getSeasonDates(new Date(2026, 1, 15)); // Feb 2026
    expect(result).toEqual({ start: '2025-10-01', end: '2026-09-30' });
  });
});

// KI-18: "today" is the America/Chicago date, not the device clock. Evenings of Sep 30 and
// Oct 1 are checked: on daylight time (UTC-5) the UTC date is already the next day from 7 PM.
describe('computeSeason with no date uses the Chicago date (KI-18)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const at = (iso: string) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); return computeSeason(); };

  it('Sep 30 evening, 6:00 PM to 11:59 PM CDT, is still the old season', () => {
    expect(at('2026-09-30T23:00:00Z')).toBe(2026); // 6:00 PM CDT
    expect(at('2026-10-01T00:00:00Z')).toBe(2026); // 7:00 PM CDT, Oct 1 in UTC
    expect(at('2026-10-01T04:59:00Z')).toBe(2026); // 11:59 PM CDT
  });
  it('Oct 1, 12:00 AM CDT starts the new season', () => {
    expect(at('2026-10-01T05:00:00Z')).toBe(2027);
  });
  it('Oct 1 evening, 6:00 PM to 11:59 PM CDT, stays in the new season', () => {
    expect(at('2026-10-01T23:00:00Z')).toBe(2027); // 6:00 PM CDT
    expect(at('2026-10-02T00:00:00Z')).toBe(2027); // 7:00 PM CDT, Oct 2 in UTC
    expect(at('2026-10-02T04:59:00Z')).toBe(2027); // 11:59 PM CDT
  });
  it('getSeasonDates() follows the same Chicago date', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T01:30:00Z')); // Sep 30, 8:30 PM CDT
    expect(getSeasonDates()).toEqual({ start: '2025-10-01', end: '2026-09-30' });
  });
});

describe('computeSeason with a YYYY-MM-DD string', () => {
  it('reads the calendar date as written', () => {
    expect(computeSeason('2026-09-30')).toBe(2026);
    expect(computeSeason('2026-10-01')).toBe(2027);
    expect(getSeasonDates('2026-10-01')).toEqual({ start: '2026-10-01', end: '2027-09-30' });
  });
});
