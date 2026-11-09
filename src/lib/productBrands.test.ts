import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockAssertRpcResult } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockAssertRpcResult: vi.fn((data: unknown, name: string) => {
    if (data == null) throw new Error(`${name} returned no data`);
    return data;
  }),
}));

vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db')>('./db');
  return {
    hasRpcCode: actual.hasRpcCode,
    RpcErrorCodes: actual.RpcErrorCodes,
    supabaseUntyped: { rpc: mockRpc },
    assertRpcResult: mockAssertRpcResult,
    supabase: { from: vi.fn() },
  };
});

import {
  EPA_REGISTRATION_PATTERN,
  epaLabelSearchUrl,
  getProductBrands,
  productBrandErrorMessage,
  saveProductBrand,
  suggestBrandNamesFromProductName,
} from './productBrands';

describe('suggestBrandNamesFromProductName', () => {
  it('reads the brand list inside the parentheses', () => {
    expect(suggestBrandNamesFromProductName('Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - 2.5 Gal'))
      .toEqual(['Ag Saver 5.4', 'Slam 5.4']);
    expect(suggestBrandNamesFromProductName('Gen Liberty: Higher Quality (Interline, Inflame) - 2.5 Gal'))
      .toEqual(['Interline', 'Inflame']);
  });

  it('leaves out names already listed, ignoring case, and duplicates', () => {
    expect(suggestBrandNamesFromProductName('Gen Stinger: (Bite, CleanSlate, bite) - 2.5 Gal', ['cleanslate']))
      .toEqual(['Bite']);
  });

  it('suggests nothing for a name without parentheses', () => {
    expect(suggestBrandNamesFromProductName('Callisto - 1 Gal')).toEqual([]);
  });

  it('suggests no notes and does not split a ratio on its slash', () => {
    expect(suggestBrandNamesFromProductName('Gen Mix (50/50) (Alpha, retired, 25%) - 2.5 Gal')).toEqual(['Alpha']);
  });

  it('suggests the brands of a cut-off name without the size it swallowed', () => {
    expect(suggestBrandNamesFromProductName('Gen Cut: (Alpha, Bravo, 2.5G')).toEqual(['Alpha', 'Bravo']);
  });
});

describe('EPA_REGISTRATION_PATTERN', () => {
  it('accepts registration and distributor numbers and refuses anything else', () => {
    expect(EPA_REGISTRATION_PATTERN.test('524-475')).toBe(true);
    expect(EPA_REGISTRATION_PATTERN.test('100-1234-5905')).toBe(true);
    expect(EPA_REGISTRATION_PATTERN.test('524')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('524-475 ')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('EPA 524-475')).toBe(false);
  });

  it('matches the EPA lookup: no zero-led part, at most 6, 5 and 6 digits', () => {
    expect(EPA_REGISTRATION_PATTERN.test('123456-12345-123456')).toBe(true);
    expect(EPA_REGISTRATION_PATTERN.test('0-1')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('524-0475')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('1234567-1')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('524-123456')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('524-475-1234567')).toBe(false);
  });
});

describe('epaLabelSearchUrl', () => {
  const url = 'https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102:::NO::P102_REG_NUM:';

  it('links a two-part registration to its number', () => {
    expect(epaLabelSearchUrl('524-475')).toBe(`${url}524-475`);
  });

  it('links a three-part distributor number to its two-part base', () => {
    expect(epaLabelSearchUrl('524-475-1381')).toBe(`${url}524-475`);
  });

  it('trims surrounding spaces before validating and building the link', () => {
    expect(epaLabelSearchUrl('  100-1070  ')).toBe(`${url}100-1070`);
  });

  it.each(['', '   '])('returns null for blank input %j', (registration) => {
    expect(epaLabelSearchUrl(registration)).toBeNull();
  });

  it.each([null, undefined])('returns null for missing input %s', (registration) => {
    expect(epaLabelSearchUrl(registration)).toBeNull();
  });

  it('returns null for a malformed registration', () => {
    expect(epaLabelSearchUrl('EPA 524-475')).toBeNull();
  });
});

// saveProductBrand first re-reads which list the size uses (get_product_brands), then saves.
const ownList = { data: { source: 'product', parent_id: null, parent_name: null, brands: [] }, error: null };
const parentList = (id: string) => ({ data: { source: 'parent', parent_id: id, parent_name: 'Roundup', brands: [] }, error: null });

