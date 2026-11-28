## 2026-11-24 — Job changes go only through the job screens' server actions

- New migration `20270303110000_close_direct_job_writes.sql` (not applied live; record in `docs/reference/migrations.d/`).
- Signed-in users can no longer write the spray job and job field tables directly; every change goes through the reviewed server actions the job screens already use (`edit_jobs`, `save_job`, `complete_job`, and the rest). Reads, the screens' behavior and who may do what through them are unchanged. No rows change. This is the planned last step (PR C) of `docs/plans/2026-11-19-job-writes-through-rpcs-CONTRACT.md` §3, now also covering job field rows.
- The migration refuses to run if the live permission rules have drifted from what it expects, gives up after 5 seconds rather than making job screens wait, and checks afterwards that no write permission remains and reads still work.
- `smoke-billed-job-immutability` now runs its sales-rep checks as the owner with the rep's sign-in, since the rep can no longer write the table directly.
- Rollout: production's current app still saves jobs directly, so the live apply waits until the release carrying the `edit_jobs` screens (#2151) is on production.
- The job-lifecycle browser test now starts its job through `start_job` (the server action Job Detail uses) and fails loudly if the start is refused, instead of writing the jobs table directly.
