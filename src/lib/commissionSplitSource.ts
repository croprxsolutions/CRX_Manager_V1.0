import type { CommissionSplit } from '../types';

/** The customer's default split when it names anyone, else null. */
export function customerSplit(split: CommissionSplit | null | undefined): CommissionSplit | null {
  return split?.splits?.length ? split : null;
}

/** Same recipients and percentages in the same order. */
export function sameSplit(a: CommissionSplit, b: CommissionSplit): boolean {
  const key = (s: CommissionSplit) => JSON.stringify(s.splits.map(({ recipient, percentage }) => [recipient, percentage]));
  return key(a) === key(b);
}
