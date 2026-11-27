## 2026-11-26 — Undo Filing: refused on billed tickets, warns about lot corrections

- Mason, 2026-11-26: "Yes, fix and run 6" (decision `docs/manual/decision-log.d/2026-11-26-pr2679-undo-filing-round6.md`).
- Undo Filing is refused while the blend ticket has an active invoice (billed, or a live invoice that is not voided,
  cancelled or deleted, the same test that keeps a billed ticket on its job). Void the invoice first. The button is
  disabled on screen with that reason, and `reverse_application_record` refuses it (`APPLICATION_RECORD_TICKET_INVOICED`).
- The Undo Filing confirmation now warns that lot numbers, quantities and receiving links corrected in Application
  Records are lost and must be re-entered after filing again. It does not block.
- Stock returned by an undo because other tickets for the job had taken extra is now a positive `adjusted` row
  (stock added back) linked to the job's application record, not a negative `job_applied` row, so the transaction
  history and both stock-vs-history checks read it correctly. The undo recreates a retired Main Warehouse row for it.
- The confirmation stays tied to the ticket it was opened for; the success message names returned stock; the
  Create App Record confirmation no longer says filing cannot be undone.
- Migration `20270314150000_job_ticket_stock_count_once.sql` (still not applied). Proof:
  `scripts/smoke/prove-job-ticket-stock-count-once-real-schema.mjs`.
