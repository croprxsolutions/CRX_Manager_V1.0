import { supabaseUntyped } from './db';
import { fetchAllRows, pageWithList } from './pagedRead';
import { commitEpaProposal, fetchParentEpaState, normalizeEpaNumber, startEpaLookup, WRITABLE_CLASSES, type EpaDecision } from './epaProposals';
import { runRecordedEpaLookup } from './epaLookupClient';
import type { EpaChemistryProposal, EpaProposalItem } from '../types';

// EPA batch fill (docs/plans/2026-11-18-epa-batch-fill-CONTRACT.md). Runs the same DM-4 lookup → commit a person runs
// on the product page, one parent at a time, and saves ingredients only. Anything unusual waits for a person.

const LOOKUP_EXPIRY_MS = 30 * 60 * 1000;
const REQUEST_DEADLINE_MS = 60_000;

export interface BatchCandidate {
  parentId: string;
  name: string;
  /** The parent's only EPA number, or null when it has none or several. */
  epaNumber: string | null;
  /** Parent, size and brand names, for the EPA name check. */
  appNames: string[];
  /** Why the parent cannot run, or null when it can. */
  skip: string | null;
}

type Filter = { eq?: [string, string | boolean]; in?: [string, string[]] };

async function readAll<T>(table: string, columns: string, order: string, filter: Filter = {}): Promise<T[]> {
  const { data, error } = await fetchAllRows<T>((from, to) => {
    let query = supabaseUntyped.from(table).select(columns, { count: 'exact' });
    if (filter.eq) query = query.eq(...filter.eq);
    if (filter.in) query = query.in(...filter.in);
    return pageWithList(query.order(order).range(from, to) as PromiseLike<{ data: T[] | null; error: { message: string } | null; count?: number | null }>);
  });
  if (error) throw error;
  return data ?? [];
}

