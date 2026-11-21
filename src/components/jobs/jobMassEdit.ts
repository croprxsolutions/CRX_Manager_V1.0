import type { JobStatus } from '../../types';

// Field-app parity #7: pure helpers for the Mass Edit bulk action over the
// checkbox-selected jobs. Kept side-effect-free so the "only set the filled
// fields" + status-legality logic is unit-testable away from Supabase.

/**
 * The opt-in sections the office can toggle in the Mass Edit modal. Each is OFF
 * by default ("leave unchanged"); only an enabled section contributes to the
 * write. The loader-worksheet section (#10) bulk-sets the per-load planning inputs
 * (carrier rate / tank-capacity override / loader comment) across many jobs.
 */
export interface MassEditDraft {
  /** Set the visible "Scheduled" date (jobs.job_date) on every selected job. */
  setJobDate: boolean;
  jobDate: string; // yyyy-mm-dd

  /** Also set the #1 planning sub-field (jobs.schedule_date). */
  setScheduleDate: boolean;
  scheduleDate: string; // yyyy-mm-dd

  /** Bulk-set jobs.status (only safe, side-effect-free transitions apply). */
  setStatus: boolean;
  status: JobStatus | '';

  /** Bulk-set jobs.applicator_id (or clear it). */
  setApplicator: boolean;
  applicatorId: string | null; // null = clear

  /** Bulk-set jobs.batch_ref (or clear it). */
  setBatch: boolean;
  batchRef: string | null; // null = remove from batch

  // ── Loader Worksheet (#10) — per-load planning inputs ────────────────────────
  /** Bulk-set the loader-worksheet inputs (carrier rate / tank capacity / comment). */
  setLoader: boolean;
  /** Carrier (water/spray) gallons per acre. Blank => clear (NULL). */
  carrierRateGpa: string;
  /** Per-job tank-capacity override (gallons). Blank => clear (NULL = use vehicle). */
  loaderTankCapacity: string;
  /** Free-text loader comment. Blank => clear. */
  loaderComment: string;
}

export const emptyMassEditDraft: MassEditDraft = {
  setJobDate: false,
  jobDate: '',
  setScheduleDate: false,
  scheduleDate: '',
  setStatus: false,
  status: '',
  setApplicator: false,
  applicatorId: null,
  setBatch: false,
  batchRef: null,
  setLoader: false,
  carrierRateGpa: '',
  loaderTankCapacity: '',
  loaderComment: '',
};

/**
 * Canonical status superset (matches the live CHECK on jobs.status and the #6
 * filter list). Only `cancelled` is a SAFE bulk target: it is the one transition
 * JobDetail performs as a plain .update() with no data-integrity side-effects
 * (mirrors handleCancelJob). The forward lifecycle steps each run through an RPC
 * that creates required side-effects — start_job (records actual_start_time +
 * activity), complete_job (creates the application_record, consumes inventory
 * holds, writes inventory_transactions), and invoiced (transfer_job_to_invoice
 * mints an invoice). Bulk-flipping those raw would skip that work AND many would
 * be rejected by _enforce_job_status_transition(). So the modal offers them but
 * disables them, pointing the user at the per-job action.
 */
export const MASS_EDIT_STATUS_OPTIONS: { value: JobStatus; label: string; bulkSafe: boolean }[] = [
  { value: 'scheduled', label: 'Scheduled', bulkSafe: false },
  { value: 'in_progress', label: 'In Progress', bulkSafe: false },
  { value: 'completed', label: 'Completed', bulkSafe: false },
  { value: 'invoiced', label: 'Invoiced', bulkSafe: false },
  { value: 'cancelled', label: 'Cancelled', bulkSafe: true },
];

export function isStatusBulkSafe(status: JobStatus): boolean {
  return MASS_EDIT_STATUS_OPTIONS.find((o) => o.value === status)?.bulkSafe ?? false;
}

/**
 * The set of CURRENT job statuses from which a non-admin bulk transition to
 * `target` is allowed by _enforce_job_status_transition(). Used to pre-flight a
 * bulk status change so we never fire an UPDATE the trigger will reject (and so
 * the modal can warn about jobs that would be skipped). Same-status is a no-op
 * the trigger accepts but we treat as "already there" (not a change).
 *
 * Mirrors the trigger exactly (see 20260620150000_job_cancel_gate.sql):
 *   scheduled    -> in_progress
 *   in_progress  -> completed
 *   completed    -> invoiced
 *   scheduled|in_progress -> cancelled
 */
export function allowedSourceStatuses(target: JobStatus): JobStatus[] {
  switch (target) {
    case 'in_progress':
      return ['scheduled'];
    case 'completed':
      return ['in_progress'];
    case 'invoiced':
      return ['completed'];
    case 'cancelled':
      return ['scheduled', 'in_progress'];
    case 'scheduled':
    default:
      // Nothing legally transitions FORWARD into 'scheduled'.
      return [];
  }
}

/**
 * Split selected jobs into the ones a bulk status change to `target` can legally
 * touch vs the ones that would be rejected/skipped. A job already AT `target` is
 * "unchanged" (no-op), not eligible and not a failure.
 */
export function partitionByStatusLegality<T extends { id: string; status: JobStatus }>(
  jobs: T[],
  target: JobStatus
): { eligible: T[]; unchanged: T[]; blocked: T[] } {
  const sources = allowedSourceStatuses(target);
  const eligible: T[] = [];
  const unchanged: T[] = [];
  const blocked: T[] = [];
  for (const j of jobs) {
    if (j.status === target) unchanged.push(j);
    else if (sources.includes(j.status)) eligible.push(j);
    else blocked.push(j);
  }
  return { eligible, unchanged, blocked };
}

