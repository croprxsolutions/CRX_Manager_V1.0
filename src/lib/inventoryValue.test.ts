import { describe, expect, it } from 'vitest';
import { quantityTimesCostCents, summarizeInventoryValue } from './inventoryValue';

describe('inventory value (KI-135)', () => {
  it('multiplies exactly and rounds half away from zero', () => {
    expect(quantityTimesCostCents(0.3, 0.05)).toBe(2); // float 0.3 * 5 = 1.4999… would round down
    expect(quantityTimesCostCents('2.5', '10.125')).toBe(2531); // 25.3125 dollars
    expect(quantityTimesCostCents(1e-7, 1)).toBe(0); // JavaScript prints this as exponent notation
    expect(quantityTimesCostCents(5e-7, 1e5)).toBe(5); // 0.05 dollars
    expect(quantityTimesCostCents(2, '1.5E1')).toBe(3000);
    expect(quantityTimesCostCents('abc', 1)).toBeNaN();
  });

  it('values only stock above zero with a cost, and counts the rest apart', () => {
    const summary = summarizeInventoryValue([
      { quantity: 10, unitCost: 12.5 },
      { quantity: -4, unitCost: 100 },
      { quantity: 3, unitCost: null },
      { quantity: 2, unitCost: 0 },
      { quantity: 0, unitCost: 7 },
      { quantity: 0.1, unitCost: 0.2 },
    ]);
    expect(summary).toEqual({ valueCents: 12502, belowZeroCount: 1, noCostCount: 2 });
  });
});
