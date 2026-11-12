import { assertRpcResult, supabaseUntyped } from './db';
import { strengthText } from './productChemistry';
import type {
  ChemistryStrengthBasis, ChemistryStrengthUnit, EpaChemistryProposal, EpaCommitItemResult, EpaLinkKind, EpaLookup,
  EpaLookupFailure, EpaLookupFailureReason, EpaProposalHoldReason, EpaProposalItem, EpaProposalItemClass,
} from '../types';

// DM-4 (20270105110000_epa_chemistry_proposals): EPA auto-fill. The screen starts a lookup, the epa-lookup Edge
// Function asks EPA and records the answer, and an admin commits or rejects the proposal. Nothing is written to
// chemistry or the registration until an admin commits (D-I). These RPCs are not in the generated types yet.

export interface StartedEpaLookup {
  lookup_id: string;
  epa_registration: string;
  link_kind: EpaLinkKind;
  link_id: string;
  registration_version: number;
  chemistry_version: number;
}

export type EpaCommitResult =
  | { status: 'held'; proposal_id: string; hold_reason: EpaProposalHoldReason; proposal_version: number }
  | {
    status: 'committed'; proposal_id: string; chemistry_version: number; registration_version: number;
    counts: Partial<Record<EpaCommitItemResult, number>>; commit_result: Record<string, EpaCommitItemResult>;
    posted_sales_to_record: unknown[];
  };

export interface EpaDecision { item_id: string; accept: boolean }

/** As the database's `_normalize_epa_registration`: whitespace removed, upper case, blank is none. */
export function normalizeEpaNumber(text: string | null | undefined): string | null {
  const value = (text ?? '').replace(/\s/g, '').toUpperCase();
  return value === '' ? null : value;
}

