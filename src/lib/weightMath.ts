import type { ProductWeightKind, ProductWeightNoneReason, WeightUnitFactors } from '../types';

// ── Line weight math (DM-2 sheet section 4.1). Never uses fieldAppPricedQuantity and never guesses. ──

/** What a line's weight is computed from: a catalog weight, a ticket snapshot, or why there is none. */
export interface WeightBasis {
  kind: ProductWeightKind;
  /** none_at_save: a saved ticket line whose product had no parent or no approved weight when the ticket was saved. */
  none_reason?: ProductWeightNoneReason | 'unlinked' | 'not_recorded' | 'none_at_save' | null;
  lb_per_unit?: number | null;
  /** density: Gal; net_weight and unit_weight: the size's stock unit. */
  per_unit?: string | null;
}

export type LineWeight = { lb: number } | { refused: true; reason: string };
export type UnitEntry = { kind: 'weight' | 'volume' | 'count'; factor: number };

export interface WeighLine {
  /** The line's own product name, so an unlinked line can still be named. */
  name: string;
  quantity: unknown;
  unit: string | null | undefined;
  form: string | null | undefined;
  weight: WeightBasis | null | undefined;
}

const refuse = (reason: string): { refused: true; reason: string } => ({ refused: true, reason });

function noneReason(name: string, reason: WeightBasis['none_reason'] | undefined): string {
  switch (reason) {
    case 'unlinked': return `${name} is not linked to a product, so it has no weight`;
    case 'not_recorded': return `${name}'s weight was not recorded for this ticket`;
    case 'no_parent': return `put ${name} in a parent to record its weight`;
    case 'no_approved_weight': return `${name} has no approved weight yet`;
    case 'none_at_save': return `${name} had no approved weight when this ticket was saved`;
    case 'seed_or_each': return "weight isn't tracked for seed or each products";
    case 'unknown_form': return `${name} has no form set`;
    case 'unit_not_convertible': return `${name}'s stock unit is not a weight or count unit, so it has no weight`;
    default: return `${name} has no weight`;
  }
}

/** A unit's entry in the map (key `lower(trim(unit))`), or why it cannot be used. */
export function unitEntry(name: string, unit: string | null | undefined, units: WeightUnitFactors): UnitEntry | { reason: string } {
  const key = (unit ?? '').trim().toLowerCase();
  if (key === '') return { reason: `${name} has no unit recorded` };
  if (units.ambiguous.includes(key)) return { reason: `${name}'s unit ${unit} has conflicting entries in the unit table` };
  const entry = Object.prototype.hasOwnProperty.call(units.factors, key) ? units.factors[key] : undefined;
  return entry ?? { reason: `${name}'s unit ${unit} isn't in the unit table` };
}

/** A raw amount that cannot be weighed, by name; null when it is a finite, non-negative number. */
export function badAmount(name: string, quantity: unknown): string | null {
  if (typeof quantity !== 'number' || Number.isNaN(quantity)) return `${name} has an invalid amount`;
  if (!Number.isFinite(quantity)) return `${name}'s amount is too large to weigh`;
  return quantity < 0 ? `${name} has a negative amount` : null;
}

/** Refusals that come before the unit is looked at: a bad amount, unlinked, not recorded, no form, seed or each. */
function refusedFirst({ name, quantity, form, weight }: WeighLine): string | null {
  const amount = badAmount(name, quantity);
  if (amount) return amount;
  const reason = weight?.kind === 'none' ? weight.none_reason : undefined;
  if (reason === 'unlinked' || reason === 'not_recorded' || reason === 'unknown_form' || reason === 'seed_or_each') return noneReason(name, reason);
  if (form === 'seed' || form === 'each') return noneReason(name, 'seed_or_each');
  return form === 'liquid' || form === 'dry' ? null : noneReason(name, 'unknown_form');
}

function volumeLb(line: WeighLine, quantity: number, entry: UnitEntry): LineWeight {
  const { name, unit, form, weight } = line;
  if (form !== 'liquid') return refuse(`${name} is dry but recorded in ${unit}, a volume unit`);
  if (weight?.kind !== 'density' || weight.lb_per_unit == null) return refuse(noneReason(name, weight?.none_reason));
  return { lb: quantity * entry.factor * weight.lb_per_unit };
}

