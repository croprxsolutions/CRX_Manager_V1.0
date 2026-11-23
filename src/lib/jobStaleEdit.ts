import { supabase } from './db';

/**
 * Job columns that another person's save (Job Detail, Job Schedule bulk edit, the field app) changes and that
 * this screen's Save would silently overwrite. Same idea as the PO cost check (KI-197): the screen sends back
 * what it loaded and the save is refused when the stored value moved. total_acres and total_price_cents stand in
 * for someone else's field and product lines. Left out on purpose: updated_at (printing and applied records bump
 * it, which would refuse ordinary saves), printed_at, applied_acres, remaining_acres.
 */
const JOB_STALE_CHECK_COLUMNS = [
  'status', 'customer_id', 'job_date', 'scheduled_time', 'applicator_id', 'vehicle_id', 'recipe_id',
  'application_service_id', 'notes', 'batch_id', 'total_acres', 'total_price_cents', 'call_date',
  'date_proposed', 'time_proposed', 'schedule_date', 'date_expires', 'consultant_id', 'loader_comment',
  'additional_info', 'internal_memo', 'ground_crew_id', 'carrier_rate_gpa', 'loader_tank_capacity',
  'invoice_id', 'deleted_at',
] as const;

export type JobStaleSnapshot = Record<string, unknown>;

export const JOB_CHANGED_SINCE_LOADED_MESSAGE =
  'Someone else changed this job after you opened it. Nothing was saved. Reload the page to see their changes, then make your edits again.';

export function pickJobStaleSnapshot(row: Record<string, unknown>): JobStaleSnapshot {
  return Object.fromEntries(JOB_STALE_CHECK_COLUMNS.map((c) => [c, row[c] ?? null]));
}

/** The checked columns whose stored value differs from what the screen loaded. */
function jobChangedColumns(loaded: JobStaleSnapshot, current: Record<string, unknown>): string[] {
  return JOB_STALE_CHECK_COLUMNS.filter(
    (c) => JSON.stringify(loaded[c] ?? null) !== JSON.stringify(current[c] ?? null),
  );
}

/**
 * Re-reads the job and returns the columns changed since `loaded`. Throws on a failed read so the save stops.
 * shortcut: checked just before save_job, not inside it, so two saves landing within the same moment can still
 * both pass; move the compare into save_job if that ever matters.
 */
export async function jobChangedSinceLoaded(jobId: string, loaded: JobStaleSnapshot): Promise<string[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select(JOB_STALE_CHECK_COLUMNS.join(', '))
    .eq('id', jobId)
    .single();
  if (error) throw error;
  return jobChangedColumns(loaded, (data ?? {}) as unknown as Record<string, unknown>);
}
