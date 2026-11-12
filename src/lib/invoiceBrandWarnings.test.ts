import { describe, expect, it } from 'vitest';
import { brandDeliveryIds, brandPostWarningText, invoiceBrandWarnings, type BrandWarningLine, type DeliveryPickLine } from './invoiceBrandWarnings';
import { paperBrandInfo, type BrandPaperEvent } from './deliveryBrandPaper';
import {
  invoiceBrandNotes,
  invoiceLineEpaText,
  receiptBrandInfoFromPicks,
  receiptBrandNotes,
} from '../../supabase/functions/_shared/brandNotes.ts';

const e = (o: Record<string, unknown>) => ({
  brand_key: `b:${String(o.brand_name ?? '').toLowerCase()}|${o.epa_registration ?? ''}`,
  epa_registration: null, typed: false, pick_id: `pk-${String(o.brand_name)}`, delivery_id: 'd1', delivery_item_id: 'di1', line_delivered: 5,
  ...o,
});
const line = (brand_lines: unknown, quantity = 5, extra: Partial<BrandWarningLine> = {}): BrandWarningLine => ({
  label: 'Gly', quantity, order_item_id: 'oi1', product_id: 'p1', delivery_id: null, brand_lines, ...extra,
});
type Pick = DeliveryPickLine['picks'][number];
const pk = (o: Partial<Pick>): Pick => ({ id: 'pa', brand_name: 'A', epa_registration: '1-1', quantity: 5, review_state: null, ...o });
const now = (picks: Pick[], extra: Partial<DeliveryPickLine> = {}): DeliveryPickLine => ({
  delivery_id: 'd1', delivery_item_id: 'di1', order_item_id: 'oi1', product_id: 'p1', delivered: 5, picks, ...extra,
});
/** Today's picks exactly as the lines saved them (nothing changed since), with the given picks still pending review. */
const asSaved = (lines: BrandWarningLine[], pending: string[] = []): DeliveryPickLine[] => {
  const byItem = new Map<string, DeliveryPickLine>();
  for (const l of lines) {
    const before = new Set(byItem.keys()); // payers of one Bill Split share the trip: take it once
    for (const x of (l.brand_lines as Array<Record<string, unknown>> | null) ?? []) {
      const item = String(x.delivery_item_id);
      if (before.has(item)) continue;
      const cur = byItem.get(item) ?? now([], { delivery_item_id: item, delivered: Number(x.line_delivered) });
      if (x.brand_key !== 'n:') {
        cur.picks.push(pk({ id: String(x.pick_id), brand_name: String(x.brand_name), epa_registration: (x.epa_registration as string | null) ?? null,
          quantity: Number(x.quantity), review_state: pending.includes(String(x.pick_id)) ? 'pending' : null }));
      }
      byItem.set(item, cur);
    }
  }
  return [...byItem.values()];
};
const warn = (lines: BrandWarningLine[], pending: string[] = []) => invoiceBrandWarnings(lines, asSaved(lines, pending));

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
    const w = warn([line([e({ brand_name: 'A', epa_registration: '1-1', quantity: 5 })])]);
    expect(w).toEqual({ noRecord: [], followUp: [] });
    expect(brandPostWarningText(w)).toBeNull();
  });
  it('a split that does not add up gets no RUP record', () => {
    const w = warn([line([e({ brand_name: 'A', epa_registration: '1-1', quantity: 4 })])]);
    expect(w.noRecord).toEqual(['Gly: Split does not match delivered (4 of 5 recorded)']);
  });
  it('two wrong trips are each named, so they never cancel into a total that looks right', () => {
    const bl = [
      e({ brand_name: 'A', epa_registration: '1-1', quantity: 6, delivery_item_id: 'di-1' }),
      e({ brand_name: 'A', epa_registration: '1-1', quantity: 4, delivery_item_id: 'di-2' }),
    ];
    const w = warn([line(bl, 10)]);
    expect(w.noRecord).toEqual(['Gly: Split does not match delivered (6 of 5, 4 of 5 recorded)']);
  });
  it('billed above delivered across a Bill Split group gets no RUP record; below is a follow-up', () => {
    const bl = [e({ brand_name: 'A', epa_registration: '1-1', quantity: 5 })];
    const above = warn([line(bl, 3, { label: 'X-1 Gly' }), line(bl, 3, { label: 'X-2 Gly' })]);
    expect(above.noRecord).toEqual(['X-1 Gly: Billed above delivered (6 billed, 5 delivered)', 'X-2 Gly: Billed above delivered (6 billed, 5 delivered)']);
    const below = warn([line(bl, 4)]);
    expect(below.noRecord).toEqual([]);
    expect(below.followUp).toEqual(['Gly: Quantity changed from delivered (4 billed, 5 delivered)']);
  });
  it('not recorded, no EPA number and a typed brand still waiting are follow-ups', () => {
    const w = warn([
      line([]),
      line([e({ brand_name: 'Golf', typed: true, pick_id: 'p9', quantity: 5 })], 5, { label: 'Dic', order_item_id: 'oi2' }),
    ], ['p9']);
    expect(w.noRecord).toEqual([]);
    expect(w.followUp).toEqual([
      "Gly: Brand not recorded (uses the product's EPA number)",
      "Dic: EPA number not recorded for Golf (uses the product's EPA number)",
      'Dic: Brand typed at delivery, not yet checked (Golf)',
    ]);
    expect(brandDeliveryIds([line([e({ brand_name: 'Golf', typed: true, quantity: 5 })]), line(null, 5, { delivery_id: 'd2' })]))
      .toEqual(['d1', 'd2']);
    expect(brandPostWarningText(w)).toContain('Brand follow-ups to check:');
  });
  it('a checked typed brand does not warn', () => {
    const w = warn([line([e({ brand_name: 'Golf', epa_registration: '1-9', typed: true, pick_id: 'p9', quantity: 5 })])]);
    expect(w).toEqual({ noRecord: [], followUp: [] });
  });
  it('saved brands that no longer match the picks (a corrected Bill Split draft) get no RUP record', () => {
    const saved = [line([e({ brand_name: 'A', epa_registration: '1-1', pick_id: 'pa', quantity: 5 })], 5, { label: 'X-1 Gly', delivery_id: 'd1' })];
    const changed = 'X-1 Gly: Brands changed since this invoice was made';
    expect(invoiceBrandWarnings(saved, [now([pk({})])]).noRecord).toEqual([]);
    // A different pick, a new amount, a brand or EPA number corrected in place, or a trip added since: changed.
    expect(invoiceBrandWarnings(saved, [now([pk({ id: 'pb' })])]).noRecord).toEqual([changed]);
    expect(invoiceBrandWarnings(saved, [now([pk({ quantity: 4 })])]).noRecord).toEqual([changed]);
    expect(invoiceBrandWarnings(saved, [now([pk({ brand_name: 'B' })])]).noRecord).toEqual([changed]);
    expect(invoiceBrandWarnings(saved, [now([pk({ epa_registration: '1-2' })])]).noRecord).toEqual([changed]);
    expect(invoiceBrandWarnings(saved, [now([pk({})]), now([pk({ id: 'pc' })], { delivery_item_id: 'di2' })]).noRecord).toEqual([changed]);
    // A line of the delivery for another order line, or one that delivered nothing, is not this line's.
    expect(invoiceBrandWarnings(saved, [now([pk({})]), now([pk({ id: 'pc' })], { delivery_item_id: 'di3', order_item_id: 'oi9' }),
      now([], { delivery_item_id: 'di4', delivered: 0 })]).noRecord).toEqual([]);
  });
  it('a line saved with no brands whose delivery line now has a pick gets no RUP record', () => {
    const picked = [now([pk({})])];
    expect(invoiceBrandWarnings([line(null, 5, { delivery_id: 'd1' })], picked).noRecord)
      .toEqual(['Gly: Brands changed since this invoice was made']);
    expect(invoiceBrandWarnings([line([], 5, { delivery_id: 'd1' })], picked).noRecord)
      .toEqual(['Gly: Brands changed since this invoice was made']);
    expect(invoiceBrandWarnings([line(null, 5, { delivery_id: 'd1' })], [now([])])).toEqual({ noRecord: [], followUp: [] });
  });
});

