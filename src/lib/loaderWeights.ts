import { fmtNum } from './applicatorSheetData';
import { badAmount, formatLb, lineWeightLb, sumWeights, unitEntry, type LineWeight, type WeightBasis } from './weightMath';
import type { LoaderLoadProduct, LoaderWorksheet } from './loaderWorksheet';
import type { JobLoaderWorksheetWeight, ProductWeight, WeightUnitFactors } from '../types';

// DM-2 sheet 4.3: each load's printed amount weighed line by line, through that row's own weight and unit map.

/** A job line as read, before the tank split (its raw amount is checked here, never parsed loosely). */
export interface LoaderSourceLine {
  id: string;
  product_id: string | null;
  quantity: unknown;
  unit: string | null;
}

/** One product's weights for one worksheet: its saved snapshot (if any) and its current approved weight. */
export interface LoaderProductWeights {
  saved?: JobLoaderWorksheetWeight | null;
  current?: ProductWeight | null;
}

export type LoaderWeightMark = 'saved' | 'current' | null;

export interface LoaderCell {
  /** The printed amount, or the reason it is refused (never a silent 0, a negative or Infinity). */
  amountCell: string;
  weight: LineWeight;
  /** "104.30 lb", or the reason there is no weight. */
  weightText: string;
  mark: LoaderWeightMark;
}

export interface LoaderLoadWeights {
  /** Aligned with the load's `products` (one entry per job line, in order). */
  cells: LoaderCell[];
  /** "Product weight: 115.40 lb", or why the load's total is withheld. */
  totalText: string;
  /** The load's product weight in pounds, or null when withheld. */
  totalLb: number | null;
}

export interface LoaderWeights {
  loads: LoaderLoadWeights[];
  /** True when some line uses a current weight (the saved-worksheet caption names it). */
  anyCurrent: boolean;
}

const PLAIN_DECIMAL = /^-?(\d+\.?\d*|\.\d+)$/;

/** A source line's amount as a number, or the reason it cannot be printed or weighed. */
export function sourceAmount(name: string, raw: unknown): { value: number } | { reason: string } {
  let quantity = raw;
  if (typeof raw === 'string') {
    if (!PLAIN_DECIMAL.test(raw.trim())) return { reason: `${name}'s amount is not a number` };
    quantity = Number(raw.trim());
  }
  const bad = badAmount(name, quantity);
  return bad ? { reason: bad } : { value: quantity as number };
}

/** True when rounding moves any load's printed amount more than 1% from its exact share. */
function roundsBadly(ws: LoaderWorksheet, index: number, total: number): boolean {
  if (!(total > 0) || !(ws.spray_volume > 0)) return false;
  return ws.loads.some((load) => {
    const exact = total * (load.volume / ws.spray_volume);
    return Math.abs((load.products[index]?.amount ?? 0) - exact) > exact * 0.01;
  });
}

const savedBasis = (row: JobLoaderWorksheetWeight): WeightBasis =>
  ({ kind: row.weight_kind, none_reason: row.none_reason, lb_per_unit: row.lb_per_unit, per_unit: row.per_unit });

interface Picked { basis: WeightBasis | null; units: WeightUnitFactors; form: string | null | undefined; mark: LoaderWeightMark }

/** The saved snapshot when it can weigh this line, else the product's current weight (sheet 3.4b). */
function pick(product: LoaderLoadProduct, weights: Record<string, LoaderProductWeights>, currentUnits: WeightUnitFactors): Picked {
  if (!product.product_id) return { basis: { kind: 'none', none_reason: 'unlinked' }, units: currentUnits, form: product.product_form, mark: null };
  const { saved, current } = weights[product.product_id] ?? {};
  if (saved && saved.weight_kind !== 'none') return { basis: savedBasis(saved), units: saved.unit_factors, form: saved.product_form, mark: 'saved' };
  if (saved) {
    // A `none` row is kept only for its unit map: a line in a weight unit of that map is weighed from it.
    const entry = unitEntry(product.product_name, product.unit, saved.unit_factors);
    if ('kind' in entry && entry.kind === 'weight') return { basis: savedBasis(saved), units: saved.unit_factors, form: saved.product_form, mark: 'saved' };
  }
  // A product with no readable current weight is not marked current: its cell says why there is no weight.
  return { basis: current ?? null, units: currentUnits, form: product.product_form, mark: current ? 'current' : null };
}

interface Refusal { cell: string; reason: string }
const plain = (reason: string): Refusal => ({ cell: reason, reason });

