import { assertRpcResult, supabaseUntyped } from './db';
import { generateIdempotencyKey, isDefinitiveRpcRejection } from './idempotency';
import type {
  ActiveIngredientSummary, ChemistrySource, ChemistryStrengthBasis, ChemistryStrengthUnit, FertilizerBasis,
  FertilizerNutrient, ModeOfActionScheme, ParentActiveCosts, ParentChemistry, ParentChemistryPreview,
  IngredientChangePreview, IngredientWorklist,
} from '../types';

// DM-1 (20261209100000_product_chemistry, 20261211100000_product_chemistry_confirmed_swaps): a parent's
// ingredients, modes of action and fertilizer analysis, the ingredient list, and cost per lb of active.
// These RPCs are not in the generated types yet.

export const CHEMISTRY_SOURCES: ReadonlyArray<{ value: Exclude<ChemistrySource, 'epa_lookup'>; label: string }> = [
  { value: 'label', label: 'Label' },
  { value: 'sds', label: 'SDS' },
  { value: 'supplier', label: 'Supplier' },
  { value: 'other', label: 'Other' },
];
export const SOURCE_LABEL: Record<ChemistrySource, string> = { label: 'label', sds: 'SDS', supplier: 'supplier', other: 'other', epa_lookup: 'EPA lookup' };
export const UNIT_LABEL: Record<ChemistryStrengthUnit, string> = { pct_ww: '% w/w', lb_per_gal: 'lb/gal' };
export const BASIS_LABEL: Record<ChemistryStrengthBasis | FertilizerBasis, string> = {
  active_ingredient: 'a.i.', acid_equivalent: 'a.e.', elemental: 'elemental', oxide: 'oxide',
};
export const SCHEMES: ModeOfActionScheme[] = ['HRAC', 'FRAC', 'IRAC'];
export const NUTRIENTS: FertilizerNutrient[] = ['N', 'P', 'K', 'S', 'Ca', 'Mg', 'B', 'Cl', 'Co', 'Cu', 'Fe', 'Mn', 'Mo', 'Ni', 'Zn'];
/** How a label states an oxide nutrient (P is stored as P on the oxide basis, shown as P2O5). */
export const nutrientLabel = (nutrient: string, basis: string) =>
  (basis === 'oxide' ? ({ P: 'P₂O₅', K: 'K₂O' } as Record<string, string>)[nutrient] ?? nutrient : nutrient);

/** A typed number, or null when blank (unknown), or 'invalid'. */
export function parseAmount(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d*\.?\d+$|^\d+\.$/.test(trimmed)) return 'invalid';
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : 'invalid';
}

/** CAS format and check digit, as the database checks it (`_ingredient_cas_valid`). */
export function casValid(cas: string): boolean {
  const match = /^([1-9]\d{1,6})-(\d{2})-(\d)$/.exec(cas.trim());
  if (!match) return false;
  const digits = (match[1] + match[2]).split('').reverse();
  const sum = digits.reduce((total, digit, index) => total + Number(digit) * (index + 1), 0);
  return sum % 10 === Number(match[3]);
}

/** The database refusal token an error starts with ("CHEMISTRY_STALE: ..."), or null. */
/** A database message without its leading code, for showing on screen ("CODE: text" -> "Text."). */
export function plainRefusal(message: string): string {
  const text = message.replace(/^[A-Z][A-Z0-9_]*:\s*/, '');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;
}

export function refusalCode(error: unknown): string | null {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : null;
  return typeof message === 'string' ? /^([A-Z][A-Z0-9_]*)(?=$|[:\s])/.exec(message)?.[1] ?? null : null;
}

/** "41 % w/w a.i." or "strength unknown". */
export function strengthText(value: number | null, unit: ChemistryStrengthUnit, basis: ChemistryStrengthBasis): string {
  return value == null ? 'strength unknown' : `${value} ${UNIT_LABEL[unit]} ${BASIS_LABEL[basis]}`;
}

