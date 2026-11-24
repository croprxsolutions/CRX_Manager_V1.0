# Behavior contract: job Save refuses a newer change, checked in the database

Follow-up to PR #2337 (screen-only check). Decision: `docs/manual/decision-log.d/2026-11-23-pr2337-job-stale-check-screen-only.md` (on #2337's branch). Read at `origin/staging` c2a85624e.

## Facts (with source)

- `save_job` (6 args) is a wrapper: actor check, folds rate units, then calls `_save_job_cost_step2_impl` (admin) or the same with server-priced chemicals (non-admin). Newest wrapper body: `20270226150000_job_transfer_below_cost_whole_line.sql` (#2247, which added the up-front INSUFFICIENT_ROLE, the key's advisory lock and job row lock, and JOB_COMPLETED_CHEMICALS_LOCKED). The impl is the old `save_job` body from `20260904185900`, renamed in `20261019230000`.
- The impl's replay: `check_idempotency_intent(key, 'save_job', actor, fingerprint)` takes `pg_advisory_xact_lock(hashtextextended('crx:idempotency:'||key,0))`, deletes the key's receipt if `expires_at < now()`, and returns the stored result (same actor + same fingerprint), or raises (other operation / actor / fingerprint). It writes nothing else. The impl then locks the job row `FOR UPDATE` and rewrites job columns and all `job_fields`, `job_field_shares`, `job_chemicals` lines (delete + insert, so line ids change on every save).
- Only active admins and sales reps may save (`INSUFFICIENT_ROLE` otherwise, inside the impl).
- `save_job`'s existing-job UPDATE writes `loader_comment` from the payload but not `status`, the ground crew, carrier rate or tank capacity; the page's follow-up `edit_jobs` writes those, sending only the values the user changed.
- `job_chemicals` is only written by insert/delete (`save_job`, quote conversion); no `UPDATE job_chemicals` exists in any migration or in `src/`. So a cost change always comes with new line ids.
- `dispatch_job_locations` and `undispatch_job_locations` lock the job row `FOR UPDATE`; dispatch upserts `job_location_dispatches` per location (assignee, `dispatch_status = 'dispatched'`) and logs one `activity_feed` row each. The only trigger on that table sets `updated_at`. Its newest wrapper (`20261123110000`:756) binds the assignments into its replay fingerprint.
- Expired idempotency receipts are also deleted outside the key's advisory lock (e.g. `20260714220000`:31).
- The jobs table's cost columns are column-revoked, so a PostgREST computed field on `jobs` cannot be read (the reason `invoices_postable` exists, `20261022090000`).

## 1. Outcome and authority

- **Outcome:** a job Save is refused, with nothing written, when what it compares changed after the page read it. The check runs inside `save_job`, under the job row lock, after the replay lookup. Closes #2337's gaps: (1) two saves at once, (2) a retry after a lost reply gets the stored result (except a sales rep's retry after a server price change, which the existing replay check already refuses: Challenge #24), (3) the page's own Dispatch wizard no longer absorbs someone else's change.
- **Smallest change (DB PR):** one migration, `20270228201000_save_job_refuses_changed_job.sql`:
  - `_job_edit_version(p_job_id) returns jsonb` (internal, no API grants): `{core: md5 of the job's edited columns + its field, share and chemical lines (with line ids, without cost), dispatches: sorted "job_field_id|applicator_id|crew_id|dispatch_status" strings}`. Columns are #2337's list (`src/lib/jobStaleEdit.ts`). Left out, as in #2337: `updated_at`, `printed_at`, applied/remaining acres, cost.
  - `job_edit_version(p_job_id) returns jsonb`: the RPC the page calls. Returns the version for an active admin or sales rep; refuses anyone else.
  - `save_job` wrapper (same signature, frozen): built on #2247's body, which already refuses non-editors (`INSUFFICIENT_ROLE`) before anything else and locks the key, then the job row. When `p_job_id` is set and the payload carries `expected_version`: a malformed version is refused before any lock; under the key's advisory lock, if a live receipt exists, hold it `FOR SHARE` (so no expired-key sweep can delete it before the impl reads it) and skip the compare (the impl then replays or refuses; it never writes); otherwise, under the job row lock, refuse `JOB_CHANGED_SINCE_LOADED` unless the current version equals the expected one (dispatch strings compared as a set). No `expected_version` = today's behavior, so the deployed app is unaffected.
  - The version also carries `rev`: an md5 of the row versions (`xmin`) of the job, its lines and its dispatches, which every write moves, even one that puts a value back. `save_job` never compares it (printing and applied records write those rows too). A replayed save's result carries `"replayed": true`. The final role check holds the caller's profile `FOR SHARE` until commit (Sol round 12).
- **Screen PR (after the DB is live):** the page calls `job_edit_version` before its job select and again after it (a computed field on `jobs` is unreadable because of the cost column lock, so these are separate reads). If `rev` moved between the two, something wrote the job while the form loaded, possibly changing a value and putting it back: the page reloads (up to 3 tries, then Save is blocked with "reload"). It sends the first version as `expected_version`. After its own Dispatch wizard it replaces only the dispatch strings of the locations it dispatched, with the assignments it sent (status is always `dispatched`; a wrong guess only refuses). It drops #2337's pre-save re-read and maps the refusal to the existing message. If the version could not be read, Save of an existing job is blocked with "reload" (fail closed), never sent without it.
- **Later (named, not in these PRs):** once the screen has been live long enough for open tabs to reload, a small migration can make `expected_version` mandatory for existing-job saves, closing the old-tab path.
- **Authority:** unchanged. The version carries no cost (only line ids, which reps can already read), and is withheld from non-editors.

## 2. State and failure

- **Rule:** a save with an expected version writes only if what it compares (job columns, lines, dispatches) is as the page read it, plus the page's own dispatches. A change that leaves every compared value as it was (a same-assignee redispatch, a value changed and changed back) is not refused: nothing the user did not see is overwritten. Checked and written in one transaction under the job row lock; the app's writers of these rows (save, dispatch, undispatch, status changes, line inserts via their foreign key check) take or wait on that lock. A direct in-place line UPDATE outside those paths would not; none exists in the app or migrations.
- **Status** is compared although Save does not write it (as #2337): an applied record starting the job mid-edit is something the editor should reload and see.
- **Existing rows:** no data change. No new column.
- **Timing:**
  - Two saves from the same version: the second waits for the first's lock, then sees the new version and is refused; nothing of it is written. Screen: "changed after you opened it, reload."
  - Retry after a lost reply (same key, same payload): the receipt exists, so no compare; the stored result returns with `"replayed": true`. The page then does NOT run its crew/loader/override follow-ups (they are unchecked and could overwrite a newer change): it says the job was saved and asks for a reload to check crew and loader (Sol round 12).
  - Retry after the receipt expired (24 h): compared, and normally refused (the first save changed line ids). Safe side.
  - Change landing between the page's version reads and its job select: `rev` moves, so the page reloads before the user edits; a change put back in that window is caught too (Sol round 12).
  - Own Dispatch wizard, then Save: accepted. Someone else's change to anything compared, other than the locations the page itself just dispatched: refused. The wizard itself still replaces an assignment another dispatcher made to the same location (today's wizard behavior, on the Dispatch Board too; not changed here).
  - Printing, applied acres, cost-only changes: do not change the version.
- **Undo:** none; a refused save writes nothing.

## 3. Delivery

DB PR into `staging` first (compatible: the deployed app sends no `expected_version`). Built on PR #2247's `save_job` (merged to staging 2026-11-23, Mason's yes the same day to rebuild on it): its refusals are kept, the preflight pins its body and the postflight pins ours. Screen PR on top of #2337's branch, merges only after the DB is live. Rollback order: screen first, then the database. Mason merges both by hand; no live apply without him.

## 4. Proof cases

Database cases: `scripts/smoke/prove-job-save-version-real-schema.mjs` (disposable PostgreSQL, every migration replayed, never live).

0. Before the migration, two saves from the same page version both succeed and the second overwrites the first (the gap).
1. When two sessions save from the same version and the first holds its lock until commit, then the second waits, is refused `JOB_CHANGED_SINCE_LOADED`, and the job has the first save's values.
2. When a save commits and is retried with the same key and payload (its version now stale), then the retry returns the first result plus `"replayed": true` and writes nothing more; a new key with that version is refused.
3. When another user changed a job column, a field line or a dispatch, then Save is refused and nothing changes; with the current version, Save succeeds.
4. When a save sends no `expected_version`, then it behaves as today.
5. When the page dispatches a location itself and sends the version with that location's dispatch string replaced, then Save succeeds; when another dispatcher also changed a location, it is refused.
6. When a job is printed, applied acres change, or a chemical's cost changes in place, then the version (all but `rev`) is unchanged and `rev` moved.
6b. When a job column, a field line or a dispatch is changed and put back, then the version (all but `rev`) is unchanged and `rev` moved.
7. A driver calling `job_edit_version` is refused; a sales rep gets the same version; the internal function is not callable by the app.
7b. A sales rep denied the Job Schedule page is refused both `job_edit_version` and `save_job` (`INSUFFICIENT_ROLE`), as `edit_jobs` already refuses them (Sol round 2).
7c. While a rep's save is uncommitted past its last role check, a denial of the page waits for it (Sol round 12).
8. A malformed `expected_version` is refused; a driver's save carrying a version gets `INSUFFICIENT_ROLE`, not a version answer.
9. A completed job's chemicals still can't change (#2247's `JOB_COMPLETED_CHEMICALS_LOCKED`), current version or not; the installed body is the one the postflight pins.
10. Screen (browser, staging, after the DB is live): two tabs on one job, save in each → the second is refused with the reload message; own Dispatch wizard then Save → saved; version read failing → Save blocked; `rev` moving during load → reload; a replayed save → no crew/loader follow-up, reload message.

## Challenge (Astra gpt-6.2-astra high, 2026-11-23): 41 findings

- Fixed: non-editors reached the lock before the role check (#13); an expiring receipt could be swept between the wrapper's check and the impl's (#25); wording on what the wizard writes (#18), what Save writes (#4), the invoice precedent (#34), the same-location dispatch promise (#1) and value-preserving changes (#2, #3); fail-closed screen when the version is missing (#32); old-tab path named as a later step (#8).
- Pre-existing, not changed by this work: Save's triggers rewriting dispatches when the whole-job applicator changes or fields are re-added (#19-#21); the wizard replacing a same-location assignment (#1); a rep's retry failing replay when server pricing changed in between (#24); crew/loader follow-ups after the core save (#29; they already send only changed values); recovery = reload, as #2337 (#31).
- Declined: a stored revision counter bumped by triggers on four tables plus a dispatch RPC change (#41): more moving parts on live tables for the same outcome (no silent overwrite).
- Answered by the proof cases or the screen PR's tests: #10, #12, #16, #17, #27, #33, #35-#37. Performance (#40): one small extra read per page load; the compare reads one job's lines.

## Sol rounds (2026-11-23)

- Round 1: HIGH #1 (two other changes, the second undoing the first, between the page's version read and form read) and #2 (crew/loader follow-up, issue #2365) skipped by Mason. MEDs fixed: page permission on `job_edit_version`, job id in the version, rollback order.
- Round 2: the same two repeated. New HIGHs fixed: `save_job` honours the Job Schedule page denial (it did not before); with a version, the job's dispatch rows are held `FOR SHARE` before the compare, so a crew deletion's cascade cannot change them mid-save. MEDs fixed: the receipt lookup is limited to `save_job` receipts; the postflight checks one job, not every job. LOWs fixed: `deleted_at` hashed in UTC; loader comment wording; the race proof holds 8 s.

- Round 12: Mason chose to fix all three HIGHs: the last role check holds the profile `FOR SHARE`; `rev` plus before/after version reads close the put-back gap; a replayed save is flagged and the page skips its follow-ups.

## Open business decisions

None. Mason settled the trade-off on 2026-11-23 (database check as the follow-up).
