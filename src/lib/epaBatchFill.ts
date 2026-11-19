import { supabaseUntyped } from './db';
import { fetchAllRows, pageWithList } from './pagedRead';
import { commitEpaProposalBatch, fetchParentEpaState, normalizeEpaNumber, startEpaLookup, WRITABLE_CLASSES, type EpaDecision } from './epaProposals';
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
  const [parents, ingredients, members, products, parentBrands, legacyBrands, lookups, proposals, failures, registrations] = await Promise.all([
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
    readAll<{ epa_registration: string }>('epa_registrations', 'epa_registration', 'epa_registration'),
  ]);
  // start_epa_lookup refuses a number with no registration row (EPA_REGISTRATION_MISSING), so it is never offered.
  const registered = new Set(registrations.map((r) => r.epa_registration));
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
    else if (!registered.has(numbers[0])) skip = 'EPA number not set up on the EPA Registration screen';
    else if (on(lookups).some((l) => now - Date.parse(l.requested_at) < LOOKUP_EXPIRY_MS)) skip = 'A lookup is running';
    else if (on(proposals).some((p) => p.status !== 'rejected')) skip = 'A proposal is waiting for a decision';
    else if (on(proposals).length > 0) skip = 'A proposal was rejected before';
    else if (on(failures).length > 0) skip = 'A lookup failed before';
    out.push({ parentId: parent.id, name: parent.name, epaNumber, appNames, skip });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const words = (s: string) => s.toLowerCase().split(/[\s\-/]+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);

/** A word of EPA's product name equals the first word of at least one app name (catches wrong numbers). */
export function epaNameMatches(epaProductName: string | null | undefined, appNames: string[]): boolean {
  const epa = new Set(words(epaProductName ?? ''));
  return appNames.some((name) => {
    const first = words(name)[0];
    return first !== undefined && epa.has(first);
  });
}

const CAS_PATTERN = /^\d{2,7}-\d{2}-\d$/;

// Percent in hundred-thousandths, so a sum is exact (EPA gives at most four decimals).
const pctUnits = (value: number) => Math.round(value * 100_000);

function labelBlocks(item: EpaProposalItem): string | null {
  // Status is never written (D-T) and is 'unknown' on every registration, so "EPA says active" is always a difference;
  // blocking it would block every product. Only EPA saying cancelled needs a person (contract, Astra settlement).
  if (item.item_id === 'label:registration_status') {
    return item.epa === true ? 'EPA lists the registration as cancelled' : null;
  }
  if (item.item_id === 'label:label_document' && item.class === 'fill') {
    // A newer EPA label over an existing date or link is a change, not a blank (Codex App, 2026-11-18).
    const current = item.current as { label_accepted_on?: unknown; label_url?: unknown } | null;
    return current?.label_accepted_on == null && current?.label_url == null ? null : 'EPA has a newer label than the one recorded';
  }
  if (item.class === 'fill' || item.class === 'confirm' || item.class === 'matches') return null;
  return item.class === 'rup_upgrade' ? 'EPA lists it as restricted use' : `Label fact differs (${item.item_id.replace(/^label:/, '')})`;
}

export type BatchDecision = { commit: true; decisions: EpaDecision[]; ingredients: number } | { commit: false; reason: string };

/** The EPA record itself needs a person: flagged, distributor, cancelled, or not this product by name. */
function recordBlocks(summary: Record<string, unknown>, appNames: string[]): string | null {
  if (summary.needsManual === true) return 'EPA marks this record for manual checking';
  if (summary.base_label_note === true) return 'Distributor number: EPA has only the base label';
  if (summary.isCancelled === true) return 'EPA lists the registration as cancelled';
  if (!epaNameMatches(summary.productname as string | undefined, appNames)) {
    return `EPA name "${String(summary.productname ?? '')}" does not match this product`;
  }
  return null;
}

