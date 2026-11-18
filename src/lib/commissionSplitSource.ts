import type { CommissionSplit } from '../types';

/**
 * The customer's default split, or null when none was ever set. An empty list is a real setting (no commission)
 * and is returned as is, so a quote can take it like any other split (Luna, 18 Nov).
 */
export function customerSplit(split: CommissionSplit | null | undefined): CommissionSplit | null {
  return Array.isArray(split?.splits) ? split : null;
}

/** Same recipients and percentages in the same order. */
export function sameSplit(a: CommissionSplit, b: CommissionSplit): boolean {
  const key = (s: CommissionSplit) => JSON.stringify(s.splits.map(({ recipient, percentage }) => [recipient, percentage]));
  return key(a) === key(b);
}

/** "Test Rep One 60% · Test Rep Two 40%", or "no commission" for an empty split. */
export function describeSplit(split: CommissionSplit): string {
  return split.splits.length ? split.splits.map((s) => `${s.recipient} ${s.percentage}%`).join(' · ') : 'no commission';
}