describe('saveProductBrand', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockAssertRpcResult.mockClear();
  });

  it('sends a new brand with blanks as NULL and the retry key', async () => {
    mockRpc.mockResolvedValueOnce(ownList).mockResolvedValue({ data: { id: 'b1', brand_name: 'Slam 5.4' }, error: null });
    await saveProductBrand({
      productId: 'p1',
      brandName: '  Slam 5.4 ',
      epaRegistration: ' ',
      manufacturer: '',
      isCurrentlySourced: true,
      isRup: null,
      signalWord: null,
    }, 'key-1');
    expect(mockRpc).toHaveBeenCalledWith('upsert_product_brand', {
      p_product_id: 'p1',
      p_brand_id: null,
      p_expected_row_version: null,
      p_brand_name: 'Slam 5.4',
      p_epa_registration: null,
      p_manufacturer: null,
      p_is_currently_sourced: true,
      p_is_rup: null,
      p_signal_word: null,
      p_idempotency_key: 'key-1',
    });
    expect(mockAssertRpcResult).toHaveBeenCalledWith({ id: 'b1', brand_name: 'Slam 5.4' }, 'upsert_product_brand');
  });

  it('sends an edit with the version it read', async () => {
    mockRpc.mockResolvedValueOnce(ownList).mockResolvedValue({ data: { id: 'b1' }, error: null });
    await saveProductBrand({
      productId: 'p1',
      brandId: 'b1',
      expectedRowVersion: 3,
      brandName: 'Slam 5.4',
      epaRegistration: '524-475',
      manufacturer: 'Bayer',
      isCurrentlySourced: false,
      isRup: false,
      signalWord: 'Caution',
    }, 'key-2');
    expect(mockRpc.mock.calls[1][1]).toMatchObject({
      p_brand_id: 'b1',
      p_expected_row_version: 3,
      p_epa_registration: '524-475',
      p_manufacturer: 'Bayer',
      p_is_currently_sourced: false,
      p_is_rup: false,
      p_signal_word: 'Caution',
    });
  });

  it('throws the database error', async () => {
    mockRpc.mockResolvedValueOnce(ownList).mockResolvedValue({ data: null, error: { message: 'BRAND_NAME_TAKEN: x' } });
    await expect(saveProductBrand({
      productId: 'p1', brandName: 'x', epaRegistration: '', manufacturer: '',
      isCurrentlySourced: true, isRup: null, signalWord: null,
    }, 'k')).rejects.toMatchObject({ message: 'BRAND_NAME_TAKEN: x' });
  });
});

describe('getProductBrands (PAR-2)', () => {
  beforeEach(() => mockRpc.mockReset());

  it('returns the parent list of a grouped size, shown on this size', async () => {
    mockRpc.mockResolvedValue({ data: { source: 'parent', parent_id: 'par1', parent_name: 'Roundup', brands: [{ id: 'pb1', parent_id: 'par1', brand_name: 'Slam' }] }, error: null });
    const list = await getProductBrands('p1');
    expect(mockRpc).toHaveBeenCalledWith('get_product_brands', { p_product_id: 'p1' });
    expect(list).toMatchObject({ parentId: 'par1', parentName: 'Roundup', brands: [{ id: 'pb1', product_id: 'p1', brand_name: 'Slam' }] });
  });

  it('returns the own list of an ungrouped size with no parent', async () => {
    mockRpc.mockResolvedValue({ data: { source: 'product', parent_id: null, parent_name: null, brands: [{ id: 'b1', product_id: 'p1', brand_name: 'Slam' }] }, error: null });
    expect(await getProductBrands('p1')).toMatchObject({ parentId: null, parentName: null, brands: [{ id: 'b1' }] });
  });
});

describe('saveProductBrand on a parent', () => {
  beforeEach(() => mockRpc.mockReset());

  it('saves the brand of a grouped size through upsert_parent_brand', async () => {
    mockRpc.mockResolvedValueOnce(parentList('par1')).mockResolvedValue({ data: { id: 'pb1', parent_id: 'par1', brand_name: 'Slam' }, error: null });
    const saved = await saveProductBrand({
      productId: 'p1', parentId: 'par1', brandName: 'Slam', epaRegistration: '', manufacturer: '',
      isCurrentlySourced: true, isRup: null, signalWord: null,
    }, 'k');
    // p_product_id lets the database refuse a size that moved off par1 after the re-read above.
    expect(mockRpc).toHaveBeenCalledWith('upsert_parent_brand', expect.objectContaining({
      p_parent_id: 'par1', p_product_id: 'p1', p_brand_name: 'Slam', p_idempotency_key: 'k',
    }));
    expect(saved).toMatchObject({ id: 'pb1', product_id: 'p1' });
  });

  it('refuses, saving nothing, when the size moved to another parent since its list loaded', async () => {
    mockRpc.mockResolvedValueOnce(parentList('par2'));
    await expect(saveProductBrand({
      productId: 'p1', parentId: 'par1', brandName: 'Slam', epaRegistration: '', manufacturer: '',
      isCurrentlySourced: true, isRup: null, signalWord: null,
    }, 'k')).rejects.toThrow(/^PRODUCT_BRANDS_PARENT_CHANGED/);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('refuses, saving nothing, when an ungrouped size joined a parent since its list loaded', async () => {
    mockRpc.mockResolvedValueOnce(parentList('par1'));
    await expect(saveProductBrand({
      productId: 'p1', brandName: 'Slam', epaRegistration: '', manufacturer: '',
      isCurrentlySourced: true, isRup: null, signalWord: null,
    }, 'k')).rejects.toThrow(/^PRODUCT_BRANDS_PARENT_CHANGED/);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('productBrandErrorMessage', () => {
  it('turns the database refusals into plain English', () => {
    expect(productBrandErrorMessage({ message: 'BRAND_NAME_TAKEN: this product already lists a brand named Slam' }))
      .toBe('This product already lists a brand with that name.');
    expect(productBrandErrorMessage({ message: 'BRAND_CHANGED: someone else changed this brand' }))
      .toBe('Someone else changed this brand. The list has been reloaded; open it again to edit.');
    expect(productBrandErrorMessage({ message: 'BRAND_NAME_TAKENX: not our token' }))
      .not.toBe('This product already lists a brand with that name.');
    expect(productBrandErrorMessage({ message: 'NOT_AUTHORIZED: only an admin' }))
      .toBe('Only an admin can change a product’s brands.');
    expect(productBrandErrorMessage(new Error('PRODUCT_BRANDS_PARENT_CHANGED: moved')))
      .toMatch(/moved to a different parent since the page loaded, so nothing was saved/);
    expect(productBrandErrorMessage({ message: 'PRODUCT_PARENT_GROUPING_NOT_OPEN: grouping opens later' }))
      .toBe('Shared parent brands can be changed once grouping is switched on. Nothing was saved.');
  });
});
