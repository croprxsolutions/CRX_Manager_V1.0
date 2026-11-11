/**
 * Inventory value at price-list cost (KI-135). Only stock above zero with a cost is valued: a product
 * below zero (KI-29) is counted apart, never subtracted, and stock with no cost is "value unknown",
 * never $0. Quantities are in different units, so they are counted as products, never added together.
 */
export interface InventoryValueSummary {
  /** Sum over valued products, in whole cents. */
  valueCents: number;
  /** Products whose quantity is below zero; left out of the value. */
  belowZeroCount: number;
  /** Products with stock but no cost (missing or zero); left out of the value. */
  noCostCount: number;
}

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * quantity x unit cost in whole cents, exact (BigInt, no binary float) and rounded half away from
 * zero like PostgreSQL ROUND(numeric). Both inputs are positive here. NaN when a value is not a plain
 * decimal (for example exponent notation), so a bad row fails the total visibly instead of shifting it.
 */
export function quantityTimesCostCents(quantity: number | string, unitCost: number | string): number {
  const q = PLAIN_DECIMAL.exec(String(quantity).trim());
  const c = PLAIN_DECIMAL.exec(String(unitCost).trim());
  if (!q || !c) return Number.NaN;
  const qFrac = q[2] ?? '';
  const cFrac = c[2] ?? '';
  const numerator = BigInt(q[1] + qFrac) * BigInt(c[1] + cFrac) * 100n;
  const denominator = 10n ** BigInt(qFrac.length + cFrac.length);
  const quotient = numerator / denominator;
  const cents = (numerator % denominator) * 2n >= denominator ? quotient + 1n : quotient;
  return cents > BigInt(Number.MAX_SAFE_INTEGER) ? Number.NaN : Number(cents);
}

/** What the total leaves out, for a line under it; empty when nothing is left out. */
export function inventoryValueNote({ belowZeroCount, noCostCount }: InventoryValueSummary): string {
  const parts: string[] = [];
  if (belowZeroCount > 0) parts.push(`${belowZeroCount} below zero, not counted`);
  if (noCostCount > 0) parts.push(`${noCostCount} with no cost, value unknown`);
  return parts.join(' · ');
}

export function summarizeInventoryValue(
  rows: ReadonlyArray<{ quantity: number | string | null; unitCost: number | string | null | undefined }>,
): InventoryValueSummary {
  const summary: InventoryValueSummary = { valueCents: 0, belowZeroCount: 0, noCostCount: 0 };
  for (const row of rows) {
    const quantity = Number(row.quantity ?? 0);
    if (quantity < 0) summary.belowZeroCount += 1;
    if (!(quantity > 0)) continue;
    if (row.unitCost == null || !(Number(row.unitCost) > 0)) {
      summary.noCostCount += 1;
      continue;
    }
    summary.valueCents += quantityTimesCostCents(row.quantity as number | string, row.unitCost);
  }
  return summary;
}