/** Every ingredient is a plain new one with a CAS number and a positive percent, and they sum to 100 or less. */
function ingredientsBlock(ingredients: EpaProposalItem[]): string | null {
  if (ingredients.length === 0) return 'EPA lists no ingredients';
  let total = 0;
  for (const item of ingredients) {
    const change = item.change ?? {};
    const pct = change.strength_value;
    if (item.class !== 'add' || typeof change.cas !== 'string' || !CAS_PATTERN.test(change.cas)) return `Ingredient needs a person (${item.class})`;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) return 'Ingredient has no percent';
    total += pctUnits(pct);
  }
  return total > pctUnits(100) ? 'Ingredient percents add up to more than 100' : null;
}

/** Whether the batch may commit this proposal, and the explicit decisions it sends: ingredients yes, every label no. */
export function batchDecision(proposal: Pick<EpaChemistryProposal, 'status' | 'items' | 'epa_summary'>, appNames: string[]): BatchDecision {
  if (proposal.status !== 'proposed') return { commit: false, reason: `Proposal is ${proposal.status}` };
  const ingredients = proposal.items.filter((i) => i.kind === 'ingredient');
  const reason = recordBlocks(proposal.epa_summary ?? {}, appNames) ?? ingredientsBlock(ingredients)
    ?? proposal.items.filter((i) => i.kind === 'label').map(labelBlocks).find((r) => r !== null) ?? null;
  if (reason) return { commit: false, reason };
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

/** A request outlived its deadline; it may still finish, so the run stops instead of starting another product. */
export class BatchDeadlineError extends Error {}

/** Readable text for any thrown value; database errors arrive as plain objects with a message. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new BatchDeadlineError('No reply within 60 seconds')), REQUEST_DEADLINE_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** One retry with the same key: the server replays a saved receipt, so a lost reply never writes twice. */
async function once<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await withDeadline(call());
  } catch (error: unknown) {
    if (error instanceof BatchDeadlineError) throw error; // the first call may still be running
    if (errorText(error).startsWith('EPA_BATCH_')) throw error; // the database's decision, not a lost reply
    return withDeadline(call());
  }
}

/** The parent's current names: its own, its sizes', its active brands' and its sizes' legacy brands'. */
async function fetchAppNames(parentId: string): Promise<string[]> {
  const get = async <T>(q: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as T[];
  };
  const [parents, members, brands] = await Promise.all([
    get<{ name: string }>(supabaseUntyped.from('product_parents').select('name').eq('id', parentId)),
    get<{ product_id: string }>(supabaseUntyped.from('product_parent_members').select('product_id').eq('parent_id', parentId)),
    get<{ brand_name: string }>(supabaseUntyped.from('product_parent_brands').select('brand_name').eq('parent_id', parentId).eq('status', 'active')),
  ]);
  const ids = members.map((m) => m.product_id);
  const [sizes, legacy] = ids.length === 0 ? [[], []] : await Promise.all([
    get<{ product_name: string }>(supabaseUntyped.from('products').select('product_name').in('id', ids)),
    get<{ brand_name: string }>(supabaseUntyped.from('product_brands').select('brand_name').in('product_id', ids)),
  ]);
  return [...parents.map((p) => p.name), ...sizes.map((p) => p.product_name), ...brands.map((b) => b.brand_name), ...legacy.map((b) => b.brand_name)];
}

async function ingredientCount(parentId: string): Promise<number> {
  const { count, error } = await supabaseUntyped.from('product_parent_ingredients')
    .select('id', { count: 'exact', head: true }).eq('parent_id', parentId);
  if (error) throw error;
  if (count === null) throw new Error('Ingredient count unavailable');
  return count;
}

/** Fresh checks right before a write: still empty, still exactly this one number, nothing else running or waiting. */
async function stillEligible(candidate: BatchCandidate & { epaNumber: string }, now: number, ownProposalId?: string): Promise<string | null> {
  const [state, count] = await Promise.all([fetchParentEpaState(candidate.parentId), ingredientCount(candidate.parentId)]);
  if (count > 0) return 'Ingredients were added meanwhile';
  if (state.numbers.length !== 1 || state.numbers[0] !== candidate.epaNumber) return 'Its EPA numbers changed';
  const mine = (r: { epa_registration: string }) => r.epa_registration === candidate.epaNumber;
  if (state.lookups.some((l) => mine(l) && l.status === 'pending' && now - Date.parse(l.requested_at) < LOOKUP_EXPIRY_MS)) return 'A lookup is running';
  if (state.proposals.some((p) => mine(p) && p.id !== ownProposalId && ['proposed', 'held', 'rejected'].includes(p.status))) return 'A proposal is waiting or was rejected';
  if (state.failures.some(mine)) return 'A lookup failed before';
  return null;
}

