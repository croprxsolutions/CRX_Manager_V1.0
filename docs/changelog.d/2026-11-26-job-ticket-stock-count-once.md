## 2026-11-26 — A job and its blend tickets take stock out once

- Mason, 2026-11-26: "A: count once, flag".
- Before: filing an application record from a blend ticket linked to a job, then completing that job (or the other
  way round), took the same product out of Main Warehouse twice.
- Now: for one job and one product, the total taken is the larger of the job's amount and its tickets' amounts
  together. Whichever posts second takes only the difference, and its stock line is flagged for office review with a
  note ("N already counted by …"). Unlinked tickets and jobs with no filed ticket work as before.
- Reversing a blend ticket's application record is refused once its job is completed
  (`APPLICATION_RECORD_COUNTED_WITH_JOB`); correct stock with an inventory adjustment instead. (A filed ticket's job
  link was already frozen.)
- Migration `20270312120000_job_ticket_stock_count_once.sql` (two ledger columns, three re-emitted bodies). Proof: `scripts/smoke/prove-job-ticket-stock-count-once-real-schema.mjs`.
