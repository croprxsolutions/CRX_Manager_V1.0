import { assertRpcResult, supabaseUntyped } from './db';
import type { ProductWeight, ProductWeightEvent, ProductWeightSource, WeightUnitFactors } from '../types';

// DM-2 (20261207100000_product_weights): weight per gallon on a liquid's parent and net weight per pack
// on a dry size stocked in Ea/Unit. These RPCs are not in the generated types yet.

export const WEIGHT_SOURCES: ReadonlyArray<{ value: ProductWeightSource; label: string }> = [
  { value: 'measured', label: 'Measured' },
  { value: 'sds', label: 'SDS' },
  { value: 'label', label: 'Label' },
  { value: 'supplier', label: 'Supplier' },
];
const SOURCE_TEXT: Record<string, string> = { measured: 'measured', sds: 'the SDS', label: 'the label', supplier: 'the supplier', unit: 'its stock unit' };
export const sourceText = (source: string | null | undefined) => (source ? SOURCE_TEXT[source] ?? source : 'an unknown source');

/** Trust order, highest first (measured > SDS > label > supplier); same as `_product_weight_trust_rank`. */
const TRUST: Record<ProductWeightSource, number> = { measured: 4, sds: 3, label: 2, supplier: 1 };
export const isLowerTrust = (next: ProductWeightSource, approved: string | null | undefined) =>
  approved != null && approved in TRUST && TRUST[next] < TRUST[approved as ProductWeightSource];

export interface WeightDraft {
  id: string;
  value: number;
  entered_value: number;
  entered_unit: 'lb_per_gal' | 'specific_gravity' | 'lb';
  source: ProductWeightSource;
  source_note: string | null;
  reason: string | null;
  evidence: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  basis: Record<string, unknown>;
}

export interface WeightSubject {
  kind: 'density' | 'net_weight';
  subject_id: string;
  version: number;
  parent_name?: string;
}

/** One product's entry in `get_product_weights`. */
export interface ProductWeightEntry {
  product_id: string;
  found: boolean;
  product_name?: string;
  product_form?: string | null;
  inventory_unit?: string | null;
  weight?: ProductWeight;
  subject?: WeightSubject | null;
  current_basis?: Record<string, unknown> | null;
  draft?: WeightDraft | null;
}

export interface ProductWeightsResult {
  read_at: string;
  units: WeightUnitFactors;
  products: Record<string, ProductWeightEntry>;
}

const MAX_WEIGHED_PRODUCTS = 500;

/**
 * Current weights for up to 500 distinct products in ONE call, so every weight and the unit map come from
 * one database snapshot. More than 500 is refused by name rather than read in two moments.
 */
export async function fetchProductWeights(productIds: readonly string[]): Promise<ProductWeightsResult> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length > MAX_WEIGHED_PRODUCTS) throw new Error('Too many products to weigh at once');
  const { data, error } = await supabaseUntyped.rpc('get_product_weights', { p_product_ids: ids });
  if (error) throw error;
  return assertRpcResult<ProductWeightsResult>(data, 'get_product_weights');
}

/** A draft can be approved only for the pack or formulation it was entered for (`approve_weights` re-checks). */
export function draftMatchesBasis(draft: WeightDraft, current: Record<string, unknown> | null | undefined): boolean {
  if (!current) return false;
  const keys = new Set([...Object.keys(draft.basis ?? {}), ...Object.keys(current)]);
  return [...keys].every((key) => JSON.stringify(draft.basis?.[key] ?? null) === JSON.stringify(current[key] ?? null));
}

const WATER_LB_PER_GAL = '8.345404';
const DECIMAL = /^\d+(\.\d+)?$/;

function toScaled(text: string): { n: bigint; scale: number } {
  const [whole, frac = ''] = text.split('.');
  return { n: BigInt(whole + frac), scale: frac.length };
}

/** Round a non-negative scaled integer to 4 decimals, half-up, and print it. */
function round4(n: bigint, scale: number): string {
  let v = n;
  if (scale > 4) {
    const div = 10n ** BigInt(scale - 4);
    v = (n + div / 2n) / div;
  } else {
    v = n * 10n ** BigInt(4 - scale);
  }
  const s = v.toString().padStart(5, '0');
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
}

/**
 * What the database will store for a typed weight, exactly (half-up to 4 decimals; specific gravity times
 * 8.345404 first). Null when the text is not a plain decimal number.
 */