function countLb(line: WeighLine, quantity: number, entry: UnitEntry, units: WeightUnitFactors): LineWeight {
  const { name, unit, form, weight } = line;
  if (form === 'liquid') return refuse(`${name} is a liquid recorded in ${unit}; record it in a volume unit`);
  if (weight?.kind === 'unit_weight') return refuse(`${name} is stocked in ${weight.per_unit}; record it in ${weight.per_unit}`);
  if (weight?.kind !== 'net_weight' || weight.lb_per_unit == null) return refuse(noneReason(name, weight?.none_reason));
  const stock = unitEntry(name, weight.per_unit, units);
  if ('reason' in stock) return refuse(stock.reason);
  if (stock.kind !== 'count') return refuse(`${name} is stocked in ${weight.per_unit}; record it in ${weight.per_unit}`);
  return { lb: (quantity * entry.factor / stock.factor) * weight.lb_per_unit };
}

/**
 * Pounds in one line, through the unit map `units` read with its weight (section 3.2), or a refusal that
 * names the product and says what would fix it. A weight unit needs no stored weight; a volume unit needs a
 * liquid's density; a count unit needs a dry count-stocked size's pack weight.
 */
export function lineWeightLb(line: WeighLine, units: WeightUnitFactors): LineWeight {
  const first = refusedFirst(line);
  if (first) return refuse(first);
  const quantity = line.quantity as number;
  const entry = unitEntry(line.name, line.unit, units);
  if ('reason' in entry) return refuse(entry.reason);
  let result: LineWeight;
  if (entry.kind === 'weight') result = { lb: quantity * entry.factor };
  else if (entry.kind === 'volume') result = volumeLb(line, quantity, entry);
  else result = countLb(line, quantity, entry, units);
  return 'lb' in result && !Number.isFinite(result.lb) ? refuse(`${line.name}'s amount is too large to weigh`) : result;
}

/** A pound total in a weight unit of the map; refuses any other unit and a result that is not finite. */
export function lbToUnit(lb: number, unit: string | null | undefined, units: WeightUnitFactors): { value: number } | { refused: true; reason: string } {
  const key = (unit ?? '').trim().toLowerCase();
  if (units.ambiguous.includes(key)) return refuse(`${unit} has conflicting entries in the unit table`);
  const entry = Object.prototype.hasOwnProperty.call(units.factors, key) ? units.factors[key] : undefined;
  if (!entry) return refuse(`${unit} is not in the unit table`);
  if (entry.kind !== 'weight') return refuse(`${unit} is not a weight unit`);
  const value = lb / entry.factor;
  return Number.isFinite(value) ? { value } : refuse('the total is too large to check');
}

/**
 * Total pounds of the contributing lines (quantity not zero), only when every one has a weight; otherwise
 * each refused line's reason, never a partial sum. No contributing lines is a total of 0 from 0 lines.
 */
export function sumWeights(lines: ReadonlyArray<{ quantity: unknown; weight: LineWeight }>):
  { lb: number; contributing: number } | { refused: true; reasons: string[] } {
  const contributing = lines.filter((line) => line.quantity !== 0);
  const reasons = contributing.flatMap((line) => ('refused' in line.weight ? [line.weight.reason] : []));
  if (reasons.length > 0) return { refused: true, reasons };
  const lb = contributing.reduce((sum, line) => sum + ('lb' in line.weight ? line.weight.lb : 0), 0);
  if (!Number.isFinite(lb)) return { refused: true, reasons: ['the total is too large to weigh'] };
  return { lb, contributing: contributing.length };
}

const LB_2DP = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1 lb or more to 2 decimals; a smaller non-zero weight to 3 significant figures, so it never shows as 0.00. */
export function formatLb(lb: number): string {
  if (lb === 0) return '0 lb';
  return `${Math.abs(lb) >= 1 ? LB_2DP.format(lb) : lb.toPrecision(3)} lb`;
}