describe('delivery paper brand notes follow the receipt rule', () => {
  const read = (picks: Array<{ id: string; brand_name: string; epa_registration: string | null; quantity: number; review_state: string | null }>) => ({
    status: 'completed',
    lines: [{ delivery_item_id: 'di1', order_item_id: 'oi1', product_id: 'p1', quantity: 5, quantity_delivered: 5, picks }],
  });
  const pick = { id: 'pa', brand_name: 'Alpha', epa_registration: '1-1', quantity: 5, review_state: null };
  const completed = (picks_confirmed: boolean | null, brand_list_size = 2): BrandPaperEvent => ({
    seq: 1, event_type: 'completed', details: { picks_confirmed, lines: [{ delivery_item_id: 'di1', brand_list_size }] },
    before_rows: [], after_rows: [],
  });
  it('prints the brand when the completion confirmed it', () => {
    expect(paperBrandInfo(read([pick]), [completed(true)]).get('di1'))
      .toEqual({ brands: [{ name: 'Alpha', epa_registration: '1-1', quantity: 5 }] });
  });
  it('prints no brand from an out-of-date completion until the line is corrected', () => {
    expect(paperBrandInfo(read([pick]), [completed(false)]).get('di1')).toEqual({});
    const fix: BrandPaperEvent = { seq: 2, event_type: 'corrected', details: null, before_rows: [], after_rows: [{ delivery_item_id: 'di1' }] };
    expect(paperBrandInfo(read([pick]), [completed(false), fix]).get('di1')?.brands).toHaveLength(1);
  });
  it('"not recorded" uses the brand list the line had at completion, not the current one', () => {
    expect(paperBrandInfo(read([]), [completed(true, 0)]).get('di1')).toEqual({});
    expect(paperBrandInfo(read([]), [completed(true, 2)]).get('di1')).toEqual({ brand_recorded: false });
    expect(paperBrandInfo(read([]), []).get('di1')).toEqual({});
  });
  it('a delivery completed before brand capture prints no brand until the office corrects it', () => {
    expect(paperBrandInfo(read([pick]), []).get('di1')).toEqual({});
    const fix: BrandPaperEvent = { seq: 5, event_type: 'corrected', details: null, before_rows: [{ delivery_item_id: 'di1' }], after_rows: [] };
    expect(paperBrandInfo(read([pick]), [fix]).get('di1')?.brands).toHaveLength(1);
  });
});
