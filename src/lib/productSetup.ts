import type { Product, ProductCategory } from '../types';
import { supabaseUntyped } from './db';
import { EPA_REGISTRATION_PATTERN } from './productBrands';

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
    sku: keepUnchanged(product.sku, persisted.sku, normalized.sku),
    epa_registration: keepUnchanged(product.epa_registration, persisted.epa_registration, normalized.epa_registration),
    vendor: keepUnchanged(product.vendor, persisted.vendor, normalized.vendor),
    manufacturer: keepUnchanged(product.manufacturer, persisted.manufacturer, normalized.manufacturer),
    rei_hours: keepUnchangedInterval(reiDraft, persisted.rei_hours, normalized.rei_hours),
    phi_days: keepUnchangedInterval(phiDraft, persisted.phi_days, normalized.phi_days),
  };
}