/** Why a product's amounts cannot be printed on any load (the cell text, and the reason a total is withheld), or null. */
function productRefusal(ws: LoaderWorksheet, index: number, product: LoaderLoadProduct, sources: Map<string, LoaderSourceLine>): Refusal | null {
  const name = product.product_name;
  const source = product.source_line_id === undefined ? undefined : sources.get(product.source_line_id);
  if (!source) return plain(`${name}: its job line was not found; reload to print it`);
  const amount = sourceAmount(name, source.quantity);
  if ('reason' in amount) return plain(amount.reason);
  if (ws.loads.some((load) => !Number.isFinite(load.products[index]?.amount))) return plain(`${name}'s amount is too large to print`);
  if (!roundsBadly(ws, index, amount.value)) return null;
  const reason = `${name}: amount too small to print accurately per load`;
  return { cell: `${reason} (job total ${fmtNum(amount.value)})`, reason };
}

/**
 * Each load's printed amounts and their weights, plus the load's product weight. `weightsByProductId` is this
 * worksheet's own map; `sourceLines` are the job lines the split was computed from, matched by `source_line_id`.
 */
export function loaderLoadWeights(ws: LoaderWorksheet, weightsByProductId: Record<string, LoaderProductWeights>,
  currentUnits: WeightUnitFactors, sourceLines: readonly LoaderSourceLine[]): LoaderWeights {
  const sources = new Map(sourceLines.map((line) => [line.id, line]));
  const refusals = (ws.loads[0]?.products ?? []).map((product, index) => productRefusal(ws, index, product, sources));
  let anyCurrent = false;
  const loads = ws.loads.map((load) => {
    const cells = load.products.map((product, index): LoaderCell => {
      const refusal = refusals[index];
      if (refusal) return { amountCell: refusal.cell, weight: { refused: true, reason: refusal.reason }, weightText: refusal.cell, mark: null };
      const picked = pick(product, weightsByProductId, currentUnits);
      // Weigh the amount exactly as printed (fmtNum shows 4 decimals), so the two never disagree.
      const printed = Math.round(product.amount * 10000) / 10000;
      if (picked.mark === 'current') anyCurrent = true;
      const weight: LineWeight = picked.basis
        ? lineWeightLb({ name: product.product_name, quantity: printed, unit: product.unit, form: picked.form, weight: picked.basis }, picked.units)
        : { refused: true, reason: `${product.product_name}: weights unavailable` };
      return { amountCell: fmtNum(printed), weight, weightText: 'lb' in weight ? formatLb(weight.lb) : weight.reason, mark: picked.mark };
    });
    // An amount refusal is counted even on a load that printed 0, so its total is withheld (never `0 lb`).
    const sum = sumWeights(cells.map((cell, index) => ({ quantity: refusals[index] ? null : Math.round(load.products[index].amount * 10000) / 10000, weight: cell.weight })));
    const totalText = 'lb' in sum ? `Product weight: ${formatLb(sum.lb)}` : `Product weight not shown: ${sum.reasons.join('; ')}`;
    return { cells, totalText, totalLb: 'lb' in sum ? sum.lb : null };
  });
  return { loads, anyCurrent };
}

/**
 * A condensed column's weight for one line (or its total): one text when every load in the group weighs the same,
 * else lowest to highest ("80.00–80.01 lb"), so "each" never shows the first load's weight for all of them.
 */
export function loaderGroupWeightText(weights: LoaderWeights, loadIndexes: readonly number[], line: number | 'total'): string {
  const items = loadIndexes.flatMap((index) => {
    const load = weights.loads[index];
    if (!load) return [];
    if (line === 'total') return [{ text: load.totalText, lb: load.totalLb }];
    const cell = load.cells[line];
    return cell ? [{ text: cell.weightText, lb: 'lb' in cell.weight ? cell.weight.lb : null }] : [];
  });
  const texts = [...new Set(items.map((item) => item.text))];
  if (texts.length <= 1) return texts[0] ?? '';
  if (items.some((item) => item.lb == null)) return texts.join('; ');
  const lbs = items.map((item) => item.lb as number);
  const range = `${formatLb(Math.min(...lbs)).replace(/ lb$/, '')}–${formatLb(Math.max(...lbs))}`;
  return line === 'total' ? `Product weight: ${range}` : range;
}

/** The caption under a worksheet's weights (sheet 4.3). */
export function loaderWeightCaption(savedWorksheet: boolean, anyCurrent: boolean): string {
  if (!savedWorksheet) return 'Weights use the current approved weights.';
  return anyCurrent ? 'Weights saved with this worksheet, except lines marked current' : 'Weights saved with this worksheet';
}
