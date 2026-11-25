import { describe, expect, it } from 'vitest';
import { firstOpenDay, planRefundDraw, refundErrors, returnedDateError, drawText } from './m9Reversals';

const closed = [{ period_start: '2026-09-01', period_end: '2026-09-30' }, { period_start: '2026-10-01', period_end: '2026-10-31' }];
const credits = [
  { id: 'b', label: 'Fall 2026 prepay', balance_cents: 30000, created_at: '2026-09-15T15:00:00Z' },
  { id: 'a', label: 'Spring 2026 prepay', balance_cents: 20000, created_at: '2026-03-02T15:00:00Z' },
  { id: 'z', label: 'Used up', balance_cents: 0, created_at: '2026-01-01T15:00:00Z' },
];

describe('M9 refund rules', () => {
  it('draws oldest first, or only the picked credit', () => {
    expect(drawText(planRefundDraw(credits, 30000))).toBe('Spring 2026 prepay $200.00, then Fall 2026 prepay $100.00');
    expect(planRefundDraw(credits, 30000, 'b')).toEqual([{ id: 'b', label: 'Fall 2026 prepay', cents: 30000 }]);
  });

  it('says what is wrong with each field', () => {
    const base = { availableCents: 50000, reference: 'QB 1', reason: 'why', today: '2026-11-23', closed };
    expect(refundErrors({ ...base, amountCents: 65000, paidOn: '2026-10-28' })).toEqual({
      amount: 'More than the $500.00 available.', paidOn: 'October is closed. Use Nov 1 to today.',
    });
    expect(refundErrors({ ...base, amountCents: null, paidOn: '2026-11-24' })).toEqual({
      amount: 'Enter an amount with no more than two decimal places.', paidOn: "Can't be after today.",
    });
    expect(refundErrors({ ...base, amountCents: 30000, paidOn: '2026-11-23', reason: '  ' })).toEqual({ reason: 'Add a reason. It shows in the prepay history.' });
    expect(firstOpenDay(closed, '2026-11-23')).toBe('2026-11-01');
  });
});

describe('M9 returned-check dates', () => {
  it('the bank date may be in a closed month but not before the check or after today', () => {
    expect(returnedDateError('2026-09-20', '2026-09-15', '2026-11-23')).toBeNull();
    expect(returnedDateError('2026-09-14', '2026-09-15', '2026-11-23')).toBe("Can't be before the check (Sep 15).");
    expect(returnedDateError('2026-11-24', '2026-09-15', '2026-11-23')).toBe("Can't be after today.");
  });
});
