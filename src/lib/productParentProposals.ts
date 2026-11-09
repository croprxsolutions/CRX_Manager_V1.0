import { assertRpcResult, supabaseUntyped } from './db';
import { sanitizeError } from './errorSanitizer';
import { fetchAllRows, pageWithList } from './pagedRead';
import { previewProductRateCorrection } from './productRateLock';
import type { ProductRatePerAcre } from '../types';

/**
 * PAR-2 "Group products" (build sheet section 5, migrations 20261123120000 and 20261201110000).
 * The proposal tables are admin-read only and written only by these RPCs; the generated types do not
 * list them yet, so reads and calls go through the untyped client.
 */

export type ProposalGroupStatus = 'proposed' | 'approved' | 'rejected' | 'held';
export type SizeRole = 'package' | 'bulk' | 'fixed_tote';

export interface ProposalMemberBrand {
  brand_id: string;
  row_version: number;
  brand_name: string;
  epa_registration: string | null;
  manufacturer: string | null;
  is_currently_sourced: boolean;
  is_rup: boolean | null;
  signal_word: string | null;
}

/** The allow-listed member view the proposal stores (no cost, price or stock). */
export interface ProposalMember {
  product_id: string;
  product_name: string;
  sku: string | null;
  product_form: string | null;
  container_size: string | null;
  container_unit: string | null;
  inventory_unit: string | null;
  is_active: boolean;
  category: string | null;
  use_timings: string[] | null;
  rate_per_acre: string | null;
  rate_unit: string | null;
  suggested_rate: string | null;
  epa_registration: string | null;
  manufacturer: string | null;
  suggested_size_role: SizeRole;
  brands: ProposalMemberBrand[];
}

export interface RateValues {
  rate_per_acre: string | null;
  rate_unit: string | null;
  suggested_rate: string | null;
}

/** Every copied field where the sizes disagree, with each distinct value. */
export interface ProposalConflicts {
  category?: (string | null)[];
  use_timings?: (string[] | null)[];
  rates?: RateValues[];
}
export type ConflictField = keyof ProposalConflicts;

export const CONFLICT_LABELS: Record<ConflictField, string> = {
  category: 'Category',
  use_timings: 'Use Timing',
  rates: 'Rate per acre',
};


export interface ProposalGroup {
  id: string;
  proposal_id: string;
  suggested_name: string;
  product_form: string | null;
  generic_epa_registration: string | null;
  identity_basis: 'epa_number' | 'owner_confirmed' | null;
  members: ProposalMember[];
  conflicts: ProposalConflicts;
  flags: string[];
  group_fingerprint: string;
  status: ProposalGroupStatus;
  parent_id: string | null;
  decided_at: string | null;
  reason: string | null;
}

export interface Proposal {
  id: string;
  proposal_version: number;
  status: 'open' | 'superseded' | 'closed';
  built_at: string;
}

export interface DuplicateParent {
  generic_epa_registration: string | null;
  product_form: string | null;
  names: string[];
}

export interface BuildResult {
  proposal_id: string;
  proposal_version: number;
  group_count: number;
  held_count: number;
  rejected_count: number;
  duplicate_parents: DuplicateParent[];
}

/** Plain-English names for the flags the build sets. */
export const FLAG_LABELS: Record<string, string> = {
  same_epa_different_name: 'Same EPA number as a group with a different name',
  manufacturer_differs: 'Manufacturer differs',
  inactive_member: 'Has an inactive size',
  two_bulk_candidates: 'Two Bulk sizes',
  tote_without_bulk: 'Tote with no Bulk size',
  brand_lists_differ: 'Brand lists differ',
  epa_has_parent: 'EPA number already has a parent',
  owner_confirmation_needed: 'No EPA number: confirm same product',
  form_missing: 'Product form missing',
  name_missing: 'Name is only a size',
  fill_missing_epa: 'Some sizes miss the EPA number',
  epa_unreadable: 'EPA number unreadable',
  ambiguous_strength_token: 'Names differ by a strength token',
  size_numbers_differ: 'Different numbers in the names',
  rejected_before: 'Rejected before',
};

