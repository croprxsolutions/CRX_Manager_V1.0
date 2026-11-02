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

export function productSetupValidationMessage(
  product: Partial<Product>, reiDraft: string, phiDraft: string,
): string | null {
  if (!product.product_name?.trim()) return 'Enter a product name.';
  if (product.rate_per_acre != null && (!Number.isFinite(product.rate_per_acre) || product.rate_per_acre < 0)) {
    return 'Rate Per Acre must be zero or greater.';
  }
  for (const [value, label] of [[reiDraft, 'REI (hours)'], [phiDraft, 'PHI (days)']] as const) {
    if (value.trim() !== '' && (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)))) {
      return `${label} must be a whole number of zero or greater.`;
    }
  }
  const epa = product.epa_registration?.trim();
  if (epa && !EPA_REGISTRATION_PATTERN.test(epa)) {
    return 'Enter an EPA number in a format like 524-475 or 100-1234-5905. This checks format only, not registration validity.';
  }
  return null;
}

export function normalizedProductSetup(product: Partial<Product>, reiDraft: string, phiDraft: string): Partial<Product> {
  return {
    ...product,
    product_name: product.product_name?.trim() ?? '',
    sku: product.sku?.trim() || null,
    epa_registration: product.epa_registration?.trim() || null,
    vendor: product.vendor?.trim() || null,
    manufacturer: product.manufacturer?.trim() || null,
    rei_hours: reiDraft.trim() === '' ? null : Number(reiDraft),
    phi_days: phiDraft.trim() === '' ? null : Number(phiDraft),
  };
}
