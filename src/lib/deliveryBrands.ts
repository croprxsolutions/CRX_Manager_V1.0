import { assertRpcResult, hasRpcCode, RpcErrorCodes, supabaseUntyped } from './db';
import { sanitizeError } from './errorSanitizer';

/**
 * Brand PR B, part B-2: the screens' calls to the B-1 brand functions (migration 20270104120000).
 * Untyped client: these functions are not in the generated types yet. Nothing about brands ever
 * refuses a completion (Mason, 2026-11-09: warn, never block).
 */

/** One entry of a line's brand list (_delivery_line_brand_list), currently bought first. */
export interface DeliveryBrandOption {
  source: 'parent' | 'size';
  parent_id: string | null;
  brand_id: string;
  brand_name: string;
  epa_registration: string | null;
  manufacturer: string | null;
  is_currently_sourced: boolean;
}

/** A saved pick (a current delivery_item_brands row). */
export interface DeliveryBrandPick {
  id: string;
  delivery_item_id: string;
  source: 'parent' | 'size' | 'typed';
  parent_brand_id: string | null;
  legacy_brand_id: string | null;
  brand_name: string;
  epa_registration: string | null;
  manufacturer: string | null;
  quantity: number;
  review_state: 'pending' | 'added' | 'dismissed' | null;
}

export interface DeliveryBrandLine {
  delivery_item_id: string;
  product_id: string;
  product_name: string | null;
  quantity: number;
  quantity_delivered: number | null;
  unit_size: string | null;
  brand_list: DeliveryBrandOption[];
  picks: DeliveryBrandPick[];
}

export interface DeliveryBrands {
  delivery_id: string;
  status: string;
  event_seq: number;
  lines: DeliveryBrandLine[];
}

/** The picker's value for "Other brand…" (a brand typed from the jug); real brand ids are uuids. */
export const OTHER_BRAND = 'other';
/**
 * The brand seq a completion sends when the screen could not confirm the saved picks (brands did not load, or a
 * choice was left out, refused or overtaken). complete_delivery still completes, records picks_confirmed false,
 * and lists every picked line on the office's missing-brands list (20270104120000): warn, never block.
 */
export const BRANDS_NOT_CONFIRMED = -1;

/** What the screen holds for one pick while it is being edited: a brand id, OTHER_BRAND, or '' (not chosen yet). */
export interface DraftPick {
  brandId: string;
  typedName: string;
  typedEpa: string;
  typedManufacturer: string;
  /** As typed; parsed on save. */
  quantity: string;
}

export type DraftLines = Record<string, DraftPick[]>;

export interface PickPayload {
  brand_id?: string;
  typed_name?: string;
  typed_epa?: string;
  typed_manufacturer?: string;
  quantity: number;
}

export async function getDeliveryBrands(deliveryId: string): Promise<DeliveryBrands> {
  const { data, error } = await supabaseUntyped.rpc('get_delivery_brands', { p_delivery_id: deliveryId });
  if (error) throw error;
  const reply = assertRpcResult<DeliveryBrands>(data, 'get_delivery_brands');
  if (!Array.isArray(reply.lines) || typeof reply.event_seq !== 'number') throw new Error('get_delivery_brands returned an unexpected shape');
  return reply;
}

interface BrandWriteResult { delivery_id: string; event_seq: number; picks: DeliveryBrandPick[] }

export async function setDeliveryBrands(
  deliveryId: string, lines: { delivery_item_id: string; picks: PickPayload[] }[], baseSeq: number, key: string,
): Promise<BrandWriteResult> {
  const args = { p_delivery_id: deliveryId, p_lines: lines, p_base_event_seq: baseSeq, p_idempotency_key: key };
  // Re-copying picks onto unposted invoices can briefly find the order busy; that refusal rolls back and
  // records nothing, so it is retried once on the same key.
  const firstTry = await supabaseUntyped.rpc('set_delivery_brands', args);
  const { data, error } = hasRpcCode(firstTry.error, RpcErrorCodes.ORDER_LIFECYCLE_BUSY_RETRY)
    ? await supabaseUntyped.rpc('set_delivery_brands', args) : firstTry;
  if (error) throw error;
  return assertRpcResult<BrandWriteResult>(data, 'set_delivery_brands');
}

