# Completed to-do items removed - 2026-11-22

Rows removed from `docs/manual/TO_DO_LIST.md` after a read-only triage against `origin/staging` `17a72d0ee`. Existing row numbers are preserved. The live database was not re-queried; evidence is the repository, merged pull requests and the migration records in `docs/reference/migrations.d/`.

| Removed row | Evidence checked |
|---|---|
| 0.15 | PRs #1114 and #1147 merged 2026-10-27. Migration `20261027070000_email_type_purchase_order` applied live 2026-10-27 (ledger `20261027185937`, `docs/reference/migration-history.md` row 995). `send-email` deployed live as v20 and proven end to end: Email PO Copy sent, logged `sent` and received (`docs/manual/CURRENT_STATE.md`, 2026-10-27 entry). |
| 9.7 | PR #1387 (commit `d0f259010`) and PR #1394 are merged into `origin/main`; `src/lib/statementPdf.ts` draws one footer per page. The row's own proof (render test counting footers on every page and real PDFs checked) was recorded when it was written. |
| 11.5 | PR #1513 merged 2026-11-05. `20261110140000_rup_records_require_posted_invoice` applied live 2026-11-05 21:32 UTC (ledger `20261105213209`, `docs/reference/migrations.d/20261110140000_rup_records_require_posted_invoice.md`); it refuses unposted invoices in the RPC and by trigger. |
| 11.7 | Mason accepted it as is on 2026-11-08: drivers and applicators keep the delivery address (`docs/manual/KNOWN_ISSUES.md`, KI-73 notes). Later driver-card work (#2018) is separate. |

## Original rows (history)

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 0.15 | **Send a purchase order to a vendor** as a PDF and by email | **PDF built and merged 2026-10-27 (PR #1114); email incomplete.** Admins can download the PO PDF. Email PO Copy is designed to send only to the owner's own address; Mason orders through supplier portals, so vendors need no email. **Still needed:** `20261027070000_email_type_purchase_order.sql` is absent from the live ledger checked 2026-10-27, and deployment of `send-email` needs Mason's explicit approval. PR #1147 merged 2026-10-27 with PO-number/order-date snapshot checks and retry-key fixes; its code does not deploy the email service. Keep the email portion open (KI-72). | PDF built; email apply/deploy open | SHOULD |
| 9.7 | A statement prints its last-page footer once, not twice | **Fixed in code, 2026-11-03 (PR pending).** `src/lib/statementPdf.ts` now draws one footer per page after all pages exist; a render test counts footers on every page (summary, detailed, one-page, multi-page, no transactions), and real generated PDFs were checked. Not live until the PR merges and deploys. | Done once merged | SHOULD |
| 11.5 | A rep can't write RUP register rows for an invoice that was never posted | **Open** (`KNOWN_ISSUES.md`, MED, 2026-10-14). It would put false sales in a regulated record, but only a sales rep can do it. | Goal 1 follow-up | CAN-WAIT (MUST before the first regular rep gets an account) |
| 11.7 | Drivers and applicators see only the customer addresses they need | **Open** (old `TODO.md` (2026-09-27), §5). Today they can read every customer's address. Narrow it, or Mason accepts it. | Fix or accept | SHOULD |

## Work retained

Every other numbered row remains, including built rows that still await a staging proof, a real-device check or an owner decision.
