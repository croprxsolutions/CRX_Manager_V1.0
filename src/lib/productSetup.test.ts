import { describe, expect, it } from 'vitest';
import type { Product } from '../types';
import { hasRpcCode, RpcErrorCodes } from './db';
import {
  matchReadIntervals,
  epaCoveredProductIds, isSetupIncomplete, missingProductSetup, nearMatchNames, normalizedProductSetup, productSetupValidationMessage, visibleProductCategories,
} from './productSetup';

describe('product setup validation and options', () => {
  const valid = { product_name: 'Chem', epa_registration: '524-475', rate_per_acre: 0 } satisfies Partial<Product>;

  it.each([
    [{ product_name: '   ' }, '', '', 'Enter a product name.'],
    [{ rate_per_acre: -0.1 }, '', '', 'Rate Per Acre must be zero or greater.'],
    [{ epa_registration: '00-123' }, '', '', 'Enter an EPA number in a format'],
    [{}, '12.5', '', 'REI (hours) must be a whole number'],
    [{}, '', '12.5', 'PHI (days) must be a whole number'],
    [{}, '2147483648', '', 'REI (hours) must be a whole number'],
    [{}, '', '2147483648', 'PHI (days) must be a whole number'],
  ] as Array<[Partial<Product>, string, string, string]>)('rejects invalid setup before a request', (change, rei, phi, message) => {
    expect(productSetupValidationMessage({ ...valid, ...change }, rei, phi)).toContain(message);
  });

  it('trims text, saves empty optional text as NULL, and keeps whole intervals', () => {
    const source: Partial<Product> = {
      product_name: '  Chem  ', category: ' ', sku: '   ', epa_registration: '  ', vendor: '', manufacturer: '  ',
    };
    expect(productSetupValidationMessage(source, '12', '0')).toBeNull();
    expect(normalizedProductSetup(source, '12', '0')).toMatchObject({
      product_name: 'Chem', category: null, sku: null, epa_registration: null, vendor: null,
      manufacturer: null, rei_hours: 12, phi_days: 0,
    });
  });

  it('leaves unchanged legacy bad fields intact during an unrelated edit', () => {
    const legacy = {
      product_name: '  Legacy  ', sku: '', epa_registration: 'bad', rei_hours: -1, phi_days: -1,
      rate_per_acre: -1, notes: 'old',
    } as Product;
    const editing = { ...legacy, notes: 'new' };
    expect(productSetupValidationMessage(editing, '-1', '-1', legacy)).toBeNull();
    expect(normalizedProductSetup(editing, '-1', '-1', legacy)).toMatchObject({
      product_name: '  Legacy  ', sku: '', epa_registration: 'bad', rei_hours: -1, phi_days: -1,
    });
    expect(productSetupValidationMessage({ ...editing, product_name: '  ' }, '-1', '-1', legacy))
      .toBe('Enter a product name.');
    expect(productSetupValidationMessage({ ...editing, epa_registration: 'still-bad' }, '-1', '-1', legacy))
      .toContain('EPA number');
  });

  it('shows an existing retired category only for its own product', () => {
    const categories = [
      { name: 'Seed', is_active: true, sort_order: 1 },
      { name: 'Old', is_active: false, sort_order: 2 },
    ];
    expect(visibleProductCategories(categories, null).map((item) => item.name)).toEqual(['Seed']);
    expect(visibleProductCategories(categories, 'Old').map((item) => item.name)).toEqual(['Seed', 'Old']);
  });

  it('matches the retired-category database token at the start of a refusal', () => {
    expect(hasRpcCode(new Error('PRODUCT_CATEGORY_RETIRED: choose an active category'), RpcErrorCodes.PRODUCT_CATEGORY_RETIRED)).toBe(true);
    expect(hasRpcCode(new Error('note PRODUCT_CATEGORY_RETIRED'), RpcErrorCodes.PRODUCT_CATEGORY_RETIRED)).toBe(false);
  });
});

