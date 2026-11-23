/**
 * KI-195: the EPA number a job's printouts show per product. A sprayed or finished job keeps the number each product
 * had (`job_product_epa`, migration 20261204120000); only a product with no kept row reads the catalog, as before.
 */
import { supabase } from './db';

export const EPA_NOT_RECORDED = 'Not recorded';
export const EPA_UNKNOWN = 'Unknown';

export interface KeptEpa {
  epa_registration: string | null;
  not_recorded: boolean;
}

/** Print text for one product: the kept number, `Unknown` (kept with no number), `Not recorded`, else the catalog's. */
export function jobEpaText(kept: KeptEpa | undefined, catalog: string | null): string | null {
  if (!kept) return catalog;
  if (kept.not_recorded) return EPA_NOT_RECORDED;
  return kept.epa_registration ?? EPA_UNKNOWN;
}

/**
 * Replace each product's catalog `epa_registration` in `labels` (keyed by product id) with the job's print text.
 * Throws when the kept numbers cannot be read: a compliance printout must never fall back to the catalog.
 */
export async function applyKeptEpa<T extends { epa_registration: string | null }>(
  jobId: string,
  labels: Map<string, T>,
): Promise<void> {
  if (labels.size === 0) return;
  // The kept rows are visible only while the job is: a job the caller can no longer see must not read as "none kept".
  const { data: job, error: jobError } = await supabase.from('jobs').select('id').eq('id', jobId).maybeSingle();
  if (jobError || !job) throw (jobError ?? new Error('This job can no longer be opened, so its EPA numbers cannot be printed'));
  // Only the printed products: at most one row each, so the answer is never cut short.
  const { data, error } = await supabase
    .from('job_product_epa')
    .select('product_id, epa_registration, not_recorded')
    .eq('job_id', jobId)
    .in('product_id', [...labels.keys()]);
  if (error || !data) throw (error ?? new Error('Could not load the EPA numbers kept on this job'));
  const kept = new Map(data.map((r) => [r.product_id, r]));
  labels.forEach((label, productId) => {
    label.epa_registration = jobEpaText(kept.get(productId), label.epa_registration);
  });
}
