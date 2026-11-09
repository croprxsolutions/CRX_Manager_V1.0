import type { MobileProduct } from '../types';
import type { ParentSearchIndex } from './productParents';

// Keep phone and desktop search on the same Product identity fields and matching rule.
// A size also matches its parent's name and nickname (PAR-1).
export function matchesProductSearch(product: MobileProduct, search: string, parents?: ParentSearchIndex): boolean {
  const lowerSearch = search.toLowerCase();
  const parent = parents?.get(product.id);
  return [
    product.product_name,
    product.sku,
    product.category,
    product.vendor,
    product.manufacturer,
    product.epa_registration,
    parent?.name,
    parent?.nickname,
  ].some((value) => value != null && String(value).toLowerCase().includes(lowerSearch));
}

/** The typed text back from `ilikeOrPattern`'s quoted LIKE pattern (undo the quote escape, then the LIKE escape). */
export function textFromIlikePattern(pattern: string): string {
  return pattern.slice(2, -2).replace(/\\(.)/g, '$1').replace(/\\(.)/g, '$1');
}
