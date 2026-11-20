import { supabase } from './db';
import { Sentry } from './sentry';

/**
 * The Settings-page defaults that shape new records: Default Tier (new customers)
 * and Default Quote Valid Days (where a quote's "Pick a date" expiry starts).
 * A failed read returns null and is reported; callers keep their built-in default.
 */
async function readAppSetting(key: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', key)
      .maybeSingle();
    if (error) throw error;
    return data?.setting_value ?? null;
  } catch (err) {
    // Also catches a thrown network failure, so the new-customer form still finishes loading.
    Sentry.captureException(err, { tags: { source: 'read', action: `app_setting_${key}` } });
    return null;
  }
}

/** customers.assigned_tier accepts 1, 2 or 3 (customers_assigned_tier_check); anything else is 1. */
export function parseDefaultTier(raw: string | null): 1 | 2 | 3 {
  const tier = Number(raw);
  return tier === 2 || tier === 3 ? tier : 1;
}

export const loadDefaultTier = async () => parseDefaultTier(await readAppSetting('default_tier'));

/** A whole number of days from 1 to 3650, else null (no usable setting). */
export function parseQuoteValidDays(raw: string | null): number | null {
  const days = Number(raw);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null;
}

export const loadQuoteValidDays = async () => parseQuoteValidDays(await readAppSetting('default_quote_valid_days'));

/**
 * Where "Pick a date" starts: today + Valid Days, never past season end (bookings run to
 * season end, Mason 2026-10-26/27). Dates are YYYY-MM-DD, so they compare as strings.
 */
export function pickedExpiryStart(today: string, validDays: number | null, seasonEnd: string): string {
  if (validDays === null) return seasonEnd;
  const [y, m, d] = today.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d + validDays)).toISOString().slice(0, 10);
  return start < seasonEnd ? start : seasonEnd;
}

export type BookingTiming = 'pre_plant' | 'in_season' | 'late_summer';
export type BookingConfidence = 'firm' | 'likely' | 'maybe';
export type TimingWindows = Record<BookingTiming, { start: string; end: string }>;
export const DEFAULT_TIMING_WINDOWS: TimingWindows = {
  pre_plant: { start: '03-01', end: '05-15' },
  in_season: { start: '05-16', end: '07-15' },
  late_summer: { start: '07-16', end: '09-15' },
};

const isMonthDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{2}-\d{2}$/.test(v)) return false;
  // A common year, so 02-29 is refused: it is not a date most years (the database falls back too).
  const d = new Date(`2023-${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(5, 10) === v;
};

/** booking_timing_windows (20270127110000). Bad JSON or a bad month-day falls back to the default per timing. */
export function parseTimingWindows(raw: string | null): TimingWindows {
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const out = { ...DEFAULT_TIMING_WINDOWS };
  for (const t of Object.keys(DEFAULT_TIMING_WINDOWS) as BookingTiming[]) {
    const w = (parsed as Record<string, { start?: unknown; end?: unknown }> | null)?.[t];
    if (w && isMonthDay(w.start) && isMonthDay(w.end)) out[t] = { start: w.start, end: w.end };
  }
  return out;
}

// The row is seeded by the migration, so null means the read failed: no windows, and the Timing pick stays off rather than saving default dates.
export const loadTimingWindows = async (): Promise<TimingWindows | null> => {
  const raw = await readAppSetting('booking_timing_windows').catch(() => null);
  return raw == null ? null : parseTimingWindows(raw);
};

/**
 * A-R1: the start of the window that contains today, else of the next one (YYYY-MM-DD).
 * Never a past date: inside a window that already began it is today, since a past needed-by date
 * would end a Planned booking's stock hold at once (Sol, PR #1980).
 * A window whose end comes before its start runs into the next year.
 */
export function timingWindowStart(windows: TimingWindows, timing: BookingTiming, today: string): string {
  const { start, end } = windows[timing];
  const year = Number(today.slice(0, 4));
  for (const y of [year - 1, year, year + 1]) {
    const s = `${y}-${start}`;
    const e = `${end < start ? y + 1 : y}-${end}`;
    if (e >= today) return s < today ? today : s;
  }
  return `${year + 1}-${start}`;
}
