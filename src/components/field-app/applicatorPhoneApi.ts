// shortcut: built ahead of the slice 2 database PRs; re-check names/types against the merged migrations and the regenerated registry before merge.
import { assertRpcResult, supabase, supabaseUntyped } from '../../lib/db';

export interface ApplicatorPhoneField {
  jobFieldId: string;
  fieldId: string;
  fieldName: string;
  state: string | null;
  plannedAcres: number | null;
}

export interface ApplicatorPhoneJob {
  id: string;
  jobNumber: string | null;
  status: string;
  jobDate: string | null;
  scheduledTime: string | null;
  plannedAcres: number | null;
  appliedAcres: number | null;
  remainingAcres: number | null;
  billedCustomerNames: string[];
  fields: ApplicatorPhoneField[] | null;
}

export interface ApplicatorLoadChoice {
  loadId: string;
  revisionId: string;
  label: string;
}

export interface RestrictedUseFieldDefinition {
  key: string;
  label: string;
}

export interface WorkEntryWeatherDraft {
  windSpeedMph: string;
  windDirection: string;
  temperatureF: string;
  humidityPercent: string;
}

export interface WorkEntryGaugeDraft {
  outcome: 'ran_dry' | 'gallons_left';
  gallonsLeft: string;
}

export interface WorkEntrySegmentDraft {
  loadId: string;
  revisionId: string;
  acres: string;
}

export interface ApplicatorWorkEntryDraft {
  jobId: string;
  fieldId: string;
  startedAt: string;
  finishedAt: string;
  acresSprayed: string;
  segments: WorkEntrySegmentDraft[];
  gauge: WorkEntryGaugeDraft | null;
  weather: WorkEntryWeatherDraft;
  restrictedUseValues: Record<string, string>;
  notes: string;
  pause: { acresLeft: string; resumeNote: string } | null;
}

export interface ApplicatorWorkEntrySummary {
  id: string;
  fieldId: string;
  sprayDateCentral: string;
  acresSprayed: number;
  resumeNote: string | null;
}

export interface NextLoadProposal {
  fieldId: string;
  fieldName: string;
  acresToFinish: number;
  resumeNote: string | null;
}

export const APPLICATOR_PHONE_CONTRACT_TODOS = {
  workEntryRead: 'TODO_WORK_ENTRY_READ_RPC: the safe read function, arguments, returned columns, and duplicate-warning result are not named.',
  loadRevisionRead: 'TODO_LOAD_REVISION_READ_PATH: the applicator load/revision choice path and returned columns are not named.',
  workEntryWrite: 'TODO_WORK_ENTRY_WRITE_RPC: the save function and exact argument names for entries, segments, gauge, weather, restricted-use values, and pause are not named.',
  jobDoneWrite: 'TODO_READY_FOR_REVIEW_RPC: the Job done function and exact argument names are not named.',
  fieldAssignments: 'TODO_FIELD_ASSIGNMENTS_READ_PATH: the safe crew-view columns or safe function for assigned field names, states, order, and acres are not named.',
  restrictedUseFields: 'TODO_RESTRICTED_USE_FIELDS: the per-state configuration source, field names, and value rules are not named.',
  weatherLookup: 'TODO_WEATHER_LOOKUP: the data source and exact field/time lookup contract are not named.',
  nextLoadProposal: 'TODO_NEXT_LOAD_PROPOSAL: the read path and exact acres-left/resume-note columns are not named.',
} as const;

interface CrewJobRow {
  id: string;
  job_number: string | null;
  status: string;
  job_date: string | null;
  scheduled_time: string | null;
  total_acres: number | null;
  applied_acres: number | null;
  remaining_acres: number | null;
}

interface BilledCustomerRpcRow {
  customer_id: string;
  farm_name: string | null;
  account_number: string | null;
  is_primary: boolean;
}

export class ApplicatorPhoneContractPendingError extends Error {
  readonly todo: string;

