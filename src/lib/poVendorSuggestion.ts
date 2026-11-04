import { listProductVendors } from './productVendors';

export interface CostSuggestion { vendor: string; cents: number }

/** The preferred vendor's newest cost per inventory unit (WP-PM-15b), or null when none is known. */
export async function fetchPreferredVendorCost(productId: string): Promise<CostSuggestion | null> {
  const preferred = (await listProductVendors(productId)).find((v) => v.is_preferred);
  const cents = preferred?.last_cost_cents ?? null;
  if (!preferred || cents === null || !Number.isSafeInteger(cents)) return null;
  return { vendor: preferred.vendor_name, cents };
}

/** A suggested cost belongs to its vendor: a PO for another vendor uses the catalog cost. */
export function costForVendor(suggestion: CostSuggestion, vendor: string, catalogCost: number): number {
  return suggestion.vendor === vendor.trim() ? suggestion.cents / 100 : catalogCost;
}
