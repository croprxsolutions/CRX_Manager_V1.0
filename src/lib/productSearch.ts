import type { MobileProduct } from '../types';

// Keep phone and desktop search on the same Product identity fields and matching rule.
export function matchesProductSearch(product: MobileProduct, search: string): boolean {
  const lowerSearch = search.toLowerCase();
  return [
    product.product_name,
    product.sku,
    product.category,
    product.vendor,
    product.manufacturer,
    product.epa_registration,
  ].some((value) => value != null && String(value).toLowerCase().includes(lowerSearch));
}
