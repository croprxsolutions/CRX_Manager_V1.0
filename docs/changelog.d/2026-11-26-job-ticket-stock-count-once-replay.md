## 2026-11-26 — Same-key reversals replay after the lock (Luna round 6)

- `20270312120000_job_ticket_stock_count_once.sql` (not applied): `reverse_application_record` re-reads its saved
  receipt after taking the application-record number lock, so two identical requests sent at once return the same answer.