export async function correctDeliveryBrands(
  deliveryId: string, lines: { delivery_item_id: string; picks: PickPayload[] }[], reason: string, baseSeq: number,
  key: string,
): Promise<BrandWriteResult & { invoice_ids: string[] }> {
  const args = { p_delivery_id: deliveryId, p_lines: lines, p_reason: reason, p_base_event_seq: baseSeq, p_idempotency_key: key };
  // Re-copying picks onto unposted invoices can briefly find the order busy; that refusal rolls back and
  // records nothing, so it is retried once on the same key.
  const firstTry = await supabaseUntyped.rpc('correct_delivery_brands', args);
  const { data, error } = hasRpcCode(firstTry.error, RpcErrorCodes.ORDER_LIFECYCLE_BUSY_RETRY)
    ? await supabaseUntyped.rpc('correct_delivery_brands', args) : firstTry;
  if (error) throw error;
  return assertRpcResult<BrandWriteResult & { invoice_ids: string[] }>(data, 'correct_delivery_brands');
}

export interface TypedBrandForReview {
  pick_id: string;
  delivery_id: string;
  delivery_number: string | null;
  delivery_status: string;
  product_id: string;
  product_name: string | null;
  brand_name: string;
  epa_registration: string | null;
  manufacturer: string | null;
  quantity: number;
  review_note: string | null;
  entered_at: string;
}

export async function getTypedBrandsForReview(): Promise<TypedBrandForReview[]> {
  const { data, error } = await supabaseUntyped.rpc('get_typed_brands_for_review');
  if (error) throw error;
  const reply = assertRpcResult<TypedBrandForReview[]>(data, 'get_typed_brands_for_review');
  if (!Array.isArray(reply)) throw new Error('get_typed_brands_for_review returned an unexpected shape');
  return reply;
}

/** One completed line on the office's missing-brands follow-up list (get_deliveries_missing_brands). */
export interface DeliveryMissingBrandsLine {
  delivery_id: string;
  delivery_number: string | null;
  delivered_on: string;
  delivery_item_id: string;
  product_name: string | null;
  quantity_delivered: number;
  picked_quantity: number;
  reasons: string[];
}

/** Plain words for each reason the database gives (unknown reasons show as they are). */
export const MISSING_BRAND_REASON_LABELS: Record<string, string> = {
  completed_before_brand_capture: 'Completed before brand capture',
  brand_not_recorded: 'Brand not recorded',
  split_does_not_match_delivered: 'Split does not match delivered',
  epa_number_not_recorded: 'EPA number not recorded',
  brand_no_longer_listed: 'Brand no longer listed',
  picks_not_confirmed: 'Brands not confirmed at completion',
};

export async function getDeliveriesMissingBrands(from: string, to: string): Promise<DeliveryMissingBrandsLine[]> {
  const { data, error } = await supabaseUntyped.rpc('get_deliveries_missing_brands', { p_from: from, p_to: to });
  if (error) throw error;
  const reply = assertRpcResult<DeliveryMissingBrandsLine[]>(data, 'get_deliveries_missing_brands');
  if (!Array.isArray(reply)) throw new Error('get_deliveries_missing_brands returned an unexpected shape');
  return reply;
}

export async function reviewTypedBrand(
  pickId: string, action: 'link' | 'dismiss', brandId: string | null, key: string,
): Promise<void> {
  const { data, error } = await supabaseUntyped.rpc('review_typed_brand', {
    p_pick_id: pickId, p_action: action, p_brand_id: brandId, p_reason: null, p_idempotency_key: key,
  });
  if (error) throw error;
  assertRpcResult(data, 'review_typed_brand');
}

/** A line needs a brand when its product has a brand list (or already carries picks). */
export function isBrandedLine(line: DeliveryBrandLine): boolean {
  return line.brand_list.length > 0 || line.picks.length > 0;
}

/** The editable copy of a line's saved picks. */
export function draftFromPicks(picks: DeliveryBrandPick[]): DraftPick[] {
  return picks.map((p) => p.source === 'typed'
    ? { brandId: OTHER_BRAND, typedName: p.brand_name, typedEpa: p.epa_registration ?? '', typedManufacturer: p.manufacturer ?? '', quantity: String(p.quantity) }
    : { brandId: (p.parent_brand_id ?? p.legacy_brand_id)!, typedName: '', typedEpa: '', typedManufacturer: '', quantity: String(p.quantity) });
}

/**
 * The picks to send for one line. A single pick with no amount typed takes `fullQuantity` (the loaded
 * amount before completion, the delivered amount in a correction). Throws a plain message the screen shows.
 */
