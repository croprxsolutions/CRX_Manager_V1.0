/**
 * Water to add for a loader tank: finished gallons minus the gallons the liquid products
 * take up (Sol 62). Dry, seed and "each" products add no volume. Water never goes below 0:
 * a recipe bigger than the finished gallons prints 0 and sets `over` so the sheet warns.
 * Water is shown only when known (Mason, 2026-11-24, "Yes, only when known"): every product's
 * record must say liquid or dry, and every liquid must size to gallons. Otherwise it is null
 * (prints a dash) and the note says why. Nothing is guessed from the unit.
 */
import { toGallonOrLbEquivalent } from './chemCalculator';
import type { LoaderLoadProduct, LoaderProductInput } from './loaderWorksheet';
import type { ProductForm } from '../types';

export interface LoaderWater {
  finished_gal: number;
  /** null = not known (prints a dash); unknown/unsized/missing say why. */
  water_gal: number | null;
  /** The liquid products are more than the finished gallons (water printed as 0). */
  over: boolean;
  /** Products whose record does not say liquid or dry. */
  unknown: string[];
  /** Liquid products whose unit has no gallon size (e.g. measured by weight). */
  unsized: string[];
  /** Liquid products with no usable amount. */
  missing: string[];
}

type WaterProduct = Pick<LoaderLoadProduct, 'product_name' | 'amount' | 'unit' | 'product_form'>;

const FORMS: readonly string[] = ['liquid', 'dry', 'seed', 'each'];

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Gallons this product adds to the tank, or why it cannot be told. */
function liquidGallons(product: WaterProduct): number | 'unknown' | 'unsized' | 'missing' {
  const form = FORMS.includes(product.product_form ?? '') ? product.product_form as ProductForm : null;
  if (!form) return 'unknown';
  if (form !== 'liquid') return 0;
  if (!Number.isFinite(product.amount)) return 'missing';
  if (product.amount === 0) return 0;
  const converted = toGallonOrLbEquivalent(product.amount, product.unit, form);
  return converted?.unit === 'gal' ? converted.value : 'unsized';
}

/** Finished gallons and water to add for one tank (or the whole batch). */
export function loaderWater(finishedGal: number, products: readonly WaterProduct[]): LoaderWater {
  let liquid = 0;
  const unknown: string[] = [];
  const unsized: string[] = [];
  const missing: string[] = [];
  for (const product of products) {
    const gal = liquidGallons(product);
    if (gal === 'unknown') unknown.push(product.product_name);
    else if (gal === 'unsized') unsized.push(product.product_name);
    else if (gal === 'missing') missing.push(product.product_name);
    else liquid += gal;
  }
  if (unknown.length + unsized.length + missing.length > 0) {
    return { finished_gal: finishedGal, water_gal: null, over: false, unknown, unsized, missing };
  }
  // Compare before rounding so a sliver over the finished gallons still warns; the epsilon absorbs float drift.
  const over = liquid - finishedGal > 1e-9;
  return { finished_gal: finishedGal, water_gal: over ? 0 : Math.max(0, round4(finishedGal - liquid)), over, unknown, unsized, missing };
}

/**
 * Water for one tank of a computed plan. `inputs` are the plan's product lines, index-aligned with
 * `products`: the engine splits a missing amount as 0, but for water its volume is unknown, never none.
 */
export function loaderTankWater(volume: number, products: readonly WaterProduct[], inputs: readonly Pick<LoaderProductInput, 'total_quantity'>[]): LoaderWater {
  return loaderWater(volume, products.map((product, pi) =>
    (Number.isFinite(inputs[pi]?.total_quantity ?? NaN) ? product : { ...product, amount: NaN })));
}

/** Why water to add is not shown, one sentence per reason. */
export function loaderWaterNotes(water: Pick<LoaderWater, 'unknown' | 'unsized' | 'missing'>): string[] {
  const notes: string[] = [];
  const names = (list: string[]) => [...new Set(list)].join(', ');
  if (water.unknown.length > 0) notes.push(`Water to add not shown: set liquid/dry on the product for ${names(water.unknown)}.`);
  if (water.unsized.length > 0) notes.push(`Water to add not shown: the gallons of ${names(water.unsized)} cannot be worked out from its unit.`);
  if (water.missing.length > 0) notes.push(`Water to add not shown: the amount of ${names(water.missing)} is missing. Fix it on the job.`);
  return notes;
}

/** Water to add in loader units, or a dash when it is not known. */
export function fmtLoaderWater(water: Pick<LoaderWater, 'water_gal'>): string {
  return water.water_gal === null ? '—' : fmtLoaderGallons(water.water_gal);
}

/** Gallons in loader units: "58 GL 7.68 FL OZ". */
export function fmtLoaderGallons(gal: number): string {
  const totalOz = Math.round(gal * 128 * 100) / 100;
  const whole = Math.floor(totalOz / 128);
  const rest = Math.round((totalOz - whole * 128) * 100) / 100;
  if (rest === 0) return `${whole} GL`;
  return whole === 0 ? `${rest} FL OZ` : `${whole} GL ${rest} FL OZ`;
}
