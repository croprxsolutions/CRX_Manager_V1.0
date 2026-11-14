import { useEffect, useMemo, useState } from 'react';
import { assertRpcResult, supabaseUntyped } from './db';
import { Sentry } from './sentry';
import type { ProductRatePerAcre } from '../types';
import { toSentryError } from './sentryError';

// PAR-1 (20261108120000_product_parents): one parent per formulation owns category, use timings and
// rates; the database copies them onto every size. These RPCs are not in the generated types yet.

export type ProductSizeRole = 'package' | 'bulk' | 'fixed_tote';

export const SIZE_ROLE_LABELS: Record<ProductSizeRole, string> = {
  package: 'Package',
  bulk: 'Bulk',
  fixed_tote: 'Fixed tote',
};

export interface ProductParentSize {
  product_id: string;
  product_name: string;
  sku: string | null;
  size_role: ProductSizeRole;
  fill_source_product_id: string | null;
  is_active: boolean;
}

export interface ProductParent {
  id: string;
  name: string;
  nickname: string | null;
  product_form: string;
  formulation_type: string | null;
  safener: string | null;
  generic_epa_registration: string | null;
  category: string | null;
  use_timings: string[] | null;
  /** Exact decimal as text, as the database sends it. */
  rate_per_acre: string | null;
  rate_unit: string | null;
  suggested_rate: string | null;
  parent_version: number;
  is_active: boolean;
  sizes: ProductParentSize[];
}

export interface ParentWriteResult {
  parent_id: string;
  parent_version: number;
  product_id?: string;
  event_id: number;
}

/** One size in a rate preview. Sent back unchanged as the snapshot the save checks. */
export interface ParentRatePreviewSize {
  product_id: string;
  product_name: string;
  pricing_version: number;
  unit_size: string | null;
  inventory_unit: string | null;
  product_form: string | null;
  rate_per_acre: string | null;
  rate_unit: string | null;
  suggested_rate: string | null;
  prices: ProductRatePerAcre;
  before_prices: ProductRatePerAcre;
}

interface RateValues { rate_per_acre: string | null; rate_unit: string | null; suggested_rate: string | null }

export interface ParentRatePreview {
  parent_id: string;
  parent_version: number;
  rates_locked: boolean;
  before: RateValues;
  after: RateValues;
  sizes: ParentRatePreviewSize[];
}

export interface MoveSizePreview {
  refusal: string | null;
  prices: ProductRatePerAcre | null;
  before_prices: ProductRatePerAcre | null;
  from_parent_id: string;
  from_parent_version: number;
  to_parent_id: string;
  to_parent_version: number;
  size_fingerprint: string;
  before: Record<string, unknown>;
  after: { category: string | null; use_timings: string[] | null; epa_registration: string | null } & RateValues;
  rates_locked: boolean;
}

export interface IdentityValues { formulation_type: string | null; safener: string | null; generic_epa_registration: string | null }

export interface IdentityPreview {
  parent_id: string;
  parent_version: number;
  before: IdentityValues;
  after: IdentityValues;
  sizes: Array<{ product_id: string; product_name: string; epa_registration: string | null }>;
}

/** One open quote, order, job or template that uses a size (informational; nothing saved changes). */
export interface OpenWorkEntry { product_id: string; kind: string; number: string | null; message: string }

export const getProductParents = async (productIds: string[] | null) =>
  {
  const { data, error } = await supabaseUntyped.rpc('get_product_parents', { p_product_ids: productIds });
  if (error) throw error;
  return assertRpcResult<ProductParent[]>(data, 'get_product_parents');
}

export const searchProductParents = async (text: string) =>
  {
  const { data, error } = await supabaseUntyped.rpc('search_product_parents', { p_text: text, p_active_only: true });
  if (error) throw error;
  return assertRpcResult<ProductParent[]>(data, 'search_product_parents');
}

/** The parent of one size, or null when it has none. */
export async function getParentOfProduct(productId: string): Promise<ProductParent | null> {
  const parents = await getProductParents([productId]);
  return parents.find((parent) => parent.sizes.some((size) => size.product_id === productId)) ?? null;
}

export const createProductWithParent = async (parent: Record<string, unknown>, size: Record<string, unknown>, key: string) =>
  {
  const { data, error } = await supabaseUntyped.rpc('create_product_with_parent', { p_parent: parent, p_size: size, p_idempotency_key: key });
  if (error) throw error;
  return assertRpcResult<ParentWriteResult>(data, 'create_product_with_parent');
}

