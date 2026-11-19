import type { CommissionSplit } from '../types';

/**
 * The customer's default split, or null when none was ever set. An empty list is a real setting (no commission)
 * and is returned as is, so a quote can take it like any other split (Luna, 18 Nov).
 */
export function customerSplit(split: CommissionSplit | null | undefined): CommissionSplit | null {
  // The same rule the database applies when a split is saved (20260722174029: each share above 0 and up to 100,
  // totalling 100 within 0.01), plus a named recipient; anything else counts as never set, so picking the customer
  // can't throw half way through its updates (Sol HIGH and MEDs, 19 Nov). Array.from turns a hole into undefined.
  const pct = (r: unknown) => (r as { percentage?: unknown }).percentage as number;
  const rowOk = (r: unknown) =>
    !!r && typeof r === 'object' && typeof (r as { recipient?: unknown }).recipient === 'string'
    && (r as { recipient: string }).recipient.trim() !== ''
    && Number.isFinite(pct(r)) && pct(r) > 0 && pct(r) <= 100;
  if (!split || !Array.isArray(split.splits) || !Array.from(split.splits).every(rowOk)) return null;
  const total = split.splits.reduce((sum, r) => sum + r.percentage, 0);
  return split.splits.length === 0 || Math.abs(total - 100) <= 0.01 + 1e-9 ? split : null;
}

/** Same recipients at the same percentages, in any row order (Sol LOW, 19 Nov). */
export function sameSplit(a: CommissionSplit, b: CommissionSplit): boolean {
  // Each row is its own JSON string, so a name can't fake a separator; String() keeps NaN and Infinity apart (Sol LOWs).
  const key = (s: CommissionSplit) => JSON.stringify(s.splits.map(({ recipient, percentage }) => JSON.stringify([recipient, String(percentage)])).sort());
  return key(a) === key(b);
}
