/**
 * Checks on the date a payment is recorded under (Record Payments). The database is the authority:
 * allocate_payment refuses a date after today in Central time (PAYMENT_DATE_IN_FUTURE) and a date in a
 * closed accounting period (check_period_open). These checks say the same thing in plain words before
 * the save, so a check received on the 30th can be dated the 30th without a cryptic refusal.
 */
import { supabase } from './db';
import { daysSinceBusinessDate, parseLocalDate, todayInBusinessTz } from './dateUtils';

/** Past this many days back the screen asks before saving: an old date is usually a typo. */
const OLD_PAYMENT_DATE_DAYS = 31;

/** Same limit as the duplicate-payment check that runs beside it. */
const CLOSED_PERIOD_CHECK_TIMEOUT_MS = 15_000;

const showDay = (day: string): string => parseLocalDate(day).toLocaleDateString('en-US');

/** Why this payment date cannot be saved, or null when it can. Days are Central business days. */
export function paymentDateProblem(day: string | null, today: string = todayInBusinessTz()): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'Enter the payment date';
  if (day > today) return `A payment cannot be dated after today (${showDay(today)})`;
  return null;
}

/** Days back from today when the date is more than OLD_PAYMENT_DATE_DAYS ago, else null. */
export function oldPaymentDateDays(day: string, now: Date = new Date()): number | null {
  const days = daysSinceBusinessDate(day, now);
  return days > OLD_PAYMENT_DATE_DAYS ? days : null;
}

export function oldPaymentDateMessage(day: string, days: number): string {
  return `This payment is dated ${showDay(day)}, ${days} days ago. Check the date before saving.`;
}

export interface ClosedPeriod {
  period_start: string;
  period_end: string;
}

export function closedPeriodMessage(day: string, period: ClosedPeriod): string {
  return `${showDay(day)} is in a closed month (${showDay(period.period_start)} to ${showDay(period.period_end)}). `
    + 'Nothing was saved. Date the payment in an open month, or ask an admin to reopen that month in Month-End Close.';
}

/**
 * The closed accounting period holding this day, or null. Only admins may read accounting_periods, so
 * for anyone else this finds nothing and the database's own refusal (closedPeriodRefusal) speaks instead.
 * A failed read also returns null: it only decides whether to warn early, never whether to save.
 */
export async function findClosedPeriod(day: string): Promise<ClosedPeriod | null> {
  // A stalled read must not hold the payment form disabled: past the limit, skip the early warning.
  const timeLimit = AbortSignal.timeout(CLOSED_PERIOD_CHECK_TIMEOUT_MS);
  const stalled = new Promise<null>((resolve) => {
    timeLimit.addEventListener('abort', () => resolve(null), { once: true });
  });
  const read = Promise.resolve(supabase
    .from('accounting_periods')
    .select('period_start, period_end')
    .eq('status', 'closed')
    .lte('period_start', day)
    .gte('period_end', day)
    .limit(1)
    .abortSignal(timeLimit))
    .catch(() => null);
  const result = await Promise.race([read, stalled]);
  if (!result) return null;
  const { data, error } = result;
  if (error || !Array.isArray(data) || data.length === 0) return null;
  return data[0] as ClosedPeriod;
}

/** The plain-words reason when allocate_payment refused the payment's date, else null. */
export function paymentDateRefusal(err: unknown, day: string): string | null {
  const message = String((err as { message?: unknown } | null)?.message ?? '');
  if (message.startsWith('PAYMENT_DATE_IN_FUTURE')) {
    return `Nothing was saved. ${paymentDateProblem(day) ?? 'A payment cannot be dated after today'}.`;
  }
  // check_period_open: "Date 2026-10-30 falls in closed accounting period (2026-10-01 to 2026-10-31)".
  const closed = /falls in closed accounting period \((\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})\)/.exec(message);
  if (closed) return closedPeriodMessage(day, { period_start: closed[1], period_end: closed[2] });
  return null;
}
