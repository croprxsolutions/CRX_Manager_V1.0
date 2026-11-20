# Behavior contract: spray job writes go through a server function (#1979)

Read at `c0b544a23` (origin/staging, 2026-11-19). Booking items in #1979 are out of scope (Taha owns bookings until 2026-12-15). Challenged by Astra (`gpt-6.2-astra`, high): cold challenge (52 findings) and one targeted re-check of the redesign (27 findings); both settled at the end. The plan-contract cold challenge for this contract is finished; reviews of the code continue as usual.

**Principle: parity.** This change moves today's screen writes behind one checked server function and then removes direct writes. It does not change any business rule the screens follow today (who may edit which job, which statuses may be cancelled or deleted, license timing, last-writer-wins edits, no undo). Each of those stays exactly as it is; changing one is a separate decision.

**One intended change:** Mass Edit's field changes and its cancel now save together or not at all. Today they are two separate saves, so a refused cancel could leave the date change saved; now a refusal anywhere saves nothing, and the screen says so.

## Facts (with sources)

- F1. Live grants (read-only query, 2026-11-19): `authenticated` has column-level INSERT and UPDATE on 43 of 45 `jobs` columns (all but `completed_at`, `remaining_acres`), including `id`, `customer_id`, `invoice_id`, `total_price_cents`, `commission_split`, `created_by`, `quote_id`, `status`, `deleted_at`, plus table DELETE. No PUBLIC grant. `metabase_ro` SELECT only.
- F2. Live policies: `jobs_insert`, `jobs_update` = `is_admin() OR is_sales_rep()`; `jobs_delete` = `is_admin()`.
- F3. Live (2026-11-19): 14 user triggers on `jobs`, all row-level (none statement-level): status transition, billed-job lock, applicator license, `updated_at` stamp, hold release (status, deleted_at), completion marker/stamp, dispatch sync/close, EPA freeze/id guard, commission stamps, applicator profile lock. No BEFORE trigger returns NULL (only the two AFTER EPA triggers do, which cannot suppress a write). Staging adds `jobs_live_on_open_booking` (`20270127120000`, release #1990); the prover replays it. They behave the same whoever issues the UPDATE.
- F9. Live column types: `job_date` date NOT NULL; `schedule_date` date; `applicator_id` uuid → profiles; `batch_ref` uuid → job_batches; `ground_crew_id` uuid → ground_crews; `carrier_rate_gpa` numeric (unscaled, CHECK ≥ 0); `loader_tank_capacity` numeric (unscaled, CHECK > 0); `loader_comment` text. All but `job_date` nullable.
- F4. `_enforce_job_status_transition` (`20260620150000_job_cancel_gate.sql`) allows `scheduled → in_progress → completed → invoiced` by direct UPDATE. Today an admin or rep can mark a job completed by a direct UPDATE, skipping `start_job` / `complete_job`. This is the hole the change closes.
- F5. Creation and lifecycle already go through SECURITY DEFINER functions (`save_job`, `create_job_from_quote_section`, `start_job`, `complete_job`, `assign_job_applicator`, invoice transfer, scheduler). No screen inserts or hard-deletes jobs. No Edge Function or script writes `jobs` as a signed-in user (grep of `src/`, `supabase/functions/`, `scripts/`).
- F6. The only direct screen writes, six sites:
  1. `src/pages/JobDetail.tsx:2980`: crew/loader (`ground_crew_id`, `carrier_rate_gpa`, `loader_tank_capacity`) after `save_job`.
  2. `src/pages/JobDetail.tsx:3306`: cancel one job.
  3. `src/pages/Jobs.tsx:1468`: soft delete selected jobs in `scheduled`/`in_progress`/`completed`.
  4. `src/components/jobs/JobMassEditModal.tsx:131`: mass edit `job_date`, `schedule_date`, `applicator_id`, `batch_ref`, `carrier_rate_gpa`, `loader_tank_capacity`, `loader_comment`.
  5. `src/components/jobs/JobMassEditModal.tsx:148`: mass cancel (second, separate UPDATE in the same click).
  6. `src/components/jobs/JobBatchAssignModal.tsx:109`: set/clear `batch_ref`.
- F7. `check_idempotency_intent` takes `pg_advisory_xact_lock` on the key, so two simultaneous calls with one key run one after the other; the second replays the first's receipt (live `pg_proc`, 2026-11-19).
- F8. Precedent: DECISION_LOG 2026-11-06, job chemical lines lost direct writes (Mason approved).

## 1. Outcome and authority

**Outcome:** every screen change to a spray job goes through `edit_jobs`, a SECURITY DEFINER function; then signed-in users lose direct INSERT/UPDATE/DELETE on `jobs`.

**One function** (Astra suggestion 52, adopted): `edit_jobs(p_job_ids uuid[], p_changes jsonb DEFAULT NULL, p_action text DEFAULT NULL, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`.

- Allowed shapes: changes only; `cancel` only; changes + `cancel` (Mass Edit, one transaction); `delete` only. Changes + `delete`, an unknown action, or nothing at all: refused.
- **Who:** an active admin or sales rep, any job, as today (`profiles.is_active`, checked once at the start). Actor is `auth.uid()`; `p_performed_by`, if sent, must match (`ACTOR_MISMATCH`). No signed-in user (incl. service role with no user) → `AUTH_REQUIRED`.
- **Ids:** a flat list only (a nested list → `BAD_JOB_LIST`); null elements dropped, duplicates removed; more than 1000 entries → `TOO_MANY_ENTRIES`, more than 500 distinct jobs → `TOO_MANY_JOBS`; none left → `NO_JOBS`. Every selected job is locked `FOR UPDATE` in id order first (one snapshot: each requested id is locked and live, or skipped as deleted / not found), the caller's active role is re-checked, then the jobs are changed set-wise, one UPDATE per kind of change (Sol round 2), so overlapping calls cannot deadlock on the job rows. Rows the triggers lock (stock holds, bookings) can still deadlock in rare overlaps, as today's multi-row updates can: PostgreSQL aborts one call, nothing of it is saved, and the screen offers a retry.
- **Key:** `p_idempotency_key` is required on every call (`IDEMPOTENCY_KEY_REQUIRED`). A receipt replays for the shared receipt lifetime (24 hours, as every replay-keyed function); a retry after that is a new call. Retry identity is the caller, the de-duplicated sorted id set, the decoded changes and the action: the same key with any of those different is refused, including the same ids with another action.
- **Changes:** only `job_date`, `schedule_date`, `applicator_id`, `batch_ref`, `ground_crew_id`, `carrier_rate_gpa`, `loader_tank_capacity`, `loader_comment`. A key that is absent is untouched; a key present with `null` clears it (except `job_date`: refused). Values must be JSON strings (dates, ids, comment) or numbers (rates); dates must be `YYYY-MM-DD` real calendar days (no `tomorrow`, `infinity` or locale formats). Every value is parsed and range-checked before any job is read, so a wrong type, malformed date or id, negative rate or non-positive capacity refuses the whole call even if every selected job would be skipped. An id that points at nothing (foreign key) refuses when written. A key sent twice in the JSON keeps its last value (JSON decoding). Empty changes `{}` → `NO_CHANGES`; screens send no changes at all for a cancel- or delete-only call. Only the sent columns appear in the UPDATE, so column-scoped triggers fire exactly as today's direct UPDATE did. Same-value writes still stamp `updated_by`/`updated_at` (as today).
- **Per job:** not found or already deleted → skipped (reason `not_found` / `deleted`), nothing changed. Otherwise: changes apply to every such job, whatever its status (as today's mass edit patch did); then `cancel` applies only if the job's status after the changes is `scheduled`/`in_progress` (else skipped, reason `status`); `delete` applies only to `scheduled`/`in_progress`/`completed` (else skipped). Each UPDATE must change exactly the rows it targets, or the call aborts (`EDIT_NOT_APPLIED`).
- **Fields at every scope:** any allowed field may be sent for one job or many. That is no wider than today: signed-in admins and reps can write each of these columns directly on any job now.
- **Trigger refusals** (billed-job lock, license, booking guard, status transition) abort the whole call; nothing is saved. Skips are only the checks above, decided before writing. (Admins pass the billed-job lock, as they do today.)
- **Result:** `{"updated": [ids], "cancelled": [ids], "deleted": [ids], "skipped": [{"id", "reason", "status"?}]}`, ids sorted. A job can appear in both `updated` and `skipped` (edited, but not cancellable). Screens and activity entries word each count by operation ("2 jobs edited. 1 cancelled. 1 already completed and could not be cancelled."), never the selection size or a sum.
- **Errors by caller:** `anon` cannot run the function at all (permission denied); a signed-in non-admin/rep → `INSUFFICIENT_ROLE`; a role with execute but no user (service role) → `AUTH_REQUIRED`.

Files: `supabase/migrations/20270131100000_job_writes_through_rpcs.sql` (PR A), `src/types/supabase.ts`, the four screen files in F6 and their tests (PR B), a later revoke migration (PR C), `docs/changelog.d/` records, DECISION_LOG entry for C.

## 2. State and failure

- **Always holds:** each call's job changes and its idempotency receipt commit together or not at all. Hold release, dispatch close and booking checks run inside that transaction through the existing triggers.
- **Activity log:** stays written by the screen after success, as today (best effort), now from the server's counts. `updated_by` and the receipt record who acted.
- **Existing rows:** no data changes, no new columns or statuses. Jobs completed through the old direct path are not touched (a separate question if wanted).
- **Timing:** double click / retry after timeout → same key (screen scopes the key to the exact payload via `useIdempotencyKey.getKeyFor`), so the server replays the stored result (F7). An edited payload gets a new key. Two users on one job: row locks serialize. A later cancel or delete sees the new status and is skipped if no longer eligible; a later field edit still applies (last writer wins, as today), including to a job the first user just cancelled. A stale list (job billed since loading) → trigger refusal or skip, reported. Late responses keep the existing route-epoch guards.
- **Undo:** none, as today.

## 3. Delivery

1. **PR A (database):** `edit_jobs`. Additive; the deployed app is unaffected.
2. **PR B (screens):** six sites call `edit_jobs`. Merges after A is live.
3. **PR C (database):** revoke INSERT, UPDATE, DELETE, TRUNCATE on `jobs` (table and every column) from `anon, authenticated`; drop `jobs_insert`, `jobs_update`, `jobs_delete`. `service_role` and `postgres` unchanged. Applied only after B has been on production long enough that no old tab is in use (an old tab would get "permission denied", nothing saved; a refresh fixes it). The migration header records the exact pre-C grants and policies, and a ready rollback migration restores both.

## 4. Proof cases (local prover / migrated local database, test data)

1. Rep cancels {scheduled, in_progress, completed, missing id, deleted job} → 2 cancelled; completed skipped `status`; missing `not_found`; deleted `deleted`. Holds of the cancelled jobs released; their location dispatches closed.
2. Applicator, inactive admin, and no user → refused; nothing changes. `p_performed_by` ≠ caller → `ACTOR_MISMATCH`.
3. Same key, same payload, twice → same result, one change; same key, different ids, changes or action → refused, nothing changed. Two sessions in parallel with one key → one change, the second replays. Two sessions in parallel, different keys, same jobs in opposite order → both finish (no deadlock).
4. Delete {scheduled, completed, invoiced} → 2 deleted, invoiced skipped and its `deleted_at` still null.
5. Changes with `total_price_cents`, `status` or `customer_id` → whole call refused; with `job_date: null` → refused; malformed or impossible date, `tomorrow`/`infinity`/`01/02/2027`, non-string id, negative carrier rate, zero capacity → refused, also when every selected job is missing or deleted. Nested id list and 1001 entries → refused.
6. Changes `{loader_comment}` only → only that column changes; applicator/batch untouched; license trigger not fired.
7. Changes `{batch_ref: null}` → batch cleared; absent keys untouched.
8. Applicator whose latest active license expired before today (Chicago) → refused; applicator with no license rows → allowed (today's rule).
9. Rep changes `schedule_date` on {scheduled, invoiced} → whole call refused by the billed-job lock, scheduled job unchanged. Admin same call → both updated (today's rule).
10. Changes + cancel on {scheduled, completed} → both get the date change; only scheduled cancelled; completed skipped for cancel.
10a. Rep changes + cancel on {scheduled, invoiced} → billed-job lock refuses the invoiced patch; nothing saved, the scheduled job is not cancelled.
10b. 500 scheduled jobs, changes + cancel in one call → all 500 updated and cancelled; time recorded.
11. Booking-linked scheduled job on an open booking → cancel works and the booking guard is satisfied.
12. After C: as admin, rep and anon, `has_table_privilege` / `has_column_privilege` report no INSERT/UPDATE/DELETE/TRUNCATE on `jobs`; direct UPDATE of `status` and of `deleted_at` → permission denied; SELECT still works for admin, rep, assigned applicator. The existing job prover suites (save_job, start/complete, quote-to-job, invoice transfer, scheduler, field-invoice save) pass with C applied.
13. Browser (local dev, test data): single cancel, mass edit + cancel with a skipped job, batch add/remove, bulk delete with a skipped job, new-job crew/loader save and its failure path (stays on the saved job, no duplicate on retry). Toasts show server counts.

## Open business decisions

1. **Remove direct job edits (PR C), including admins' unused direct hard delete.** (a) Remove, as done for job lines on 2026-11-06: every job change goes through a checked function and no one can mark a job completed without the completion step. (b) Keep: the screens still move over, but the back door stays open. **Recommendation: (a).** Asked 2026-11-19; answer: pending.

## Challenge settlement (Astra, 52 findings)

- **Contract corrected:** 4 (deleted jobs skipped), 13 (actor/service role), 14/15 (trigger count, only sent columns written), 20/21/52 (one function, one transaction for Mass Edit, patch on all, cancel on eligible), 22 (skip vs abort split), 23 (server decides eligibility from the whole selection), 24/25 (typed result, toasts use server counts), 28/29/33 (patch meaning, value types, id list bounds), 32 (500 kept; screens refuse a larger selection with a message), 40 (payload-scoped keys), 45/46 (C records exact pre-state + ready rollback; old tabs fail closed), 2/16/17/26/49 (proof cases 1, 8, 11, 12, 13).
- **Disproved with evidence:** 38 (F7 advisory lock); 11 (no PUBLIC grant, F1; C proof uses `has_*_privilege` per role); 47 (F5 grep of src, functions, scripts; service role unchanged); 12 (functions owned by `postgres`, `SET search_path = public, pg_temp`, same as every other job function).
- **Parity, unchanged by this work (not a new decision):** 1, 3, 5, 7, 30, 31, 35, 36, 37, 41, 42, 43, 44. Each describes today's rule; this change keeps it.
- **Out of scope:** 6, 18 (historical rows), 10/50 (existing functions are unchanged; proof 12 runs their suites), 19, 27 (crew failure path kept as is, proof 13), 34, 48, 51 (PR C cutover is gated by the merge/apply gates and Sol).
- **To Mason:** 8 and 9 folded into Open decision 1.

## Re-check settlement (Astra, 27 findings)

- **Fixed in the migration:** 1 (the `CASE` inside `ELSIF` is parenthesised; it would not have compiled), 2/3 (every value parsed and range-checked before any job is read), 4 (dates `YYYY-MM-DD` only), 12 (each write must change exactly one row), 13 (cancel eligibility uses the status after the changes), 18 (jobs locked one at a time in id order by an explicit loop), 22 (separate messages for 1000 entries / 500 jobs), 23 (nested lists refused).
- **Contract corrected:** 9 (Mass Edit atomicity named as the one intended change), 10 (timing: later field edits still win), 11 (errors by caller), 16 (operation-specific counts), 19 (key required on every call), 20 (retry identity defined; `1` vs `1.0` fingerprints differ, so a retry with a re-encoded number is refused, failing closed), 27 (stale "private helper" removed), 7/8 (empty changes and repeated keys defined).
- **Settled by live evidence (F3, F9):** 5 (column types match the map; clears covered by C5 for `schedule_date`, `batch_ref`-style uuid and rates), 6 (rate and capacity are unscaled `numeric`, no rounding before the CHECK), 12 (no BEFORE trigger returns NULL), 14 (no statement-level triggers; row triggers fire per job either way), 15 (`set_jobs_updated_at` is a BEFORE row trigger, stamps every write as today).
- **Proof added:** 21 (same key, other action refused), 24/25 (case 10a: a late refusal saves nothing; C7 likewise), 26 (case 10b: 500-job call timed), 18 (opposite-order race in the prover).
- **Parity:** 17 (every allowed field is directly writable by admins and reps today).

## Reviewer settlement (rls-security-reviewer, migration-drift-reviewer, 2026-11-19)

- Both: no BLOCKER, HIGH or MED. Fixed: owner set to `postgres` explicitly; migration record `docs/reference/migrations.d/20270131100000_job_writes_through_rpcs.md` added. At apply: re-read the live ledger for ordering.
- Parity, noted: admins' field changes reach invoiced or cancelled jobs (the billed-job lock exempts admins, as today); the screens already filter those jobs out of Mass Edit. Enforcing it in the server is a later rule change, not this one.
- Receipt-binding trigger list not extended for `edit_jobs`, matching every 2027 function that uses the same helpers; an unbound receipt fails closed (refused retry).
- Time limit: live `authenticated` has `statement_timeout = 8s`. Case 10b's timing decides the cap: if 500 jobs is not well under 8 s locally, the cap is lowered and screens refuse a larger selection.

## Sol round 1 settlement (base origin/staging c79b2a04d, 2 HIGH, 7 MED, 2 LOW)

- **HIGH 1 fixed:** `smoke-edit-jobs.sql` is container-only (`container_only` + `container_prover` in `smoke-specs.json`; header note): probe P5 deactivates a rep inside the transaction and would lock that user's live session rows.
- **HIGH 2 fixed:** every listed regression chain must pass (`SMOKE_PASS_ROLLBACK`) before and after the candidate; a chain stopping at its own setup no longer counts. Nine old chains fail on the current schema before this change for reasons seeding cannot fix (missing cost basis, missing replay key, unknown rate unit, missing delivery evidence, a ledger-only migration); they are left out with the reason in the prover header. Six remain, with a second admin, a second applicator and the invented `4c4d` profiles seeded.
- **MED fixed:** 5 (C9's scheduled job sorts first, so the refusal provably undoes an applied edit + cancel), 6 (C10's 500 jobs each hold stock; all holds released; must finish under 4 s, half the live 8 s limit), 7 (same-key race: the second call writes nothing).
- **MED deferred (parity with today, named for the PR):** 1 admins can change invoiced or cancelled jobs (business rule; later change); 2 soft delete of an in-progress job leaves its location dispatch rows open, as a direct delete does today; 3 a Dispatch Wizard save locking the same jobs in another order can deadlock — Postgres aborts one side, nothing is saved, a retry works; 4 the replay marks `20261217100000_job_access_ends_with_the_job` ledger-only (needs storage the container lacks); `edit_jobs` does not use what it changes.
- **LOW fixed:** 1 header made honest; `batch_ref` set then cleared (C5); a rep cancels the job made from their own open booking (case 11). 2 the license case uses an applicator with no license rows.

## Sol round 2 settlement (2 HIGH, 6 MED, 2 LOW)

- **HIGH 1 fixed:** jobs are locked in id order first, then changed set-wise (one UPDATE per kind of change), as the screens' bulk update does. Measured in the replayed container on one planned booking with 200 stocked jobs: the per-job version took 11.3 s to cancel them (over the live 8 s limit, so it would have rolled back); the set-wise version 0.16 s, every hold released. Prover case 11b keeps this under 4 s.
- **HIGH 2 fixed:** the prover's container-reuse path is removed; it only ever seeds a fresh network-less container it built.
- **MED fixed:** deadlock with a concurrent completion (all job locks are now taken before any trigger locks the booking); loader numbers above 1,000,000 refused (`1e400` case in C4).
- **MED deferred (parity with the direct writes the app makes today, named for the PR):** admins change invoiced/cancelled jobs; a rep can soft-delete a completed unbilled job (hides it from Unbilled Jobs) — a business rule for Mason, not this additive change; soft delete leaves dispatch rows open; the replay marks `20261217100000` ledger-only.
- **LOW fixed:** the opposite-order race checks the first caller's committed receipt. **LOW refuted:** `p_idempotency_key` is optional in the generated types because the house rule requires `DEFAULT NULL`; the function refuses a missing key at runtime (C4) and PR B's callers always send one.
- **Luna on the fix (1982cff3a), MED deferred as parity:** set-wise UPDATEs run row triggers in no guaranteed order, so two concurrent calls over different jobs on the same two bookings could take the booking locks in opposite orders; Postgres aborts one call, nothing is saved, a retry works. The screens' bulk `.update().in('id', ids)` today has exactly this property.

## Sol round 3 settlement (1 HIGH, 8 MED, 4 LOW)

- **HIGH (same mechanism as round 2, the existing booking reservation trigger):** cancelling part of a large booking still rebuilds the booking's remaining holds once per cancelled job, because `trg_release_job_holds_on_lifecycle` is a per-row trigger. The screens' bulk cancel today does exactly the same. It only bites with roughly 150+ open stocked jobs on one booking (measured: 200 per-job rebuilds = 11.3 s); live has 4 jobs and none linked to a booking (2026-11-19). Removing it means changing that trigger to rebuild once per statement: booking/inventory core, Taha's area until 2026-12-15. Put to Mason as a business trade-off (AGENTS.md: a mechanism back a third time).
- **MED fixed:** one snapshot for locked / deleted / not-found ids; the caller's active role is re-checked after the job locks are taken; receipt lifetime (24 h, house-wide) stated in the contract; contract now describes lock-all-then-set-wise.
- **MED refuted:** C9's refusal comes from the planning UPDATE, but the whole call is one transaction, so a later cancel failure rolls back the planning edit by the same rule (Postgres semantics; no savepoint in the function).
- **MED deferred (parity, already named):** admins edit billed/cancelled jobs; a rep can soft-delete completed unbilled work; soft delete leaves dispatch rows open; booking lock order.
- **LOW fixed:** positive values below 0.001 refused (`1e-400` case); C4 now proves a missing, empty or blank key is refused; contract wording. **LOW deferred:** the replay marks `20261217100000` ledger-only (named in round 1).
