import type { Product, ProductCategory } from '../types';
import { supabaseUntyped } from './db';
import { EPA_REGISTRATION_PATTERN } from './productBrands';
import { calculateSimilarity } from './productIdentityResolver';

export async function listProductCategories(): Promise<ProductCategory[]> {
  const { data, error } = await supabaseUntyped
    .from('product_categories')
    .select('name, is_active, sort_order')
    .order('sort_order')
    .order('name');
  if (error) throw error;
  return (data ?? []) as ProductCategory[];
}

export function visibleProductCategories(categories: readonly ProductCategory[], current: string | null | undefined): ProductCategory[] {
  return categories.filter((category) => category.is_active || category.name === current);
}

function fieldChanged<T>(current: T, previous: T | undefined, hasSavedProduct: boolean): boolean {
  return !hasSavedProduct || current !== previous;
}

function intervalError(value: string, label: string, previous: number | null | undefined, hasSavedProduct: boolean): string | null {
  if (hasSavedProduct && value === (previous == null ? '' : String(previous))) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed) && Number.isInteger(Number(trimmed)) && Number(trimmed) <= 2147483647) return null;
  return `${label} must be a whole number of zero or greater.`;
}

function keepUnchanged<T>(current: T, previous: T, normalized: T): T {
  return current === previous ? previous : normalized;
}

function keepUnchangedInterval(draft: string, previous: number | null, normalized: number | null | undefined): number | null | undefined {
  return draft === (previous == null ? '' : String(previous)) ? previous : normalized;
}

export function productSetupValidationMessage(
  product: Partial<Product>, reiDraft: string, phiDraft: string, persisted?: Product | null,
): string | null {
  if (fieldChanged(product.product_name, persisted?.product_name, Boolean(persisted)) && !product.product_name?.trim()) return 'Enter a product name.';
  if (fieldChanged(product.rate_per_acre, persisted?.rate_per_acre, Boolean(persisted))
    && product.rate_per_acre != null && (!Number.isFinite(product.rate_per_acre) || product.rate_per_acre < 0)) {
    return 'Rate Per Acre must be zero or greater.';
  }
  const reiError = intervalError(reiDraft, 'REI (hours)', persisted?.rei_hours, Boolean(persisted));
  if (reiError) return reiError;
  const phiError = intervalError(phiDraft, 'PHI (days)', persisted?.phi_days, Boolean(persisted));
  if (phiError) return phiError;
  const epa = product.epa_registration?.trim();
  if (fieldChanged(product.epa_registration, persisted?.epa_registration, Boolean(persisted)) && epa && !EPA_REGISTRATION_PATTERN.test(epa)) {
    return 'Enter an EPA number in a format like 524-475 or 100-1234-5905. This checks format only, not registration validity.';
  }
  return null;
}

export function normalizedProductSetup(
  product: Partial<Product>, reiDraft: string, phiDraft: string, persisted?: Product | null,
): Partial<Product> {
  const normalized: Partial<Product> = {
    ...product,
    product_name: product.product_name?.trim() ?? '',
    category: product.category?.trim() || null,
    sku: product.sku?.trim() || null,
    epa_registration: product.epa_registration?.trim() || null,
    vendor: product.vendor?.trim() || null,
    manufacturer: product.manufacturer?.trim() || null,
    rei_hours: reiDraft.trim() === '' ? null : Number(reiDraft),
    phi_days: phiDraft.trim() === '' ? null : Number(phiDraft),
  };
  if (!persisted) return normalized;
  return {
    ...normalized,
    product_name: keepUnchanged(product.product_name, persisted.product_name, normalized.product_name),
    category: keepUnchanged(product.category, persisted.category, normalized.category),
    sku: keepUnchanged(product.sku, persisted.sku, normalized.sku),
    epa_registration: keepUnchanged(product.epa_registration, persisted.epa_registration, normalized.epa_registration),
    vendor: keepUnchanged(product.vendor, persisted.vendor, normalized.vendor),
    manufacturer: keepUnchanged(product.manufacturer, persisted.manufacturer, normalized.manufacturer),
    rei_hours: keepUnchangedInterval(reiDraft, persisted.rei_hours, normalized.rei_hours),
    phi_days: keepUnchangedInterval(phiDraft, persisted.phi_days, normalized.phi_days),
  };
}

export type ProductSetupFields = Pick<Product,
  'category' | 'product_form' | 'inventory_unit' | 'container_size' | 'container_unit'
  | 'epa_registration' | 'signal_word' | 'rei_hours' | 'phi_days'>;

const PESTICIDE_CATEGORIES = new Set(['Herbicide', 'Fungicide', 'Insecticide']);

// A product with an EPA number, or in a pesticide category, is treated as a registered pesticide.
// Everything else (fertilizer, adjuvant, seed, biological without an EPA number) needs only the base fields.
function isRegisteredPesticide(product: Partial<Pick<Product, 'category' | 'epa_registration'>>): boolean {
  return Boolean(product.epa_registration?.trim()) || PESTICIDE_CATEGORIES.has(product.category?.trim() ?? '');
}

/** Setup fields still blank. A blank REI/PHI is unknown; a saved 0 is a real 0 and counts as set. RUP is a yes/no that always has a value. */
export function missingProductSetup(product: Partial<ProductSetupFields>): string[] {
  const missing: string[] = [];
  if (!product.category?.trim()) missing.push('Category');
  if (!product.product_form) missing.push('Form');
  if (!product.inventory_unit?.trim()) missing.push('Inventory unit');
  if (product.container_size == null || !(product.container_size > 0)) missing.push('Container size');
  if (!product.container_unit?.trim()) missing.push('Container unit');
  if (isRegisteredPesticide(product)) {
    if (!product.epa_registration?.trim()) missing.push('EPA number');
    if (!product.signal_word) missing.push('Signal word');
    if (product.rei_hours == null) missing.push('REI');
    if (product.phi_days == null) missing.push('PHI');
  }
  return missing;
}

/** Existing names a typed vendor or manufacturer is probably a misspelling of; empty when it matches one exactly. */
export function nearMatchNames(value: string | null | undefined, existing: readonly string[]): string[] {
  const typed = value?.trim().toLowerCase();
  if (!typed || typed.length < 3) return [];
  if (existing.some((name) => name.trim() === value?.trim())) return [];
  return existing
    .map((name) => {
      const known = name.trim().toLowerCase();
      // A fragment of a longer name is mid-typing (the dropdown already lists those), not a misspelling.
      if (known !== typed && (known.includes(typed) || typed.includes(known))) return { name, score: 0 };
      return { name, score: calculateSimilarity(typed, known) };
    })
    .filter(({ score }) => score >= 0.75)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, 3)
    .map(({ name }) => name);
}

export type SetupFilter = '' | 'incomplete';

export function isSetupIncomplete(product: Partial<ProductSetupFields>): boolean {
  return missingProductSetup(product).length > 0;
}