/** Active parents with no ingredient row (any status), each with its EPA number or the reason it is skipped. */
export async function fetchBatchCandidates(now = Date.now()): Promise<BatchCandidate[]> {
  type Num = { epa_registration: string | null };
  const [parents, ingredients, members, products, parentBrands, legacyBrands, lookups, proposals, failures] = await Promise.all([
    readAll<{ id: string; name: string; generic_epa_registration: string | null }>('product_parents',
      'id, name, generic_epa_registration', 'id', { eq: ['is_active', true] }),
    readAll<{ id: string; parent_id: string }>('product_parent_ingredients', 'id, parent_id', 'id'),
    readAll<{ product_id: string; parent_id: string }>('product_parent_members', 'product_id, parent_id', 'product_id'),
    readAll<Num & { id: string; product_name: string }>('products', 'id, product_name, epa_registration', 'id'),
    readAll<Num & { id: string; parent_id: string; brand_name: string }>('product_parent_brands',
      'id, parent_id, brand_name, epa_registration', 'id', { eq: ['status', 'active'] }),
    readAll<Num & { id: string; product_id: string; brand_name: string }>('product_brands', 'id, product_id, brand_name, epa_registration', 'id'),
    readAll<{ id: string; parent_id: string; epa_registration: string; status: string; requested_at: string }>('epa_lookups',
      'id, parent_id, epa_registration, status, requested_at', 'id', { eq: ['status', 'pending'] }),
    readAll<{ id: string; parent_id: string; epa_registration: string; status: string }>('epa_chemistry_proposals',
      'id, parent_id, epa_registration, status', 'id', { in: ['status', ['proposed', 'held', 'rejected']] }),
    readAll<{ id: string; parent_id: string; epa_registration: string }>('epa_lookup_failures', 'id, parent_id, epa_registration', 'id'),
  ]);
  const filled = new Set(ingredients.map((i) => i.parent_id));
  const productById = new Map(products.map((p) => [p.id, p]));
  const out: BatchCandidate[] = [];
  for (const parent of parents) {
    if (filled.has(parent.id)) continue;
    const productIds = members.filter((m) => m.parent_id === parent.id).map((m) => m.product_id);
    const sizes = productIds.map((id) => productById.get(id)).filter((p) => p !== undefined);
    const brands = parentBrands.filter((b) => b.parent_id === parent.id);
    const legacy = legacyBrands.filter((b) => productIds.includes(b.product_id));
    // The same four places fetchParentEpaNumbers and start_epa_lookup read.
    const numbers = [...new Set([parent.generic_epa_registration, ...sizes.map((s) => s.epa_registration),
      ...brands.map((b) => b.epa_registration), ...legacy.map((b) => b.epa_registration)]
      .map(normalizeEpaNumber).filter((n): n is string => n !== null))];
    const appNames = [parent.name, ...sizes.map((s) => s.product_name), ...brands.map((b) => b.brand_name), ...legacy.map((b) => b.brand_name)];
    const epaNumber = numbers.length === 1 ? numbers[0] : null;
    const on = <T extends { parent_id: string; epa_registration: string }>(rows: T[]) =>
      rows.filter((r) => r.parent_id === parent.id && r.epa_registration === epaNumber);
    let skip: string | null = null;
    if (numbers.length === 0) skip = 'No EPA number';
    else if (numbers.length > 1) skip = `Several EPA numbers (${numbers.join(', ')})`;
    else if (on(lookups).some((l) => now - Date.parse(l.requested_at) < LOOKUP_EXPIRY_MS)) skip = 'A lookup is running';
    else if (on(proposals).some((p) => p.status !== 'rejected')) skip = 'A proposal is waiting for a decision';
    else if (on(proposals).length > 0) skip = 'A proposal was rejected before';
    else if (on(failures).length > 0) skip = 'A lookup failed before';
    out.push({ parentId: parent.id, name: parent.name, epaNumber, appNames, skip });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** EPA's product name contains the first word of at least one app name (the preview's test; catches wrong numbers). */
export function epaNameMatches(epaProductName: string | null | undefined, appNames: string[]): boolean {
  const epa = norm(epaProductName ?? '');
  if (!epa) return false;
  return appNames.some((name) => {
    const first = norm(name.trim().split(/[\s\-/]/)[0] ?? '');
    return first.length > 0 && epa.includes(first);
  });
}

// Percent in hundred-thousandths, so a sum is exact (EPA gives at most four decimals).
const pctUnits = (value: number) => Math.round(value * 100_000);

function labelBlocks(item: EpaProposalItem): string | null {
  if (item.item_id === 'label:registration_status') {
    return item.epa === true ? 'EPA lists the registration as cancelled' : null;
  }
  if (item.class === 'fill' || item.class === 'confirm' || item.class === 'matches') return null;
  return item.class === 'rup_upgrade' ? 'EPA lists it as restricted use' : `Label fact differs (${item.item_id.replace(/^label:/, '')})`;
}

export type BatchDecision = { commit: true; decisions: EpaDecision[]; ingredients: number } | { commit: false; reason: string };

/** Whether the batch may commit this proposal, and the explicit decisions it sends: ingredients yes, every label no. */
export function batchDecision(proposal: Pick<EpaChemistryProposal, 'status' | 'items' | 'epa_summary'>, appNames: string[]): BatchDecision {
  if (proposal.status !== 'proposed') return { commit: false, reason: `Proposal is ${proposal.status}` };
  const summary = proposal.epa_summary ?? {};
  if (summary.needsManual === true) return { commit: false, reason: 'EPA marks this record for manual checking' };
  if (summary.base_label_note === true) return { commit: false, reason: 'Distributor number: EPA has only the base label' };
  if (summary.isCancelled === true) return { commit: false, reason: 'EPA lists the registration as cancelled' };
  if (!epaNameMatches(summary.productname as string | undefined, appNames)) {
    return { commit: false, reason: `EPA name "${String(summary.productname ?? '')}" does not match this product` };
  }
  const ingredients = proposal.items.filter((i) => i.kind === 'ingredient');
  if (ingredients.length === 0) return { commit: false, reason: 'EPA lists no ingredients' };
  let total = 0;
  for (const item of ingredients) {
    const change = item.change ?? {};
    const pct = change.strength_value;
    if (item.class !== 'add' || typeof change.cas !== 'string' || change.cas === '') {
      return { commit: false, reason: `Ingredient needs a person (${item.class})` };
    }
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) return { commit: false, reason: 'Ingredient has no percent' };
    total += pctUnits(pct);
  }
  if (total > pctUnits(100)) return { commit: false, reason: 'Ingredient percents add up to more than 100' };
  for (const item of proposal.items.filter((i) => i.kind === 'label')) {
    const reason = labelBlocks(item);
    if (reason) return { commit: false, reason };
  }
  const decisions = proposal.items.filter((i) => WRITABLE_CLASSES.has(i.class))
    .map((i) => ({ item_id: i.item_id, accept: i.kind === 'ingredient' }));
  // Every item the server could write is decided explicitly; only ingredient adds are accepted.
  const accepted = decisions.filter((d) => d.accept);
  if (accepted.length !== ingredients.length || accepted.some((d) => !d.item_id.startsWith('ing:'))) {
    throw new Error('EPA batch: refusing to send decisions that accept anything but ingredients');
  }
  return { commit: true, decisions, ingredients: ingredients.length };
}