export async function startEpaLookup(parentId: string, epaRegistration: string, idempotencyKey: string): Promise<StartedEpaLookup> {
  const { data, error } = await supabaseUntyped.rpc('start_epa_lookup', {
    p_parent_id: parentId, p_epa_registration: epaRegistration, p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<StartedEpaLookup>(data, 'start_epa_lookup');
}

export async function commitEpaProposal(
  proposalId: string, expectedVersion: number, decisions: EpaDecision[], idempotencyKey: string,
): Promise<EpaCommitResult> {
  const { data, error } = await supabaseUntyped.rpc('commit_epa_proposal', {
    p_proposal_id: proposalId, p_expected_proposal_version: expectedVersion, p_decisions: decisions,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<EpaCommitResult>(data, 'commit_epa_proposal');
}

export async function rejectEpaProposal(proposalId: string, expectedVersion: number, reason: string, idempotencyKey: string): Promise<void> {
  const { data, error } = await supabaseUntyped.rpc('reject_epa_proposal', {
    p_proposal_id: proposalId, p_expected_proposal_version: expectedVersion, p_reason: reason, p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  assertRpcResult(data, 'reject_epa_proposal');
}

export interface ParentEpaState {
  /** Every distinct EPA number on the parent: its own, its sizes', its active brands' and its sizes' legacy brands'. */
  numbers: string[];
  lookups: EpaLookup[];
  proposals: EpaChemistryProposal[];
  failures: EpaLookupFailure[];
}

async function rows<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

/** The same four places `start_epa_lookup` and the typed-chemistry gate read. */
async function fetchParentEpaNumbers(parentId: string): Promise<string[]> {
  const [parents, members, brands] = await Promise.all([
    rows<{ generic_epa_registration: string | null }>(supabaseUntyped.from('product_parents')
      .select('generic_epa_registration').eq('id', parentId)),
    rows<{ product_id: string }>(supabaseUntyped.from('product_parent_members').select('product_id').eq('parent_id', parentId)),
    rows<{ epa_registration: string | null }>(supabaseUntyped.from('product_parent_brands')
      .select('epa_registration').eq('parent_id', parentId).eq('status', 'active')),
  ]);
  const productIds = members.map((m) => m.product_id);
  const [sizes, legacy] = productIds.length === 0 ? [[], []] : await Promise.all([
    rows<{ epa_registration: string | null }>(supabaseUntyped.from('products').select('epa_registration').in('id', productIds)),
    rows<{ epa_registration: string | null }>(supabaseUntyped.from('product_brands').select('epa_registration').in('product_id', productIds)),
  ]);
  const all = [parents[0]?.generic_epa_registration, ...sizes.map((r) => r.epa_registration), ...brands.map((r) => r.epa_registration),
    ...legacy.map((r) => r.epa_registration)].map(normalizeEpaNumber).filter((n): n is string => n !== null);
  return [...new Set(all)].sort();
}

export async function fetchParentEpaState(parentId: string): Promise<ParentEpaState> {
  const [numbers, lookups, proposals, failures] = await Promise.all([
    fetchParentEpaNumbers(parentId),
    rows<EpaLookup>(supabaseUntyped.from('epa_lookups').select('*').eq('parent_id', parentId)
      .order('requested_at', { ascending: false }).order('id', { ascending: false })),
    rows<EpaChemistryProposal>(supabaseUntyped.from('epa_chemistry_proposals').select('*').eq('parent_id', parentId)
      .order('created_at', { ascending: false })),
    rows<EpaLookupFailure>(supabaseUntyped.from('epa_lookup_failures').select('*').eq('parent_id', parentId)
      .order('created_at', { ascending: false })),
  ]);
  return { numbers, lookups, proposals, failures };
}

/** record_epa_lookup refuses a pending lookup older than this; the gate ignores it too. */
const LOOKUP_EXPIRY_MS = 30 * 60 * 1000;

export interface NumberSummary {
  /** The proposal waiting for a decision (proposed or held), if any. */
  open: EpaChemistryProposal | null;
  /** The newest lookup that was not replaced: still running, or what it produced. */
  latest:
    | { kind: 'none' }
    | { kind: 'running'; lookup: EpaLookup }
    | { kind: 'proposal'; proposal: EpaChemistryProposal }
    | { kind: 'failure'; failure: EpaLookupFailure };
  /** The newest committed proposal, for the differences EPA showed that were kept (D-L). */
  committed: EpaChemistryProposal | null;
}

export function summarizeNumber(state: ParentEpaState, epaNumber: string, now: number): NumberSummary {
  const proposals = state.proposals.filter((p) => p.epa_registration === epaNumber);
  const open = proposals.find((p) => p.status === 'proposed' || p.status === 'held') ?? null;
  const committed = proposals.find((p) => p.status === 'committed') ?? null;
  const newest = state.lookups.find((l) => l.epa_registration === epaNumber && l.status !== 'abandoned');
  let latest: NumberSummary['latest'] = { kind: 'none' };
  if (newest?.status === 'pending' && now - Date.parse(newest.requested_at) < LOOKUP_EXPIRY_MS) {
    latest = { kind: 'running', lookup: newest };
  } else if (newest?.status === 'recorded') {
    const proposal = proposals.find((p) => p.lookup_id === newest.id);
    const failure = state.failures.find((f) => f.lookup_id === newest.id);
    if (proposal) latest = { kind: 'proposal', proposal };
    else if (failure) latest = { kind: 'failure', failure };
  }
  return { open, latest, committed };
}

/** Items the admin may tick; every other class is a difference: shown, never written (D-L). */
export const WRITABLE_CLASSES: ReadonlySet<EpaProposalItemClass> = new Set(['add', 'add_name_only', 'fill', 'confirm', 'rup_upgrade']);

export const CLASS_LABEL: Record<EpaProposalItemClass, string> = {
  add: 'New', add_name_only: 'New, no CAS', fill: 'Fill in', confirm: 'Matches', rup_upgrade: 'Restricted use',
  differs: 'Differs', differs_typed: 'Differs from typed', differs_epa: 'Differs', differs_identity: 'Differs',
  epa_conflict: 'EPA unclear', ingredient_retired: 'Retired ingredient', matches: 'Matches', missing_from_epa: 'Not on EPA',
};

export const FAILURE_LABEL: Record<EpaLookupFailureReason, string> = {
  not_found: 'EPA has no record of this number',
  transferred: 'EPA moved this registration',
  upstream_error: 'EPA could not be reached',
  invalid_result: 'EPA sent an answer that could not be read',
};

export const HOLD_LABEL: Record<EpaProposalHoldReason, string> = {
  relinked: 'The EPA number moved on this product after the lookup.',
  chemistry_changed: "This product's chemistry changed after the lookup.",
  registration_changed: "The registration's label facts changed after the lookup.",
};

const LABEL_FACT: Record<string, string> = {
  signal_word: 'Signal word', rup_status: 'Restricted use', registration_status: 'Registration status',
  label_document: 'Label date and link',
};

type IngredientSide = { name?: string; cas?: string | null; strength?: number | null; strength_value?: number | null;
  strength_unit?: ChemistryStrengthUnit; strength_basis?: ChemistryStrengthBasis; source?: string };

export function itemName(item: EpaProposalItem): string {
  if (item.kind === 'label') return LABEL_FACT[item.item_id.replace(/^label:/, '')] ?? item.item_id;
  const side = (item.epa ?? item.current) as IngredientSide | null;
  return side?.name ?? 'Ingredient';
}

function ingredientText(side: IngredientSide, fromEpa: boolean): string {
  const strength = fromEpa
    ? (side.strength == null ? 'strength unknown' : `${side.strength} % w/w a.i.`)
    : strengthText(side.strength_value ?? null, side.strength_unit ?? 'pct_ww', side.strength_basis ?? 'active_ingredient');
  const source = !fromEpa && side.source ? (side.source === 'epa_lookup' ? ', from EPA' : ', typed') : '';
  return `${strength}${side.cas ? ` · CAS ${side.cas}` : ''}${source}`;
}

function labelText(fact: string, value: unknown): string {
  if (fact === 'registration_status') {
    if (typeof value === 'boolean') return value ? 'Cancelled' : 'Active';
    return typeof value === 'string' ? value.charAt(0).toUpperCase() + value.slice(1) : '—';
  }
  if (fact === 'label_document') {
    const doc = value as { label_accepted_on?: string | null; label_url?: string | null } | null;
    if (!doc) return '—';
    return `${doc.label_accepted_on ? `accepted ${doc.label_accepted_on}` : 'no date'}${doc.label_url ? ', with link' : ''}`;
  }
  if (typeof value === 'string') return value.charAt(0).toUpperCase() + value.slice(1);
  return '—';
}

/** "What we have now" or "what EPA says" for one item, in words. */
export function sideText(item: EpaProposalItem, side: 'epa' | 'current'): string {
  const value = item[side];
  if (value == null) return '—';
  if (item.kind === 'ingredient') return ingredientText(value as IngredientSide, side === 'epa');
  return labelText(item.item_id.replace(/^label:/, ''), value);
}

export interface EpaLookupOverview {
  failures: EpaLookupFailure[];
  open: Pick<EpaChemistryProposal, 'id' | 'parent_id' | 'epa_registration' | 'status' | 'hold_reason' | 'created_at'>[];
  /** parent id → its name and one size to open the product page on. */
  parents: Map<string, { name: string; productId: string | null }>;
}

/** shortcut: the newest 500 failures only; page through them if the list ever outgrows that. */
const OVERVIEW_FAILURE_LIMIT = 500;

/** The EPA lookups page (admin): failed lookups by number, and proposals waiting for a decision. */
export async function fetchEpaLookupOverview(): Promise<EpaLookupOverview> {
  const [failures, open] = await Promise.all([
    rows<EpaLookupFailure>(supabaseUntyped.from('epa_lookup_failures').select('*')
      .order('created_at', { ascending: false }).limit(OVERVIEW_FAILURE_LIMIT)),
    rows<EpaLookupOverview['open'][number]>(supabaseUntyped.from('epa_chemistry_proposals')
      .select('id, parent_id, epa_registration, status, hold_reason, created_at').in('status', ['proposed', 'held'])
      .order('created_at', { ascending: false })),
  ]);
  const parentIds = [...new Set([...failures, ...open].map((r) => r.parent_id))];
  const parents = new Map<string, { name: string; productId: string | null }>();
  if (parentIds.length === 0) return { failures, open, parents };
  const [names, members] = await Promise.all([
    rows<{ id: string; name: string }>(supabaseUntyped.from('product_parents').select('id, name').in('id', parentIds)),
    rows<{ product_id: string; parent_id: string }>(supabaseUntyped.from('product_parent_members')
      .select('product_id, parent_id').in('parent_id', parentIds).order('product_id')),
  ]);
  for (const parent of names) {
    parents.set(parent.id, { name: parent.name, productId: members.find((m) => m.parent_id === parent.id)?.product_id ?? null });
  }
  return { failures, open, parents };
}
