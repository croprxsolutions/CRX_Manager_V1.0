import { describe, expect, it, vi } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock('./db', () => ({ supabase: { from: mockFrom } }));

import {
  findClosedPeriod,
  oldPaymentDateDays,
  paymentDateProblem,
  paymentDateRefusal,
} from './paymentDateCheck';

function chain(result: { data: unknown; error: unknown }, calls: Array<[string, unknown[]]> = []) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'lte', 'gte', 'limit']) {
    self[m] = (...args: unknown[]) => { calls.push([m, args]); return self; };
  }
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  return self;
}

describe('paymentDateProblem', () => {
  it('allows today and earlier days, in Central business days', () => {
    expect(paymentDateProblem('2026-11-24', '2026-11-24')).toBeNull();
    expect(paymentDateProblem('2026-10-30', '2026-11-24')).toBeNull();
  });

  it('refuses a day after today', () => {
    expect(paymentDateProblem('2026-11-25', '2026-11-24')).toBe('A payment cannot be dated after today (11/24/2026)');
  });

  it.each([null, '', '2026-11-24T05:00:00Z'])('asks for a date when there is none (%j)', (day) => {
    expect(paymentDateProblem(day, '2026-11-24')).toBe('Enter the payment date');
  });

  it("uses Chicago's today, not the device's UTC date", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T03:30:00Z'));
    expect(paymentDateProblem('2026-11-25')).toMatch(/after today \(11\/24\/2026\)/);
    expect(paymentDateProblem('2026-11-24')).toBeNull();
    vi.useRealTimers();
  });
});

describe('oldPaymentDateDays', () => {
  const now = new Date('2026-11-24T18:00:00Z');
  it('is null up to 31 days back', () => {
    expect(oldPaymentDateDays('2026-11-24', now)).toBeNull();
    expect(oldPaymentDateDays('2026-10-24', now)).toBeNull();
  });
  it('counts the days past that', () => {
    expect(oldPaymentDateDays('2026-10-23', now)).toBe(32);
  });
});

describe('findClosedPeriod', () => {
  it('reads the closed period holding the day', async () => {
    const calls: Array<[string, unknown[]]> = [];
    mockFrom.mockReturnValueOnce(chain({ data: [{ period_start: '2026-10-01', period_end: '2026-10-31' }], error: null }, calls));
    await expect(findClosedPeriod('2026-10-30')).resolves.toEqual({ period_start: '2026-10-01', period_end: '2026-10-31' });
    expect(mockFrom).toHaveBeenCalledWith('accounting_periods');
    expect(calls).toEqual(expect.arrayContaining([
      ['eq', ['status', 'closed']], ['lte', ['period_start', '2026-10-30']], ['gte', ['period_end', '2026-10-30']],
    ]));
  });

  it('finds nothing when the read fails or returns no rows (the database still refuses a closed month)', async () => {
    mockFrom.mockReturnValueOnce(chain({ data: null, error: { message: 'permission denied' } }));
    await expect(findClosedPeriod('2026-10-30')).resolves.toBeNull();
    mockFrom.mockReturnValueOnce(chain({ data: [], error: null }));
    await expect(findClosedPeriod('2026-10-30')).resolves.toBeNull();
  });
});

describe('paymentDateRefusal', () => {
  it("puts the database's closed-period refusal in plain words", () => {
    expect(paymentDateRefusal({ message: 'Date 2026-10-30 falls in closed accounting period (2026-10-01 to 2026-10-31)' }, '2026-10-30'))
      .toBe('10/30/2026 is in a closed month (10/1/2026 to 10/31/2026). Nothing was saved. '
        + 'Date the payment in an open month, or ask an admin to reopen that month in Month-End Close.');
  });

  it('names a future-date refusal', () => {
    expect(paymentDateRefusal({ message: 'PAYMENT_DATE_IN_FUTURE: payment date 2026-11-25 is after today (2026-11-24) in Central time' }, '2099-01-01'))
      .toMatch(/^Nothing was saved\. A payment cannot be dated after today/);
  });

  it('leaves every other error alone', () => {
    expect(paymentDateRefusal({ message: 'Payment amount must be positive' }, '2026-10-30')).toBeNull();
    expect(paymentDateRefusal(null, '2026-10-30')).toBeNull();
  });
});
