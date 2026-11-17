import { assertRpcResult, supabaseUntyped } from './db';
import { fetchAllRows, fetchAllRowsForIds, pageWithList } from './pagedRead';
import type { IngredientWorkbookRow, SetupWorkbookChemistryExport, WeightWorkbookRow } from './productSetupChemistryWorkbook';
import type { Json } from '../types/supabase';

export const SETUP_WORKBOOK_CHEMISTRY_SCOPE = 'setup-workbook-chemistry';
export const SETUP_CHEMISTRY_SAFE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function isSetupChemistryRetryExpired(createdAt: number, now = Date.now()): boolean {
  const age = now - createdAt;
  return !Number.isFinite(createdAt) || !Number.isFinite(now) || age < 0 || age >= SETUP_CHEMISTRY_SAFE_RETRY_WINDOW_MS;
}

export interface WeightPreviewRow {
  kind: 'density' | 'net_weight'; subject_id: string; name: string; expected_version: number;
  status: 'change' | 'unchanged' | 'stale' | 'invalid' | 'not_found'; problem?: string;
  before?: { value: string; source: string; source_note: string | null };
  after?: { value: string; source: string; source_note: string | null };
}
export interface WeightPreview { rows: WeightPreviewRow[] }
export type WeightTabRpcRow = Pick<WeightWorkbookRow,
  'kind' | 'subject_id' | 'expected_version' | 'value' | 'unit' | 'source' | 'source_note' | 'reason' | 'evidence'>;

/** Project display-bound workbook rows onto the exact DM-1b preview/commit contract. */
export function weightRowsToRpcRows(rows: readonly WeightWorkbookRow[]): WeightTabRpcRow[] {
  return rows.map(({ kind, subject_id, expected_version, value, unit, source, source_note, reason, evidence }) => ({
    kind, subject_id, expected_version, value, unit, source, source_note, reason, evidence,
  }));
}

export interface IngredientPreviewParent {
  parent_id: string; parent_name?: string; chemistry_version: number;
  status: 'unchanged' | 'proposal' | 'stale' | 'refused' | 'invalid' | 'not_found';
  problem?: string;
  has_delete?: boolean;
  items?: ProposalItem[];
}
export interface IngredientPreview { parents: IngredientPreviewParent[] }
export interface CommitWeightsResult { saved_count: number; saved: Array<{ kind: string; subject_id: string; name: string }> }
export interface CommitIngredientsResult {
  proposal_count: number;
  proposals: Array<{ proposal_id: string; parent_id: string; has_delete: boolean; base_chemistry_version: number; proposal_version: number; item_count: number }>;
}
export interface ProposalItem {
  kind: 'ingredient'; action: 'add' | 'change' | 'retire'; row_id?: string; name?: string; cas?: string | null;
  strength_value?: number | null; strength_unit?: string | null; strength_basis?: string | null;
  source?: string; source_note?: string;
}
export interface ChemistryChangeProposal {
  id: string; parent_id: string; items: ProposalItem[]; has_delete: boolean; base_chemistry_version: number;
  proposal_version: number; status: 'proposed'; created_by: string; created_at: string;
}
export interface ChemistryProposalItemView extends ProposalItem { display_name: string | null; unresolved: boolean }
export interface ChemistryProposalView extends ChemistryChangeProposal {
  parent_name: string | null; items: ChemistryProposalItemView[]; unresolved: boolean;
}
interface QueryResult<T> { data: T[] | null; error: { message: string } | null; count?: number | null }
interface ParentName { id: string; name: string }
interface IngredientLink { id: string; ingredient_id: string }
interface IngredientName { id: string; name: string; cas: string | null }

export async function loadSetupWorkbookChemistry(): Promise<SetupWorkbookChemistryExport> {
  const { data, error } = await supabaseUntyped.rpc('get_setup_workbook_chemistry');
  if (error) throw error;
  const serverRows = assertRpcResult<SetupWorkbookChemistryRpcExport>(data, 'get_setup_workbook_chemistry');
  return normalizeSetupWorkbookChemistry(serverRows);
}

interface SetupWorkbookChemistryRpcValue {
  source: string; source_note: string | null; lb_per_gal?: string; net_lb?: string;
}
interface SetupWorkbookChemistryRpcExport {
  densities: Array<Omit<SetupWorkbookChemistryExport['densities'][number], 'approved' | 'draft'> & {
    approved: SetupWorkbookChemistryRpcValue | null; draft: SetupWorkbookChemistryRpcValue | null;
  }>;
  net_weights: Array<Omit<SetupWorkbookChemistryExport['net_weights'][number], 'approved' | 'draft'> & {
    approved: SetupWorkbookChemistryRpcValue | null; draft: SetupWorkbookChemistryRpcValue | null;
  }>;
  parents: SetupWorkbookChemistryExport['parents'];
}

