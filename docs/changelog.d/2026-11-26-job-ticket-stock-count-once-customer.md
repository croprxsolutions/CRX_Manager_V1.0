## 2026-11-26 — Count once only within one customer (Sol round 1)

- `20270312120000_job_ticket_stock_count_once.sql` (not applied): a blend ticket counts with its job only when both are
  for the same customer (the job record's customer once completed, else the job's), so a job moved to another farm never
  cancels out a separate spray. The migration and its rollback take the application-record number lock first, and the
  migration re-applies cleanly after a rollback.
