/**
 * Pure math functions extracted from QuoteBuilder for testability.
 * These are the core pricing / unit-conversion calculations.
 *
 * NOT AUTHORITATIVE FOR PERSISTENCE. The server recalculates and persists all
 * quote line math in save_quote() (migration 20260528042000) — that is the
 * single source of truth for stored prices. These functions exist only for
 * unit-test coverage of the pricing rules and as a reference for live-preview
 * display math. They are NOT imported by QuoteBuilder's save payload, and new
 * code must NOT route persisted values through them — read the server-returned
 * values after save instead. (Foundation audit P2-E, 2026-05-28.)
 * One exception: QuoteBuilder compares a typed price with getQuoteTierPrice to decide
 * whether it is a price_override, which save_quote stores.
 */
import type { Product, UnitConversion } from '../types';
import { parseDollarsToCents } from './parseCents';

export type CalcMode = 'rate_acres' | 'units_direct';

export interface CalcItem {
  product_id: string;
  product?: Product;
  actual_rate: number | null;
  rate_unit: string | null;
  acres: number | null;
  price_per_unit: number;
  current_cost: number;
  oz_per_acre: number | null;
  price_per_acre: number | null;
  total_units_needed: number | null;
  total_price: number;
  profit: number;
  net_margin: number;
  suggested_rate: string | null;
  unit_size: string | null;
  notes: string | null;
  sort_order: number;
  calc_mode?: CalcMode;
}

/** Get tier price from product — pure function.
 * Falls back to tier1_price when tier2/3 is missing OR $0. Used by invoices; quotes use
 * getQuoteTierPrice, which keeps a stated $0. */
export function getTierPrice(product: Product, tierNum: number): number {
  const t1 = product.tier1_price || 0;
  if (tierNum === 1) return t1;
  if (tierNum === 2) return product.tier2_price || t1;
  return product.tier3_price || t1;
}

/** The quote price for a tier, keeping a stated $0: only a missing (null) tier-2/3 price falls
 * back to tier 1, matching save_quote's COALESCE and job pricing (Mason, 2026-10-23). */
export function getQuoteTierPrice(product: Product, tierNum: number): number {
  const own = tierNum === 1 ? product.tier1_price : tierNum === 2 ? product.tier2_price : product.tier3_price;
  return own ?? product.tier1_price ?? 0;
}

/** The product's price for a tier in integer cents, keeping a stated $0: only a missing (null)
 * tier-2/3 price falls back to tier 1. Null when the product states neither (or states a price
 * the whole-cent parser refuses). Used by job pricing. */
export function getStatedTierPriceCents(product: Product, tierNum: 1 | 2 | 3): number | null {
  const own = tierNum === 3 ? product.tier3_price : tierNum === 2 ? product.tier2_price : product.tier1_price;
  const dollars = own ?? product.tier1_price ?? null;
  return dollars == null ? null : parseDollarsToCents(String(dollars));
}

/** True when the product states no price for the tier (nor tier 1). The database refuses a $0
 * sale line for such a product (QUOTE/ORDER/INVOICE_PRICE_MISSING); a stated $0 is a price. */
export function isTierPriceMissing(
  product: Pick<Product, 'tier1_price' | 'tier2_price' | 'tier3_price'>,
  tierNum: number,
): boolean {
  const own = tierNum === 1 ? product.tier1_price : tierNum === 2 ? product.tier2_price : product.tier3_price;
  return (own ?? product.tier1_price) == null;
}

/** Look up unit→oz conversion factor — pure function */
export function getConversionFactor(
  unit: string | null,
  conversions: UnitConversion[]
): number {
  if (!unit) return 1;
  const conv = conversions.find(
    (c) => c.unit.toLowerCase() === unit.toLowerCase()
  );
  return conv ? conv.factor_oz : 1;
}

/** Seed and each have no conversions, so their stock unit never falls back to unit_size. */
function stockUnitOf(product: Product): string | null {
  return product.product_form === 'seed' || product.product_form === 'each'
    ? product.inventory_unit
    : product.inventory_unit || product.unit_size;
}

/** A blank seed/each rate unit means the stock unit, never the 1-oz default. */
function rateUnitOf(rateUnit: string | null | undefined, product: Product): string | null {
  return (product.product_form === 'seed' || product.product_form === 'each') && !rateUnit?.trim()
    ? product.inventory_unit
    : rateUnit ?? null;
}

