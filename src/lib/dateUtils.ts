/**
 * Date utility functions that avoid UTC timezone bugs.
 *
 * Problem: `new Date().toISOString().split('T')[0]` returns tomorrow's date
 * for US users after ~5pm local time (because toISOString() converts to UTC).
 * Similarly, `new Date('2026-03-11')` parses as UTC midnight, which displays
 * as March 10 in US timezones.
 *
 * Solution: "today" is the Chicago business day (localToday, todayInBusinessTz);
 * a stored YYYY-MM-DD is parsed and formatted in local time (parseLocalDate, formatLocalDate).
 */

/**
 * Today's date as YYYY-MM-DD: the Crop RX business day (America/Chicago), whatever the
 * device's own clock or timezone says (KI-18). Same value as todayInBusinessTz(); kept
 * under this name for its many callers. Use this instead of `new Date().toISOString().split('T')[0]`.
 */
export function localToday(): string {
  return todayInBusinessTz();
}

/**
 * Parses a YYYY-MM-DD string as a local-timezone Date (midnight local).
 * Use this instead of `new Date(dateString)` for date-only strings.
 *
 * `new Date('2026-03-11')` → UTC midnight → shows as March 10 in US timezones.
 * `parseLocalDate('2026-03-11')` → local midnight → always shows March 11.
 */
export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Formats a Date object as YYYY-MM-DD in the user's local timezone.
 * Use this instead of `date.toISOString().split('T')[0]`.
 */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The business day (America/Chicago) N calendar days from today, as YYYY-MM-DD
 * (KI-18). Useful for default due dates (e.g., 30 days from now) and "last N days" filters.
 */
export function localDatePlusDays(days: number): string {
  return addDaysToDate(todayInBusinessTz(), days);
}

/** How far ahead an invoice may be dated; matches the database check on invoices.invoice_date (KI-18). */
export const INVOICE_DATE_MAX_DAYS_AHEAD = 365;

/** Latest invoice date accepted: 365 days after today's Chicago date (a fixed day count, not a calendar year), so a typed year like 2206 is caught. */
export function latestInvoiceDate(): string {
  return localDatePlusDays(INVOICE_DATE_MAX_DAYS_AHEAD);
}

/** The save-time message when an invoice date is past latestInvoiceDate() (a date box's max does not stop a typed value), else null. */
export function invoiceDateTooFarProblem(date: string | null | undefined): string | null {
  const day = (date ?? '').split('T')[0];
  if (!day) return null;
  // A five-digit year (10000-01-01) is not YYYY-MM-DD and would compare as earlier; refuse it too.
  return !/^\d{4}-\d{2}-\d{2}$/.test(day) || day > latestInvoiceDate()
    ? `The invoice date ${day} is more than ${INVOICE_DATE_MAX_DAYS_AHEAD} days from today. Check the year.`
    : null;
}

/** A YYYY-MM-DD date plus N calendar days (date-only arithmetic, so daylight saving cannot shift it). */
export function addDaysToDate(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * The instant a Chicago business day begins, as an ISO timestamp, for filtering a timestamp
 * column by a business date (KI-18): `created_at >= businessDayStartIso('2026-10-01')`.
 * Chicago midnight is 05:00 UTC in daylight time and 06:00 UTC in standard time; the clock
 * changes at 2 AM, so midnight itself is never ambiguous.
 */
export function businessDayStartIso(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  for (const offsetHours of [5, 6]) {
    const start = new Date(Date.UTC(year, month - 1, day, offsetHours));
    const before = new Date(start.getTime() - 1);
    if (todayInBusinessTz(start) === dateStr && todayInBusinessTz(before) !== dateStr) {
      return start.toISOString();
    }
  }
  throw new Error(`Not a valid business date: ${dateStr}`);
}

export const BUSINESS_TIMEZONE = 'America/Chicago';

/**
 * Today's date as YYYY-MM-DD in BUSINESS_TIMEZONE, regardless of the viewer's own clock.
 *
 * The business day matches the database (current_season(), invoice_date defaults), so a
 * device set to another timezone (or UTC) never lands on tomorrow's date in the evening.
 */
export function todayInBusinessTz(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';

  if (!year || !month || !day) {
    throw new Error('Unable to format today in the business timezone');
  }

  return `${year}-${month}-${day}`;
}

/**
 * Calendar days from a YYYY-MM-DD date-only value to today's BUSINESS_TIMEZONE
 * date (0 for today, 1 for yesterday), on any device clock and across DST.
 * Timestamps must not be passed: their UTC date can differ from the business day.
 */
export function daysSinceBusinessDate(dateStr: string, now: Date = new Date()): number {
  if (!dateStr) return 0;
  const utcDay = (ymd: string) => {
    const [year, month, day] = ymd.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / 86400000;
  };
  return utcDay(todayInBusinessTz(now)) - utcDay(dateStr);
}
