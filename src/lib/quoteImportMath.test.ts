import { describe, expect, it } from 'vitest';
import { quoteImportAmounts } from './quoteImportMath';

describe('exact quote import extended amounts', () => {
  it('avoids quantity float drift at a half-cent boundary', () => {
    expect(quoteImportAmounts({ acres: .7, rate: 3, rateFactor: 1, inventoryFactor: 1, priceCents: 335n, costCents: 100n }))
      .toEqual({ ouncesPerAcre: 3, totalUnits: 2.1, priceCents: 704n, costCents: 210n });
  });
  it('rounds money from the ratio rather than a truncated recurring quantity', () => {
    expect(quoteImportAmounts({ acres: 1, rate: 1, rateFactor: 1, inventoryFactor: 3, priceCents: 3n, costCents: 2n }))
      .toEqual({ ouncesPerAcre: 1, totalUnits: 1 / 3, priceCents: 1n, costCents: 1n });
  });
  it('keeps fractional conversion factors exact', () => {
    expect(quoteImportAmounts({ acres: .7, rate: .3, rateFactor: 10, inventoryFactor: 1, priceCents: 335n, costCents: 0n }).priceCents).toBe(704n);
  });
  it.each([0, -1, Infinity, NaN])('rejects invalid inventory conversion %s', (inventoryFactor) => {
    expect(() => quoteImportAmounts({ acres: 1, rate: 1, rateFactor: 1, inventoryFactor, priceCents: 1n, costCents: 0n })).toThrow();
  });
});
