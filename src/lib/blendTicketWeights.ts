import { toSentryError } from './sentryError';
import { assertRpcResult, supabaseUntyped } from './db';
import { BUSINESS_TIMEZONE } from './dateUtils';
import { Sentry } from './sentry';
import { sourceText, type ProductWeightsResult } from './productWeights';
import { formatLb, lineWeightLb, sumWeights, unitEntry, type LineWeight, type WeightBasis } from './weightMath';
import type { MappedLine } from './blendWeightTotals';
import type { BlendTicketProductWeight, WeightUnitFactors } from '../types';

// DM-2 sheet 4.4: the weights a blend ticket was saved with (`get_blend_ticket_weights`, one snapshot per
// product) and, for a line not yet saved, the weight its save would use.

export type TicketSnapshot = Omit<BlendTicketProductWeight, 'product_name'> & { captured_name: string };
type NoneRow = { weight_kind: 'none'; none_reason: 'unlinked' | 'not_recorded' };

export interface BlendTicketWeights {
  read_at: string;
  ticket: Record<string, unknown> | null;
  basis_unit_factors: WeightUnitFactors | null;
  current_unit_factors: WeightUnitFactors;
  lines: Array<{ line_id: string; product_id: string | null; line: Record<string, unknown>; weight: TicketSnapshot | NoneRow }>;
  retained: Record<string, TicketSnapshot>;
}

export async function fetchBlendTicketWeights(ticketId: string): Promise<BlendTicketWeights> {
  const { data, error } = await supabaseUntyped.rpc('get_blend_ticket_weights', { p_blend_ticket_id: ticketId });
  if (error) throw error;
  return assertRpcResult<BlendTicketWeights>(data, 'get_blend_ticket_weights');
}

const isSnapshot = (row: TicketSnapshot | NoneRow): row is TicketSnapshot => 'unit_factors' in row;
const EMPTY_UNITS: WeightUnitFactors = { factors: {}, ambiguous: [] };

/** Two stored values are the same (numbers compared as numbers: 100 and 100.0 are one value). */
function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  return typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : a === b;
}

const HEADER_FIELDS = ['total_volume', 'total_volume_unit', 'total_acres', 'application_rate'] as const;
const LINE_FIELDS = ['product_id', 'quantity', 'unit', 'rate_per_acre', 'rate_per_acre_unit'] as const;

/**
 * True when the weight read saw the same ticket the page loaded, so amounts and saved weights come from one
 * moment; otherwise the page shows no weights rather than mixing two reads.
 */
export function matchesPageRead(weights: BlendTicketWeights, header: Record<string, unknown>,
  lines: ReadonlyArray<Record<string, unknown>>): boolean {
  const ticket = weights.ticket;
  if (!ticket || !HEADER_FIELDS.every((key) => same(ticket[key], header[key]))) return false;
  if (weights.lines.length !== lines.length) return false;
  return lines.every((pageLine) => {
    const read = weights.lines.find((candidate) => candidate.line_id === pageLine.id);
    return read !== undefined && LINE_FIELDS.every((key) => same(read.line[key], pageLine[key]));
  });
}

/** The header total or unit differs from the saved one, so the save will store the current map. */
export function headerEdited(weights: BlendTicketWeights, total: number | null, unit: string | null): boolean {
  const ticket = weights.ticket ?? {};
  return !same(ticket.total_volume, total) || !same(ticket.total_volume_unit, unit);
}

/** The snapshot a saved line kept, or the one its save would reuse (another line's, or `retained`). */
function savedRowFor(line: TicketLineInput, saved: BlendTicketWeights | null): TicketSnapshot | NoneRow | null {
  if (!saved || !line.product_id) return null;
  const own = line.id ? saved.lines.find((read) => read.line_id === line.id && read.product_id === line.product_id) : undefined;
  if (own) return own.weight;
  const shared = saved.lines.map((read) => read.weight).find((row) => isSnapshot(row) && row.product_id === line.product_id);
  return shared ?? saved.retained[line.product_id] ?? null;
}

function provenance(row: TicketSnapshot): string {
  const date = row.value_reviewed_at ? `, approved ${new Date(row.value_reviewed_at).toLocaleDateString('en-US', { timeZone: BUSINESS_TIMEZONE })}` : '';
  const kept = row.captured_how === 'backfill_at_apply' ? '; captured at DM-2 apply, original not recorded' : '';
  if (row.weight_kind === 'density') return `${row.lb_per_unit} lb/gal, from ${sourceText(row.source)}${date}${kept}`;
  if (row.weight_kind === 'net_weight') return `${row.lb_per_unit} lb per ${row.per_unit}, from ${sourceText(row.source)}${date}${kept}`;
  if (row.weight_kind === 'unit_weight') return `weight from its stock unit (${row.per_unit})${kept}`;
  return `no weight when saved${kept}`;
}

export interface TicketLineInput {
  /** A saved line's id; absent on a line added on the open page. */
  id?: string | null;
  product_id: string | null;
  product_name: string;
  quantity: unknown;
  unit: string | null;
  /** The catalog's form for the line's current product, when the page has it. */
  catalogForm: string | null;
}

export interface TicketWeightSources {
  /** The saved ticket's weights; null on a new ticket. */
  saved: BlendTicketWeights | null;
  /** Current weights of the lines' products; null when not read (yet) or the read failed. */
  current: ProductWeightsResult | null;
}

interface Picked { basis: WeightBasis | null; units: WeightUnitFactors; form: string | null; note: string }

