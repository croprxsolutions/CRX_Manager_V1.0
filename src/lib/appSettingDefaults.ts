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