/** Exact whole cents (a whole-number string from the database) as dollars, without floating point. */
export function centsText(cents: string): string {
  if (!/^\d+$/.test(cents)) return cents;
  const padded = cents.padStart(3, '0');
  const whole = padded.slice(0, -2).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}.${padded.slice(-2)}`;
}

const REASONS: Record<string, string> = {
  DENSITY_NOT_APPROVED: 'no approved weight per gallon yet',
  DENSITY_INVALID: 'the approved weight per gallon is unusable',
  STRENGTH_EXCEEDS_DENSITY: 'the ingredients weigh more than the approved weight per gallon',
  STRENGTH_UNKNOWN: 'strength unknown',
  STRENGTH_UNIT_MISMATCH: 'lb/gal strength on a dry size',
  FRACTION_UNKNOWN: 'acid fraction unknown',
  NUTRIENT_NOT_OXIDE: 'no oxide factor for this nutrient',
  FORM_NOT_COSTED: 'seed and each products are not costed',
  COST_MISSING: 'no cost',
  COST_INVALID: 'the cost is not usable',
  COST_NOT_CENTS: 'the cost is not whole cents',
  UNIT_UNKNOWN: 'unknown priced unit',
  UNIT_NOT_SUPPORTED: 'metric priced unit, not supported yet',
  UNIT_IS_COUNT: 'priced per count unit',
  REFERENCE_UNSET: 'no reference size picked',
  REFERENCE_NOT_MEMBER: 'the reference size is no longer a size of this parent',
  REFERENCE_INACTIVE: 'the reference size is inactive',
};
/** A named refusal from the cost read in plain words ("priced per Ea" names the unit). */
export function costReasonText(reason: string, pricedUnit?: string | null): string {
  if ((reason === 'UNIT_IS_COUNT' || reason === 'UNIT_NOT_SUPPORTED' || reason === 'UNIT_UNKNOWN') && pricedUnit) {
    return `priced per ${pricedUnit}${reason === 'UNIT_NOT_SUPPORTED' ? ' (metric, not supported yet)' : reason === 'UNIT_UNKNOWN' ? ' (unknown unit)' : ''}`;
  }
  return REASONS[reason] ?? reason;
}

/** How an ingredient reads in a list: name, CAS or "needs CAS", and the acid it is measured as. */
export function ingredientLine(item: Pick<ActiveIngredientSummary, 'name' | 'cas' | 'is_parent_form' | 'canonical_name' | 'canonical_fraction'>): string {
  const parts = [item.cas ? `CAS ${item.cas}` : 'needs CAS'];
  if (item.is_parent_form) parts.push('the acid');
  else if (item.canonical_name) parts.push(`as ${item.canonical_name}${item.canonical_fraction != null ? ` × ${item.canonical_fraction}` : ''}`);
  return `${item.name} (${parts.join(', ')})`;
}

export interface NewIngredientDraft {
  name: string;
  cas: string;
  isAcid: boolean;
  acid: ActiveIngredientSummary | null;
  fraction: string;
}
export const EMPTY_NEW_INGREDIENT: NewIngredientDraft = { name: '', cas: '', isAcid: false, acid: null, fraction: '' };

/** A typed fraction (0 < f <= 1), null when blank, or 'invalid'. */
export function parseFraction(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return /^(0?\.\d+|1(\.0+)?|0)$/.test(trimmed) && value > 0 && value <= 1 ? value : 'invalid';
}

/** What is wrong with a new-ingredient draft, or null. The database checks all of it again. */
export function newIngredientProblem(draft: NewIngredientDraft): string | null {
  if (!draft.name.trim()) return 'Give the ingredient’s name.';
  if (draft.cas.trim() && !casValid(draft.cas)) return 'That CAS number is not valid (format or check digit).';
  const fraction = parseFraction(draft.fraction);
  if (fraction === 'invalid') return 'The fraction must be above 0 and at most 1, like 0.741.';
  if (fraction !== null && !draft.acid) return 'A fraction needs the acid it is measured as.';
  if (draft.isAcid && draft.acid) return 'An acid has no acid of its own.';
  return null;
}

/** The identity fields a new form sends (`_resolve_active_ingredient`). */
export function newIngredientFields(draft: NewIngredientDraft): Record<string, unknown> {
  const fraction = parseFraction(draft.fraction);
  return {
    name: draft.name.trim(),
    ...(draft.cas.trim() ? { cas: draft.cas.trim() } : {}),
    ...(draft.isAcid ? { is_parent_form: true } : {}),
    ...(draft.acid ? { canonical_ingredient_id: draft.acid.id } : {}),
    ...(typeof fraction === 'number' ? { canonical_fraction: fraction, fraction_basis: 'acid_equivalent' } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function fetchParentChemistry(parentId: string): Promise<ParentChemistry> {
  const { data, error } = await supabaseUntyped.rpc('get_parent_chemistry', { p_parent_id: parentId });
  if (error) throw error;
  return assertRpcResult<ParentChemistry>(data, 'get_parent_chemistry');
}

async function fetchParentActiveCosts(parentId: string): Promise<ParentActiveCosts> {
  const { data, error } = await supabaseUntyped.rpc('get_parent_active_costs', { p_parent_id: parentId });
  if (error) throw error;
  return assertRpcResult<ParentActiveCosts>(data, 'get_parent_active_costs');
}

/** The cost reference row's version (0 when none), which `set_parent_cost_reference` checks. Admin read. */
async function fetchCostReferenceVersion(parentId: string): Promise<number> {
  const { data, error } = await supabaseUntyped.from('product_parent_cost_reference')
    .select('row_version').eq('parent_id', parentId).maybeSingle();
  if (error) throw error;
  return (data as { row_version: number } | null)?.row_version ?? 0;
}

/**
 * The costs and the reference version they were read at. The version only grows, so the same version before and
 * after the costs read means the costs show that version's reference (a change in between reads again).
 */
export async function fetchActiveCostsWithVersion(parentId: string): Promise<{ costs: ParentActiveCosts; refVersion: number }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await fetchCostReferenceVersion(parentId);
    const costs = await fetchParentActiveCosts(parentId);
    if (await fetchCostReferenceVersion(parentId) === before) return { costs, refVersion: before };
  }
  throw new Error('The reference size kept changing while loading; try again.');
}

export async function searchActiveIngredients(text: string): Promise<ActiveIngredientSummary[]> {
  const { data, error } = await supabaseUntyped.rpc('search_active_ingredients', { p_text: text, p_limit: 20 });
  if (error) throw error;
  return assertRpcResult<ActiveIngredientSummary[]>(data, 'search_active_ingredients');
}

export async function fetchIngredientWorklist(): Promise<IngredientWorklist> {
  const { data, error } = await supabaseUntyped.rpc('get_active_ingredient_worklist');
  if (error) throw error;
  return assertRpcResult<IngredientWorklist>(data, 'get_active_ingredient_worklist');
}

export async function previewChemistryCorrection(parentId: string, changes: ChemistryChange[]): Promise<ParentChemistryPreview> {
  const { data, error } = await supabaseUntyped.rpc('preview_parent_chemistry_correction', { p_parent_id: parentId, p_changes: changes });
  if (error) throw error;
  return assertRpcResult<ParentChemistryPreview>(data, 'preview_parent_chemistry_correction');
}

export async function previewIngredientChange(ingredientId: string, fields: IngredientFields): Promise<IngredientChangePreview> {
  const { data, error } = await supabaseUntyped.rpc('preview_active_ingredient_change', { p_ingredient_id: ingredientId, p_fields: fields });
  if (error) throw error;
  return assertRpcResult<IngredientChangePreview>(data, 'preview_active_ingredient_change');
}

// ---------------------------------------------------------------------------------------------
// Writes: every one keeps its retry key in local storage until the outcome is known (sheet section 6)
// ---------------------------------------------------------------------------------------------

/** One entry of `p_changes`: see `_apply_parent_chemistry` for the fields each kind and action takes. */
export type ChemistryChange = Record<string, unknown> & { kind: 'ingredient' | 'mode_of_action' | 'fertilizer'; action?: string };
/** Ingredient identity fields (`save_active_ingredient` / `preview_active_ingredient_change`). */
export type IngredientFields = Partial<{
  name: string; cas: string | null; canonical_ingredient_id: string | null; canonical_fraction: number | null;
  fraction_basis: 'acid_equivalent' | null; is_parent_form: boolean;
}>;

const CHEMISTRY_RPCS = [
  'set_parent_chemistry', 'correct_parent_chemistry', 'set_parent_cost_reference',
  'save_active_ingredient', 'retire_active_ingredient', 'reactivate_active_ingredient',
] as const;
export type ChemistryRpc = typeof CHEMISTRY_RPCS[number];

/** An unfinished save: kept until a success or a named refusal from the database. */
export interface PendingChemistrySave {
  key: string;
  userId: string;
  /** The parent ID for parent writes; `INGREDIENT_SCOPE` for ingredient-list writes. */
  scope: string;
  rpc: ChemistryRpc;
  args: Record<string, unknown>;
  /** What the admin was doing, in words, for the "finish the save you started" prompt. */
  label: string;
  createdAt: number;
}

export const INGREDIENT_SCOPE = 'ingredients';
const PREFIX = 'crx:chemistry-pending:v1:';

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** The signed-in user's unfinished saves for one scope, oldest first. Another user's records are never returned. */
export function pendingSaves(userId: string, scope: string): PendingChemistrySave[] {
  const store = storage();
  if (!store || !userId) return [];
  const found: PendingChemistrySave[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const name = store.key(index);
    if (!name?.startsWith(PREFIX)) continue;
    try {
      const record = JSON.parse(store.getItem(name) ?? 'null') as PendingChemistrySave | null;
      if (record && (CHEMISTRY_RPCS as readonly string[]).includes(record.rpc) && record.userId === userId && record.scope === scope && record.key === name.slice(PREFIX.length)) found.push(record);
    } catch { /* a damaged record is left alone; it matches no user */ }
  }
  return found.sort((a, b) => a.createdAt - b.createdAt);
}

/** Thrown when a save's outcome is unknown (network error, timeout, gateway error): its record is kept. */
export class ChemistrySaveUncertain extends Error {
  constructor(readonly cause: unknown) {
    super('We could not confirm the save. Finish it from the notice on this product; it reuses the same retry key.');
  }
}

/** One literal call per write, so each is checked by name; the result is checked only when the database accepted it. */
async function callChemistryWrite(rpc: ChemistryRpc, params: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }> {
  switch (rpc) {
    case 'set_parent_chemistry': {
      const { data, error } = await supabaseUntyped.rpc('set_parent_chemistry', params);
      return error ? { error } : { data: assertRpcResult(data, 'set_parent_chemistry') };
    }
    case 'correct_parent_chemistry': {
      const { data, error } = await supabaseUntyped.rpc('correct_parent_chemistry', params);
      return error ? { error } : { data: assertRpcResult(data, 'correct_parent_chemistry') };
    }
    case 'set_parent_cost_reference': {
      const { data, error } = await supabaseUntyped.rpc('set_parent_cost_reference', params);
      return error ? { error } : { data: assertRpcResult(data, 'set_parent_cost_reference') };
    }
    case 'save_active_ingredient': {
      const { data, error } = await supabaseUntyped.rpc('save_active_ingredient', params);
      return error ? { error } : { data: assertRpcResult(data, 'save_active_ingredient') };
    }
    case 'retire_active_ingredient': {
      const { data, error } = await supabaseUntyped.rpc('retire_active_ingredient', params);
      return error ? { error } : { data: assertRpcResult(data, 'retire_active_ingredient') };
    }
    case 'reactivate_active_ingredient': {
      const { data, error } = await supabaseUntyped.rpc('reactivate_active_ingredient', params);
      return error ? { error } : { data: assertRpcResult(data, 'reactivate_active_ingredient') };
    }
  }
}

async function send<T>(record: PendingChemistrySave): Promise<T> {
  const store = storage();
  const name = PREFIX + record.key;
  // Written before the call, so a closed tab or a refresh still finds it. No record, no send: an unconfirmed
  // save could then only be retried with a new key.
  try {
    if (!store) throw new Error('no storage');
    store.setItem(name, JSON.stringify(record));
  } catch {
    throw new Error('This browser cannot keep the save record this needs (private window or storage full?). Nothing was sent.');
  }
  let result: { data?: unknown; error?: unknown };
  try {
    result = await callChemistryWrite(record.rpc, { ...record.args, p_idempotency_key: record.key });
  } catch (error) {
    throw new ChemistrySaveUncertain(error);
  }
  if (result.error) {
    if (isDefinitiveRpcRejection(result.error)) {
      store?.removeItem(name);
      throw result.error;
    }
    throw new ChemistrySaveUncertain(result.error);
  }
  store?.removeItem(name);
  return result.data as T;
}

/** A new save with a fresh retry key. Refused while the same user has an unfinished save in that scope. */
export function startChemistrySave<T>(userId: string, scope: string, rpc: ChemistryRpc, args: Record<string, unknown>, label: string): Promise<T> {
  if (pendingSaves(userId, scope).length > 0) {
    return Promise.reject(new Error('Finish the save you started first (see the notice above).'));
  }
  return send<T>({ key: generateIdempotencyKey(rpc, userId), userId, scope, rpc, args, label, createdAt: Date.now() });
}

/** Sends an unfinished save again with its own key and request: the database returns the saved result if it committed. */
export function finishChemistrySave<T>(record: PendingChemistrySave): Promise<T> {
  return send<T>(record);
}
