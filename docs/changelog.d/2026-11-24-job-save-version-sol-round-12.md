## 2026-11-24 - Job Save version check: Sol round 12 fixes (#2352)

- Migration `20270228201000_save_job_refuses_changed_job.sql` (still NOT applied live), fixed at Mason's call instead of skipped:
  - `save_job`'s last role check holds the caller's profile `FOR SHARE`, so a Job Schedule page denial cannot land between that check and the save's commit.
  - `job_edit_version` also returns `rev`, which any write to the job, its lines or dispatches moves (even one that puts a value back). `save_job` does not compare it; the screen reads the version before and after its form and reloads if `rev` moved.
  - A save answered by replay returns `"replayed": true`, so the screen skips its unchecked crew/loader follow-up and asks for a reload.
- Proof: `node scripts/smoke/prove-job-save-version-real-schema.mjs` passes (new cases 6b and 7c; cases 2 and 6 updated).