describe('complete setup and near-match warnings', () => {
  const base = {
    category: 'Liquid Fertilizer', product_form: 'liquid', inventory_unit: 'Gal', container_size: 2.5, container_unit: 'Gal',
    epa_registration: null, signal_word: null, rei_hours: null, phi_days: null,
  } satisfies Partial<Product>;
  const pesticide = { ...base, category: 'Herbicide', epa_registration: '524-475', signal_word: 'Caution', rei_hours: 0, phi_days: 0 } satisfies Partial<Product>;

  it('needs only the base fields for a non-pesticide', () => {
    expect(missingProductSetup(base)).toEqual([]);
    expect(missingProductSetup({ ...base, category: ' ', product_form: null, inventory_unit: null, container_size: 0, container_unit: '' }))
      .toEqual(['Category', 'Form', 'Inventory unit', 'Container size', 'Container unit']);
  });

  it('treats a saved 0 REI/PHI as set and a blank as unknown', () => {
    expect(missingProductSetup(pesticide)).toEqual([]);
    expect(missingProductSetup({ ...pesticide, rei_hours: null, phi_days: null })).toEqual(['REI', 'PHI']);
  });

  it('counts a blank REI/PHI marked not applicable as set, each field on its own', () => {
    const blank = { ...pesticide, rei_hours: null, phi_days: null };
    expect(missingProductSetup({ ...blank, rei_not_applicable: true })).toEqual(['PHI']);
    expect(missingProductSetup({ ...blank, phi_not_applicable: true })).toEqual(['REI']);
    expect(missingProductSetup({ ...blank, rei_not_applicable: true, phi_not_applicable: true })).toEqual([]);
    expect(missingProductSetup({ ...blank, rei_not_applicable: false, phi_not_applicable: false })).toEqual(['REI', 'PHI']);
    expect(isSetupIncomplete({ ...blank, rei_not_applicable: true, phi_not_applicable: true })).toBe(false);
  });

  it('classes a pesticide by category or by an EPA number', () => {
    expect(missingProductSetup({ ...base, category: 'Fungicide' })).toEqual(['EPA number', 'Signal word', 'REI', 'PHI']);
    expect(missingProductSetup({ ...base, category: 'Adjuvant', epa_registration: '100-1234' })).toEqual(['Signal word', 'REI', 'PHI']);
    expect(missingProductSetup({ ...base, category: 'Adjuvant' })).toEqual([]);
  });

  it('counts a generic as having an EPA number when its group carries one', () => {
    const generic = { ...pesticide, id: 'gen', epa_registration: null };
    expect(missingProductSetup(generic, true)).toEqual([]);
    expect(isSetupIncomplete(generic)).toBe(true);
    expect(isSetupIncomplete(generic, new Set(['gen']))).toBe(false);
    // Other label fields still count.
    expect(missingProductSetup({ ...base, category: 'Adjuvant' }, true)).toEqual(['Signal word', 'REI', 'PHI']);
    expect(isSetupIncomplete({ ...generic, signal_word: null }, new Set(['gen']))).toBe(true);

    const size = (id: string) => ({ product_id: id });
    const parents = [
      { id: 'p-brand', generic_epa_registration: null, sizes: [size('a1'), size('a2')] },
      { id: 'p-generic', generic_epa_registration: '524-475', sizes: [size('b1')] },
      { id: 'p-sibling', generic_epa_registration: null, sizes: [size('c1'), size('c2')] },
      { id: 'p-legacy', generic_epa_registration: null, sizes: [size('d1'), size('d2')] },
      { id: 'p-none', generic_epa_registration: ' ', sizes: [size('e1')] },
    ];
    const products = [{ id: 'c2', epa_registration: '100-1' }, { id: 'e1', epa_registration: null }];
    expect([...epaCoveredProductIds(parents, products, new Set(['p-brand']), new Set(['d2', 'solo']))].sort())
      .toEqual(['a1', 'a2', 'b1', 'c1', 'c2', 'd1', 'd2', 'solo']);
  });

  it('suggests close spellings of an existing name and stays quiet on an exact one', () => {
    const makers = ['Syngenta', 'Bayer', 'Corteva'];
    expect(nearMatchNames('Syngnta', makers)).toEqual(['Syngenta']);
    expect(nearMatchNames('syngenta', makers)).toEqual(['Syngenta']);
    expect(nearMatchNames('Syngenta', makers)).toEqual([]);
    expect(nearMatchNames('Helena', makers)).toEqual([]);
    expect(nearMatchNames('', makers)).toEqual([]);
    expect(nearMatchNames('Syn', makers)).toEqual([]);
    expect(nearMatchNames('Bayer Crop', makers)).toEqual([]);
  });
});

describe('matchReadIntervals', () => {
  const recorder = () => {
    const calls: string[] = [];
    const q = {
      is(column: string, value: null) { calls.push(`${column} is ${value}`); return q; },
      eq(column: string, value: unknown) { calls.push(`${column} = ${String(value)}`); return q; },
    };
    return { q, calls };
  };
  const read = { rei_hours: null, rei_not_applicable: false, phi_days: 30, epa_registration: '100-1234' } as Product;

  it('adds no filter when neither interval nor flag is saved', () => {
    const { q, calls } = recorder();
    matchReadIntervals(q, { product_name: 'x' }, read);
    expect(calls).toEqual([]);
  });

  it('saves a tick only over the blank interval, flag and EPA number the page read', () => {
    const { q, calls } = recorder();
    matchReadIntervals(q, { rei_not_applicable: true, rei_hours: null }, read);
    expect(calls).toEqual(['rei_hours is null', 'rei_not_applicable = false', 'epa_registration = 100-1234']);
  });

  it('guards a changed PHI number on the number and EPA number read', () => {
    const { q, calls } = recorder();
    matchReadIntervals(q, { phi_days: 14 }, read);
    expect(calls).toEqual(['phi_days = 30', 'phi_not_applicable = false', 'epa_registration = 100-1234']);
  });

  it('guards a flag-only save (number unchanged, so not sent) the same way', () => {
    const { q, calls } = recorder();
    matchReadIntervals(q, { phi_not_applicable: false }, { ...read, phi_days: null, phi_not_applicable: true });
    expect(calls).toEqual(['phi_days is null', 'phi_not_applicable = true', 'epa_registration = 100-1234']);
  });
});