  constructor(todo: string, action: string) {
    super(`${action} is waiting for the field-application database contract. Nothing was saved.`);
    this.name = 'ApplicatorPhoneContractPendingError';
    this.todo = todo;
  }
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function rowsFrom(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    : [];
}

function parseCrewJob(value: Record<string, unknown>): CrewJobRow | null {
  if (typeof value.id !== 'string' || typeof value.status !== 'string') return null;
  return {
    id: value.id,
    job_number: nullableString(value.job_number),
    status: value.status,
    job_date: nullableString(value.job_date),
    scheduled_time: nullableString(value.scheduled_time),
    total_acres: nullableNumber(value.total_acres),
    applied_acres: nullableNumber(value.applied_acres),
    remaining_acres: nullableNumber(value.remaining_acres),
  };
}

async function loadBilledCustomerNames(jobId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('get_job_billed_customers', { p_job_id: jobId });
  if (error) throw error;
  const customers = assertRpcResult<BilledCustomerRpcRow[]>(data, 'get_job_billed_customers');
  return [...new Set(customers.map((row) => row.farm_name?.trim()).filter((name): name is string => Boolean(name)))];
}

export async function loadApplicatorPhoneJobs(): Promise<ApplicatorPhoneJob[]> {
  const { data, error } = await supabaseUntyped
    .from('jobs_crew')
    .select('id, job_number, status, job_date, scheduled_time, total_acres, applied_acres, remaining_acres')
    .in('status', ['scheduled', 'in_progress', 'ready_for_review'])
    .order('job_date', { ascending: true, nullsFirst: true });
  if (error) throw error;

  const jobs = rowsFrom(data).map(parseCrewJob).filter((job): job is CrewJobRow => job !== null);
  return Promise.all(jobs.map(async (job) => {
    const billedCustomerNames = await loadBilledCustomerNames(job.id);
    return {
      id: job.id,
      jobNumber: job.job_number,
      status: job.status,
      jobDate: job.job_date,
      scheduledTime: job.scheduled_time,
      plannedAcres: job.total_acres,
      appliedAcres: job.applied_acres,
      remainingAcres: job.remaining_acres,
      billedCustomerNames,
      fields: null,
    };
  }));
}

function pendingContract<T>(todo: string, action: string): Promise<T> {
  return Promise.reject(new ApplicatorPhoneContractPendingError(todo, action));
}

export function loadApplicatorWorkEntries(
  _jobId: string,
  _fieldId: string,
): Promise<ApplicatorWorkEntrySummary[]> {
  return pendingContract(APPLICATOR_PHONE_CONTRACT_TODOS.workEntryRead, 'Saved work entries');
}

export function loadApplicatorLoadChoices(_jobId: string): Promise<ApplicatorLoadChoice[]> {
  return pendingContract(APPLICATOR_PHONE_CONTRACT_TODOS.loadRevisionRead, 'Load and revision choices');
}

export function loadRestrictedUseFieldDefinitions(_state: string | null): Promise<RestrictedUseFieldDefinition[]> {
  return pendingContract(APPLICATOR_PHONE_CONTRACT_TODOS.restrictedUseFields, 'State-specific restricted-use fields');
}

export function loadNextLoadProposal(_jobId: string, _fieldId: string): Promise<NextLoadProposal | null> {
  return pendingContract(APPLICATOR_PHONE_CONTRACT_TODOS.nextLoadProposal, 'The next-load proposal');
}

export function saveApplicatorWorkEntry(
  _draft: ApplicatorWorkEntryDraft,
  _idempotencyKey: string,
): Promise<{ recordId: string }> {
  return pendingContract(APPLICATOR_PHONE_CONTRACT_TODOS.workEntryWrite, 'Saving this work entry');
}

export function markApplicatorJobDone(_jobId: string, _idempotencyKey: string): Promise<void> {
  return pendingContract(APPLICATOR_PHONE_CONTRACT_TODOS.jobDoneWrite, 'Marking this job done');
}
