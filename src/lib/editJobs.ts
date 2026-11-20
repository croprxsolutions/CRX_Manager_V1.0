import { supabase, assertRpcResult } from './db';

/** The server refuses more than this many jobs in one call (TOO_MANY_JOBS). */
export const EDIT_JOBS_MAX = 500;

export type EditJobsAction = 'cancel' | 'delete';
export type EditJobsChanges = Record<string, string | number | null>;

export interface EditJobsResult {
  updated: string[];
  cancelled: string[];
  deleted: string[];
  skipped: { id: string; reason: 'not_found' | 'deleted' | 'status'; status?: string }[];
}

/**
 * The idempotency scope for one edit_jobs payload: the same jobs + changes + action reuse one
 * key (a double click or a retry after a lost reply replays the stored result); any edit mints a new one.
 */
export function editJobsScope(jobIds: string[], changes: EditJobsChanges | null, action: EditJobsAction | null): string {
  const sortedChanges = changes ? Object.fromEntries(Object.entries(changes).sort(([a], [b]) => a.localeCompare(b))) : null;
  return JSON.stringify([[...new Set(jobIds)].sort(), sortedChanges, action]);
}

/** One call to edit_jobs: field changes, cancel, changes + cancel, or delete. Throws on any refusal. */
export async function editJobs(params: {
  jobIds: string[];
  changes?: EditJobsChanges | null;
  action?: EditJobsAction | null;
  performedBy: string;
  idempotencyKey: string;
}): Promise<EditJobsResult> {
  const { data, error } = await supabase.rpc('edit_jobs', {
    p_job_ids: params.jobIds,
    p_changes: params.changes ?? undefined,
    p_action: params.action ?? undefined,
    p_performed_by: params.performedBy,
    p_idempotency_key: params.idempotencyKey,
  });
  if (error) throw error;
  const result = assertRpcResult<EditJobsResult>(data, 'edit_jobs');
  if (!Array.isArray(result.updated) || !Array.isArray(result.cancelled) || !Array.isArray(result.deleted) || !Array.isArray(result.skipped)) {
    throw new Error('edit_jobs returned an unexpected result');
  }
  return result;
}

const jobs = (n: number) => `${n} job${n === 1 ? '' : 's'}`;

/**
 * Words each server count by operation, never the selection size:
 * "2 jobs edited. 1 cancelled. 1 already completed and could not be cancelled."
 */
export function describeEditJobsResult(result: EditJobsResult, action: EditJobsAction | null): string {
  const parts: string[] = [];
  if (result.updated.length > 0) parts.push(`${jobs(result.updated.length)} edited.`);
  if (result.cancelled.length > 0) parts.push(`${parts.length ? result.cancelled.length : jobs(result.cancelled.length)} cancelled.`);
  if (result.deleted.length > 0) parts.push(`${parts.length ? result.deleted.length : jobs(result.deleted.length)} deleted.`);

  const verb = action === 'delete' ? 'deleted' : action === 'cancel' ? 'cancelled' : 'changed';
  const byStatus = new Map<string, number>();
  let gone = 0;
  for (const s of result.skipped) {
    if (s.reason === 'status') byStatus.set(s.status ?? 'other', (byStatus.get(s.status ?? 'other') ?? 0) + 1);
    else gone += 1;
  }
  for (const [status, n] of byStatus) {
    parts.push(`${n} already ${status.replace(/_/g, ' ')} and could not be ${verb}.`);
  }
  if (gone > 0) parts.push(`${gone} no longer exist${gone === 1 ? 's' : ''} and ${gone === 1 ? 'was' : 'were'} skipped.`);
  return parts.length > 0 ? parts.join(' ') : 'Nothing changed.';
}

/** True when nothing the caller asked for actually happened (every job skipped). */
export function editJobsChangedNothing(result: EditJobsResult): boolean {
  return result.updated.length + result.cancelled.length + result.deleted.length === 0;
}
