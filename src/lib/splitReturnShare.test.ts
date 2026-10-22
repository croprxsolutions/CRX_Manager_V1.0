import { describe, expect, it } from 'vitest';
import { returnableQuantity, type BilledLine, type OpenReturnLine } from './splitReturnShare';

const A = 'customer-a';
const B = 'customer-b';
const LINE = 'line-1';
const billed: BilledLine[] = [
  { order_item_id: LINE, quantity: 2, customer_id: A, invoice_group_id: 'g1' },
  { order_item_id: LINE, quantity: 2, customer_id: B, invoice_group_id: 'g1' },
];

describe('returnableQuantity (split-payer returns, 20261021155000)', () => {
  it('keeps the delivered rule on a line billed only to the order customer', () => {
    const openReturns: OpenReturnLine[] = [{ order_item_id: LINE, quantity: 1, customer_id: A }];
    expect(returnableQuantity({
      orderItemId: LINE, delivered: 4, orderCustomerId: A, customerId: A,
      billed: [{ order_item_id: LINE, quantity: 3, customer_id: A, invoice_group_id: null }], openReturns,
    })).toBe(3);
  });

  it('caps a landlord at its own billed share, less its open returns', () => {
    const openReturns: OpenReturnLine[] = [{ order_item_id: LINE, quantity: 0.25, customer_id: B }];
    expect(returnableQuantity({ orderItemId: LINE, delivered: 4, orderCustomerId: A, customerId: B, billed, openReturns }))
      .toBe(1.75);
  });

  it('caps the order customer at its share once another payer was billed for the line', () => {
    expect(returnableQuantity({ orderItemId: LINE, delivered: 4, orderCustomerId: A, customerId: A, billed, openReturns: [] }))
      .toBe(2);
  });

  it('never exceeds what is left of the delivery after every open return', () => {
    const openReturns: OpenReturnLine[] = [{ order_item_id: LINE, quantity: 3, customer_id: A }];
    expect(returnableQuantity({ orderItemId: LINE, delivered: 4, orderCustomerId: A, customerId: B, billed, openReturns }))
      .toBe(1);
  });

  it('gives a customer other than the order customer nothing from an ungrouped invoice', () => {
    expect(returnableQuantity({
      orderItemId: LINE, delivered: 4, orderCustomerId: A, customerId: B,
      billed: [{ order_item_id: LINE, quantity: 2, customer_id: B, invoice_group_id: null }], openReturns: [],
    })).toBe(0);
  });
});
