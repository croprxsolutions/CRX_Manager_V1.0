import { badAmount, lbToUnit, sumWeights, unitEntry, type LineWeight, type UnitEntry } from './weightMath';
import type { WeightUnitFactors } from '../types';

// DM-2 (sheet section 4.4): the ticket total checked through the unit map, used only when the screen passes
// one. A line's weight (`weightLb`) and its own map (`rowUnits`) come from the ticket's saved snapshot or the
// current catalog, chosen by the screen; this file only adds up and compares.

const TOLERANCE = 0.05; // same 5% as blendMathValidator

export interface MappedLine {
  product_name: string;
  product_id?: string | null;
  quantity: unknown;
  unit: string | null;
  /** The saved line's captured form, else the catalog form. */
  form: string | null;
  weightLb?: LineWeight;
  /** The map this line's unit is read through (its snapshot's, else the current map). */
  rowUnits?: WeightUnitFactors | null;
}

type Warning = { level: 'mismatch' | 'unchecked'; message: string };
const unchecked = (message: string): Warning[] => [{ level: 'unchecked', message }];
const lineName = (line: MappedLine) => line.product_name || 'Unnamed product';

function weightTotal(total: number, unit: string, units: WeightUnitFactors, lines: MappedLine[]): Warning[] {
  if (total < 0) return unchecked('Total weight not checked: the total is negative');
  const sum = sumWeights(lines.map((line) => ({
    quantity: line.quantity,
    weight: line.weightLb ?? { refused: true as const, reason: `${lineName(line)} has no weight` },
  })));
  if ('refused' in sum) return unchecked(`Total weight not checked: ${sum.reasons.join('; ')}`);
  if (sum.contributing === 0) return total > 0 ? unchecked('Total weight not checked: no product amounts to add up') : [];
  const converted = lbToUnit(sum.lb, unit, units);
  if ('refused' in converted) return unchecked(`Total weight not checked: ${converted.reason}`);
  const off = total === 0 ? converted.value > 0 : Math.abs(converted.value - total) / total > TOLERANCE;
  return off
    ? [{ level: 'mismatch', message: `Total weight (${total} ${unit}) doesn't match the products, which add up to ${converted.value.toFixed(2)} ${unit}` }]
    : [];
}

/** One spray-tank row in gallons through its own map, or why it is left out of the sum. */
function rowGallons(line: MappedLine): number | string {
  const name = lineName(line);
  const amount = badAmount(name, line.quantity);
  if (amount) return amount;
  if (!line.product_id) return `${name} is not linked to a product`;
  if (!line.form) return `${name} has no form set`;
  if (line.form !== 'liquid') return `${name} is ${line.form}`;
  if (!line.rowUnits) return `${name}'s unit basis was not recorded`;
  const entry = unitEntry(name, line.unit, line.rowUnits);
  if ('reason' in entry) return entry.reason;
  return entry.kind === 'volume' ? (line.quantity as number) * entry.factor : `${name}'s unit ${line.unit} isn't a volume unit`;
}

/** A left-out row's gallons when its amount and volume unit are known (an unlinked, dry or formless row), else 0. */
function knownGallons(line: MappedLine): number {
  if (badAmount(lineName(line), line.quantity) || !line.rowUnits) return 0;
  const entry = unitEntry(lineName(line), line.unit, line.rowUnits);
  return 'kind' in entry && entry.kind === 'volume' ? (line.quantity as number) * entry.factor : 0;
}

function volumeTotal(total: number, unit: string, header: UnitEntry, lines: MappedLine[]): Warning[] {
  if (total < 0) return unchecked(`Total volume not checked: the ticket total is ${total}`);
  const refused: string[] = [];
  // Gallons the tank surely holds, left-out rows included when their volume is known: these alone can show overfill.
  let atLeast = 0;
  let anyCounted = false;
  for (const line of lines) {
    if (line.quantity === 0) continue;
    const row = rowGallons(line);
    if (typeof row === 'string') {
      refused.push(row);
      const known = knownGallons(line);
      if (known > 0) { atLeast += known; anyCounted = true; }
    } else { atLeast += row; anyCounted = true; }
  }
  if (!Number.isFinite(atLeast)) return unchecked('Total volume not checked: the total is too large to check');
  const over = total === 0 ? anyCounted && atLeast > 0 : atLeast > total * header.factor * (1 + TOLERANCE);
  if (over) {
    // Left-out rows only lower the sum, so the products are over the tank whatever they hold.
    const notCounted = refused.length > 0 ? ` Counted by volume only, or left out: ${refused.join('; ')}.` : '';
    return [{ level: 'mismatch', message: `The products add up to ${refused.length > 0 ? 'at least ' : ''}${(atLeast / header.factor).toFixed(2)} ${unit}, which is more than the total volume of ${total} ${unit}. A tank can't hold more product than its total.${notCounted}` }];
  }
  return refused.length > 0 ? unchecked(`Total volume not checked: ${refused.join('; ')}`) : [];
}