export function normalizeSetupWorkbookChemistry(data: SetupWorkbookChemistryRpcExport): SetupWorkbookChemistryExport {
  const normalizeValue = (value: SetupWorkbookChemistryRpcValue | null, field: 'lb_per_gal' | 'net_lb') => {
    if (!value) return null;
    const amount = value[field];
    if (typeof amount !== 'string' || !value.source) throw new Error(`get_setup_workbook_chemistry returned an invalid ${field} value.`);
    return { value: amount, source: value.source, source_note: value.source_note };
  };
  return {
    densities: data.densities.map(({ approved, draft, ...row }) => ({
      ...row, approved: normalizeValue(approved, 'lb_per_gal'), draft: normalizeValue(draft, 'lb_per_gal'),
    })),
    net_weights: data.net_weights.map(({ approved, draft, ...row }) => ({
      ...row, approved: normalizeValue(approved, 'net_lb'), draft: normalizeValue(draft, 'net_lb'),
    })),
    parents: data.parents,
  };
}

export async function previewSetupWeights(rows: WeightWorkbookRow[]): Promise<WeightPreview> {
  const { data, error } = await supabaseUntyped.rpc('preview_weights_tab', { p_rows: weightRowsToRpcRows(rows) as unknown as Json });
  if (error) throw error;
  return assertRpcResult<WeightPreview>(data, 'preview_weights_tab');
}

export async function previewSetupIngredients(rows: IngredientWorkbookRow[]): Promise<IngredientPreview> {
  const { data, error } = await supabaseUntyped.rpc('preview_ingredients_tab', { p_rows: rows as unknown as Json });
  if (error) throw error;
  return assertRpcResult<IngredientPreview>(data, 'preview_ingredients_tab');
}

function rowsOrThrow<T>(result: QueryResult<T>, label: string): T[] {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (!Array.isArray(result.data)) throw new Error(`${label}: the server returned no list`);
  return result.data;
}

async function proposalRows(): Promise<ChemistryChangeProposal[]> {
  const read = await fetchAllRows<ChemistryChangeProposal>((from, to) => pageWithList(
    supabaseUntyped.from('chemistry_change_proposals')
      .select('id, parent_id, items, has_delete, base_chemistry_version, proposal_version, status, created_by, created_at', { count: 'exact' })
      .eq('status', 'proposed').order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to),
  ));
  return rowsOrThrow(read, 'Open chemistry proposals');
}

async function parentsByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const read = await fetchAllRowsForIds<ParentName, string>(ids, (chunk, from, to) => pageWithList(
    supabaseUntyped.from('product_parents').select('id, name', { count: 'exact' }).in('id', chunk).order('id').range(from, to),
  ));
  return new Map(rowsOrThrow(read, 'Proposal parent names').map(({ id, name }) => [id, name]));
}

async function ingredientLinksByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const read = await fetchAllRowsForIds<IngredientLink, string>(ids, (chunk, from, to) => pageWithList(
    supabaseUntyped.from('product_parent_ingredients').select('id, ingredient_id', { count: 'exact' })
      .in('id', chunk).order('id').range(from, to),
  ));
  return new Map(rowsOrThrow(read, 'Proposal ingredient links').map(({ id, ingredient_id }) => [id, ingredient_id]));
}

async function ingredientsByIds(ids: string[]): Promise<Map<string, IngredientName>> {
  if (ids.length === 0) return new Map();
  const read = await fetchAllRowsForIds<IngredientName, string>(ids, (chunk, from, to) => pageWithList(
    supabaseUntyped.from('active_ingredients').select('id, name, cas', { count: 'exact' })
      .in('id', chunk).order('id').range(from, to),
  ));
  return new Map(rowsOrThrow(read, 'Proposal ingredient names').map((ingredient) => [ingredient.id, ingredient]));
}

export async function loadOpenChemistryProposals(): Promise<ChemistryProposalView[]> {
  const proposals = await proposalRows();
  const [parents, links] = await Promise.all([
    parentsByIds(proposals.map((proposal) => proposal.parent_id)),
    ingredientLinksByIds(proposals.flatMap((proposal) => proposal.items.flatMap((item) => item.row_id ? [item.row_id] : []))),
  ]);
  const ingredientNames = await ingredientsByIds([...links.values()]);
  return proposals.map((proposal) => {
    let unresolved = !parents.has(proposal.parent_id);
    const items = proposal.items.map((item): ChemistryProposalItemView => {
      const previous = item.row_id ? ingredientNames.get(links.get(item.row_id) ?? '') : undefined;
      const isNewAdd = item.action === 'add' && !item.row_id;
      const displayName = item.row_id ? previous?.name ?? null : isNewAdd ? item.name ?? null : null;
      const missingName = displayName === null || (Boolean(item.row_id) && !previous);
      unresolved ||= missingName;
      return { ...item, display_name: displayName, unresolved: missingName, cas: item.row_id ? previous?.cas ?? null : item.cas ?? null };
    });
    return { ...proposal, parent_name: parents.get(proposal.parent_id) ?? null, items, unresolved };
  });
}

