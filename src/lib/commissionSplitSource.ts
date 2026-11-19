import type { CommissionSplit } from '../types';

/**
 * The customer's default split, or null when none was ever set. An empty list is a real setting (no commission)
 * and is returned as is, so a quote can take it like any other split (Luna, 18 Nov).
 */
export function customerSplit(split: CommissionSplit | null | undefined): CommissionSplit | null {
  // A damaged stored split (a null row, a missing name or percentage) counts as never set, so picking the customer
  // can't throw half way through its updates (Sol HIGH, 19 Nov).
  // Each share 0–100%, adding up to 100% (Luna HIGH, 19 Nov).
  const pct = (r: unknown) => (r as { percentage?: unknown }).percentage as number;
  const rowOk = (r: unknown) =>
    !!r && typeof r === 'object' && typeof (r as { recipient?: unknown }).recipient === 'string'
    && Number.isFinite(pct(r)) && pct(r) >= 0 && pct(r) <= 100;
  if (!split || !Array.isArray(split.splits) || !split.splits.every(rowOk)) return null;
  const total = split.splits.reduce((sum, r) => sum + r.percentage, 0);
  return split.splits.length === 0 || Math.abs(total - 100) < 0.005 ? split : null;
}

/** Same recipients at the same percentages, in any row order (Sol LOW, 19 Nov). */
export function sameSplit(a: CommissionSplit, b: CommissionSplit): boolean {
  const key = (s: CommissionSplit) => JSON.stringify(s.splits.map(({ recipient, percentage }) => [recipient, percentage]).sort());
  return key(a) === key(b);
}

/** "Test Rep One 60% · Test Rep Two 40%", or "no commission" for an empty split. */
export function describeSplit(split: CommissionSplit): string {
  return split.splits.length ? split.splits.map((s) => `${s.recipient} ${s.percentage}%`).join(' · ') : 'no commission';
}