/** Core pricing recalculation — pure function (no React deps) */
// Exact a × b rounded to the cent, half away from zero, like PostgreSQL's ROUND(numeric, 2).
// Binary floats cannot do this: 1.005 × 1 rounds to 1.00 in floats and to 1.01 in the database.
function exactDollars(a: number, b: number): number {
  const parts = [a, b].map((n) => /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(n)));
  if (parts.some((m) => !m)) return Math.round(a * b * 100) / 100; // exponent form: tiny or huge, float is the best we have
  const [ma, mb] = parts as RegExpExecArray[];
  const scale = (ma[3] ?? '').length + (mb[3] ?? '').length;
  const product = BigInt(ma[2] + (ma[3] ?? '')) * BigInt(mb[2] + (mb[3] ?? '')) * 100n;
  const denominator = 10n ** BigInt(scale);
  const cents = product / denominator + (2n * (product % denominator) >= denominator ? 1n : 0n);
  return ((ma[1] === '-') !== (mb[1] === '-') ? -1 : 1) * Number(cents) / 100;
}

// A float rounded to 0.01 the way PostgreSQL rounds the exact numeric: 0.145 × 100 is
// 14.499999999999998 in floats (Math.round gives 0.14) but 0.145 rounds to 0.15 in the database.
// Twelve significant digits drop the float noise before the exact half-away-from-zero rounding.
function roundDecimal2(n: number): number {
  return exactDollars(Number(n.toPrecision(12)), 1);
}

/**
 * A quote line's quantity and money, figured as save_quote figures them (S09): the quantity is
 * settled to 0.01 first, then price × quantity and cost × quantity are each rounded to the cent.
 * Figuring the total from the unsettled quantity showed $513.32 on screen and on the PDF for a
 * line the database stores and bills at $513.36 (3.68 gal × $139.50).
 */
export function billedLine(pricePerUnit: number, cost: number, rawUnits: number) {
  const units = roundDecimal2(rawUnits);
  const totalPrice = exactDollars(pricePerUnit, units);
  const profit = Math.round((totalPrice - exactDollars(cost, units)) * 100) / 100;
  const netMargin = totalPrice > 0 ? roundDecimal2((profit / totalPrice) * 100) : 0;
  return { units, totalPrice, profit, netMargin };
}

export function recalcItem(
  item: CalcItem,
  product: Product,
  tierNum: number,
  conversions: UnitConversion[]
): CalcItem {
  const pricePerUnit = getQuoteTierPrice(product, tierNum);
  const mode = item.calc_mode || 'rate_acres';
  // Stock unit: inventory_unit, falling back to unit_size for liquid/dry only
  const inventoryUnitFactorOz = getConversionFactor(stockUnitOf(product), conversions);

  if (mode === 'units_direct') {
    // User entered total_units_needed directly — skip rate×acres computation
    const billed = billedLine(pricePerUnit, product.current_cost || 0, item.total_units_needed || 0);
    const totalInventoryUnits = billed.units;
    const totalPrice = billed.totalPrice;

    // Back-calculate rate if acres is also set (informational)
    const acres = item.acres || 0;
    let ozPerAcre: number | null = item.oz_per_acre;
    let pricePerAcre: number | null = item.price_per_acre;
    if (acres > 0 && inventoryUnitFactorOz > 0) {
      const totalOz = totalInventoryUnits * inventoryUnitFactorOz;
      ozPerAcre = Math.round((totalOz / acres) * 100) / 100;
      pricePerAcre = Math.round((totalPrice / acres) * 100) / 100;
    }

    return {
      ...item,
      price_per_unit: pricePerUnit,
      current_cost: product.current_cost || 0,
      oz_per_acre: ozPerAcre,
      price_per_acre: pricePerAcre,
      total_units_needed: billed.units,
      total_price: billed.totalPrice,
      profit: billed.profit,
      net_margin: billed.netMargin,
    };
  }

  // Default: rate_acres mode — compute units from rate × acres
  const actualRate = item.actual_rate || 0;
  const acres = item.acres || 0;

  const rateUnitFactorOz = getConversionFactor(rateUnitOf(item.rate_unit, product), conversions);
  const rateInOz = actualRate * rateUnitFactorOz;
  const ozPerAcre = rateInOz;

  const totalInventoryUnits =
    inventoryUnitFactorOz > 0 ? (acres * rateInOz) / inventoryUnitFactorOz : 0;

  const pricePerAcre =
    inventoryUnitFactorOz > 0
      ? pricePerUnit * (rateInOz / inventoryUnitFactorOz)
      : 0;
  const billed = billedLine(pricePerUnit, product.current_cost || 0, totalInventoryUnits);

  return {
    ...item,
    price_per_unit: pricePerUnit,
    current_cost: product.current_cost || 0,
    oz_per_acre: Math.round(ozPerAcre * 100) / 100,
    price_per_acre: Math.round(pricePerAcre * 100) / 100,
    total_units_needed: billed.units,
    total_price: billed.totalPrice,
    profit: billed.profit,
    net_margin: billed.netMargin, // stored as percentage
  };
}

