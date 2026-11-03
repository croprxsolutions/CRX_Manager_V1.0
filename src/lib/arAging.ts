import type { ARAgingPricedRow, ARAgingRow } from '../types';

/** KI-95: only a row with no unavailable_reason and a total carries amounts; any other row is never read as $0. */
export function isPricedAgingRow(r: ARAgingRow): r is ARAgingPricedRow {
  return r.unavailable_reason == null && r.total_outstanding != null;
}

/** get_ar_aging amounts are whole-cent dollars (numeric / 100): add them as integer cents, not floats. */
export function agingCents(dollars: number): number {
  return Math.round(Number(dollars) * 100);
}
