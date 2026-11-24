import { describe, it, expect } from 'vitest';
import { deliveryLineFigures } from './deliveryLineRemaining';

describe('deliveryLineFigures (F05 "Remaining After")', () => {
  it('a completed partial load does not count itself twice (staging DEL-00031: 2 ordered, 1 delivered)', () => {
    expect(deliveryLineFigures({ status: 'completed', ordered: 2, orderDelivered: 1, otherOpen: 0, scheduled: 2, actual: 1 }))
      .toEqual({ prevDelivered: 0, remainingAfter: 1 });
  });
  it('a completed load leaves out units another open load holds', () => {
    expect(deliveryLineFigures({ status: 'completed', ordered: 2, orderDelivered: 1, otherOpen: 1, scheduled: 2, actual: 1 }))
      .toEqual({ prevDelivered: 0, remainingAfter: 0 });
  });
  it('an open load subtracts itself and the other open loads', () => {
    expect(deliveryLineFigures({ status: 'scheduled', ordered: 10, orderDelivered: 2, otherOpen: 3, scheduled: 4, actual: 0 }))
      .toEqual({ prevDelivered: 2, remainingAfter: 1 });
    expect(deliveryLineFigures({ status: 'in_progress', ordered: 10, orderDelivered: 2, otherOpen: 3, scheduled: 4, actual: 0 }).remainingAfter).toBe(1);
  });
  it('a cancelled or voided load holds nothing and delivered nothing', () => {
    for (const status of ['cancelled', 'voided']) {
      expect(deliveryLineFigures({ status, ordered: 5, orderDelivered: 1, otherOpen: 0, scheduled: 4, actual: 4 }))
        .toEqual({ prevDelivered: 1, remainingAfter: 4 });
    }
  });
  it('never shows a negative number on an already-over legacy line', () => {
    expect(deliveryLineFigures({ status: 'scheduled', ordered: 2, orderDelivered: 3, otherOpen: 1, scheduled: 1, actual: 0 }).remainingAfter).toBe(0);
  });
});