export const addProductSize = async (parentId: string, expectedVersion: number, size: Record<string, unknown>, key: string) =>
  {
  const { data, error } = await supabaseUntyped.rpc('add_product_size', {
    p_parent_id: parentId, p_expected_parent_version: expectedVersion, p_size: size, p_idempotency_key: key,
  });
  if (error) throw error;
  return assertRpcResult<ParentWriteResult>(data, 'add_product_size');
}

export const updateProductParent = async (input: {
  parentId: string; expectedVersion: number; changes: Record<string, unknown>; reason: string; key: string;
}) => {
  const { data, error } = await supabaseUntyped.rpc('update_product_parent', {
  p_parent_id: input.parentId, p_expected_parent_version: input.expectedVersion,
  p_changes: input.changes, p_reason: input.reason, p_idempotency_key: input.key,
});
  if (error) throw error;
  return assertRpcResult<ParentWriteResult>(data, 'update_product_parent');
}

/** Rates go as text so the decimal reaches the database exactly. */
export const previewParentRates = async (parentId: string, rates: RateValues) =>
  {
  const { data, error } = await supabaseUntyped.rpc('preview_parent_rates', {
    p_parent_id: parentId, p_rate_per_acre: rates.rate_per_acre, p_rate_unit: rates.rate_unit ?? '',
    p_suggested_rate: rates.suggested_rate ?? '',
  });
  if (error) throw error;
  return assertRpcResult<ParentRatePreview>(data, 'preview_parent_rates');
}

/** Rates open: saves each previewed parent, all or nothing. */
export const setParentRates = async (previews: Array<{ preview: ParentRatePreview; rates: RateValues }>, key: string) =>
  {
  const { data, error } = await supabaseUntyped.rpc('set_parent_rates', {
    p_rows: previews.map(({ preview, rates }) => ({
      parent_id: preview.parent_id,
      expected_parent_version: preview.parent_version,
      rate_per_acre: rates.rate_per_acre,
      rate_unit: rates.rate_unit ?? '',
      suggested_rate: rates.suggested_rate ?? '',
      sizes: preview.sizes,
    })),
    p_idempotency_key: key,
  });
  if (error) throw error;
  return assertRpcResult<{ changed_count: number }>(data, 'set_parent_rates');
}

/** Rates locked: one parent, with a reason. */
export const correctParentRates = async (preview: ParentRatePreview, rates: RateValues, reason: string, key: string) =>
  {
  const { data, error } = await supabaseUntyped.rpc('correct_parent_rates', {
    p_parent_id: preview.parent_id, p_rate_per_acre: rates.rate_per_acre, p_rate_unit: rates.rate_unit ?? '',
    p_suggested_rate: rates.suggested_rate ?? '', p_expected_parent_version: preview.parent_version,
    p_expected_sizes: preview.sizes, p_reason: reason, p_idempotency_key: key,
  });
  if (error) throw error;
  return assertRpcResult<ParentWriteResult>(data, 'correct_parent_rates');
}

export const previewMoveProductSize = async (productId: string, toParentId: string) =>
  {
  const { data, error } = await supabaseUntyped.rpc('preview_move_product_size', { p_product_id: productId, p_to_parent_id: toParentId });
  if (error) throw error;
  return assertRpcResult<MoveSizePreview>(data, 'preview_move_product_size');
}

export const moveProductSize = async (productId: string, preview: MoveSizePreview, reason: string, evidence: string, key: string) =>
  {
  const { data, error } = await supabaseUntyped.rpc('move_product_size', {
    p_product_id: productId, p_to_parent_id: preview.to_parent_id,
    p_expected_from_version: preview.from_parent_version, p_expected_to_version: preview.to_parent_version,
    p_expected_size_fingerprint: preview.size_fingerprint, p_reason: reason, p_evidence: evidence,
    p_expected_prices: preview.prices, p_idempotency_key: key,
  });
  if (error) throw error;
  return assertRpcResult<ParentWriteResult>(data, 'move_product_size');
}

