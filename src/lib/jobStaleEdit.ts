import { assertRpcResult, supabase } from './db';
import type { DispatchAssignmentPayload } from './dispatchWizard';

/**
 * The job's edit version as the database computes it (`job_edit_version`, migration 20270228110000): a hash of the
 * job's edited columns and lines, plus one "job_field_id|applicator_id|crew_id|dispatch_status" string per field
 * dispatch. Save sends it back as `expected_version`; `save_job` refuses JOB_CHANGED_SINCE_LOADED under the job row
 * lock if the job no longer matches, and a lost-reply retry with the same key gets the stored result instead.
 */
export type JobEditVersion = { core: string; dispatches: string[] };

export const JOB_CHANGED_SINCE_LOADED_MESSAGE =
  'This job changed after you opened it. Nothing was saved. Reload the page to see the job as it is now, then make your edits again.';

/** Read before the page's job select, so a change landing in between can only refuse a save, never be overwritten. */
export async function readJobEditVersion(jobId: string): Promise<JobEditVersion> {
  const { data, error } = await supabase.rpc('job_edit_version', { p_job_id: jobId });
  if (error) throw error;
  const v = assertRpcResult<JobEditVersion>(data, 'job_edit_version');
  if (typeof v?.core !== 'string' || !Array.isArray(v.dispatches)) throw new Error('job_edit_version returned no version');
  return v;
}

/**
 * The version after this page's own Dispatch wizard: only the dispatched locations' strings are replaced, with what
 * the wizard sent (dispatch always sets status 'dispatched'). Anyone else's change still refuses the next Save.
 */
export function withOwnDispatches(version: JobEditVersion, sent: DispatchAssignmentPayload[]): JobEditVersion {
  const ids = new Set(sent.map((a) => a.job_field_id));
  const kept = version.dispatches.filter((d) => !ids.has(d.split('|')[0]));
  const mine = sent.map((a) => `${a.job_field_id}|${a.applicator_id ?? ''}|${a.crew_id ?? ''}|dispatched`);
  return { ...version, dispatches: [...kept, ...mine].sort() };
}
