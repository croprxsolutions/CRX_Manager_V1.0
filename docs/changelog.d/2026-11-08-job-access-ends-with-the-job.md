## 2026-11-08 — Job access ends with the job (KI-01 part C, KI-73, To-Do row 11.4)

Part C of the row 11.4 fix plan in `docs/manual/KNOWN_ISSUES.md`. One new migration,
`20261217100000_job_access_ends_with_the_job.sql` (not applied), and a checked-in disposable prover
(`scripts/smoke/prove-job-access-ends-with-the-job-real-schema.mjs`). No screen changed. Scope is
Mason's 2026-10-25 decision (`DECISION_LOG.md`): someone sent to a job sees the entire job while the
assignment is current.

### What was wrong

* The whole-job applicator (`jobs.applicator_id`) read the job and everything on it forever: after it
  was completed, cancelled or deleted. `start_job`, `complete_job`, the offline completion queue,
  printing, the job map, billed customers, the dispatch board and the dispatched list all let them in.
* A current dispatch kept granting a job after the job was deleted.
* An applicator sent to a job by dispatch could not read the job's shares, completion info and
  records, attachments or photos.

### What changed

* New column `jobs.completed_at`, set only by the new trigger `trg_stamp_job_completed_at`: server time
  when the job first reaches completed or invoiced, kept while it stays there, cleared if it leaves. A
  value sent by the app is ignored. Existing jobs start empty (no backfill).
* New `_is_job_applicator(job)`: the active whole-job applicator, job not deleted, and scheduled, in
  progress, or completed/invoiced with `completed_at` in the last 7 days. Never cancelled. The scheduled
  date no longer matters (Sol, 2026-11-08: a date near today must not reopen an old job, and an
  applicator can edit their own completion notes, so neither is a trustworthy clock). A completed job
  with no `completed_at` (finished before this change) grants nothing through this leg; today that is one
  invoiced job, which its dispatch row already closes.
* `job_location_dispatches_select`: an assignee reads their own dispatch row only while
  `_is_dispatched_to_me(job)` holds, so not after the job is deleted or cancelled.
* `jobs_select` uses it, and every policy that looks the job up through `jobs` inherits it. The
  eleven SECURITY DEFINER functions above change only their whole-job line.
* `_is_dispatched_to_me`, `_can_see_field`'s dispatch leg and `get_dispatched_list` refuse a deleted or
  cancelled job, including one cancelled after its dispatch was completed, and a completed or invoiced
  job more than 7 days after `completed_at` (Sol, 2026-11-08: an office override to invoiced leaves the
  dispatch open, and editing a completed dispatch row moves its own timestamp). A job finished before
  `completed_at` existed keeps today's clock, the dispatch row's last update.
* Dispatch-only applicators gain reads (no writes) of the job's shares, completion info, records and
  their field and crew rows, attachments and photos.

### Proof (disposable copy of the real schema, each role signed in)

Whole-job applicator: 11 jobs before, 5 after (scheduled; completed 2 days ago; invoiced yesterday; done
today but dated 30 days out; done today but dated 20 days ago with no dispatch row); loses completed 10
days ago, done 8 days ago but dated 30 days out, done 10 days ago but dated in 3 days, cancelled, and the
two deleted ones in every table and function. The trigger stamps server time on completion and ignores
a value the client sends. Dispatch rows: an assignee no longer reads the rows of deleted or cancelled jobs. The fixture includes the dispatch rows
the assignment triggers would write.
Dispatch-only applicator: before 5 jobs and none of their records; after 1 job (not the deleted one,
nor one cancelled after its dispatch was completed, nor one finished 10 days ago whose dispatch was left open or edited today) and all of its records. Customer addresses: identical before and after for every role.
Admin and sales rep: identical before and after.

### Not changed

Customer addresses (row 11.7) stay readable by every active account: Mason, 2026-11-08, drivers keep
the delivery address on FieldStop even when a delivery runs past its date; applicators keep
theirs as is too (Mason, 2026-11-08), with no later change planned.

What office staff read or write; `application_records` (an applicator's own spray records); every
billing, invoice, quote, sale and commission function. No existing row changes (the new column starts empty). `customers_select` keeps its own rule: an
applicator sees a customer only through a job scheduled no more than 7 days ago, so a job finished
today but scheduled earlier shows without its customer name, as it does today.

Rollout (Mason, 2026-11-08: no backfill, no install check): a job finished before the apply has no
`completed_at` and loses access at once. Accepted: nobody uses applicator access for business until
March 2027, and live on 2026-11-08 there is no such job (the only finished job was invoiced in August).

Office staff still see, in the dispatched list, a dispatch row left open on a job invoiced more than 7 days
ago (Sol MED), so it can be cleaned up; the 7-day clock there applies to field callers only.

Deferred (Sol LOW, 2026-11-08): `start_job` and `complete_job` answer a repeated request (same
idempotency key) with their earlier result before the access check, so a former applicator replaying
their own key still gets back that result (job or record ids they already had). Nothing new is written.
Tracked in KI-73.

### Doc stamps

`CURRENT_STATE.md` and `KNOWN_ISSUES.md` re-stamped 2026-11-08 for the live ledger only: a read-only
read of `supabase_migrations.schema_migrations` at 12:25 PM Central showed the latest live row
`20261108043505` (`20261211100000_product_chemistry_confirmed_swaps`). This PR's migration is not in it.