export const previewIdentityCorrection = async (parentId: string, changes: Partial<IdentityValues>) =>
  {
  const { data, error } = await supabaseUntyped.rpc('preview_product_parent_identity_correction', { p_parent_id: parentId, p_changes: changes });
  if (error) throw error;
  return assertRpcResult<IdentityPreview>(data, 'preview_product_parent_identity_correction');
}

export const correctParentIdentity = async (input: {
  parentId: string; expectedVersion: number; changes: Partial<IdentityValues>; reason: string; evidence: string; key: string;
}) => {
  const { data, error } = await supabaseUntyped.rpc('correct_product_parent_identity', {
  p_parent_id: input.parentId, p_expected_parent_version: input.expectedVersion, p_changes: input.changes,
  p_reason: input.reason, p_evidence: input.evidence, p_idempotency_key: input.key,
});
  if (error) throw error;
  return assertRpcResult<ParentWriteResult>(data, 'correct_product_parent_identity');
}

const OPEN_WORK_BATCH = 500;

/**
 * Open quotes, orders, jobs and templates that use these sizes, from the read-only active-change review
 * (admin). A rate change reprices none of them; the list tells the admin which a rep may want to revise.
 */
export async function loadOpenWork(productIds: string[]): Promise<OpenWorkEntry[]> {
  const entries: OpenWorkEntry[] = [];
  // The review RPC refuses more than 500 ids, so every size is checked in batches; none is skipped.
  for (let start = 0; start < productIds.length; start += OPEN_WORK_BATCH) {
    const { data, error } = await supabaseUntyped.rpc('preview_product_active_change', {
      p_product_ids: productIds.slice(start, start + OPEN_WORK_BATCH), p_active: false,
    });
    if (error) throw error;
    const review = assertRpcResult<{ blockers: OpenWorkEntry[]; warnings: OpenWorkEntry[] }>(data, 'preview_product_active_change');
    entries.push(...(review.blockers ?? []), ...(review.warnings ?? []));
  }
  return entries.filter((entry) => entry.kind !== 'stock');
}

// The fields a new size may carry (apply_product_setup's insert mode); category, timings and rates
// come from the parent, and the database refuses them on the size.
const SIZE_INSERT_KEYS = [
  'product_name', 'sku', 'vendor', 'manufacturer', 'product_form', 'inventory_unit', 'unit_size',
  'container_unit', 'container_type', 'epa_registration', 'signal_word', 'max_label_rate_unit', 'notes',
  'container_size', 'max_label_rate', 'rei_hours', 'phi_days', 'is_rup',
] as const;

/** A new size's fields for create_product_with_parent or add_product_size; blank text goes as null. */
export function newSizeFields(product: Record<string, unknown>, role: ProductSizeRole): Record<string, unknown> {
  const size: Record<string, unknown> = { size_role: role };
  for (const key of SIZE_INSERT_KEYS) {
    const value = product[key];
    if (value === undefined) continue;
    size[key] = typeof value === 'string' && value.trim() === '' ? null : value;
  }
  return size;
}

export type ParentSearchIndex = ReadonlyMap<string, { name: string; nickname: string | null }>;

/** Size id → its parent's name and nickname, for text search. */
function parentSearchIndex(parents: readonly ProductParent[]): ParentSearchIndex {
  const index = new Map<string, { name: string; nickname: string | null }>();
  for (const parent of parents) {
    for (const size of parent.sizes) index.set(size.product_id, { name: parent.name, nickname: parent.nickname });
  }
  return index;
}

/**
 * Every parent, loaded once per screen. Grouped sizes come from it too. A failed load is reported and
 * leaves the map empty, so search still works on the size's own fields.
 */
export function useProductParents(reloadToken = 0): { parents: ProductParent[]; byProduct: ReadonlyMap<string, ProductParent>; index: ParentSearchIndex } {
  const [parents, setParents] = useState<ProductParent[]>([]);
  useEffect(() => {
    let cancelled = false;
    getProductParents(null)
      .then((loaded) => { if (!cancelled) setParents(loaded); })
      .catch((error: unknown) => {
        Sentry.captureException(toSentryError(error), { extra: { context: 'get_product_parents' } });
      });
    return () => { cancelled = true; };
  }, [reloadToken]);
  return useMemo(() => {
    const byProduct = new Map<string, ProductParent>();
    for (const parent of parents) for (const size of parent.sizes) byProduct.set(size.product_id, parent);
    return { parents, byProduct, index: parentSearchIndex(parents) };
  }, [parents]);
}
