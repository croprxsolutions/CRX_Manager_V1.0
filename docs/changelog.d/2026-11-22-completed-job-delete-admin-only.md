## 2026-11-22 — Only an admin can delete a completed job, on every path (#2196)

- New migration `20270210110000_completed_job_delete_admin_only.sql` (not applied live; record in `docs/reference/migrations.d/`).
- A completed spray job is billable work: only an admin may delete it (Mason, 2026-11-21). The job screens already followed this; now the database refuses a sales rep's direct delete too, so billable work cannot silently drop out of Unbilled Jobs. A deleted job also cannot be marked completed by a non-admin. Everything else about editing, deleting scheduled jobs and restoring is unchanged.
- Proof: container prover `scripts/smoke/prove-completed-job-delete-admin-only-real-schema.mjs` (before: the hole is real; after: rep refused, admin allowed, edit_jobs unchanged, existing job chains pass). Not yet verified on staging.
