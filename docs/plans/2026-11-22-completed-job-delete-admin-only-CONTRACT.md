# Completed job delete is admin-only on every path (#2196) — behavior contract

Read at `origin/staging` `def05e704` (2026-11-22).

## Facts

- F1. `edit_jobs` (`20270203110000_job_writes_through_rpcs.sql` ~L190) lets a sales rep soft-delete only `scheduled`/`in_progress` jobs; an admin may also delete `completed`. Invoiced work is skipped for everyone.
- F2. Direct writes are still open: `jobs_update` RLS allows admin and sales rep only (`20260430180000` replaced the applicator arm); `authenticated` holds UPDATE on `deleted_at` (job-writes contract F1). PR C (revoke direct writes) is still pending Mason's answer.
- F3. The table guard `_enforce_billed_job_immutability()` (newest body `20260629120000`, BEFORE UPDATE trigger `enforce_billed_job_immutability`) returns early for any status other than `invoiced`/`cancelled`, so a `completed` job's `deleted_at` can be set by any non-admin with direct UPDATE.
- F4. Hard DELETE is admin-only (`jobs_delete` USING `is_admin()`).
- F5. The only function that writes `jobs.deleted_at` is `edit_jobs` (multiline search of `supabase/migrations/`); no screen, Edge Function or script writes it directly (PR B #2151 moved the screens).
- F6. Unbilled Jobs reads `status='completed' AND invoice_id IS NULL AND deleted_at IS NULL` (`UnbilledApplicationsPanel.tsx:186-190`), so a soft-deleted completed job silently leaves it.

## Established decision

- Only an admin may delete a completed job (Mason, 2026-11-21; job-writes contract exception (b)).

## Outcome

The database refuses any non-admin write that newly leaves a job both `completed` and deleted: deleting a completed job, completing and deleting in one write, or completing an already-deleted job. Refusal is `check_violation` on a direct write; `edit_jobs` keeps skipping a rep's completed job (reason `status`); an applicator's direct UPDATE touches no row (RLS). Admins and the existing `app.admin_override` hatch are unchanged.

Smallest change: one new migration that re-creates `_enforce_billed_job_immutability()` with one added block before the early return; trigger unchanged. Files: the migration, its ledger record, a real-schema prover (`scripts/smoke/prove-completed-job-delete-admin-only-real-schema.mjs`).

## State and failure

- Rules that always hold: a non-admin can never move a completed job to deleted. Restoring (non-NULL → NULL) is not touched.
- Existing rows: none change. A completed job a rep already soft-deleted stays deleted (an admin can restore it); no new values or readers.
- Deployed app: screens call `edit_jobs`, which already skips completed jobs for reps, so the trigger never fires on a screen path. No rollout ordering.
- Timing: a single-row trigger check; no new locks.
- `edit_jobs` called by an admin: `is_admin()` reads `auth.uid()` of the caller inside the SECURITY DEFINER function, so the admin delete still passes.

## Proof cases (real-schema prover, disposable Docker Postgres)

1. BEFORE the migration: as a sales rep under RLS, `UPDATE jobs SET deleted_at = now()` on a completed job succeeds (the hole is real).
2. AFTER: same rep update → refused `check_violation`, `deleted_at` still NULL.
3. AFTER: assigned applicator, same update on their completed job → 0 rows (RLS), job unchanged. Rep completing a deleted job, and rep completing + deleting in one write → refused. Override unset (NULL) and explicitly `false` → refused; `true` (sanctioned hatch) → passes. Inactive admin → refused.
4. AFTER: admin direct update on a completed job → succeeds.
5. AFTER: `edit_jobs` delete as admin on {completed} → deleted; as rep on {scheduled, completed} → scheduled deleted, completed skipped `status` (unchanged behavior).
6. AFTER: rep direct soft-delete of a `scheduled` job → still succeeds (no wider change).
7. AFTER: other edits by a rep on a completed job (e.g. `loader_comment`) → still succeed (no wider change).
8. Existing job chains (edit_jobs, billed-job immutability, booking guard) still pass.

## Open business decisions

None. (Completed → invoiced by direct status UPDATE without an invoice is a separate hole closed by the pending PR C; noted, not changed here.)

## Challenge (Astra gpt-6.2-astra high, 2026-11-22, 22 findings) — settled

- Fixed: #3 `_is_admin_override()` is NULL when unset, so `NOT (is_admin() OR override)` would not raise: wrapped in `coalesce(..., false)`, proved with the setting unset and false. #5/#6 completion in the same write or of a deleted job: the rule now keys on the resulting row (completed AND deleted, not already so). #1 applicator has no direct UPDATE: case 3 corrected. #2/#12 observable result per path stated above.
- Disproved: #8 `is_admin()` (live body) = active profile with role admin from `auth.uid()`, the same test `edit_jobs` makes. #19 live body md5 `dca314dd…` and trigger `enforce_billed_job_immutability` (BEFORE UPDATE, enabled) read 2026-11-22 and pinned by the migration preflight. #14 live count of completed + deleted jobs = 0 (read 2026-11-22), so no hidden work to review. #17 the check runs on the row the UPDATE finally writes, after any row-lock wait. #20 completed rows still return before the billed-column list (case 7). #4 the override hatch is unchanged from the guard it extends; no override-setting function writes `jobs.deleted_at` (F5).
- Out of scope, named: #9 admins may change billed history directly (existing parity, job-writes contract MED deferred); #10/#11 a rep can still move completed → invoiced directly (closed by pending PR C); #7 a job inserted already deleted was never visible billable work; #13/#18 screens unchanged by this PR; #15/#16 restoring a deleted job is untouched (it brings work back, not hides it); #21 rollback re-runs the June body.

## Luna rounds

- r1 BLOCKER "caller can set app.admin_override": refuted (signed-in users reach Postgres only through the API on the public schema; `set_config` is not exposed; no public function sets the hatch from caller input; same hatch the guard already honours). LOWs refuted (N1 still checks the exact booking refusal; 2027 stamps are the house sequence).
- r2 HIGH fixed: a rep could move a completed job to invoiced and delete it in one write; the rule now covers any delete of a job that is or becomes completed in that write (prover case added). LOW refuted: the guard is SECURITY INVOKER and `is_admin()` reads `public.profiles` fully qualified.
