import { todayInBusinessTz } from './dateUtils';

/**
 * The business day (America/Chicago) a payment belongs to: its payment date, or, for an older
 * payment saved without one, the Chicago date it was entered (its UTC date can be a day later
 * in the evening).
 */
export function paymentBusinessDate(paymentDate: string | null, createdAt: string): string {
  return paymentDate ? paymentDate.slice(0, 10) : todayInBusinessTz(new Date(createdAt));
}

/** Whether a YYYY-MM-DD day falls inside an inclusive From/To range; an empty end is open. */
export function isDayInRange(day: string, from: string | null, to: string | null): boolean {
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

/** The first day of the current Chicago business month, as YYYY-MM-DD. */
export function firstOfBusinessMonth(now: Date = new Date()): string {
  return `${todayInBusinessTz(now).slice(0, 8)}01`;
}

/** A From after To: no day can match, so the screen shows an error, not an empty $0 list. */
export function isRangeBackwards(from: string | null, to: string | null): boolean {
  return !!(from && to && from > to);
}

/** Which quick choice the range matches ('all' when no dates are set), else null. */
export function dateRangePreset(from: string | null, to: string | null): 'today' | 'month' | 'all' | null {
  if (!from && !to) return 'all';
  const today = todayInBusinessTz();
  if (to !== today) return null;
  if (from === today) return 'today';
  return from === firstOfBusinessMonth() ? 'month' : null;
}

/** Words for under a total: "all time", "today", "this month" or "in selected dates". */
export function dateRangeCaption(from: string | null, to: string | null): string {
  const preset = dateRangePreset(from, to);
  if (preset === 'all') return 'all time';
  if (preset === 'today') return 'today';
  return preset === 'month' ? 'this month' : 'in selected dates';
}
