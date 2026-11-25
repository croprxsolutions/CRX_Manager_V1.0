/**
 * Checks entered on Prepay Credits > New Check, not through Record Payments. Payment History counts
 * them as payments received, the way Month-End Close does (`_month_payments_received`).
 */
import { supabase } from './db';
import { fetchAllRows, pageWithList } from './pagedRead';
import { isDayInRange, isRangeBackwards, paymentBusinessDate } from './paymentDateRange';

export interface PrepayCheck {
  customer_id: string;
  farm_name: string;
  /** The Chicago business day it was entered. */
  day: string;
  reference: string | null;
  cents: number;
}

interface PrepayCheckRow {
  customer_id: string; created_at: string; source_reference: string | null; original_amount_cents: number | null;
  customers?: { farm_name: string } | null;
}

/**
 * One per check: the bucket splits of one check share its customer, entry time and reference.
 * shortcut: Month-End also splits two checks entered at the same instant with the same reference (by audit
 * row); here they count once. That changes the count only, never the dollars.
 */
function groupPrepayChecks(rows: ReadonlyArray<PrepayCheckRow>): PrepayCheck[] {
  const byCheck = new Map<string, PrepayCheck>();
  for (const r of rows) {
    const key = `${r.customer_id}|${r.created_at}|${r.source_reference ?? ''}`;
    const check = byCheck.get(key) ?? {
      customer_id: r.customer_id,
      farm_name: r.customers?.farm_name || 'Unknown',
      day: paymentBusinessDate(null, r.created_at),
      reference: r.source_reference,
      cents: 0,
    };
    check.cents += Number(r.original_amount_cents) || 0;
    byCheck.set(key, check);
  }
  return [...byCheck.values()];
}

/** Every Prepay Credits check, grouped one per check; a failed read returns the error and no rows. */
export async function fetchPrepayChecks(): Promise<{ data: PrepayCheck[] | null; error: unknown }> {
  const { data, error } = await fetchAllRows<PrepayCheckRow>((from, to) => pageWithList(supabase
    .from('prepay_credits')
    .select('id, customer_id, created_at, source_reference, original_amount_cents, customers!prepay_credits_customer_id_fkey ( farm_name )', { count: 'exact' })
    .eq('source_type', 'check')
    .is('allocation_set_id', null)
    .gt('original_amount_cents', 0)
    .order('created_at', { ascending: false })
    .order('id')
    .range(from, to)));
  if (error || !data) return { data: null, error: error ?? new Error('prepay checks returned no data') };
  return { data: groupPrepayChecks(data), error: null };
}

/** The checks for the chosen customer and dates; none for a backwards range. */
export function prepayChecksShown(checks: PrepayCheck[], customerId: string, from: string | null, to: string | null) {
  if (isRangeBackwards(from, to)) return [];
  return checks.filter((c) => (!customerId || c.customer_id === customerId) && isDayInRange(c.day, from, to));
}
