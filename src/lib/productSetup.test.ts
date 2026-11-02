import { describe, expect, it } from 'vitest';
import type { Product } from '../types';
import { hasRpcCode, RpcErrorCodes } from './db';
import { normalizedProductSetup, productSetupValidationMessage, visibleProductCategories } from './productSetup';

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
      product_name: '  Chem  ', sku: '   ', epa_registration: '  ', vendor: '', manufacturer: '  ',
    };
    expect(productSetupValidationMessage(source, '12', '0')).toBeNull();
    expect(normalizedProductSetup(source, '12', '0')).toMatchObject({
      product_name: 'Chem', sku: null, epa_registration: null, vendor: null,
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
