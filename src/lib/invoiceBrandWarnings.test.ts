import { describe, expect, it } from 'vitest';
import { brandPostWarningText, invoiceBrandWarnings, typedBrandDeliveryIds, type BrandWarningLine } from './invoiceBrandWarnings';
import {
  invoiceBrandNotes,
  invoiceLineEpaText,
  receiptBrandInfoFromPicks,
  receiptBrandNotes,
} from '../../supabase/functions/_shared/brandNotes.ts';

const e = (o: Record<string, unknown>) => ({
  brand_key: `b:${String(o.brand_name ?? '').toLowerCase()}|${o.epa_registration ?? ''}`,
  epa_registration: null, typed: false, pick_id: null, delivery_id: 'd1', delivery_item_id: 'di1', line_delivered: 5,
  ...o,
});
const line = (brand_lines: unknown, quantity = 5, extra: Partial<BrandWarningLine> = {}): BrandWarningLine => ({
  label: 'Gly', quantity, order_item_id: 'oi1', product_id: 'p1', brand_lines, ...extra,
});

describe('invoice brand notes (paper)', () => {
  it('prints nothing for a line with no brand information, and not recorded for []', () => {
    expect(invoiceBrandNotes(null)).toEqual([]);
    expect(invoiceBrandNotes([])).toEqual(['Brand not recorded']);
  });
  it('prints each brand with its number and amount, on the load for a Bill Split payer, and a mismatch', () => {
    const bl = [e({ brand_name: 'Bravo', epa_registration: '100-2', quantity: 3 }), e({ brand_name: 'Alpha', quantity: 1 })];
    expect(invoiceBrandNotes(bl, true)).toEqual([
      'Brand: Bravo (EPA 100-2) - 3 on the load',
      'Brand: Alpha (no EPA number) - 1 on the load',
      'Brand amounts do not match delivered: 4 of 5 recorded',
    ]);
  });
  it('joins the numbers of a split in the EPA column, else keeps the line number', () => {
    const bl = [e({ brand_name: 'A', epa_registration: '1-1', quantity: 2 }), e({ brand_name: 'B', epa_registration: '1-2', quantity: 3 })];
    expect(invoiceLineEpaText(bl, '9-9')).toBe('1-1, 1-2');
    expect(invoiceLineEpaText([bl[0]], '1-1')).toBe('1-1');
    expect(invoiceLineEpaText(null, '9-9')).toBe('9-9');
  });
  it('no-brand trip entry prints not recorded', () => {
    expect(invoiceBrandNotes([e({ brand_key: 'n:', brand_name: null, quantity: 5 })])).toEqual(['Brand not recorded']);
  });
});

describe('receipt brand notes', () => {
  it('matches the snapshot rule: amounts when they add up, names and picked total when not', () => {
    const picks = [{ brand_name: 'bravo', epa_registration: '1', quantity: 3 }, { brand_name: 'Alpha', epa_registration: null, quantity: 2 }];
    expect(receiptBrandInfoFromPicks(picks, 5, true)).toEqual({ brands: [
      { name: 'Alpha', epa_registration: null, quantity: 2 }, { name: 'bravo', epa_registration: '1', quantity: 3 }] });
    const off = receiptBrandInfoFromPicks(picks, 6, true);
    expect(off.brand_picked_quantity).toBe(5);
    expect(receiptBrandNotes({ ...off, qty: 6 })).toEqual([
      'Brand: Alpha (no EPA number)', 'Brand: bravo (EPA 1)', 'Brand amounts do not match delivered: 5 of 6 recorded']);
    expect(receiptBrandInfoFromPicks([], 5, true)).toEqual({ brand_recorded: false });
    expect(receiptBrandInfoFromPicks([], 5, false)).toEqual({});
    expect(receiptBrandNotes({ qty: 5 })).toEqual([]);
  });
  it('compares 4-place amounts exactly (0.1 + 0.2 picks against 0.3 delivered)', () => {
    const picks = [{ brand_name: 'A', epa_registration: null, quantity: 0.1 }, { brand_name: 'B', epa_registration: null, quantity: 0.2 }];
    expect(receiptBrandInfoFromPicks(picks, 0.3, true).brand_picked_quantity).toBeUndefined();
  });
});

describe('invoice brand warnings before posting', () => {
  it('says nothing for a clean branded line', () => {
    const w = invoiceBrandWarnings([line([e({ brand_name: 'A', epa_registration: '1-1', quantity: 5 })])], new Set());
    expect(w).toEqual({ noRecord: [], followUp: [] });
    expect(brandPostWarningText(w)).toBeNull();
  });
  it('a split that does not add up gets no RUP record', () => {
    const w = invoiceBrandWarnings([line([e({ brand_name: 'A', epa_registration: '1-1', quantity: 4 })])], new Set());
    expect(w.noRecord).toEqual(['Gly: Split does not match delivered (4 of 5 recorded)']);
  });
  it('two wrong trips are each named, so they never cancel into a total that looks right', () => {
    const bl = [
      e({ brand_name: 'A', epa_registration: '1-1', quantity: 6, delivery_item_id: 'di-1' }),
      e({ brand_name: 'A', epa_registration: '1-1', quantity: 4, delivery_item_id: 'di-2' }),
    ];
    const w = invoiceBrandWarnings([line(bl, 10)], new Set());
    expect(w.noRecord).toEqual(['Gly: Split does not match delivered (6 of 5, 4 of 5 recorded)']);
  });
  it('billed above delivered across a Bill Split group gets no RUP record; below is a follow-up', () => {
    const bl = [e({ brand_name: 'A', epa_registration: '1-1', quantity: 5 })];
    const above = invoiceBrandWarnings([line(bl, 3, { label: 'X-1 Gly' }), line(bl, 3, { label: 'X-2 Gly' })], new Set());
    expect(above.noRecord).toEqual(['X-1 Gly: Billed above delivered (6 billed, 5 delivered)', 'X-2 Gly: Billed above delivered (6 billed, 5 delivered)']);
    const below = invoiceBrandWarnings([line(bl, 4)], new Set());
    expect(below.noRecord).toEqual([]);
    expect(below.followUp).toEqual(['Gly: Quantity changed from delivered (4 billed, 5 delivered)']);
  });
  it('not recorded, no EPA number and a typed brand still waiting are follow-ups', () => {
    const w = invoiceBrandWarnings([
      line([]),
      line([e({ brand_name: 'Golf', typed: true, pick_id: 'p9', quantity: 5 })], 5, { label: 'Dic', order_item_id: 'oi2' }),
    ], new Set(['p9']));
    expect(w.noRecord).toEqual([]);
    expect(w.followUp).toEqual([
      "Gly: Brand not recorded (uses the product's EPA number)",
      "Dic: EPA number not recorded for Golf (uses the product's EPA number)",
      'Dic: Brand typed at delivery, not yet checked (Golf)',
    ]);
    expect(typedBrandDeliveryIds([line([e({ brand_name: 'Golf', typed: true, quantity: 5 })])])).toEqual(['d1']);
    expect(brandPostWarningText(w)).toContain('Brand follow-ups, listed on Sales to check:');
  });
  it('a checked typed brand does not warn', () => {
    const w = invoiceBrandWarnings([line([e({ brand_name: 'Golf', epa_registration: '1-9', typed: true, pick_id: 'p9', quantity: 5 })])], new Set());
    expect(w.followUp).toEqual([]);
  });
});
