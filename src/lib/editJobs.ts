import { supabase, assertRpcResult } from './db';
import { generateIdempotencyKey } from './idempotency';
import { sanitizeError } from './errorSanitizer';
import type { Json } from '../types/supabase';
import type { JobStatus } from '../types';

// #1979: every screen change to a spray job goes through the edit_jobs server function
// (20270203110000_job_writes_through_rpcs.sql). This file is the one caller.

const EDIT_JOBS_MAX = 500;

/** Too many jobs for one save, as a message to show BEFORE asking the user to confirm; null when fine. */
export function editJobsLimitMessage(count: number): string | null {
  return count > EDIT_JOBS_MAX ? `Choose at most ${EDIT_JOBS_MAX} jobs at a time (${count} selected).` : null;
}

export type EditJobsAction = 'cancel' | 'delete';
export type EditJobsChanges = Partial<Record<
  'job_date' | 'schedule_date' | 'applicator_id' | 'batch_ref' | 'ground_crew_id'
  | 'carrier_rate_gpa' | 'loader_tank_capacity' | 'loader_comment',
  string | number | null
>>;
export interface EditJobsSkip { id: string; reason: 'not_found' | 'deleted' | 'status'; status?: JobStatus }
export interface EditJobsResult { updated: string[]; cancelled: string[]; deleted: string[]; skipped: EditJobsSkip[] }

export async function editJobs(args: {
  jobIds: string[];
  changes?: EditJobsChanges | null;
  action?: EditJobsAction | null;
  performedBy: string;
}): Promise<EditJobsResult> {
  if (args.jobIds.length > EDIT_JOBS_MAX) {
    throw new Error(`Nothing was saved. Choose at most ${EDIT_JOBS_MAX} jobs at a time.`);
  }
  const { data, error } = await supabase.rpc('edit_jobs', {
    p_job_ids: args.jobIds,
    p_changes: (args.changes ?? undefined) as Json | undefined,
    p_action: args.action ?? undefined,
    p_performed_by: args.performedBy,
    // Every click is a fresh save, never a replay of an earlier attempt (Mason, 2026-11-21, #2151): each edit
    // sets values or skips jobs already cancelled/deleted, so sending it again is safe.
    // eslint-disable-next-line local-rules/idempotency-key-from-hook -- fresh per click is Mason's decision (DECISION_LOG 2026-11-21, #2151)
    p_idempotency_key: generateIdempotencyKey('edit_jobs', args.performedBy),
  });
  if (error) throw error;
  const r = assertRpcResult<EditJobsResult>(data, 'edit_jobs');
  if (![r.updated, r.cancelled, r.deleted, r.skipped].every(Array.isArray)) {
    throw new Error('edit_jobs returned an unexpected result');
  }
  return r;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function skipLabel(s: EditJobsSkip): string {
  if (s.reason === 'not_found') return 'no longer exists';
  if (s.reason === 'deleted') return 'already deleted';
  // A second click after a lost reply finds the job cancelled by the first: say so plainly.
  if (s.status === 'cancelled') return 'already cancelled';
  return (s.status ?? 'other status').replace(/_/g, ' ');
}

/** Server counts in words: "2 jobs edited. 1 cancelled. 1 skipped (completed)." */
export function summarizeEditJobs(r: EditJobsResult): string {
  const parts: string[] = [];
  if (r.updated.length) parts.push(`${plural(r.updated.length, 'job')} edited.`);
  if (r.cancelled.length) parts.push(`${plural(r.cancelled.length, 'job')} cancelled.`);
  if (r.deleted.length) parts.push(`${plural(r.deleted.length, 'job')} deleted.`);
  // A job whose field changes saved but whose cancel was refused is "not cancelled", not "skipped".
  const groups = new Map<string, number>();
  for (const s of r.skipped) {
    const key = `${r.updated.includes(s.id) ? 'not cancelled' : 'skipped'} (${skipLabel(s)})`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [label, n] of groups) parts.push(`${plural(n, 'job')} ${label}.`);
  return parts.length ? parts.join(' ') : 'Nothing changed.';
}

const FIELD_LABELS: Record<string, string> = {
  job_date: 'Schedule date', schedule_date: 'Planning date', applicator_id: 'Applicator',
  batch_ref: 'Batch', ground_crew_id: 'Ground crew', carrier_rate_gpa: 'Carrier rate',
  loader_tank_capacity: 'Tank capacity', loader_comment: 'Loader comment',
};

/** Plain-English refusal for an edit_jobs error; anything else goes through sanitizeError. */
export function editJobsErrorMessage(err: unknown): string {
  const message = typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : '';
  if (/^INSUFFICIENT_ROLE\b/.test(message)) {
    return 'Nothing was saved. Only an admin, or a sales rep with the Job Schedule page, can change jobs.';
  }
  if (/^EDIT_NOT_APPLIED\b/.test(message)) {
    return 'Nothing was saved. Some jobs changed while saving; refresh and try again.';
  }
  const detail = message.match(/^(?:BAD_VALUE|JOB_DATE_REQUIRED|TOO_MANY_JOBS|TOO_MANY_ENTRIES|NO_JOBS):\s*(.+)$/s)?.[1];
  if (detail) {
    const named = detail.replace(/\b[a-z_]+\b/g, (w) => FIELD_LABELS[w] ?? w);
    return `Nothing was saved. ${named.charAt(0).toUpperCase()}${named.slice(1)}.`;
  }
  if (message.startsWith('Nothing was saved.')) return message;
  return sanitizeError(err);
}
