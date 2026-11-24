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
}

type WaterProduct = Pick<LoaderLoadProduct, 'product_name' | 'amount' | 'unit' | 'product_form'>;

const FORMS: readonly string[] = ['liquid', 'dry', 'seed', 'each'];
// With the form unknown, an ounce could be a fluid ounce or a weight ounce: never guess.
const AMBIGUOUS_UNITS = new Set(['oz', 'ounce', 'ounces']);

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Gallons this product adds to the tank, or null when it cannot be told. */
function liquidGallons(product: WaterProduct): number | null {
  const form = FORMS.includes(product.product_form ?? '') ? product.product_form as ProductForm : null;
  if (form && form !== 'liquid') return 0;
  if (!Number.isFinite(product.amount)) return null; // a line with no usable amount: its volume is unknown
  if (product.amount === 0) return 0;
  const converted = toGallonOrLbEquivalent(product.amount, product.unit, form);
  if (converted?.unit === 'gal') return converted.value;
  const unit = (product.unit ?? '').trim().toLowerCase();
  if (!form && converted?.unit === 'lb' && !AMBIGUOUS_UNITS.has(unit)) return 0;
  return null;
}

/** Finished gallons and water to add for one tank (or the whole batch). */
export function loaderWater(finishedGal: number, products: readonly WaterProduct[]): LoaderWater {
  let liquid = 0;
  const unsized: string[] = [];
  for (const product of products) {
    const gal = liquidGallons(product);
    if (gal === null) unsized.push(product.product_name);
    else liquid += gal;
  }
  const water = round4(finishedGal - liquid);
  return { finished_gal: finishedGal, water_gal: Math.max(0, water), over: water < 0, unsized };
}

/**
 * Water for one tank of a computed plan. `inputs` are the plan's product lines, index-aligned with
 * `products`: the engine splits a missing amount as 0, but for water its volume is unknown, never none.
 */
export function loaderTankWater(volume: number, products: readonly WaterProduct[], inputs: readonly Pick<LoaderProductInput, 'total_quantity'>[]): LoaderWater {
  return loaderWater(volume, products.map((product, pi) =>
    (Number.isFinite(inputs[pi]?.total_quantity ?? NaN) ? product : { ...product, amount: NaN })));
}

/** Gallons in loader units: "58 GL 7.68 FL OZ". */
export function fmtLoaderGallons(gal: number): string {
  const totalOz = Math.round(gal * 128 * 100) / 100;
  const whole = Math.floor(totalOz / 128);
  const rest = Math.round((totalOz - whole * 128) * 100) / 100;
  if (rest === 0) return `${whole} GL`;
  return whole === 0 ? `${rest} FL OZ` : `${whole} GL ${rest} FL OZ`;
}
