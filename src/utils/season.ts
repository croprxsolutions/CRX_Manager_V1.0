/**
 * Season calendar utilities.
 * Season runs October 1 to September 30, named by end-year.
 * Season 2026 = Oct 1, 2025 – Sep 30, 2026.
 *
 * "Today" is the America/Chicago date, matching the database's current_season()
 * (migration 20261103120000), so a device set to another timezone picks the same season.
 *
 * To change the season boundary in the future, update SEASON_START_MONTH
 * here and the matching compute_season() SQL function.
 */
import { todayInBusinessTz } from '../lib/dateUtils';

/** October (1-based) — first month of a new season */
const SEASON_START_MONTH = 10;

/**
 * Season number for a date. No argument = today in America/Chicago.
 * A 'YYYY-MM-DD' string is read as that calendar date. A Date is read by its local
 * calendar fields, so pass only a date-only value built at local midnight
 * (e.g. parseLocalDate); never pass `new Date()` for "now" — omit the argument instead.
 */
export function computeSeason(date: Date | string = todayInBusinessTz()): number {
  const [year, month] = typeof date === 'string'
    ? date.split('-').map(Number)
    : [date.getFullYear(), date.getMonth() + 1];
  return month >= SEASON_START_MONTH ? year + 1 : year;
}

/** First day of a season: Oct 1 of (season - 1). */
export function seasonStartDate(season: number): string {
  return `${season - 1}-10-01`;
}

/** Last day of a season: Sep 30 of season year. */
export function seasonEndDate(season: number): string {
  return `${season}-09-30`;
}

/** Start and end dates for the season containing the given date (default: today in Chicago). */
export function getSeasonDates(date?: Date | string): { start: string; end: string } {
  const season = computeSeason(date);
  return { start: seasonStartDate(season), end: seasonEndDate(season) };
}
