import { describe, expect, it } from 'vitest';
import { supplierUnitCostCents } from './supplierUnitCost';

describe('supplierUnitCostCents', () => {
  // Expected values are worked by hand from the server formula
  // round(cost_cents::numeric / package_quantity / inventory_units_per_supplier_unit)::bigint,
  // where PostgreSQL round() goes half away from zero, and were re-run on PostgreSQL 17.
  it.each([
    ['$9.00 per Case of 2 gal', 900n, 1, 2, 450n],
    ['exactly 2.5 cents rounds up', 5n, 1, 2, 3n],
    ['exactly 0.5 cent rounds up, not to even', 2n, 1, 4, 1n],
    ['exactly 2.5 cents (10 / 4) rounds up, not to even', 10n, 1, 4, 3n],
    ['499.5 cents over a 2-unit package', 999n, 2, 1, 500n],
    ['500.5 cents over a 2-unit package', 1001n, 2, 1, 501n],
    ['7 / 2.8 = 2.5 cents', 7n, 1, 2.8, 3n],
    ['3 / 3 / 0.4 = 2.5 cents', 3n, 3, 0.4, 3n],
    ['2.449 cents rounds down', 2449n, 1, 1000, 2n],
    ['33.33 cents rounds down', 100n, 3, 1, 33n],
    ['66.67 cents rounds up', 200n, 3, 1, 67n],
    ['decimal package quantity', 1250n, 2.5, 1, 500n],
  ])('%s', (_label, cost, quantity, factor, expected) => {
    expect(supplierUnitCostCents(cost, quantity, factor)).toBe(expected);
  });

  it('rounds the first division the way PostgreSQL does, not as one exact fraction', () => {
    // PostgreSQL 17 returns 360001124996 here; one exact division would give 360001124995.
    expect(supplierUnitCostCents(106_667n, 9.87654321, 0.00000003)).toBe(360_001_124_996n);
    expect(supplierUnitCostCents(888_889n, 9.87654321, 0.00000007)).toBe(1_285_714_446_413n);
  });

  it('reads numeric(20,8) values sent as JSON numbers or text without float error', () => {
    expect(supplierUnitCostCents(1_000n, JSON.parse('0.33333333'), JSON.parse('3.00000000'))).toBe(1_000n);
    expect(supplierUnitCostCents(1_000n, '0.33333333', '3')).toBe(1_000n);
    expect(supplierUnitCostCents(100n, 1, JSON.parse('0.1'))).toBe(1_000n);
  });

  it('gives no answer when a quantity is missing, not above 0, or too large to read exactly', () => {
    expect(supplierUnitCostCents(900n, null, 2)).toBeNull();
    expect(supplierUnitCostCents(900n, 1, null)).toBeNull();
    expect(supplierUnitCostCents(900n, 1, 0)).toBeNull();
    expect(supplierUnitCostCents(900n, -1, 2)).toBeNull();
    expect(supplierUnitCostCents(900n, 1, 12_345_678.5)).toBeNull();
    expect(supplierUnitCostCents(900n, 1, '1.123456789')).toBeNull();
  });
});
