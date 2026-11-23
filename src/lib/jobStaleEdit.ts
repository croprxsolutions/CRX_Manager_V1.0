import { supabase } from './db';

/**
 * What a job Save overwrites: the job columns this screen edits plus its field, billing-split and product lines.
 * Someone else changing any of them after the page loaded refuses the save (same idea as the PO cost check,
 * KI-197). Left out on purpose: updated_at (printing and applied records bump it, which would refuse ordinary
 * saves), printed_at, applied_acres, remaining_acres, line ids (lines are compared by content).
 * Every name here is in JOB_COLUMNS / JOB_CHEMICAL_COLUMNS (src/lib/costFields.ts), so no cost column is read.
 */
const JOB_STALE_CHECK_COLUMNS = [
  'status', 'customer_id', 'job_date', 'scheduled_time', 'applicator_id', 'vehicle_id', 'recipe_id',
  'application_service_id', 'notes', 'batch_id', 'total_acres', 'total_price_cents', 'call_date',
  'date_proposed', 'time_proposed', 'schedule_date', 'date_expires', 'consultant_id', 'loader_comment',
  'additional_info', 'internal_memo', 'ground_crew_id', 'carrier_rate_gpa', 'loader_tank_capacity',
  'invoice_id', 'deleted_at',
];
const JOB_STALE_CHECK_LINES: Record<string, string[]> = {
  job_fields: ['field_id', 'acres_to_treat', 'planted_acres', 'crop', 'strip', 'pests', 'sort_order'],
  job_field_shares: ['field_id', 'customer_id', 'split_pct', 'is_primary'],
  job_chemicals: ['product_id', 'quantity', 'unit', 'rate_per_acre', 'rate_unit', 'price_per_unit_cents',
    'sort_order', 'diluent_rate', 'rei_hours', 'phi_days', 'warehouse', 'vendor', 'customer_supplied', 'driver'],
};
const JOB_STALE_CHECK_SELECT = [
  ...JOB_STALE_CHECK_COLUMNS,
  ...Object.entries(JOB_STALE_CHECK_LINES).map(([table, cols]) => `${table}(${cols.join(', ')})`),
].join(', ');

export type JobStaleSnapshot = Record<string, string>;

export const JOB_CHANGED_SINCE_LOADED_MESSAGE =
  'Someone else changed this job after you opened it. Nothing was saved. Reload the page to see their changes, then make your edits again.';

/** A comparable copy of a job row as read with its lines (the page load or the pre-save re-read). */
export function pickJobStaleSnapshot(row: Record<string, unknown>): JobStaleSnapshot {
  const out: JobStaleSnapshot = {};
  for (const c of JOB_STALE_CHECK_COLUMNS) out[c] = JSON.stringify(row[c] ?? null);
  for (const [table, cols] of Object.entries(JOB_STALE_CHECK_LINES)) {
    const lines = Array.isArray(row[table]) ? (row[table] as Record<string, unknown>[]) : [];
    out[table] = JSON.stringify(lines.map((l) => JSON.stringify(cols.map((c) => l[c] ?? null))).sort());
  }
  return out;
}

/**
 * Re-reads the job and returns what changed since `loaded` (column or line-table names). Throws on a failed read.
 * shortcut: checked just before save_job, not inside it, so two saves clicked within the same moment can still
 * both pass (Mason chose this over a database change, 2026-11-23); move the compare into save_job if that matters.
 */
export async function jobChangedSinceLoaded(jobId: string, loaded: JobStaleSnapshot): Promise<string[]> {
  const { data, error } = await supabase.from('jobs').select(JOB_STALE_CHECK_SELECT).eq('id', jobId).single();
  if (error) throw error;
  const current = pickJobStaleSnapshot((data ?? {}) as unknown as Record<string, unknown>);
  return Object.keys(current).filter((k) => current[k] !== loaded[k]);
}
