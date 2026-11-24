/**
 * Water to add for a loader tank: finished gallons minus the gallons the liquid products
 * take up (Sol 62). Dry, seed and "each" products add no volume. Water never goes below 0:
 * a recipe bigger than the finished gallons prints 0 and sets `over` so the sheet warns.
 */
import { toGallonOrLbEquivalent } from './chemCalculator';
import type { LoaderLoadProduct, LoaderProductInput } from './loaderWorksheet';
import type { ProductForm } from '../types';

export interface LoaderWater {
  finished_gal: number;
  water_gal: number;
  /** The liquid products are more than the finished gallons (water printed as 0). */
  over: boolean;
  /** Products whose volume could not be sized (liquid or dry unknown, or a unit with no gallon size). */
  unsized: string[];
  /** Liquid (or not-known) products with no usable amount: their volume is left out. */
  missing: string[];
}

type WaterProduct = Pick<LoaderLoadProduct, 'product_name' | 'amount' | 'unit' | 'product_form'>;

const FORMS: readonly string[] = ['liquid', 'dry', 'seed', 'each'];

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Gallons this product adds to the tank, or why it cannot be told. */
function liquidGallons(product: WaterProduct): number | 'unsized' | 'missing' {
  const form = FORMS.includes(product.product_form ?? '') ? product.product_form as ProductForm : null;
  if (form && form !== 'liquid') return 0;
  if (!Number.isFinite(product.amount)) return 'missing';
  if (product.amount === 0) return 0;
  // With the form unknown only a volume unit counts: a liquid can be measured by weight, so a weight unit is never "no volume".
  const converted = toGallonOrLbEquivalent(product.amount, product.unit, form);
  return converted?.unit === 'gal' ? converted.value : 'unsized';
}

/** Finished gallons and water to add for one tank (or the whole batch). */
export function loaderWater(finishedGal: number, products: readonly WaterProduct[]): LoaderWater {
  let liquid = 0;
  const unsized: string[] = [];
  const missing: string[] = [];
  for (const product of products) {
    const gal = liquidGallons(product);
    if (gal === 'unsized') unsized.push(product.product_name);
    else if (gal === 'missing') missing.push(product.product_name);
    else liquid += gal;
  }
  // Compare before rounding so a sliver over the finished gallons still warns; the epsilon absorbs float drift.
  const over = liquid - finishedGal > 1e-9;
  return { finished_gal: finishedGal, water_gal: over ? 0 : Math.max(0, round4(finishedGal - liquid)), over, unsized, missing };
}

/**
 * Water for one tank of a computed plan. `inputs` are the plan's product lines, index-aligned with
 * `products`: the engine splits a missing amount as 0, but for water its volume is unknown, never none.
 */
export function loaderTankWater(volume: number, products: readonly WaterProduct[], inputs: readonly Pick<LoaderProductInput, 'total_quantity'>[]): LoaderWater {
  return loaderWater(volume, products.map((product, pi) =>
    (Number.isFinite(inputs[pi]?.total_quantity ?? NaN) ? product : { ...product, amount: NaN })));
}

/** Why water to add leaves a product out, one sentence per reason. */
export function loaderWaterNotes(water: Pick<LoaderWater, 'unsized' | 'missing'>): string[] {
  const notes: string[] = [];
  const names = (list: string[]) => [...new Set(list)].join(', ');
  if (water.missing.length > 0) notes.push(`Water to add does not count ${names(water.missing)}: the amount is missing. Fix it on the job, or subtract its volume by hand.`);
  if (water.unsized.length > 0) notes.push(`Water to add does not count ${names(water.unsized)}: its gallons cannot be worked out from this unit (or it is not known to be liquid or dry). Subtract its volume by hand.`);
  return notes;
}

/** Gallons in loader units: "58 GL 7.68 FL OZ". */
export function fmtLoaderGallons(gal: number): string {
  const totalOz = Math.round(gal * 128 * 100) / 100;
  const whole = Math.floor(totalOz / 128);
  const rest = Math.round((totalOz - whole * 128) * 100) / 100;
  if (rest === 0) return `${whole} GL`;
  return whole === 0 ? `${rest} FL OZ` : `${whole} GL ${rest} FL OZ`;
}