/**
 * The total check for a ticket whose header unit is not blank, through the unit map the save stores for it
 * (`headerUnits`; null when a saved ticket's basis was never recorded). `legacyWeightUnits` only names the
 * kind of total in a message when the map cannot.
 */
function mappedTotalWarnings(total: unknown, headerUnit: string, headerUnits: WeightUnitFactors | null,
  lines: MappedLine[], legacyWeightUnits: ReadonlySet<string>): Warning[] {
  if (total == null) return [];
  const key = headerUnit.trim().toLowerCase();
  const word = legacyWeightUnits.has(key) ? 'Total weight' : 'Total';
  if (typeof total !== 'number' || !Number.isFinite(total)) return unchecked(`${word} not checked: the total is not a number`);
  if (headerUnits === null) return unchecked(`${word} not checked: this ticket's unit basis was not recorded`);
  if (headerUnits.ambiguous.includes(key)) return unchecked(`${word} not checked: ${key} has conflicting entries in the unit table`);
  const entry = Object.prototype.hasOwnProperty.call(headerUnits.factors, key) ? headerUnits.factors[key] : undefined;
  if (entry?.kind === 'weight') return weightTotal(total, key, headerUnits, lines);
  if (entry?.kind === 'volume') return volumeTotal(total, key, entry, lines);
  if (!lines.some((line) => line.quantity !== 0)) return [];
  return unchecked(entry?.kind === 'count'
    ? `Total not checked: ${key} is a count, not a weight or volume`
    : `${word} not checked: ${key} is not in the unit table`);
}

/** With a blank header unit: a line amount that is not a usable number stops the legacy total comparison. */
function rawAmountWarnings(total: unknown, lines: MappedLine[]): Warning[] {
  if (typeof total !== 'number' || !(total > 0)) return [];
  const bad = lines.flatMap((line) => (line.quantity === 0 ? [] : [badAmount(lineName(line), line.quantity)]))
    .filter((reason): reason is string => reason !== null);
  return bad.length > 0 ? unchecked(`Total not checked: ${bad.join('; ')}`) : [];
}

/**
 * What a DM-2 screen passes the checker: the unit map and weighed lines, or that the weight read failed
 * (`unavailable`) or has not answered yet (`loading`, when no total check is shown rather than a false one).
 */
export type WeightTotalOptions =
  | { headerUnits: WeightUnitFactors | null; lines: MappedLine[] }
  | { unavailable: true; lines: MappedLine[] }
  | { loading: true };

interface TotalInput {
  total: unknown;
  rawUnit: string | null;
  /** The header unit as the legacy checks normalise it. */
  legacyUnit: string;
  weights: WeightTotalOptions;
  legacyWeightUnits: ReadonlySet<string>;
  legacyVolumeUnits: ReadonlySet<string>;
}

/** The ticket total warnings for a DM-2 screen, or null to run the legacy total checks unchanged. */
export function weightTotalWarnings({ total, rawUnit, legacyUnit, weights, legacyWeightUnits, legacyVolumeUnits }: TotalInput): Warning[] | null {
  // While weights load, today's checks run unchanged, so a tank overfill warning is never hidden.
  if ('loading' in weights) return null;
  const header = (rawUnit ?? '').trim();
  const raw = rawAmountWarnings(total, weights.lines);
  if (header === '') return raw.length > 0 ? raw : null;
  if ('headerUnits' in weights) return mappedTotalWarnings(total, header, weights.headerUnits, weights.lines, legacyWeightUnits);
  if (raw.length > 0) return raw;
  // Weights unavailable: a volume header keeps today's spray-tank check; any other total is not checked.
  const isVolume = legacyVolumeUnits.has(legacyUnit) || legacyUnit === 'oz';
  if (isVolume || typeof total !== 'number' || !(total > 0)) return null;
  return unchecked('Total weight not checked: weights unavailable');
}
