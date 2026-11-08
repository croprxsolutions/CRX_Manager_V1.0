## 2026-11-08 — Job access ends with the job (KI-01 part C, KI-73, To-Do rows 11.4 and 11.7)

Part C of the row 11.4 fix plan in `docs/manual/KNOWN_ISSUES.md`, plus row 11.7. One new migration,
`20261213100000_job_access_ends_with_the_job.sql` (not applied), and a checked-in disposable prover
(`scripts/smoke/prove-job-access-ends-with-the-job-real-schema.mjs`). No screen changed. Scope is
Mason's 2026-10-25 decision (`DECISION_LOG.md`): someone sent to a job sees the entire job while the
assignment is current.

### What was wrong

* The whole-job applicator (`jobs.applicator_id`) read the job and everything on it forever: after it
  was completed, cancelled or deleted. `start_job`, `complete_job`, the offline completion queue,
  printing, the job map, billed customers, the dispatch board and the dispatched list all let them in.
* A current dispatch kept granting a job after the job was deleted.
* Every active account, drivers and entity recipients included, read every customer's addresses.
* An applicator sent to a job by dispatch could not read the job's shares, completion info and
  records, attachments or photos.

### What changed

* New `_is_job_applicator(job)`: the active whole-job applicator, job not deleted, and scheduled, in
  progress, or completed/invoiced with `job_date` within 7 days of today, either side (Central), so a job
  completed long before its date does not stay open until then. Never cancelled. The
  clock is `job_date` because only office staff change it.
* `jobs_select` uses it, and every policy that looks the job up through `jobs` inherits it. The
  eleven SECURITY DEFINER functions above change only their whole-job line.
* `_is_dispatched_to_me` refuses a deleted job.
* `customer_addresses`: readable exactly when the customer is.
* Dispatch-only applicators gain reads (no writes) of the job's shares, completion info, records and
  their field and crew rows, attachments and photos.

### Proof (disposable copy of the real schema, each role signed in)

Whole-job applicator: 8 jobs before, 3 after (scheduled; completed 2 days ago; invoiced yesterday);
loses completed 10 days ago, one completed early but dated 30 days out, cancelled, and the two deleted
ones in every table and function.
Dispatch-only applicator: before 2 jobs and none of their records; after 1 job (not the deleted one)
and all of its records. Driver: addresses 12 → 1 (their delivery customer). Entity recipient and an
unassigned applicator: addresses 12 → 0. Admin and sales rep: identical before and after.

### Not changed

What office staff read or write; `application_records` (an applicator's own spray records); every
billing, invoice, quote, sale and commission function. No rows change.
