/**
 * KI-195: the EPA number a job's printouts show per product. A sprayed or finished job keeps the number each product
 * had (`job_product_epa`, migration 20261204120000); only a product with no kept row reads the catalog, as before.
 */
import { supabase } from './db';

const EPA_NOT_RECORDED = 'Not recorded';
// Mason 2026-11-24: a product kept with no number (most adjuvants/fertilizers) prints a dash, as before the spray.
const EPA_NONE = '—';

export interface KeptEpa {
  epa_registration: string | null;
  not_recorded: boolean;
}

/** Print text for one product: the kept number, a dash (kept with no number), `Not recorded`, else the catalog's. */
export function jobEpaText(kept: KeptEpa | undefined, catalog: string | null): string | null {
  if (!kept) return catalog;
  if (kept.not_recorded) return EPA_NOT_RECORDED;
  return kept.epa_registration?.trim() || EPA_NONE;
}

async function assertJobVisible(jobId: string): Promise<void> {
  const { data: job, error } = await supabase.from('jobs').select('id').eq('id', jobId).maybeSingle();
  if (error || !job) throw (error ?? new Error('This job can no longer be opened, so its EPA numbers cannot be printed'));
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
  // The kept rows are visible only while the job is: a job the caller cannot see must not read as "none kept".
  // Checked before AND after the read, so access that ends (or starts) in between cannot pass an empty answer.
  await assertJobVisible(jobId);
  // Only the printed products: at most one row each, so the answer is never cut short.
  const { data, error } = await supabase
    .from('job_product_epa')
    .select('product_id, epa_registration, not_recorded')
    .eq('job_id', jobId)
    .in('product_id', [...labels.keys()]);
  if (error || !data) throw (error ?? new Error('Could not load the EPA numbers kept on this job'));
  await assertJobVisible(jobId);
  const kept = new Map(data.map((r) => [r.product_id, r]));
  labels.forEach((label, productId) => {
    label.epa_registration = jobEpaText(kept.get(productId), label.epa_registration);
  });
}
