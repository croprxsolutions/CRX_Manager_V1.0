## 2026-11-23 - Job Save refuses a newer change, checked in the database (#2337 follow-up)

- Migration `20270227130000_save_job_refuses_changed_job.sql` (NOT YET APPLIED LIVE): new `job_edit_version(job_id)` (admins and sales reps) and `save_job` refusing `JOB_CHANGED_SINCE_LOADED` when the payload's `expected_version` no longer matches, under the job row lock and after the replay lookup. Built on #2247's `save_job` (its refusals kept). A save with no `expected_version` behaves as before, so the deployed app is unaffected (except the denied-page refusal below).
- `save_job` now also refuses a sales rep denied the Job Schedule page, as `edit_jobs` already did (Sol round 2).
- Closes #2337's three screen-only gaps once the screen sends the version (separate PR): two saves at once, a retry after a lost reply, and another dispatcher's change right after the page's own Dispatch wizard.
- Contract: `docs/plans/2026-11-23-job-save-version-check-CONTRACT.md`. Proof: `node scripts/smoke/prove-job-save-version-real-schema.mjs` (disposable database; fails before the migration, passes after).