export type BatchOutcome = 'saved' | 'needs_person' | 'skipped' | 'failed' | 'unknown';
export interface BatchResult { parentId: string; name: string; epaNumber: string; outcome: BatchOutcome; detail: string }

function withDeadline<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(
    () => reject(new Error('No reply within 60 seconds')), REQUEST_DEADLINE_MS))]);
}

/** One retry with the same key: the server replays a saved receipt, so a lost reply never writes twice. */
async function once<T>(call: () => Promise<T>): Promise<T> {
  try { return await withDeadline(call()); } catch { return withDeadline(call()); }
}

async function ingredientCount(parentId: string): Promise<number> {
  const { count, error } = await supabaseUntyped.from('product_parent_ingredients')
    .select('id', { count: 'exact', head: true }).eq('parent_id', parentId);
  if (error) throw error;
  if (count === null) throw new Error('Ingredient count unavailable');
  return count;
}

/** Fresh checks right before a write: still empty, still exactly this one number, nothing else running or waiting. */
async function stillEligible(candidate: BatchCandidate & { epaNumber: string }, now: number): Promise<string | null> {
  const [state, count] = await Promise.all([fetchParentEpaState(candidate.parentId), ingredientCount(candidate.parentId)]);
  if (count > 0) return 'Ingredients were added meanwhile';
  if (state.numbers.length !== 1 || state.numbers[0] !== candidate.epaNumber) return 'Its EPA numbers changed';
  const mine = (r: { epa_registration: string }) => r.epa_registration === candidate.epaNumber;
  if (state.lookups.some((l) => mine(l) && l.status === 'pending' && now - Date.parse(l.requested_at) < LOOKUP_EXPIRY_MS)) return 'A lookup is running';
  if (state.proposals.some((p) => mine(p) && ['proposed', 'held', 'rejected'].includes(p.status))) return 'A proposal is waiting or was rejected';
  if (state.failures.some(mine)) return 'A lookup failed before';
  return null;
}

/** Runs one parent. Throws only when the outcome is uncertain; the caller reports it and counts it as an error. */
export async function runBatchParent(runId: string, candidate: BatchCandidate & { epaNumber: string }): Promise<BatchResult> {
  const base = { parentId: candidate.parentId, name: candidate.name, epaNumber: candidate.epaNumber };
  const blocked = await stillEligible(candidate, Date.now());
  if (blocked) return { ...base, outcome: 'skipped', detail: blocked };
  const key = `batch:${runId}:${candidate.parentId}`;
  const started = await once(() => startEpaLookup(candidate.parentId, candidate.epaNumber, `${key}:start`));
  const record = await withDeadline(runRecordedEpaLookup(started.lookup_id).then((r) => {
    if (!r) throw new Error('Lookup cancelled');
    return r;
  }));
  if (record.outcome === 'failure') {
    if (!record.failure_id) throw new Error('EPA lookup reply named no failure');
    return { ...base, outcome: 'needs_person', detail: `EPA lookup failed: ${record.reason ?? 'unknown reason'}` };
  }
  if (!record.proposal_id) throw new Error('EPA lookup reply named no proposal');
  const { data, error } = await supabaseUntyped.from('epa_chemistry_proposals').select('*').eq('id', record.proposal_id).maybeSingle();
  if (error) throw error;
  const proposal = data as EpaChemistryProposal | null;
  if (!proposal || proposal.parent_id !== candidate.parentId || proposal.epa_registration !== candidate.epaNumber
      || proposal.lookup_id !== started.lookup_id) {
    throw new Error('The saved proposal does not match this lookup');
  }
  const decision = batchDecision(proposal, candidate.appNames);
  if (!decision.commit) return { ...base, outcome: 'needs_person', detail: decision.reason };
  if ((await ingredientCount(candidate.parentId)) > 0) return { ...base, outcome: 'skipped', detail: 'Ingredients were added meanwhile' };
  const result = await once(() => commitEpaProposal(proposal.id, proposal.proposal_version, decision.decisions, `${key}:commit`));
  if (result.status === 'held') return { ...base, outcome: 'needs_person', detail: `On hold (${result.hold_reason})` };
  const written = Object.entries(result.commit_result).filter(([id, r]) => r === 'written' && id.startsWith('ing:')).length;
  return { ...base, outcome: 'saved', detail: `${written} ingredient${written === 1 ? '' : 's'} saved` };
}