export function picksPayload(productName: string, draft: DraftPick[], fullQuantity: number): PickPayload[] {
  const picks = draft.map((d) => {
    const raw = d.quantity.trim();
    const quantity = draft.length === 1 && raw === '' ? fullQuantity : Number(raw);
    if (!Number.isFinite(quantity) || quantity <= 0 || Math.round(quantity * 10000) / 10000 !== quantity) {
      throw new Error(`${productName}: each brand needs an amount above zero`);
    }
    if (!d.brandId) throw new Error(`${productName}: pick a brand, or remove the empty row`);
    if (d.brandId !== OTHER_BRAND) return { brand_id: d.brandId, quantity };
    if (!d.typedName.trim()) throw new Error(`${productName}: name the brand on the jug, or pick one from the list`);
    return {
      typed_name: d.typedName.trim(),
      ...(d.typedEpa.trim() ? { typed_epa: d.typedEpa.trim() } : {}),
      ...(d.typedManufacturer.trim() ? { typed_manufacturer: d.typedManufacturer.trim() } : {}),
      quantity,
    };
  });
  // Amounts have at most 4 decimals, so whole ten-thousandths compare exactly.
  const total = picks.reduce((s, p) => s + Math.round(p.quantity * 10000), 0);
  if (total > Math.round(fullQuantity * 10000)) {
    throw new Error(`${productName}: the brand amounts add up to more than the ${fullQuantity} on this line`);
  }
  return picks;
}

/** Same comparison form for a saved line and a draft line, to tell which lines changed. */
function comparable(draft: DraftPick[]): string {
  return JSON.stringify(draft.map((d) => [d.brandId, d.typedName.trim(), d.typedEpa.trim(), d.typedManufacturer.trim(), Number(d.quantity.trim() || NaN)]));
}

export function changedLineIds(brands: DeliveryBrands | null, drafts: DraftLines): string[] {
  if (!brands) return [];
  return brands.lines
    .filter((l) => drafts[l.delivery_item_id] && comparable(drafts[l.delivery_item_id]) !== comparable(draftFromPicks(l.picks)))
    .map((l) => l.delivery_item_id);
}

/**
 * Warnings shown before completing (never blocking): a branded line with something delivered and no pick,
 * or picks that do not add up to what is being delivered. `delivered` maps line id to the amount the screen
 * is about to complete with.
 */
export function brandWarnings(brands: DeliveryBrands | null, drafts: DraftLines, delivered: Record<string, number>): string[] {
  if (!brands) return [];
  const warnings: string[] = [];
  for (const line of brands.lines) {
    // A line with no brand list is checked only when choices were typed on it (a correction).
    if (!isBrandedLine(line) && !drafts[line.delivery_item_id]?.length) continue;
    const qty = delivered[line.delivery_item_id] ?? line.quantity;
    if (qty <= 0) continue;
    const name = line.product_name || 'this product';
    const draft = drafts[line.delivery_item_id] ?? draftFromPicks(line.picks);
    if (draft.length === 0) { warnings.push(`No brand picked for ${name}.`); continue; }
    // Choices that cannot be saved are left out at completion (warn, never block); say so here.
    try { picksPayload(name, draft, line.quantity); } catch (error) {
      warnings.push(`${error instanceof Error ? error.message : name}. Those choices will not be saved.`);
      continue;
    }
    // One pick at or above the delivered amount is trimmed to it by the database; anything else is a mismatch.
    const sum = draft.reduce((s, d) => s + (d.quantity.trim() === '' && draft.length === 1 ? qty : Number(d.quantity) || 0), 0);
    if (draft.length === 1 ? sum < qty : Math.abs(sum - qty) > 1e-9) {
      warnings.push(`${name}: the brand amounts (${sum}) do not add up to the ${qty} delivered.`);
    }
  }
  return warnings;
}

const BRAND_REFUSAL = /^(BRAND_[A-Z_]+|DELIVERY_BRANDS_LOCKED|DELIVERY_ITEM_NOT_ON_DELIVERY|DELIVERY_NOT_COMPLETED|INVOICE_POSTED|NOT_AUTHORIZED|ADMIN_REQUIRED):\s*(.+)$/s;

function errorText(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message
    : typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : undefined;
}

/**
 * The database refused the brand choices themselves (a brand no longer listed, amounts it will not take...),
 * as opposed to a lost connection or someone else saving first (BRAND_PICKS_CHANGED).
 */
export function isBrandChoiceRefusal(error: unknown): boolean {
  const token = errorText(error)?.match(BRAND_REFUSAL)?.[1];
  return !!token && token !== 'BRAND_PICKS_CHANGED';
}

/** Plain-English message for a refused brand save: the database's own sentence after the token. */
export function deliveryBrandErrorMessage(error: unknown): string {
  const detail = errorText(error)?.match(BRAND_REFUSAL)?.[2];
  if (detail) return `Brands not saved. ${detail.charAt(0).toUpperCase()}${detail.slice(1)}`;
  return sanitizeError(error);
}
