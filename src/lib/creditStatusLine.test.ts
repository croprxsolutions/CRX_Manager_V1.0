import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ supabase: {}, supabaseUntyped: {} }));

import { describeCreditStatus } from './creditLimitGuard';

describe('describeCreditStatus (quote header, To-Do 1.8)', () => {
  it('shows the open balance when there is no limit', () => {
    expect(describeCreditStatus({ limitCents: null, exposureCents: 123456 })).toEqual({ over: false, text: 'No credit limit · $1,234.56 open' });
  });
  it('shows the credit left under the limit', () => {
    expect(describeCreditStatus({ limitCents: 1000000, exposureCents: 250000 })).toEqual({ over: false, text: '$7,500.00 credit available ($2,500.00 open of $10,000.00)' });
  });
  it('is not over when exactly at the limit', () => {
    expect(describeCreditStatus({ limitCents: 1000000, exposureCents: 1000000 }).over).toBe(false);
  });
  it('flags a customer over the limit by even a cent', () => {
    expect(describeCreditStatus({ limitCents: 1000000, exposureCents: 1000001 })).toEqual({ over: true, text: 'Over credit limit by $0.01 ($10,000.01 open of $10,000.00)' });
  });
});