/**
 * Build the column patch for the NON-status fields from a draft, including only
 * the sections the user enabled ("leave unchanged" is the default for every
 * field). Status is handled separately because it must be pre-flighted per job
 * for transition legality, so it is intentionally excluded here.
 *
 * Returns `null` when no non-status section is enabled (nothing to write).
 *
 * Loader-worksheet numbers: a blank input clears to NULL; a value outside the
 * edit_jobs range is dropped to NULL. Use `loaderInputsValid` to block it in the UI.
 */
export function buildFieldPatch(draft: MassEditDraft): Record<string, string | number | null> | null {
  const patch: Record<string, string | number | null> = {};
  if (draft.setJobDate && draft.jobDate) patch.job_date = draft.jobDate;
  if (draft.setScheduleDate) patch.schedule_date = draft.scheduleDate || null;
  if (draft.setApplicator) patch.applicator_id = draft.applicatorId;
  if (draft.setBatch) patch.batch_ref = draft.batchRef;
  if (draft.setLoader) {
    // Blank clears (NULL); an out-of-range number is dropped to NULL here, but the modal blocks
    // Apply first (loaderInputsValid), so it never reaches edit_jobs, which would refuse it.
    patch.carrier_rate_gpa = draft.carrierRateGpa.trim() !== '' && !loaderNumberError(draft.carrierRateGpa, 'carrier')
      ? Number(draft.carrierRateGpa.trim()) : null;
    patch.loader_tank_capacity = draft.loaderTankCapacity.trim() !== '' && !loaderNumberError(draft.loaderTankCapacity, 'capacity')
      ? Number(draft.loaderTankCapacity.trim()) : null;
    // Comment: blank => NULL (clear).
    patch.loader_comment = draft.loaderComment.trim() !== '' ? draft.loaderComment.trim() : null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// edit_jobs refuses loader numbers outside this range (carrier rate may also be 0).
const LOADER_NUMBER_MIN = 0.001;
const LOADER_NUMBER_MAX = 1_000_000;

/** Message for a value the server would refuse, or null when the input is blank or in range. */
export function loaderNumberError(raw: string, kind: 'carrier' | 'capacity'): string | null {
  if (raw.trim() === '') return null;
  const label = kind === 'carrier' ? 'Carrier rate' : 'Tank capacity';
  // Plain decimals only: "12abc" and "1e-400" (which Number reads as 0) are refused.
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(raw.trim())) return `${label} must be a number.`;
  const n = Number(raw.trim());
  // Only text that IS zero counts as 0: "0.000…001" with hundreds of zeros reads as 0 in Number and is refused below.
  if (kind === 'carrier' && /^-?(0+(\.0*)?|\.0+)$/.test(raw.trim())) return null;
  if (n < LOADER_NUMBER_MIN || n > LOADER_NUMBER_MAX) {
    return kind === 'carrier'
      ? 'Carrier rate must be 0, or 0.001 to 1,000,000.'
      : 'Tank capacity must be 0.001 to 1,000,000.';
  }
  return null;
}

/**
 * True when the loader section's numeric inputs are blank or inside the range edit_jobs
 * accepts (carrier 0 or 0.001-1,000,000; capacity 0.001-1,000,000). The modal uses this
 * to block Apply rather than silently dropping the value.
 */
export function loaderInputsValid(draft: MassEditDraft): boolean {
  if (!draft.setLoader) return true;
  return !loaderNumberError(draft.carrierRateGpa, 'carrier') && !loaderNumberError(draft.loaderTankCapacity, 'capacity');
}

/**
 * True when the draft would change at least one thing — a non-status field
 * patch OR a status change. Drives the Apply button's enabled state.
 */
export function hasAnyChange(draft: MassEditDraft): boolean {
  if (buildFieldPatch(draft) !== null) return true;
  if (draft.setStatus && draft.status) return true;
  return false;
}

/**
 * A human-readable list of the changes a draft will apply, for the confirm copy
 * (so the office sees exactly what is about to change before pressing Apply).
 */
export function describeChanges(
  draft: MassEditDraft,
  opts: { applicatorName?: string; batchName?: string }
): string[] {
  const lines: string[] = [];
  if (draft.setJobDate && draft.jobDate) lines.push(`Schedule Date → ${draft.jobDate}`);
  if (draft.setScheduleDate) lines.push(`Planning Date → ${draft.scheduleDate || '(cleared)'}`);
  if (draft.setStatus && draft.status) {
    const label = MASS_EDIT_STATUS_OPTIONS.find((o) => o.value === draft.status)?.label ?? draft.status;
    lines.push(`Status → ${label}`);
  }
  if (draft.setApplicator) lines.push(`Applicator → ${draft.applicatorId ? (opts.applicatorName ?? 'selected') : '(cleared)'}`);
  if (draft.setBatch) lines.push(`Batch → ${draft.batchRef ? (opts.batchName ?? 'selected') : '(removed)'}`);
  if (draft.setLoader) {
    lines.push(`Carrier Rate → ${draft.carrierRateGpa.trim() !== '' ? `${draft.carrierRateGpa} gal/ac` : '(cleared)'}`);
    lines.push(`Tank Capacity → ${draft.loaderTankCapacity.trim() !== '' ? `${draft.loaderTankCapacity} gal` : '(cleared / use vehicle)'}`);
    lines.push(`Loader Comment → ${draft.loaderComment.trim() !== '' ? 'set' : '(cleared)'}`);
  }
  return lines;
}