export function storedWeightPreview(text: string, unit: 'lb_per_gal' | 'specific_gravity' | 'lb'): string | null {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const value = toScaled(trimmed);
  if (unit !== 'specific_gravity') return round4(value.n, value.scale);
  const water = toScaled(WATER_LB_PER_GAL);
  return round4(value.n * water.n, value.scale + water.scale);
}

export interface WeightWriteResult { version?: number; value_id?: string }

interface WeightWrite {
  subject: WeightSubject;
  value: string;
  unit: 'lb_per_gal' | 'specific_gravity';
  source: ProductWeightSource;
  note: string;
  /** Present for a correction (lower trust than the approved value). */
  correction?: { reason: string; evidence: string };
  key: string;
}

/** Saves an admin's typed weight as approved: set_* normally, correct_* with a reason and evidence. */
export async function saveWeight(write: WeightWrite): Promise<WeightWriteResult> {
  const { subject, correction, key } = write;
  const note = write.note.trim() || null;
  if (subject.kind === 'density') {
    const args = { p_parent_id: subject.subject_id, p_expected_density_version: subject.version, p_value: write.value,
      p_unit: write.unit, p_source: write.source, p_source_note: note };
    if (correction) {
      const { data, error } = await supabaseUntyped.rpc('correct_parent_density', {
        ...args, p_reason: correction.reason, p_evidence: correction.evidence, p_idempotency_key: key });
      if (error) throw error;
      return assertRpcResult<WeightWriteResult>(data, 'correct_parent_density');
    }
    const { data, error } = await supabaseUntyped.rpc('set_parent_density', { ...args, p_idempotency_key: key });
    if (error) throw error;
    return assertRpcResult<WeightWriteResult>(data, 'set_parent_density');
  }
  const args = { p_product_id: subject.subject_id, p_expected_version: subject.version, p_net_lb: write.value,
    p_source: write.source, p_source_note: note };
  if (correction) {
    const { data, error } = await supabaseUntyped.rpc('correct_size_net_weight', {
      ...args, p_reason: correction.reason, p_evidence: correction.evidence, p_idempotency_key: key });
    if (error) throw error;
    return assertRpcResult<WeightWriteResult>(data, 'correct_size_net_weight');
  }
  const { data, error } = await supabaseUntyped.rpc('set_size_net_weight', { ...args, p_idempotency_key: key });
  if (error) throw error;
  return assertRpcResult<WeightWriteResult>(data, 'set_size_net_weight');
}

/** Approves one workbook draft (`approve_weights`, one item). */
export async function approveWeightDraft(subject: WeightSubject, draftId: string, key: string): Promise<unknown> {
  const { data, error } = await supabaseUntyped.rpc('approve_weights', {
    p_items: [{ kind: subject.kind, subject_id: subject.subject_id, draft_id: draftId, expected_version: subject.version }],
    p_idempotency_key: key,
  });
  if (error) throw error;
  return assertRpcResult<unknown>(data, 'approve_weights');
}

/** The weight history of one parent (density) or size (net weight), newest first. */
export async function fetchWeightEvents(subject: WeightSubject, limit = 25): Promise<ProductWeightEvent[]> {
  const column = subject.kind === 'density' ? 'parent_id' : 'product_id';
  const { data, error } = await supabaseUntyped.from('product_weight_events')
    .select('id, subject_kind, parent_id, product_id, event_type, value_id, before_value, after_value, reason, evidence, actor_kind, changed_by, changed_by_name, changed_at')
    .eq(column, subject.subject_id)
    .order('changed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as ProductWeightEvent[];
}

/** Plain-English reason a product has no weight (the resolver's `none_reason`). */
export function noWeightMessage(name: string, reason: string | undefined, stockUnit?: string | null): string {
  switch (reason) {
    case 'no_parent': return `Put ${name} in a parent to record its weight`;
    case 'no_approved_weight': return `${name} has no approved weight yet`;
    case 'seed_or_each': return "Weight isn't tracked for seed or each products";
    case 'unknown_form': return `${name} has no form set`;
    case 'unit_not_convertible': return `${name}'s stock unit ${stockUnit || '(none)'} is not a weight or count unit, so it has no weight`;
    default: return `${name} has no weight`;
  }
}
