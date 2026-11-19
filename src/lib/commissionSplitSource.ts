import type { CommissionSplit } from '../types';

/**
 * The customer's default split, or null when none was ever set. An empty list is a real setting (no commission)
 * and is returned as is, so a quote can take it like any other split (Luna, 18 Nov).
 */
export function customerSplit(split: CommissionSplit | null | undefined): CommissionSplit | null {
  // A damaged stored split (a null row, a missing name or percentage) counts as never set, so picking the customer
  // can't throw half way through its updates (Sol HIGH, 19 Nov).
  const rowOk = (r: unknown) =>
    !!r && typeof r === 'object' && typeof (r as { recipient?: unknown }).recipient === 'string'
    && Number.isFinite((r as { percentage?: unknown }).percentage);
  return split && Array.isArray(split.splits) && split.splits.every(rowOk) ? split : null;
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
