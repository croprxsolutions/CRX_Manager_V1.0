import type { CommissionSplit } from '../types';

/**
 * The customer's default split, or null when none was ever set. An empty list is a real setting (no commission)
 * and is returned as is, so a quote can take it like any other split (Luna, 18 Nov).
 */
export function customerSplit(split: CommissionSplit | null | undefined): CommissionSplit | null {
  // A damaged stored split (a null row, a missing name or percentage) counts as never set, so picking the customer
  // can't throw half way through its updates (Sol HIGH, 19 Nov).
  // Each row names someone and gives a share of 0–100% in hundredths; the shares add up to exactly 100% (Luna, Sol).
  const pct = (r: unknown) => (r as { percentage?: unknown }).percentage as number;
  const cents = (p: number) => Math.round(p * 100);
  const rowOk = (r: unknown) =>
    !!r && typeof r === 'object' && typeof (r as { recipient?: unknown }).recipient === 'string'
    && (r as { recipient: string }).recipient.trim() !== ''
    && Number.isFinite(pct(r)) && pct(r) >= 0 && pct(r) <= 100 && cents(pct(r)) / 100 === pct(r);
  // Array.from turns a hole into undefined, so a sparse list can't skip the row check (Sol LOW).
  if (!split || !Array.isArray(split.splits) || !Array.from(split.splits).every(rowOk)) return null;
  const total = split.splits.reduce((sum, r) => sum + cents(r.percentage), 0);
  return split.splits.length === 0 || total === 10000 ? split : null;
}

/** Same recipients at the same percentages, in any row order (Sol LOW, 19 Nov). */
export function sameSplit(a: CommissionSplit, b: CommissionSplit): boolean {
  // String() keeps NaN and Infinity apart, where JSON would write both as null (Sol LOW).
  const key = (s: CommissionSplit) => s.splits.map(({ recipient, percentage }) => `${recipient}\u0000${String(percentage)}`).sort().join('\u0001');
  return key(a) === key(b);
}
