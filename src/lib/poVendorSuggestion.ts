import { listProductVendors } from './productVendors';
import { Sentry } from './sentry';

export interface CostSuggestion { vendor: string; cents: number }

/** The preferred vendor's newest cost per inventory unit (WP-PM-15b); null when none is known or the read failed (reported). */
export async function fetchPreferredVendorCost(productId: string): Promise<CostSuggestion | null> {
  try {
    const preferred = (await listProductVendors(productId)).find((v) => v.is_preferred);
    const cents = preferred?.last_cost_cents ?? null;
    return preferred && cents !== null && Number.isSafeInteger(cents) ? { vendor: preferred.vendor_name, cents } : null;
  } catch (err) {
    Sentry.captureException(err);
    return null;
  }
}

/** A suggested cost belongs to its vendor: a PO for another vendor uses the catalog cost. */
export function costForVendor(suggestion: CostSuggestion, vendor: string, catalogCost: number): number {
  return suggestion.vendor === vendor.trim() ? suggestion.cents / 100 : catalogCost;
}