/**
 * A product's CATALOG price PER ACRE at a tier — the cost/acre if applied at its
 * OWN standard rate_per_acre. Computed the SAME way recalcItem prices a line's
 * per-acre (tierPrice × rateInOz / inventoryUnitFactorOz), so the value shown in
 * the product picker equals the line's $/acre once the product is added at its
 * default rate. Reference-only, for comparing products by cost-per-acre (P2-5).
 *
 * Deliberately recomputes rather than reading products.tierN_price_per_acre.
 * Those stored columns are now maintained CORRECTLY (unit-fixed 2026-07-03,
 * migration 20260702190000 — same formula as here), but we recompute live so the
 * picker always reflects the VIEWING customer's tier and can never lag a save.
 * (Before that fix they used a unit-inconsistent formula — rate in oz over
 * container_size in gal — and were wildly wrong: ~43% over $500/acre, up to $16k.)
 *
 * Returns null when the product has no positive rate_per_acre, or the inventory
 * unit doesn't convert (factor 0) — never a fabricated number.
 */
export function catalogPricePerAcre(
  product: Product,
  tierNum: number,
  conversions: UnitConversion[]
): number | null {
  const rate = product.rate_per_acre;
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  const inventoryUnitFactorOz = getConversionFactor(stockUnitOf(product), conversions);
  if (!(inventoryUnitFactorOz > 0)) return null;
  const rateInOz = rate * getConversionFactor(rateUnitOf(product.rate_unit, product), conversions);
  const perAcre = getQuoteTierPrice(product, tierNum) * (rateInOz / inventoryUnitFactorOz);
  return Math.round(perAcre * 100) / 100;
}

/** Compute quote-level totals from items */
export function computeQuoteTotals(items: CalcItem[]): {
  totalPrice: number;
  totalCost: number;
  totalProfit: number;
  totalMarginPct: number;
} {
  let totalPrice = 0;
  let totalCost = 0;
  for (const item of items) {
    totalPrice += (item.total_price || 0);
    totalCost += (item.current_cost || 0) * (item.total_units_needed || 0);
  }
  const totalProfit = totalPrice - totalCost;
  const totalMarginPct = totalPrice > 0 ? (totalProfit / totalPrice) * 100 : 0;
  return {
    totalPrice: Math.round(totalPrice * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    totalProfit: Math.round(totalProfit * 100) / 100,
    totalMarginPct: Math.round(totalMarginPct * 100) / 100,
  };
}

/** Mirror the database commission-split contract for immediate UI feedback. */
export function validateCommissionSplits(
  splits: Array<{ recipient: string; recipient_user_id?: string | null; percentage: number }>
): string | null {
  if (splits.length === 0) return null;

  const seenRecipients = new Set<string>();
  let sum = 0;
  for (const split of splits) {
    const recipient = split.recipient.trim();
    if (!recipient) return 'Every commission split needs a recipient';

    const recipientKey = recipient.toLowerCase();
    if (seenRecipients.has(recipientKey)) {
      return `Commission recipient "${recipient}" is listed more than once`;
    }
    seenRecipients.add(recipientKey);

    if (!Number.isFinite(split.percentage) || split.percentage <= 0 || split.percentage > 100) {
      return `Commission percentage for "${recipient}" must be greater than 0 and no more than 100`;
    }
    sum += split.percentage;
  }

  if (Math.abs(sum - 100) > 0.01) {
    return `Commission splits sum to ${sum.toFixed(2)}%, expected 100%`;
  }
  return null;
}

/**
 * Convert total applied quantity to gallons (liquid) or pounds (dry).
 * Liquid: OZ→GL (/128), PT→GL (/8), QT→GL (/4), GL stays.
 * Dry:    OZ→LB (/16), LB stays.
 * Seed/each: no weight or volume equivalent.
 */
export function convertToGlLb(
  totalApplied: number,
  unit: string | null | undefined,
  productForm: 'liquid' | 'dry' | string,
): { value: number; unit: string } | null {
  if (productForm === 'seed' || productForm === 'each') return null;
  const u = (unit || 'OZ').toUpperCase();

  if (productForm === 'dry') {
    if (u === 'OZ') return { value: totalApplied / 16, unit: 'LB' };
    if (u === 'LB') return { value: totalApplied, unit: 'LB' };
    // Unknown dry unit — assume already in LB
    return { value: totalApplied, unit: 'LB' };
  }
  // Liquid
  if (u === 'OZ') return { value: totalApplied / 128, unit: 'GL' };
  if (u === 'PT') return { value: totalApplied / 8, unit: 'GL' };
  if (u === 'QT') return { value: totalApplied / 4, unit: 'GL' };
  if (u === 'GL') return { value: totalApplied, unit: 'GL' };
  // Unknown liquid unit — default to OZ→GL
  return { value: totalApplied / 128, unit: 'GL' };
}