/** Runs one parent. Throws only when the outcome is uncertain; the caller reports it and counts it as an error. */
export async function runBatchParent(runId: string, candidate: BatchCandidate & { epaNumber: string }): Promise<BatchResult> {
  const base = { parentId: candidate.parentId, name: candidate.name, epaNumber: candidate.epaNumber };
  const blocked = await withDeadline(stillEligible(candidate, Date.now()));
  if (blocked) return { ...base, outcome: 'skipped', detail: blocked };
  const key = `batch:${runId}:${candidate.parentId}`;
  const started = await once(() => startEpaLookup(candidate.parentId, candidate.epaNumber, `${key}:start`));
  const record = await withDeadline(runRecordedEpaLookup(started.lookup_id).then((r) => {
    if (!r) throw new Error('Lookup cancelled');
    return r;
  }));
  if (record.outcome === 'failure') {
    if (!record.failure_id) throw new Error('EPA lookup reply named no failure');
    // EPA unreachable or unreadable counts as an error, so an outage stops the run instead of failing every product.
    if (record.reason === 'upstream_error' || record.reason === 'invalid_result') throw new Error(`EPA lookup failed (${record.reason}); recorded for a person`);
    return { ...base, outcome: 'needs_person', detail: `EPA lookup failed: ${record.reason ?? 'unknown reason'}` };
  }
  if (!record.proposal_id) throw new Error('EPA lookup reply named no proposal');
  const { data, error } = await withDeadline(Promise.resolve(supabaseUntyped.from('epa_chemistry_proposals').select('*').eq('id', record.proposal_id).maybeSingle()));
  if (error) throw error;
  const proposal = data as EpaChemistryProposal | null;
  if (!proposal || proposal.parent_id !== candidate.parentId || proposal.epa_registration !== candidate.epaNumber
      || proposal.lookup_id !== started.lookup_id) {
    throw new Error('The saved proposal does not match this lookup');
  }
  // Re-read everything the decision rests on: numbers, ingredients, other proposals and the names (Luna, 2026-11-18).
  const [changed, appNames] = await withDeadline(Promise.all([stillEligible(candidate, Date.now(), proposal.id), fetchAppNames(candidate.parentId)]));
  if (changed) return { ...base, outcome: 'needs_person', detail: `${changed}; the proposal waits for a person` };
  const decision = batchDecision(proposal, appNames);
  if (!decision.commit) return { ...base, outcome: 'needs_person', detail: decision.reason };
  let result;
  try {
    result = await once(() => commitEpaProposalBatch(proposal.id, proposal.proposal_version, decision.decisions, `${key}:commit`));
  } catch (error: unknown) {
    // The database's own check at save time (#1976): nothing was written and the proposal waits for a person.
    const refusal = /^EPA_BATCH_NOT_ELIGIBLE: (.*)$/s.exec(errorText(error));
    if (refusal) return { ...base, outcome: 'needs_person', detail: `Refused at save: ${refusal[1]}; the proposal waits for a person` };
    throw error;
  }
  if (result.status === 'held') return { ...base, outcome: 'needs_person', detail: `On hold (${result.hold_reason})` };
  const written = Object.entries(result.commit_result).filter(([id, r]) => r === 'written' && id.startsWith('ing:')).length;
  return { ...base, outcome: 'saved', detail: `${written} ingredient${written === 1 ? '' : 's'} saved` };
}

// One run per tab, kept outside the card: leaving and reopening the page must not start a second run beside it.
let activeRun: Promise<void> | null = null;
export const currentTabRun = (): Promise<void> | null => activeRun;
/** Starts the run unless one is already going in this tab; returns false when it refused. */
export function startTabRun(run: () => Promise<void>): boolean {
  if (activeRun) return false;
  activeRun = run().finally(() => { activeRun = null; });
  return true;
}
