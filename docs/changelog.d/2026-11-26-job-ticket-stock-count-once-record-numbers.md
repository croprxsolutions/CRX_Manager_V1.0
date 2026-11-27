## 2026-11-26 — Application record numbers are never reused after Undo Filing

- Mason, 2026-11-26: "yes fix and run 7" (decision `docs/manual/decision-log.d/2026-11-26-pr2679-record-numbers-round7.md`).
- Undoing a filing deletes its application record. Its number is now kept in the new admin-readable table
  `application_record_numbers_retired` (filled by a trigger on every delete), and `next_application_record_number()`
  counts those numbers too, so the next filing never reuses an undone number.
- Blend ticket screen: a late Create App Record reply no longer sets its record on another ticket opened meanwhile;
  an Undo Filing that moved no stock (its job had already counted the ticket) now says no stock changed.
- Migration `20270314150000_job_ticket_stock_count_once.sql` (still not applied). Proof:
  `scripts/smoke/prove-job-ticket-stock-count-once-real-schema.mjs`.
