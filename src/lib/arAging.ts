import type { ARAgingPricedRow, ARAgingRow } from '../types';

/** KI-95: only a row with no unavailable_reason and a total carries amounts; any other row is never read as $0. */
export function isPricedAgingRow(r: ARAgingRow): r is ARAgingPricedRow {
  return r.unavailable_reason == null && r.total_outstanding != null;
}

/** get_ar_aging amounts are whole-cent dollars (numeric / 100): add them as integer cents, not floats. */
export function agingCents(dollars: number): number {
  return Math.round(Number(dollars) * 100);
}

/**
 * The one set of A/R aging labels for every screen, export and printed statement. Days past
 * due (from the due date, else the invoice date), matching get_ar_aging and the statement's
 * buckets: Current = under 30 days past due (or not due yet), then 30–59, 60–89, 90–119, 120+.
 * Labels only: the bucket math lives in the database.
 */
export const AR_AGING_LABELS = {
  current: 'Current',
  days30: '30–59 days',
  days60: '60–89 days',
  days90: '90–119 days',
  over120: '120+ days',
  // Summary tiles that add two buckets together.
  days30to89: '30–89 days',
  days90plus: '90+ days',
} as const;
