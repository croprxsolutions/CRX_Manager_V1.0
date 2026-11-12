import { describe, expect, it, vi } from 'vitest';
import { supabaseUntyped } from './db';
import {
  brandWarnings, changedLineIds, setDeliveryBrands, deliveryBrandErrorMessage, draftFromPicks, OTHER_BRAND, picksPayload,
  type DeliveryBrandLine, type DeliveryBrandPick, type DeliveryBrands,
} from './deliveryBrands';

const option = { source: 'size' as const, parent_id: null, brand_id: 'b1', brand_name: 'Roundup', epa_registration: '524-475', manufacturer: null, is_currently_sourced: true };
const pick = (over: Partial<DeliveryBrandPick> = {}): DeliveryBrandPick => ({
  id: 'p1', delivery_item_id: 'L1', source: 'size', parent_brand_id: null, legacy_brand_id: 'b1', brand_name: 'Roundup',
  epa_registration: '524-475', manufacturer: null, quantity: 10, review_state: null, ...over,
});
const line = (over: Partial<DeliveryBrandLine> = {}): DeliveryBrandLine => ({
  delivery_item_id: 'L1', product_id: 'P1', product_name: 'Glyphosate 2.5', quantity: 10, quantity_delivered: null,
  unit_size: 'gal', brand_list: [option], picks: [], ...over,
});
const brands = (lines: DeliveryBrandLine[]): DeliveryBrands => ({ delivery_id: 'D1', status: 'in_progress', event_seq: 3, lines });

describe('brandWarnings (warn, never block)', () => {
  it('warns when a branded line has no pick, and not for an unbranded line or one delivering nothing', () => {
    const b = brands([line(), line({ delivery_item_id: 'L2', brand_list: [] }), line({ delivery_item_id: 'L3' })]);
    expect(brandWarnings(b, {}, { L3: 0 })).toEqual(['No brand picked for Glyphosate 2.5.']);
  });

  it('accepts one pick at or above the delivered amount (the database trims it) and warns below it', () => {
    const b = brands([line({ picks: [pick()] })]);
    expect(brandWarnings(b, {}, { L1: 6 })).toEqual([]);
    expect(brandWarnings(b, { L1: [{ ...draftFromPicks([pick()])[0], quantity: '4' }] }, { L1: 6 })).toHaveLength(1);
  });

  it('warns when a split does not add up to the delivered amount', () => {
    const split = [
      { brandId: 'b1', typedName: '', typedEpa: '', typedManufacturer: '', quantity: '6' },
      { brandId: OTHER_BRAND, typedName: 'Credit', typedEpa: '', typedManufacturer: '', quantity: '3' },
    ];
    expect(brandWarnings(brands([line()]), { L1: split }, { L1: 10 })).toHaveLength(1);
    expect(brandWarnings(brands([line()]), { L1: split }, { L1: 9 })).toEqual([]);
  });
});

describe('picksPayload', () => {
  it('sends a listed brand by id only, a typed brand by its typed fields, and fills a lone blank amount', () => {
    expect(picksPayload('X', [{ brandId: 'b1', typedName: '', typedEpa: '', typedManufacturer: '', quantity: '' }], 10))
      .toEqual([{ brand_id: 'b1', quantity: 10 }]);
    expect(picksPayload('X', [{ brandId: OTHER_BRAND, typedName: ' Credit ', typedEpa: '', typedManufacturer: 'Nufarm', quantity: '2.5' }], 10))
      .toEqual([{ typed_name: 'Credit', typed_manufacturer: 'Nufarm', quantity: 2.5 }]);
  });

  it('refuses a typed brand with no name, an unchosen row, and a zero or over-precise amount', () => {
    const blank = { brandId: OTHER_BRAND, typedName: ' ', typedEpa: '', typedManufacturer: '', quantity: '1' };
    expect(() => picksPayload('X', [blank], 10)).toThrow(/name the brand/);
    expect(() => picksPayload('X', [{ ...blank, brandId: '' }], 10)).toThrow(/pick a brand/);
    expect(() => picksPayload('X', [{ ...blank, brandId: 'b1', quantity: '0' }], 10)).toThrow(/above zero/);
    expect(() => picksPayload('X', [{ ...blank, brandId: 'b1', quantity: '1.00001' }], 10)).toThrow(/above zero/);
  });
});

describe('changedLineIds', () => {
  it('names only lines whose choices differ from the saved picks', () => {
    const b = brands([line({ picks: [pick()] }), line({ delivery_item_id: 'L2' })]);
    expect(changedLineIds(b, { L1: draftFromPicks([pick()]), L2: [] })).toEqual([]);
    expect(changedLineIds(b, { L1: [], L2: [] })).toEqual(['L1']);
  });
});

describe('deliveryBrandErrorMessage', () => {
  it('shows the database sentence after the token', () => {
    expect(deliveryBrandErrorMessage({ message: 'INVOICE_POSTED: void INV-1 and reissue it first' }))
      .toBe('Brands not saved. Void INV-1 and reissue it first');
  });
});

describe('setDeliveryBrands', () => {
  it('retries once on the same key when the order is briefly busy, and not a second time', async () => {
    const busy = { data: null, error: { message: 'ORDER_LIFECYCLE_BUSY_RETRY: order is busy' } };
    const ok = { data: { delivery_id: 'D1', event_seq: 4, picks: [] }, error: null };
    const rpc = vi.spyOn(supabaseUntyped, 'rpc')
      .mockResolvedValueOnce(busy as never).mockResolvedValueOnce(ok as never)
      .mockResolvedValueOnce(busy as never).mockResolvedValueOnce(busy as never);
    await expect(setDeliveryBrands('D1', [], 3, 'k1')).resolves.toMatchObject({ event_seq: 4 });
    await expect(setDeliveryBrands('D1', [], 3, 'k2')).rejects.toMatchObject(busy.error);
    expect(rpc.mock.calls.map((c) => (c[1] as { p_idempotency_key: string }).p_idempotency_key)).toEqual(['k1', 'k1', 'k2', 'k2']);
    rpc.mockRestore();
  });
});
