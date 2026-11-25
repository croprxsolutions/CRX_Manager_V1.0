import { formatPricingMarginPercent, type PricingEffect, type PricingPreviewRow } from './productPricing';

export interface NearCostTier {
  tier: 1 | 2 | 3;
  price_cents: bigint;
  cost_cents: bigint;
  /** Set when the tier's margin is above 0% and under 1%: likely 0.35 typed for 35% (Mason Q2: warn, not block). */
  fraction_margin_percent: string | null;
}

export interface NearCostProduct {
  product_id: string;
  product_name: string;
  tiers: NearCostTier[];
}

function toCents(value: bigint | number | null | undefined): bigint | null {
  // BigInt() so a plain-number cents value (as in some test previews) never throws on mixed types.
  return value == null ? null : BigInt(value);
}

/** The tiers of one ready row priced within 2% of cost or at a margin under 1%. */
function nearCostTiers(effect: PricingEffect, cost: bigint): NearCostTier[] {
  const tiers: NearCostTier[] = [];
  for (const tier of [1, 2, 3] as const) {
    const price = toCents(effect[`tier${tier}_price_cents`]);
    if (price === null) continue;
    const margin = effect[`tier${tier}_margin`];
    const fraction = margin != null && margin > 0 && margin < 0.01;
    if (!fraction && !(price >= cost && price * 100n <= cost * 102n)) continue;
    tiers.push({
      tier, price_cents: price, cost_cents: cost,
      fraction_margin_percent: fraction ? (effect[`tier${tier}_margin_percent`] ?? formatPricingMarginPercent(margin)) : null,
    });
  }
  return tiers;
}

/**
 * Audit 2026-11-24 #3: every ready row whose new tier price is at or above its new cost but within
 * 2% of it (2% included), e.g. $6.42 on a $6.40 cost. Read from the preview's own after-values, so it
 * covers margin-driven, price-driven and cost-only changes alike. Below cost is the database's
 * PRICE_BELOW_COST warning, not this.
 */
export function nearCostProducts(rows: readonly PricingPreviewRow[]): NearCostProduct[] {
  const found = new Map<string, NearCostProduct>();
  for (const row of rows) {
    const effect = row.effect;
    if (row.row_status !== 'ready' || !effect || !row.product_id || effect.pricing_changed === false) continue;
    const cost = toCents(effect.cost_cents);
    const tiers = cost !== null && cost > 0n ? nearCostTiers(effect, cost) : [];
    if (tiers.length === 0) continue;
    // One entry (and one tick) per product, even if a sheet lists it twice.
    const existing = found.get(row.product_id);
    if (existing) { existing.tiers.push(...tiers); continue; }
    const name = effect.product_name ?? row.submitted_row.product_name;
    found.set(row.product_id, {
      product_id: row.product_id,
      product_name: typeof name === 'string' && name.trim() ? name : row.product_id,
      tiers,
    });
  }
  return [...found.values()];
}