function pick(line: TicketLineInput, { saved, current }: TicketWeightSources): Picked {
  const currentUnits = current?.units ?? saved?.current_unit_factors ?? EMPTY_UNITS;
  if (!line.product_id) return { basis: { kind: 'none', none_reason: 'unlinked' }, units: currentUnits, form: line.catalogForm, note: '' };
  const row = savedRowFor(line, saved);
  if (row && isSnapshot(row)) {
    // A saved "no weight yet" is a fact about save time; a weight approved later must not make it read as current.
    const atSave = row.none_reason === 'no_parent' || row.none_reason === 'no_approved_weight' ? 'none_at_save' as const : row.none_reason;
    const basis = { kind: row.weight_kind, none_reason: atSave, lb_per_unit: row.lb_per_unit, per_unit: row.per_unit };
    return { basis, units: row.unit_factors, form: row.product_form, note: `weight saved with this ticket: ${provenance(row)}` };
  }
  if (row) return { basis: { kind: 'none', none_reason: row.none_reason }, units: EMPTY_UNITS, form: line.catalogForm, note: '' };
  const entry = current?.products[line.product_id];
  if (!entry?.weight) return { basis: null, units: currentUnits, form: line.catalogForm, note: '' };
  const { kind, none_reason, lb_per_unit, per_unit } = entry.weight;
  return { basis: { kind, none_reason, lb_per_unit, per_unit }, units: currentUnits, form: entry.product_form ?? line.catalogForm,
    note: 'current approved weight; kept when you save' };
}

export interface ResolvedLine {
  mapped: MappedLine;
  /** What the screen shows under the line: its pounds and where the weight came from, or why there is none. */
  text: string;
  /** True when no weight was read for the line (its read failed or has not answered), so it showed none. */
  unread?: boolean;
}

/** Each line's weight from its current amount and unit, through the weight and map its source gives. */
export function resolveTicketLines(lines: readonly TicketLineInput[], sources: TicketWeightSources): ResolvedLine[] {
  return lines.map((line) => {
    const name = line.product_name || 'Unnamed product';
    const picked = pick(line, sources);
    const weight: LineWeight = picked.basis
      ? lineWeightLb({ name, quantity: line.quantity, unit: line.unit, form: picked.form, weight: picked.basis }, picked.units)
      : { refused: true, reason: `${name}: weights unavailable` };
    const entry = unitEntry(name, line.unit, picked.units);
    const note = 'kind' in entry && entry.kind === 'weight' ? 'weighed from its unit' : picked.note;
    const text = 'lb' in weight ? [formatLb(weight.lb), note].filter(Boolean).join(' · ') : weight.reason;
    return {
      mapped: { product_name: name, product_id: line.product_id, quantity: line.quantity, unit: line.unit, form: picked.form,
        weightLb: weight, rowUnits: picked.units },
      text,
      ...(picked.basis ? {} : { unread: true }),
    };
  });
}

/** The header line: the total product weight, or why it is not shown. */
export function totalWeightText(lines: readonly ResolvedLine[]): string {
  const sum = sumWeights(lines.map(({ mapped }) => ({ quantity: mapped.quantity, weight: mapped.weightLb as LineWeight })));
  return 'lb' in sum ? `Total product weight: ${formatLb(sum.lb)}` : `Total product weight not shown: ${sum.reasons.join('; ')}`;
}

/**
 * After a new ticket saves: the names of lines whose saved weight differs from the preview the screen showed
 * (a weight was approved in between). A failed read returns no names; the ticket page shows the saved weights.
 */
export async function weightsChangedWhileSaving(ticketId: string, lines: readonly TicketLineInput[],
  preview: readonly ResolvedLine[]): Promise<string[]> {
  const saved = await fetchBlendTicketWeights(ticketId);
  const after = resolveTicketLines(lines, { saved, current: null });
  const lb = (line: ResolvedLine | undefined) => (line?.mapped.weightLb && 'lb' in line.mapped.weightLb ? line.mapped.weightLb.lb : null);
  // A line the screen never previewed, or showed as unread (its read failed), is not reported as changed.
  return after.flatMap((line, index) => (lines[index].product_id && preview[index] && !preview[index].unread
    && lb(line) !== lb(preview[index]) ? [line.mapped.product_name] : []));
}

/**
 * After a save: one warning per line whose kept weight differs from the preview, or one saying the check could not
 * run. A preview that was not ready (still loading, or its read failed) is not compared, so it never reads "changed";
 * the user is told to reopen the ticket instead.
 */
export async function warnWeightsChangedWhileSaving(ticketId: string, lines: readonly TicketLineInput[],
  preview: { status: string; lines: readonly ResolvedLine[] }, warn: (message: string) => void, context: string): Promise<void> {
  // A line with no weight shown has nothing to compare with: say so instead of staying silent (never a false "changed").
  const notShown = lines.some((line, index) => line.product_id && (preview.status !== 'ready' || !preview.lines[index] || preview.lines[index].unread));
  if (notShown) warn('The ticket saved, but some weights were not shown before saving. Reopen the ticket to see the weights it kept.');
  if (preview.status !== 'ready') return;
  try {
    const names = await weightsChangedWhileSaving(ticketId, lines, preview.lines);
    names.forEach((name) => warn(`${name}'s weight changed while saving; the ticket keeps the saved weight`));
  } catch (error: unknown) {
    Sentry.captureException(toSentryError(error), { level: 'warning', extra: { context } });
    warn('The ticket saved, but its weights could not be checked. Reopen the ticket to see them.');
  }
}
