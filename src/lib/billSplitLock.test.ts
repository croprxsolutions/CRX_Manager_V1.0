import { describe, expect, it } from 'vitest';
import { billSplitLock, cardPayerLiveCents } from './billSplitLock';

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'd1', delivery_number: 'DEL-1', status: 'completed', deleted_at: null, ...over,
});
const invoice = (over: Record<string, unknown> = {}) => ({
  invoice_number: 'CS-1', status: 'draft', invoice_type: 'chemical_sale',
  invoice_group_id: 'g1', delivery_id: 'd1', ...over,
});

describe('billSplitLock (same order as _refuse_bill_split_change)', () => {
  it('stays open after a completed delivery the split refused to bill', () => {
    // BILL_SPLIT_QUANTITY_TOO_SMALL or price-later: completed, no invoice. The office must fix the shares.
    expect(billSplitLock([], [delivery()])).toBeNull();
  });

  it('locks on a completed delivery once it is billed', () => {
    expect(billSplitLock([invoice()], [delivery()])).toEqual({ kind: 'delivery', number: 'DEL-1' });
  });

  it('a credit memo on the delivery does not count as billed', () => {
    expect(billSplitLock([invoice({ invoice_type: 'credit_memo', invoice_group_id: null })], [delivery()])).toBeNull();
  });

  it('ignores a deleted delivery', () => {
    expect(billSplitLock([invoice()], [delivery({ deleted_at: '2026-11-01' })])).toBeNull();
  });

  it('a posted invoice wins over the delivery', () => {
    expect(billSplitLock([invoice({ status: 'posted', invoice_number: 'CS-9' })], [delivery()]))
      .toEqual({ kind: 'posted', number: 'CS-9' });
  });

  it('locks on a one-customer draft (no group)', () => {
    expect(billSplitLock([invoice({ invoice_group_id: null, delivery_id: null, invoice_number: 'CS-5' })], []))
      .toEqual({ kind: 'draft', number: 'CS-5' });
  });

  it('a field split draft (group, no delivery) is a one-customer draft too', () => {
    expect(billSplitLock([invoice({ delivery_id: null, invoice_number: 'CS-6', status: 'unposted' })], []))
      .toEqual({ kind: 'draft', number: 'CS-6' });
  });

  it("a Bill Split payer's draft switched to misc charge is not a one-customer draft", () => {
    expect(billSplitLock([invoice({ invoice_type: 'misc_charge' })], [delivery({ status: 'scheduled' })])).toBeNull();
  });
});

describe('cardPayerLiveCents (each other payer: floor of their percent, per line)', () => {
  const items = [{ id: 'a', total_price: 100 }, { id: 'b', total_price: 33.33 }];

  it('follows the card percent on lines without their own split', () => {
    // floor(10000 * 0.4) + floor(3333 * 0.4) = 4000 + 1333
    expect(cardPayerLiveCents(items, new Set(), 40)).toBe(5333);
  });

  it('a line with its own split bills nothing through the card', () => {
    expect(cardPayerLiveCents([{ id: 'a', total_price: 100 }], new Set(['a']), 40)).toBe(0);
  });

  it('is exact on long percents (no float drift)', () => {
    // 1999 * 33.333333 / 100 = 666.33... -> 666; 100 * 29 / 100 = 29 exactly
    expect(cardPayerLiveCents([{ id: 'x', total_price: 19.99 }], new Set(), 33.333333)).toBe(666);
    expect(cardPayerLiveCents([{ id: 'y', total_price: 1 }], new Set(), 29)).toBe(29);
  });

  it('skips lines with no price yet', () => {
    expect(cardPayerLiveCents([{ id: 'p', total_price: null }], new Set(), 50)).toBe(0);
  });
});
