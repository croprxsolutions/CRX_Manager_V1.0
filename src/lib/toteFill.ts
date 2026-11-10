import { assertRpcResult, supabaseUntyped } from './db';
import { fetchAllRows, pageWithList } from './pagedRead';

// BLK-1a (20261117130000_tote_fill_from_bulk): fill a fertilizer tote from its Bulk, quantities only.
// The database checks the tote, its source, its units and the stock; these RPCs are not in the
// generated types yet.

/** What the fill would record now. Sent back unchanged: the fill refuses if anything differs. */
export interface ToteFillPreview {
  tote_product_id: string;
  bulk_product_id: string;
  parent_id: string;
  totes: number;
  tote_unit: string;
  tote_size: number;
  tote_size_unit: string;
  gallons: number;
  bulk_unit: string;
  bulk_quantity: number;
  bulk_before: number;
  bulk_after: number;
  tote_before: number;
  tote_after: number;
  shortfall: number;
  bulk_cost_cents: number | null;
  tote_cost_cents: number | null;
  estimate_before_cents: number | null;
  estimate_after_cents: number | null;
  cost_check: 'equal' | 'differ' | 'missing';
}

export interface ToteFillResult {
  fill_id: string;
  bulk_unit: string;
  bulk_quantity: number;
  bulk_after: number;
  tote_after: number;
  shortfall: number;
  requires_review: boolean;
}

export interface ToteFillRow {
  id: string;
  totes: number;
  bulk_unit: string;
  bulk_quantity: number;
  shortfall_quantity: number;
  reverses_fill_id: string | null;
  reason: string | null;
  created_at: string;
}

export async function previewToteFill(toteProductId: string, totes: number): Promise<ToteFillPreview> {
  const { data, error } = await supabaseUntyped.rpc('preview_tote_fill', { p_tote_product_id: toteProductId, p_totes: totes });
  if (error) throw error;
  return assertRpcResult<ToteFillPreview>(data, 'preview_tote_fill');
}

export async function fillToteFromBulk(preview: ToteFillPreview, key: string): Promise<ToteFillResult> {
  const { data, error } = await supabaseUntyped.rpc('fill_tote_from_bulk', {
    p_tote_product_id: preview.tote_product_id, p_totes: preview.totes, p_expected: preview, p_idempotency_key: key,
  });
  if (error) throw error;
  return assertRpcResult<ToteFillResult>(data, 'fill_tote_from_bulk');
}

export async function reverseToteFill(fillId: string, reason: string, key: string): Promise<void> {
  const { data, error } = await supabaseUntyped.rpc('reverse_tote_fill', { p_fill_id: fillId, p_reason: reason, p_idempotency_key: key });
  if (error) throw error;
  assertRpcResult(data, 'reverse_tote_fill');
}

/** The only location a tote fill reads and changes (fill_tote_from_bulk, 20261117130000). */
export const TOTE_FILL_LOCATION = 'Main Warehouse';

/** Tote sizes that have a Bulk fill source. The database still refuses any that may not be filled now. */
export async function listFillableToteIds(): Promise<Set<string>> {
  // product_id is this table's primary key (it has no id column).
  const { data, error } = await fetchAllRows<{ product_id: string }>((from, to) => pageWithList(supabaseUntyped
    .from('product_parent_members')
    .select('product_id', { count: 'exact' })
    .eq('size_role', 'fixed_tote')
    .not('fill_source_product_id', 'is', null)
    .order('product_id')
    .range(from, to)));
  if (error) throw error;
  return new Set(((data ?? []) as { product_id: string }[]).map((row) => row.product_id));
}

export async function listToteFills(toteProductId: string): Promise<ToteFillRow[]> {
  const { data, error } = await fetchAllRows<ToteFillRow>((from, to) => pageWithList(supabaseUntyped
    .from('tote_fills')
    .select('id, totes, bulk_unit, bulk_quantity, shortfall_quantity, reverses_fill_id, reason, created_at', { count: 'exact' })
    .eq('tote_product_id', toteProductId)
    .order('created_at', { ascending: false })
    .order('id')
    .range(from, to)));
  if (error) throw error;
  return (data ?? []) as ToteFillRow[];
}
