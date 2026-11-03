import { describe, expect, it } from 'vitest';
import { isPricedAgingRow } from './arAging';
import type { ARAgingRow } from '../types';

const priced = {
  customer_id: 'c1', farm_name: 'A', current_amount: 10, days_30: 0, days_60: 0, days_90: 0, over_90: 0,
  total_outstanding: 10, prepay_balance_cents: null, open_credit_cents: 0, unavailable_reason: null,
} as ARAgingRow;
const flagged = {
  customer_id: 'c2', farm_name: 'B', current_amount: null, days_30: null, days_60: null, days_90: null, over_90: null,
  total_outstanding: null, prepay_balance_cents: null, open_credit_cents: null,
  unavailable_reason: 'HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE',
} as ARAgingRow;

describe('isPricedAgingRow', () => {
  it('keeps a priced row and drops a flagged one', () => {
    expect(isPricedAgingRow(priced)).toBe(true);
    expect(isPricedAgingRow(flagged)).toBe(false);
  });

  it('drops a row with no reason but no total, rather than read it as $0', () => {
    expect(isPricedAgingRow({ ...flagged, unavailable_reason: null } as unknown as ARAgingRow)).toBe(false);
  });
});
