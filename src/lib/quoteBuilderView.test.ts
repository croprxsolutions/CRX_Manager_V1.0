import { describe, it, expect } from 'vitest';
import { primaryAction, lineNeedsRemoveConfirm, todaysPricesMessage } from './quoteBuilderView';

const base = { isNew: false, unsentChange: null, canConvert: false, canDraw: false } as const;

describe('primaryAction', () => {
  it('previews for new and draft', () => {
    expect(primaryAction({ ...base, isNew: true, status: 'draft' })).toBe('preview');
    expect(primaryAction({ ...base, status: 'draft' })).toBe('preview');
  });
  it('creates an order for sent and clean revised', () => {
    expect(primaryAction({ ...base, status: 'sent' })).toBe('createOrder');
    expect(primaryAction({ ...base, status: 'revised' })).toBe('createOrder');
  });
  it('previews for revised with an unsent change', () => {
    for (const u of ['prices', 'unreadable', 'customer'] as const) {
      expect(primaryAction({ ...base, status: 'revised', unsentChange: u })).toBe('preview');
    }
  });
  it('accepted creates an order only when it can convert', () => {
    expect(primaryAction({ ...base, status: 'accepted', canConvert: true })).toBe('createOrder');
    expect(primaryAction({ ...base, status: 'accepted' })).toBeNull();
  });
  it('has no green action for ended states', () => {
    for (const status of ['declined', 'expired', 'cancelled', 'closed_short', 'closed_by_application'] as const) {
      expect(primaryAction({ ...base, status, canConvert: true })).toBeNull();
    }
  });
});

describe('lineNeedsRemoveConfirm', () => {
  it('is false for a blank line', () => {
    expect(lineNeedsRemoveConfirm({ product_id: null, units_needed: null })).toBe(false);
    expect(lineNeedsRemoveConfirm({ product_id: null, units_needed: 0 })).toBe(false);
  });
  it('is true with a product or a quantity', () => {
    expect(lineNeedsRemoveConfirm({ product_id: 'p1', units_needed: null })).toBe(true);
    expect(lineNeedsRemoveConfirm({ product_id: null, units_needed: 5 })).toBe(true);
  });
});

describe('todaysPricesMessage', () => {
  const before = [
    { price: 10, total: 5000 }, { price: 20, total: 4000 },
    { price: 30, total: 3000 }, { price: 40, total: 2380 },
  ];
  it('counts changed lines and formats totals', () => {
    const after = [
      { price: 11, total: 5000 }, { price: 21, total: 4000 },
      { price: 31, total: 3042.5 }, { price: 40, total: 2380 },
    ];
    expect(todaysPricesMessage(before, after, 1)).toEqual({
      title: "3 lines now use today's Tier 1 prices",
      body: 'Total went from $14,380.00 to $14,422.50. Save draft to keep it.',
    });
  });
  it('says nothing changed', () => {
    expect(todaysPricesMessage(before, before, 1)).toEqual({
      title: "Prices already match today's Tier 1 prices",
      body: 'Nothing changed.',
    });
  });
  it('uses singular for one line', () => {
    const after = [{ ...before[0], price: 12 }, ...before.slice(1)];
    expect(todaysPricesMessage(before, after, 2).title).toBe("1 line now uses today's Tier 2 prices");
  });
});
