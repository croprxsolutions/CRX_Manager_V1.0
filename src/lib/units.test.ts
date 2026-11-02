import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unitOptionsForForm, rateUnitOptionsForProduct, isKnownUnit, blockedUnitSaveMessage, FORM_UNIT_RULES, asProductForm } from './units';
import type { UnitConversion } from '../types';

const CONV = [
  { id: '1', unit: 'oz', factor_oz: 1, unit_type: 'liquid' },
  { id: '2', unit: 'Gal', factor_oz: 128, unit_type: 'liquid' },
  { id: '3', unit: 'Lb', factor_oz: 16, unit_type: 'dry' },
  { id: '4', unit: 'Dry oz', factor_oz: 1, unit_type: 'dry' },
  { id: '5', unit: 'Ea', factor_oz: 1, unit_type: 'both' },
  { id: '6', unit: 'Unit', factor_oz: 1, unit_type: 'both' },
] as unknown as UnitConversion[];

describe('unitOptionsForForm', () => {
  it('returns all units when form is null/undefined', () => {
    expect(unitOptionsForForm(CONV, null).map((u) => u.unit)).toEqual(['oz', 'Gal', 'Lb', 'Dry oz', 'Ea', 'Unit']);
    expect(unitOptionsForForm(CONV, undefined)).toHaveLength(6);
  });
  it('filters to liquid + both for a liquid product', () => {
    expect(unitOptionsForForm(CONV, 'liquid').map((u) => u.unit)).toEqual(['oz', 'Gal', 'Ea', 'Unit']);
  });
  it('filters to dry + both for a dry product', () => {
    expect(unitOptionsForForm(CONV, 'dry').map((u) => u.unit)).toEqual(['Lb', 'Dry oz', 'Ea', 'Unit']);
  });
  it('offers only exact rule units for seed and each', () => {
    expect(unitOptionsForForm(CONV, 'seed').map((u) => u.unit)).toEqual(['Lb', 'Unit']);
    expect(unitOptionsForForm(CONV, 'each').map((u) => u.unit)).toEqual(['Ea', 'Unit']);
    expect(asProductForm(' Each ')).toBe('each');
    expect(asProductForm('grain')).toBeNull();
  });
  it('matches the SQL seed rows exactly', () => {
    const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20261102210000_product_forms_seed_each.sql'), 'utf8');
    const values = migration.match(/FROM \(VALUES ([^\n]+)\) v\(form, unit\)/)?.[1];
    expect(values).toBeDefined();
    const rows = [...(values ?? '').matchAll(/\('([^']+)','([^']+)'\)/g)];
    expect(rows.map((row) => [row[1], row[2]])).toEqual([
      ...FORM_UNIT_RULES.seed.map((unit) => ['seed', unit]),
      ...FORM_UNIT_RULES.each.map((unit) => ['each', unit]),
    ]);
  });
});

describe('rateUnitOptionsForProduct', () => {
  it('offers only the seed stock unit', () => {
    expect(rateUnitOptionsForProduct(CONV, 'seed', 'Lb').map((u) => u.unit)).toEqual(['Lb']);
    expect(rateUnitOptionsForProduct(CONV, 'seed', 'Unit').map((u) => u.unit)).toEqual(['Unit']);
    expect(rateUnitOptionsForProduct(CONV, 'seed', 'lb').map((u) => u.unit)).toEqual(['Lb']);
    expect(rateUnitOptionsForProduct(CONV, 'seed', null)).toEqual([]);
  });
  it('offers only the each stock unit', () => {
    expect(rateUnitOptionsForProduct(CONV, 'each', 'Ea').map((u) => u.unit)).toEqual(['Ea']);
  });
  it('preserves liquid and dry options', () => {
    for (const form of ['liquid', 'dry', null]) {
      expect(rateUnitOptionsForProduct(CONV, form, 'Lb')).toEqual(unitOptionsForForm(CONV, form));
    }
  });
});

describe('isKnownUnit (grandfathering)', () => {
  it('true for a unit present in the filtered list', () => {
    expect(isKnownUnit(CONV, 'liquid', 'Gal')).toBe(true);
    expect(isKnownUnit(CONV, 'dry', 'Lb')).toBe(true);
    expect(isKnownUnit(CONV, 'liquid', 'Ea')).toBe(true); // 'both' always included
  });
  it('false when the value exists but the form filter hides it (must be grandfathered)', () => {
    expect(isKnownUnit(CONV, 'dry', 'Gal')).toBe(false);   // Gal is liquid -> hidden for a dry product
    expect(isKnownUnit(CONV, 'liquid', 'Lb')).toBe(false); // Lb is dry -> hidden for a liquid product
  });
  it('false for a genuinely unknown unit', () => {
    expect(isKnownUnit(CONV, 'liquid', 'furlong')).toBe(false);
  });
  it('true for a blank/undefined unit (nothing to grandfather)', () => {
    expect(isKnownUnit(CONV, 'liquid', '')).toBe(true);
    expect(isKnownUnit(CONV, 'liquid', null)).toBe(true);
  });
});

// An empty conversion list means three different things — in flight, failed, and
// genuinely empty — and only one of them is "refresh the page". Reading the empty
// array as failure told an operator to refresh for a request that was about to
// succeed, so the state is passed in rather than inferred.
describe('blockedUnitSaveMessage', () => {
  it('allows the save whenever every row already carries a unit', () => {
    expect(blockedUnitSaveMessage('failed', [], false)).toBeNull();
    expect(blockedUnitSaveMessage('pending', [], false)).toBeNull();
    expect(blockedUnitSaveMessage('loaded', [], false)).toBeNull();
  });
  it('allows a deliberate blank unit once the list actually loaded', () => {
    expect(blockedUnitSaveMessage('loaded', CONV, true)).toBeNull();
  });
  it('names the in-flight request instead of claiming the load failed', () => {
    expect(blockedUnitSaveMessage('pending', [], true)).toBe(
      'Units are still loading. Try saving again in a moment.',
    );
  });
  it('blocks a blank unit the operator had no way to fill in', () => {
    expect(blockedUnitSaveMessage('failed', [], true)).toBe(
      'Units could not be loaded, so a unit is still blank. Refresh and retry before saving.',
    );
  });
  it('separates a successful empty table from a failed request', () => {
    expect(blockedUnitSaveMessage('loaded', [], true)).toBe(
      'No units are set up yet, so a unit is still blank. Add unit conversions before saving.',
    );
  });
});