export const SIZE_ROLE_LABELS: Record<SizeRole, string> = {
  package: 'Package',
  bulk: 'Bulk',
  fixed_tote: 'Tote',
};

const GROUP_COLUMNS =
  'id, proposal_id, suggested_name, product_form, generic_epa_registration, identity_basis, members, conflicts, flags, group_fingerprint, status, parent_id, decided_at, reason';

/** The newest proposal (open, or the last one built), or null before the first build. */
export async function loadLatestProposal(): Promise<Proposal | null> {
  const { data, error } = await supabaseUntyped
    .from('product_parent_proposals')
    .select('id, proposal_version, status, built_at')
    .order('proposal_version', { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as Proposal[])[0] ?? null;
}

/** Whether product grouping is switched on (admin only). While it is off, approval is always refused. */
export async function loadGroupingOpen(): Promise<boolean> {
  const { data, error } = await supabaseUntyped.rpc('get_product_grouping_open');
  if (error) throw error;
  return assertRpcResult<boolean>(data, 'get_product_grouping_open');
}

/** Every group of one proposal, read in pages so a large catalogue is never cut at the 1,000-row cap. */
export async function loadProposalGroups(proposalId: string): Promise<ProposalGroup[]> {
  const { data, error } = await fetchAllRows<ProposalGroup>((from, to) => pageWithList(supabaseUntyped
    .from('product_parent_proposal_groups')
    .select(GROUP_COLUMNS, { count: 'exact' })
    .eq('proposal_id', proposalId)
    .order('suggested_name')
    .order('id')
    .range(from, to)));
  if (error) throw error;
  return data ?? [];
}

export async function buildProposal(idempotencyKey: string): Promise<BuildResult> {
  const { data, error } = await supabaseUntyped.rpc('build_product_parent_proposal', { p_idempotency_key: idempotencyKey });
  if (error) throw error;
  return assertRpcResult<BuildResult>(data, 'build_product_parent_proposal');
}

export async function decideGroup(input: {
  decision: 'hold' | 'reject';
  group: ProposalGroup;
  proposalVersion: number;
  reason: string;
  idempotencyKey: string;
}): Promise<void> {
  const args = {
    p_group_id: input.group.id,
    p_expected_proposal_version: input.proposalVersion,
    p_group_fingerprint: input.group.group_fingerprint,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  };
  // Literal RPC names, so the repo's RPC scans can check each one.
  if (input.decision === 'hold') {
    const { data, error } = await supabaseUntyped.rpc('hold_product_parent_group', args);
    if (error) throw error;
    assertRpcResult(data, 'hold_product_parent_group');
    return;
  }
  const { data, error } = await supabaseUntyped.rpc('reject_product_parent_group', args);
  if (error) throw error;
  assertRpcResult(data, 'reject_product_parent_group');
}

/** What the admin chose for one group on the screen. */
export interface GroupDraft {
  name: string;
  /** Index into each conflict's value list. */
  picks: Partial<Record<ConflictField, number>>;
  ownerConfirmed: boolean;
  sizeRoles: Record<string, SizeRole>;
  /** product_id → shop-filled answer; missing = not answered yet. */
  totes: Record<string, boolean>;
  /** lower-case brand name → keep it, and which size's row to keep. */
  brands: Record<string, { keep: boolean; sourceBrandId: string | null }>;
}

function isFertilizer(category: string | null): boolean {
  return (category ?? '').toLowerCase().includes('fertilizer');
}

/** The parent's category as approval sets it: the picked value, else the first size's (the sizes agree). */
export function parentIsFertilizer(group: ProposalGroup, draft: GroupDraft): boolean {
  const pick = draft.picks.category;
  const category = group.conflicts.category && pick !== undefined ? group.conflicts.category[pick] : group.members[0]?.category ?? null;
  return isFertilizer(category);
}

export function rateText(r: Pick<RateValues, 'rate_per_acre' | 'rate_unit' | 'suggested_rate'>): string {
  const rate = r.rate_per_acre === null ? 'no rate' : `${r.rate_per_acre} ${r.rate_unit ?? ''}`.trim();
  return r.suggested_rate ? `${rate} (suggested ${r.suggested_rate})` : rate;
}

export function conflictValueText(field: ConflictField, value: unknown): string {
  if (field === 'rates') return rateText(value as RateValues);
  if (field === 'use_timings') return Array.isArray(value) && value.length > 0 ? value.join(', ') : 'none';
  return value === null || value === '' ? 'none' : String(value);
}

/** Every fact that can differ between two versions of a brand, so the admin can tell them apart. */
export function brandVariantText(b: ProposalMemberBrand): string {
  return [
    `EPA ${b.epa_registration ?? 'none'}`,
    b.manufacturer ?? 'no manufacturer',
    b.is_rup === null ? 'RUP not set' : b.is_rup ? 'Restricted use' : 'Not restricted use',
    b.signal_word ?? 'no signal word',
    b.is_currently_sourced ? 'sourced' : 'not sourced',
  ].join(' · ');
}

/** Distinct brand variants per lower-case name across the sizes (one entry per distinct set of facts). */
export function brandVariants(group: ProposalGroup): Map<string, ProposalMemberBrand[]> {
  const byName = new Map<string, ProposalMemberBrand[]>();
  for (const member of group.members) {
    for (const brand of member.brands ?? []) {
      const key = brand.brand_name.toLowerCase();
      const facts = JSON.stringify([brand.brand_name, brand.epa_registration, brand.manufacturer,
        brand.is_currently_sourced, brand.is_rup, brand.signal_word]);
      const list = byName.get(key) ?? [];
      if (!list.some((b) => JSON.stringify([b.brand_name, b.epa_registration, b.manufacturer,
        b.is_currently_sourced, b.is_rup, b.signal_word]) === facts)) list.push(brand);
      byName.set(key, list);
    }
  }
  return byName;
}

/** The screen's starting answers: suggested name and roles, chemical totes vendor-filled (DATA-12). */
export function initialDraft(group: ProposalGroup): GroupDraft {
  const sizeRoles: Record<string, SizeRole> = {};
  const totes: Record<string, boolean> = {};
  const categories = new Set(group.members.map((m) => m.category));
  for (const member of group.members) {
    sizeRoles[member.product_id] = member.suggested_size_role;
    // Only fertilizer totes can be shop-filled, so a chemical tote's answer is known; a fertilizer tote waits for one.
    if (member.suggested_size_role === 'fixed_tote' && ![...categories].some(isFertilizer)) totes[member.product_id] = false;
  }
  const brands: GroupDraft['brands'] = {};
  for (const [name, variants] of brandVariants(group)) {
    brands[name] = { keep: true, sourceBrandId: variants.length === 1 ? variants[0].brand_id : null };
  }
  return { name: group.suggested_name, picks: {}, ownerConfirmed: false, sizeRoles, totes, brands };
}

/** The parent's rates after approval: the picked value, or the first size's when they agree. */
export function chosenRates(group: ProposalGroup, draft: GroupDraft): RateValues | null {
  const options = group.conflicts.rates;
  if (options) {
    const pick = draft.picks.rates;
    return pick === undefined ? null : options[pick] ?? null;
  }
  const first = group.members[0];
  return { rate_per_acre: first.rate_per_acre, rate_unit: first.rate_unit, suggested_rate: first.suggested_rate };
}

function isCountForm(form: string | null): boolean {
  return form === 'seed' || form === 'each';
}

const blankToNull = (v: string | null) => (v ?? '').trim() || null;

/** The rate unit a size ends up with: a seed or each size keeps its stock unit (as _copy_parent_to_size does). */
function resultingRateUnit(member: ProposalMember, rates: RateValues): string | null {
  return isCountForm(member.product_form) ? blankToNull(member.inventory_unit) : blankToNull(rates.rate_unit);
}

/** Sizes whose rate changes when the parent's rates are copied onto them: the same test approval runs. */
export function membersWithRateChange(group: ProposalGroup, rates: RateValues): ProposalMember[] {
  return group.members.filter((m) => {
    // numeric compare, as SQL does: "1.50" and "1.5" are the same rate (both have at most 4 decimals).
    const rateDiffers = m.rate_per_acre === null || rates.rate_per_acre === null
      ? m.rate_per_acre !== rates.rate_per_acre
      : Number(m.rate_per_acre) !== Number(rates.rate_per_acre);
    return rateDiffers
      || blankToNull(m.suggested_rate) !== blankToNull(rates.suggested_rate)
      || blankToNull(m.rate_unit) !== resultingRateUnit(m, rates);
  });
}

/** The other groups in the same proposal that share this group's EPA number (what the same-EPA flag points at). */
export function sameEpaGroupNames(group: ProposalGroup, groups: ProposalGroup[]): string[] {
  if (!group.generic_epa_registration) return [];
  return groups
    .filter((g) => g.id !== group.id && g.generic_epa_registration === group.generic_epa_registration)
    .map((g) => g.suggested_name);
}

/** What still needs an answer before this group can be approved; empty when it is ready. */
export function approvalProblems(group: ProposalGroup, draft: GroupDraft): string[] {
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push('Name the parent.');
  // product_parents.name holds at most 200 characters; say so here rather than fail at save.
  else if ([...draft.name.trim()].length > 200) problems.push('Shorten the parent name to 200 characters or fewer.');
  for (const field of Object.keys(group.conflicts) as ConflictField[]) {
    if (draft.picks[field] === undefined) problems.push(`Pick the ${field === 'use_timings' ? 'Use Timing' : field === 'rates' ? 'rate' : field}.`);
  }
  if (group.identity_basis === 'owner_confirmed' && !draft.ownerConfirmed) {
    problems.push('No size has an EPA number: tick that they are the same product.');
  }
  const roles = Object.values(draft.sizeRoles);
  if (roles.filter((r) => r === 'bulk').length > 1) problems.push('Only one size can be Bulk.');
  const totes = group.members.filter((m) => draft.sizeRoles[m.product_id] === 'fixed_tote');
  if (totes.some((m) => draft.totes[m.product_id] === undefined)) problems.push('Say whether each tote is shop-filled.');
  if (totes.some((m) => draft.totes[m.product_id] === true)) {
    if (!roles.includes('bulk')) problems.push('A shop-filled tote needs a Bulk size to fill from.');
    if (!parentIsFertilizer(group, draft)) problems.push('Only fertilizer totes can be shop-filled: mark the tote vendor-filled.');
  }
  if (Object.values(draft.brands).some((b) => b.keep && !b.sourceBrandId)) {
    problems.push('Pick which version of each differing brand to keep.');
  }
  return problems;
}

export interface ApprovalEntry {
  group_id: string;
  group_fingerprint: string;
  name: string;
  choices: Record<string, unknown>;
  owner_confirmed: boolean;
  size_roles: Record<string, SizeRole>;
  totes: Record<string, { shop_filled: boolean; fill_source_product_id: string | null }>;
  brands?: Record<string, { keep: boolean; source_brand_id: string | null }>;
  prices: Record<string, ProductRatePerAcre>;
}

/** The approval payload for one group, exactly as shown on screen. */
export function approvalEntry(group: ProposalGroup, draft: GroupDraft, prices: Record<string, ProductRatePerAcre>): ApprovalEntry {
  const choices: Record<string, unknown> = {};
  for (const field of Object.keys(group.conflicts) as ConflictField[]) {
    const pick = draft.picks[field];
    // The exact stored value: approval compares it as JSON with the sizes' values.
    if (pick !== undefined) choices[field] = group.conflicts[field]?.[pick];
  }
  const bulk = group.members.find((m) => draft.sizeRoles[m.product_id] === 'bulk')?.product_id ?? null;
  const totes: ApprovalEntry['totes'] = {};
  for (const member of group.members) {
    if (draft.sizeRoles[member.product_id] !== 'fixed_tote') continue;
    const shopFilled = draft.totes[member.product_id];
    if (shopFilled === undefined) continue;
    totes[member.product_id] = { shop_filled: shopFilled, fill_source_product_id: shopFilled ? bulk : null };
  }
  const entry: ApprovalEntry = {
    group_id: group.id,
    group_fingerprint: group.group_fingerprint,
    name: draft.name.trim(),
    choices,
    owner_confirmed: group.identity_basis === 'owner_confirmed' ? draft.ownerConfirmed : false,
    size_roles: { ...draft.sizeRoles },
    totes,
    prices,
  };
  const brandNames = Object.keys(draft.brands);
  if (brandNames.length > 0) {
    entry.brands = Object.fromEntries(brandNames.map((name) => {
      const pick = draft.brands[name];
      return [name, { keep: pick.keep, source_brand_id: pick.keep ? pick.sourceBrandId : null }];
    }));
  }
  return entry;
}

export interface PriceChange {
  productId: string;
  productName: string;
  before: ProductRatePerAcre;
  after: ProductRatePerAcre;
}

/** The per-acre prices each changing size will save, from the server's own preview (admin only). */
export async function previewGroupPrices(group: ProposalGroup, rates: RateValues): Promise<PriceChange[]> {
  const changes: PriceChange[] = [];
  for (const member of membersWithRateChange(group, rates)) {
    const preview = await previewProductRateCorrection({
      productId: member.product_id,
      ratePerAcre: rates.rate_per_acre === null ? null : Number(rates.rate_per_acre),
      rateUnit: resultingRateUnit(member, rates) ?? '',
    });
    changes.push({ productId: member.product_id, productName: member.product_name, before: preview.before, after: preview.after });
  }
  return changes;
}

export async function approveGroups(input: {
  proposal: Proposal;
  entries: ApprovalEntry[];
  idempotencyKey: string;
}): Promise<void> {
  const { data, error } = await supabaseUntyped.rpc('approve_product_parent_groups', {
    p_proposal_id: input.proposal.id,
    p_proposal_version: input.proposal.proposal_version,
    p_groups: input.entries,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  assertRpcResult(data, 'approve_product_parent_groups');
}

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

const PARENT_MESSAGES: Record<string, (detail: string) => string> = {
  PRODUCT_PARENT_GROUPING_NOT_OPEN: () =>
    'Grouping is not switched on yet. You can build, hold and reject proposals now; approving waits for the switch to be turned on.',
  PRODUCT_PARENT_EPA_HAS_PARENT: (detail) =>
    `A parent with this EPA number and name already exists (${detail.replace(/; build a new proposal$/, '')}). Build a new proposal; the group will then show as held.`,
  PRODUCT_PARENT_TOTE_ANSWER_REQUIRED: () =>
    'Say whether each tote is shop-filled from the Bulk size or a vendor-filled package, then approve again.',
  PRODUCT_PARENT_BRANDS_DIFFER: (detail) =>
    `This size can't move: ${detail.replace(/; make their brand lists match before moving a size$/, '')}. Make the two brand lists match first, then move it.`,
  PRODUCT_PARENT_PROPOSAL_STALE: () => 'This proposal is no longer the current one. Reload the page.',
  PRODUCT_PARENT_GROUP_CHANGED: () => 'A size in this group changed since the proposal was built. Build a new proposal.',
  PRODUCT_PARENT_GROUP_NOT_PROPOSED: () => 'This group was already decided. Reload the page.',
};

/** Plain-English message for a failed proposal action. Unlisted parent refusals keep the server's own words. */
export function productParentErrorMessage(error: unknown): string {
  const text = errorText(error);
  const match = text.match(/^((?:PRODUCT_PARENT|PRODUCT_RATE|PRODUCT_RATES|PRODUCT_CATEGORY)_[A-Z_]+)(?::\s*(.*))?$/s);
  if (!match) return sanitizeError(error);
  const [, code, detail = ''] = match;
  const known = PARENT_MESSAGES[code];
  if (known) return known(detail.trim());
  if (detail) return `Nothing was saved. ${detail.charAt(0).toUpperCase()}${detail.slice(1)}`;
  return sanitizeError(error);
}
