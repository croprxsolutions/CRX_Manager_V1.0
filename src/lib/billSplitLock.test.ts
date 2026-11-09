import { describe, expect, it } from 'vitest';
import { billSplitLock, canEditBillSplit, cardLiveCents, sharesLeft, sharesOverHundred, sharesTotal } from './billSplitLock';

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

  it('a field split draft (in a split group) is not a one-customer draft, as the database exempts it', () => {
    expect(billSplitLock([invoice({ delivery_id: null, invoice_number: 'CS-6', status: 'unposted' })], [])).toBeNull();
  });

  it('ignores deleted invoices at every step, as the database does', () => {
    const deleted = { deleted_at: '2026-11-09' };
    expect(billSplitLock([invoice({ ...deleted, invoice_group_id: null, delivery_id: null })], [])).toBeNull();
    expect(billSplitLock([invoice({ ...deleted, status: 'posted' })], [])).toBeNull();
    expect(billSplitLock([invoice(deleted)], [delivery()])).toBeNull();
  });

  it("a Bill Split payer's draft switched to misc charge is not a one-customer draft", () => {
    expect(billSplitLock([invoice({ invoice_type: 'misc_charge' })], [delivery({ status: 'scheduled' })])).toBeNull();
  });
});

describe('cardLiveCents cents (each other payer: floor of their percent, per line)', () => {
  const p2 = (items: Array<{ id: string; total_price: number | null }>, own: Set<string>, pct: number) =>
    cardLiveCents(items, own, [{ customer_id: 'p2', pct }], 'main').get('p2') ?? 0;
  it('follows the card percent on lines without their own split', () => {
    expect(p2([{ id: 'a', total_price: 100 }, { id: 'b', total_price: 33.33 }], new Set(), 40)).toBe(5333);
  });
  it('is exact on long percents (no float drift)', () => {
    expect(p2([{ id: 'x', total_price: 19.99 }], new Set(), 33.333333)).toBe(666);
    expect(p2([{ id: 'y', total_price: 1 }], new Set(), 29)).toBe(29);
  });
  it('turns dollars into cents without float noise (1.005 is 101 cents, as the database rounds)', () => {
    expect(cardLiveCents([{ id: 'z', total_price: 1.005 }], new Set(), [], 'main').get('main')).toBe(101);
  });
  it('keeps every cent on a ten-billion-dollar line', () => {
    expect(cardLiveCents([{ id: 'big', total_price: 10_000_000_000.01 }], new Set(), [], 'main').get('main')).toBe(1_000_000_000_001);
  });
  it('skips lines with no price yet', () => {
    expect(p2([{ id: 'p', total_price: null }], new Set(), 50)).toBe(0);
  });
});

describe('canEditBillSplit (the lock decides, not the delivery status)', () => {
  it('stays editable on a fulfilled or part-delivered sale, where a refused split is fixed', () => {
    expect(canEditBillSplit('admin', 'fulfilled')).toBe(true);
    expect(canEditBillSplit('sales_rep', 'partially_fulfilled')).toBe(true);
  });
  it('is closed on a cancelled sale and for other roles', () => {
    expect(canEditBillSplit('admin', 'cancelled')).toBe(false);
    expect(canEditBillSplit('driver', 'pending')).toBe(false);
    expect(canEditBillSplit(undefined, undefined)).toBe(false);
  });
});

describe('sharesOverHundred (exact, as the database adds numeric)', () => {
  it('accepts shares that total exactly 100 despite float noise', () => {
    expect(0.2 + 83.9 + 15.9).not.toBe(100);
    expect(sharesOverHundred([0.2, 83.9, 15.9])).toBe(false);
    expect(sharesOverHundred([33.333333, 33.333333, 33.333334])).toBe(false);
  });
  it('refuses anything over 100', () => {
    expect(sharesOverHundred([60, 40.000001])).toBe(true);
  });
});

describe('sharesLeft (exact remainder)', () => {
  it('is 0 for a full split despite float noise, so no "Other 0%" line shows', () => {
    expect(sharesLeft([0.1, 64.1, 35.8])).toBe(0);
  });
  it('gives the exact rest', () => {
    expect(sharesLeft([0.2, 83.9])).toBe(15.9);
    expect(sharesLeft([33.333333])).toBe(66.666667);
  });
});

describe('sharesTotal (shown on the card)', () => {
  it('shows 100, not 100.00000000000001, for 0.2 + 83.9 + 15.9', () => {
    expect(sharesTotal([0.2, 83.9, 15.9])).toBe(100);
    expect(sharesTotal([33.333333, 33.333333])).toBe(66.666666);
  });
});

describe('cardLiveCents (each card payer as the split writer bills them)', () => {
  const line = [{ id: 'a', total_price: 100 }];
  it('gives the main customer their share plus whatever is left', () => {
    const m = cardLiveCents(line, new Set(), [{ customer_id: 'main', pct: 40 }, { customer_id: 'p2', pct: 30 }], 'main');
    expect(m.get('main')).toBe(7000);
    expect(m.get('p2')).toBe(3000);
  });
  it('gives the leftover cent to the main customer, others rounded down', () => {
    const m = cardLiveCents([{ id: 'a', total_price: 0.03 }], new Set(), [{ customer_id: 'p2', pct: 50 }], 'main');
    expect(m.get('p2')).toBe(1);
    expect(m.get('main')).toBe(2);
  });
  it('with no main share and a full card, the largest share takes the leftover', () => {
    const m = cardLiveCents([{ id: 'a', total_price: 0.03 }], new Set(), [{ customer_id: 'p2', pct: 60 }, { customer_id: 'p3', pct: 40 }], 'main');
    expect(m.get('p2')).toBe(2);
    expect(m.get('p3')).toBe(1);
  });
  it('skips lines with their own split', () => {
    const m = cardLiveCents(line, new Set(['a']), [{ customer_id: 'p2', pct: 30 }], 'main');
    expect(m.get('p2') ?? 0).toBe(0);
  });
});
