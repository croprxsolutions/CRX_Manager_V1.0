# Known Issues — what is open today

**Last verified:** 2026-11-10 for the live ledger only (latest live row `20261110061547`); KI-30 EPA numbers 2026-11-09; other evidence retains its stated dates.

**WP-PM-3 local candidate source review: 2026-11-02.** WP-PM-3 (`20261103100000_product_active_guard`) was applied live 2026-11-02; KI-92 below is a check still owed. KI-89–KI-91 closed 2026-11-08 (see the closed list).

**Shipment reconciliation: 2026-10-27 (America/Chicago).** Compared all 68 PRs in the October 25–27 UTC merge query with `main` at `fe258c2fe`, current source and the live read-only migration ledger. KI-15 is closed; KI-30's completed category/vendor work is removed from its open scope; KI-47/KI-52/KI-72 are narrowed. The [audit record](../audits/2026-10-27-shipped-work-reconciliation.md) lists every PR and the evidence limits. All other open and accepted risks remain; this is not a fresh full security audit.

**KI-18 verified: 2026-11-07 (America/Chicago)** for KI-18 only: read-only live function definitions show `generate_quote_number`, `generate_order_number` and the rebate-claim body take the Chicago year; `generate_ticket_number` and `financial_dashboard_summary` were then moved to the Chicago date by `20261121090000` (applied live 2026-11-06). On 2026-11-07 the live `get_ar_aging` and `get_detailed_statement_data` definitions were read after `20261208100000`, the last KI-18 part, so KI-18 is fixed. The rest of the file was last verified 2026-10-25; evidence for each re-check is in its PR changelog and timestamped live-ledger captures in [migration history](../reference/migration-history.md). Earlier verification notes are preserved in [the archive](archive/verification-notes-2026-10.md).
Every "applied live" statement not re-read since is the older record's claim, marked as such.

This file is the short list of things that are genuinely open, or that someone decided to live with. Everything
else (fixed, merged, retired, long write-ups, the evidence trail, old section numbers like §0d, §4b, F06) is
preserved word for word in
[`docs/manual/archive/KNOWN_ISSUES-history-2026-10.md`](archive/KNOWN_ISSUES-history-2026-10.md)
(the whole previous file, ~7,000 lines, unchanged). Comments in code or docs that cite an old section number
resolve there.

**How to read an entry.** *Severity* is HIGH / MED / LOW. *Area* groups the list. *Owner* is a named person only
where a record says so; "unassigned" means nobody is working on it. "Mason decision" means the fix is waiting on
a business or risk call that only he can make. *Status* is one of:
**OPEN** (confirmed still present on `main`), **PARTIAL** (some of it fixed, the rest open),
**ACCEPTED** (Mason decided to live with it; reason given), **UNVERIFIED** (could not be confirmed either way in
this pass; treat as open until someone checks).

**Where other facts live (not here).** Applied-migration ledger, row counts and high-water mark:
`docs/reference/migration-history.md`. Current status: `CURRENT_STATE.md`. Settled decisions: `DECISION_LOG.md`.

**Update rules.** When a finding is found, fixed, or decided, edit THIS file (do not start another issue list).
A fixed item is removed from here and its text (with the PR or migration that fixed it) is appended to the
archive. Do not re-fix something listed here as ACCEPTED without a new decision from Mason.

---

## Summary

| Status | Count |
|---|---|
| Open or partly open entries (KI-15 and KI-27 closed; several entries bundle related items and UNVERIFIED sub-items; KI-107 to KI-112 added 2026-11-08 from the [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md); KI-113 and KI-114 (RT-1) added 2026-11-09; KI-115 and KI-116 added 2026-11-10 from the prod spot-check) | 65 |
| Accepted by Mason (KI-17, KI-60 to KI-71, KI-79, KI-80, KI-104, KI-106) | 17 |
| Closed as FIXED, with proof (bottom of file and archive) | 18 |
| WP-PM-3 checks still owed (KI-92) | 1 |
| WP-PM-11a-1 rate lock deferrals (KI-100; not applied) | 1 |

Highest-priority open items, in order: KI-01 (its related lows; all three parts are live: A and B 2026-10-26 and
2026-10-27 UTC, part C, access ending with the job, 2026-11-09 UTC), KI-02 (cost and
margin: the table-level lock is live since 2026-10-25; the server-function audit is done and its fixes went live 2026-11-02 in
migration `20261102200000`), KI-10 (about 69 functions still replay a saved answer on the retry
key alone).

---

## Security and access

### KI-01 — Drivers and applicators can read every customer's fields and some money totals
**HIGH · PARTIAL · security · parts A, B and C applied live; the related lows below stay open**
Until 2026-10-26 02:10 UTC (9:10 PM Central, 2026-10-25), any signed-in account, including drivers and applicators, could call database functions that
returned every customer's field boundaries, owners, billing splits, balances and the company-wide overdue list,
because the functions never checked who was asking. Until 2026-10-27 02:05 UTC (9:05 PM Central, 2026-10-26),
applicators could also read every field-table row, not only the fields of the jobs they were sent to. Proven by
read-only impersonation on 2026-10-22. Planned as three parts: A (functions, PR #1065), B (tables, PR #1103),
C (the job route); A, B and C are applied live and merged (part C: PR #1650, ledger `20261109052957`, see KI-73). Related lows: dispatched
applicators can read chemical cost; any sales rep can edit another rep's draft field-invoice billing; invoice
emails put the invoice number and date into HTML unescaped (`src/lib/emailService.ts:123-139`).
Status 2026-10-23: part A was written and not yet applied (`20261023090000_field_functions_require_field_access`,
history row 980). It adds `_can_see_field`, filters the two field-map lookups by it, makes the other field and money
functions office-only (plus three uncalled ones the review found), and was proven in a disposable copy of the
schema (`scripts/smoke/prove-field-functions-require-field-access-real-schema.mjs`): each applicator sees only
its assigned fields, everyone else none, office staff unchanged.
Status 2026-10-26: part A is APPLIED LIVE (02:10:16 UTC, 9:10 PM Central on 2026-10-25; ledger `20261026021016`,
history row 980) on Mason's own `I approve`, and PR #1065 merged as `9ad2cb000`. Re-checked live (read-only
impersonation, counts only): the real applicator gets 2 fields from the field-map lookup (its 2 open dispatches;
it was 5) and is refused the all-fields map; a driver gets 0; an admin gets all 5. Still open: the applicator
reads all 5 rows of the `fields` table directly (part B), and the whole-job applicator route has no end (part
C, KI-73). No in-app click-through as an applicator was done.
Status 2026-10-26 (Central): part B is APPLIED LIVE (2026-10-27 02:05:46 UTC, 9:05 PM Central on 2026-10-26;
ledger `20261027020546`, history row 985) on Mason's own `I approve`, and PR #1103 merged as `5d8af90c1`.
Re-checked live read-only: `_can_see_field` md5 matches the migration's postflight pin, and the field-table
SELECT policies gate applicators on it. Visible `fields` rows per role, computed from the live policy rules with
each active person's id substituted (not a signed-in test): admins (4) 5 of 5, sales reps (3) 5 of 5, the 1
active applicator 2 of 5 (the fields of the jobs they are dispatched to; it was 5), drivers (2) 0, entity
recipients (2) 0. Still open: access does not end when the assignment ends (part C, KI-73). No in-app
click-through as an applicator was done. Part B also widened `_can_see_field` to every field of a dispatched job,
so the earlier gap where an applicator sent to one field of a split job got no weather centroid on Job Detail
should be gone (not checked in the app; 0 split assignments live, 2026-10-22).

### KI-02 — Product cost and margin: server functions audited and fixed live 2026-11-02
**MED · ACCEPTED · security/money · Mason (2026-10-21: the two residuals below) · fixes live 2026-11-02 (`20261102200000`); `admin_set_application_service_cost` retired live 2026-11-02 (`20261103090000`, ledger `20261102205903`)**
Mason decided cost and margin are admin-only. Screens and report functions were changed (migrations
`20261019010000`, `20261019230000`) and purchase-order cost is locked (`20261021140000`, `20261021141000`,
PR #980). **The column lock is live:** `20261022101000_cost_columns_admin_only` (PR #1089, applied 2026-10-25
22:34 UTC on Mason's in-chat approval, ledger `20261025223447`). Neither signed-in users (`authenticated`, admins
included) nor signed-out visitors (`anon`) can read or write a cost, profit or margin column directly on
`products`, `quotes`, `quote_items`, `quote_versions`, `orders`, `order_items`, `invoices`, `invoice_items`, `jobs`,
`job_chemicals`, `blend_ticket_products` or `commissions` (read live after the apply: 0 of 30 such columns readable
by either role; the server-only `service_role` key is unchanged); admins read cost through `get_admin_cost_fields`.
Two residuals stay accepted by Mason (2026-10-21): commission amount and rate together imply profit, and below-cost
refusals let a rep narrow a cost by trial and error. Includes the older sub-items "reps can recover
application-service cost" and "retire the old `admin_set_application_service_cost` function" (no caller left in
`src/`; dropped by `20261103090000_retire_admin_set_application_service_cost`).
**Function audit done 2026-11-02** (report: `docs/audits/2026-11-02-cost-margin-definer-function-audit.md`): every
signed-in-executable owner-rights (SECURITY DEFINER) function that names cost, reaches it through an inner helper, or
turns a cost-bearing row into JSON was traced live. Migration `20261102200000_cost_definer_leaks_closed` changes the ones
that need it so only admins get cost (real-schema proof
`scripts/smoke/prove-cost-definer-leaks-closed-real-schema.mjs`); **applied live 2026-11-02 18:39 UTC (12:39 PM Central), ledger `20261102183928`; read-only post-apply check and sweep clean**. The standing sweep
`cost-exposure-review` now flags any new or changed function that names cost, and the cost-lock proof records each
ledger-only migration once (CodeRabbit, PR #1089). Decided by Mason 2026-11-02: existing inventory notes stay as they
are; no new note gets a cost.

### KI-03 — Reps do not yet have the decided invoice and commission-split scoping
**MED · OPEN · security/money · Mason decided, build unassigned**
Mason decided reps may see all invoices read-only but only act on their own, and that only admins may change
commission splits on jobs, quotes and orders. Neither is built: no migration widens rep invoice reads or adds
own-name checks (`INVOICE_SCOPE_DENIED`) to the full set of invoice actions any active rep can call today on any
invoice id: `unpost_invoice`, `unpost_invoice_group`, `transfer_invoice_to_job`, `consolidate_draft_invoices`,
`update_field_app_applied_info`, `update_field_app_invoice_billing`, `save_field_app_invoice` (existing invoice) and
the `invoice_shares_insert` policy (checked live 2026-10-13: no ownership test); screens must also hide Edit/Post
on other reps' invoices, and payments and prepay/credit application stay open to reps. Any rep can
still change a commission split on a job, quote or order (only the customer default is protected). Any rep can
also roll over any rep's quote.
The 2026-11-02 cost audit noted more functions in this same ownership and role-check area (not cost); the list is in
Mason's private notes until the scoping work is built. It also noted that an admin's automatic draft invoice for a job
with a below-cost line always fails, so that job is billed by hand.

### KI-04 — Connected tools with no permission rule run without a prompt
**LOW · FIXED 2026-11-02 (residual accepted) · tooling-guards/security**
The original cause is gone: `migration-apply-guard.mjs` now runs only on `apply_migration` in Claude, and the Codex
adapter drops a bare "allow". The outward-facing connector tools — Slack send/schedule/canvas/list/reaction/upload,
Gmail send/reply/forward, Calendar event writes, Drive `share_file`, GitHub-MCP comment/issue/review/PR/repository
writes, Supabase feedback — are now `ask` rules in `.claude/settings.json` (risky Vercel tools were already
`deny`). User-level settings were not changed. Accepted residual (Mason, 2026-10-29: a relaxed harness): a newly
connected connector, or one whose id changes on reconnect, is unlisted until someone adds it. The two PR #605 hook
gaps are accepted in KI-78.

### KI-06 — Financial audit log can point at hard-deleted records
**FIXED 2026-11-06 12:02 AM Central (PR #1546, migration `20261115160000_financial_delete_snapshots`) · database/money**
The app never hard-deletes these rows: invoice deletes are soft (`deleted_at`), payment deletes are voids
(`allocation_sets.is_active = false`), and signed-in users hold no DELETE on `invoices`, `allocation_sets` or
`payments`. Any remaining back-office (postgres/service-role) hard delete now writes a `financial_audit_log` row
with the whole erased row plus every row that cascades away with it, naming the system actor; TRUNCATE on the
three tables is refused. Residual (accepted, recorded): 206 older audit rows (162 invoice, 43 payment, March
2026 test-era data plus one August E2E demo invoice) still point at rows erased before the fix; Mason decided
nothing is back-filled or deleted without his approval. A database owner who disables triggers can still bypass.

### KI-07 — Other small security gaps
**MED/LOW · mixed · unassigned**
- `profiles` grants `TRUNCATE`/`TRIGGER` to signed-in users (confirmed live read-only 2026-10-25 and
  2026-11-05) — revoked by `20261116100000_permission_tightening.sql` (Mason 2026-11-05; APPLIED LIVE 2026-11-06 12:28 AM Central, ledger `20261106062807`), LOW-MED.
- The same table-maintenance rights (TRUNCATE, TRIGGER, MAINTAIN) on every public table and view, `profiles` MAINTAIN included (462 grants,
  live read-only 2026-11-06) — `20261123130000_revoke_truncate_trigger_maintain.sql` APPLIED LIVE 2026-11-06 11:09 AM Central, ledger `20261106170917`; repo
  guard `browserTableMaintenanceGrants.test.ts`. Known limit: `supabase_admin`'s default privileges (platform and
  extension objects) cannot be changed by `postgres`; live sweep `browser-table-maintenance` watches for them; every app table is `postgres`-owned and the migration checks that. LOW-MED.
- Customer-document post-apply check RECORDED 2026-11-08 on the local test copy (all migrations, `20260914100700`
  included): no browser storage policy names the `customer-documents` bucket, and the Documents tab uploads and
  downloads through `customer-document-files` (served locally). Removed documents: LIVE 2026-11-09 (PR #1663;
  `20261222100000_document_restore_and_photo_uploader.sql`, ledger `20261109173810`; `customer-document-files` v6;
  Mason checked restore in the live app) — an active admin can restore one (both removal columns
  cleared, nothing else), and `customer-document-files` lets admins download a removed one; the Documents tab has an
  admin-only "Show removed documents" view with Restore. Each restore is kept in `customer_document_restores` (who
  removed it and when, who restored it), written by the database; a retried removal after a restore is refused
  instead of reporting "removed". Live API check 2026-11-09 (publishable key, `Accept-Profile: storage`): the API
  answers `PGRST106`, exposing only `public` and `graphql_public`, so the `storage` schema is not reachable. LOW.
  Deferred from #1663 (#1698), LOW each: (a) a removed document whose file was deleted can still be restored (the
  record shows, its download fails; no service-role cleanup deletes such files today); (b) the retried-removal check
  reads the document without a lock, so an admin restore at the same instant as a retried removal can still let that
  retry report "removed".
- Signed-in rep click-through of `customer-document-files` RECORDED 2026-11-08 (local test copy): a sales rep opens
  a customer document and sees no removed-documents view; after removing one, the download service answers "no
  longer available" and a restore attempt changes 0 rows. Repeat on live (v6 deployed 2026-11-09) — needs a
  sales-rep sign-in, so Mason or a rep does it — LOW.
- A staff viewer can mint a temporary photo link (Mason accepted this, see accepted list KI-60).
- 12 live SECURITY DEFINER functions set `search_path` to `public, extensions, pg_temp`, which the written rule
  (`public, pg_temp`, or an exactly empty path with fully-qualified names) does not cover: `fields_acre_authority_guard`,
  `find_overlapping_fields`, `get_field_dashboard`, `get_field_geojson`, `get_fields_geojson_by_ids`,
  `get_fields_with_geojson`, `get_job_fields_with_geojson`, `get_job_proof_data`, `save_field_geometry`,
  `save_field_polygons`, `set_field_boundary`, `set_field_override_acres` (read-only `execute_sql`, 2026-10-26 UTC; same 12 re-read
  2026-10-25 10:52 PM Central).
  They need `extensions` for PostGIS. DOCUMENTED 2026-11-05 (Mason): `docs/workflows/RLS_SECURITY_GUIDE.md`
  records the PostGIS exception; live has sixteen (these twelve plus four internal helpers). No function changed — CLOSED.

---

### KI-97 — Invoice email content is built by the app screen, not by the email service
**MED · FIXED, LIVE 2026-11-02 (PR #1340; `send-email` v22) · money · residual tracked as KI-98**
The `send-email` service checks who may send an invoice email, to whom, and when, and limits the links and map
images it may carry (PR #1302). Before this fix, the email's wording, amount and attached PDF came from the app screen.
Fix (PR #1340): the service writes the invoice email's subject, wording, Amount Due
(stored balance, whole cents) and attachment name from the saved invoice and ignores the screen's. The PDF is
still drawn by the app, so the app also sends the money the PDF prints; the service refuses the send unless that
matches the saved invoice, and checks again just before sending (same method as the purchase-order copy). Left
open: the PDF file itself is drawn by the signed-in user's app, not the server; and the last check is a read
before the send, so a payment saved in that split second can still go out with the earlier Amount Due (the
purchase-order copy has the same window). Both are accepted for now and tracked as KI-98 (Mason, 2026-11-02).
Proved live 2026-11-02 at 11:45 PM Central: test invoice CS-2026-0058 (test customer) was emailed from the app.
Its `email_log` row is `sent` with the server-written subject, Amount Due $3,000.00 and `Invoice-CS-2026-0058.pdf`.
The invoice was posted only for this test and voided right after.

---

### KI-98 — Emailed invoice and purchase-order PDFs are drawn by the sender's app, not the server
**LOW · FIXED, LIVE 2026-11-03 (PR #1346; `send-email` v23) · money · Claude**
Mason accepted this on 2026-11-02 when choosing how KI-97 would ship (`DECISION_LOG.md`, same date).
- **The fix.** `send-email` now draws the invoice and purchase-order PDFs itself, from the saved records
  (`supabase/functions/_shared/pdf/`, the same drawing code the app prints with). It refuses a PDF the app
  attaches to those two email types, and the app no longer sends one. The app still sends what its screen showed,
  so a send is refused if the screen was out of date. Before drawing an invoice it checks that the sender can open
  that invoice in the app (a rep only their own), because the server reads it with full access.
- **Proof so far.** One real chemical-sale invoice, one field-application invoice and one purchase order drawn by
  the old app code and by the new server code came out byte-for-byte the same (apart from the file's creation
  time).
- **Still accepted.** `send-email`'s last check is a read just before the provider call, not an atomic step. A
  change saved in that split second still goes out as it was a moment earlier.
- **Behaviour change.** An invoice emailed from the editor shows the saved invoice, not unsaved edits on screen.
- **Live proof (2026-11-03, about 7:00 AM Central).** `send-email` v23 was deployed on Mason's in-chat yes, and
  the app merged about 20 seconds later. Each step was run on croprxsolutions.app:
  - The PO-2026-0030 copy email was sent, and its `email_log` row is `sent` with `Purchase-Order-PO-2026-0030.pdf`.
  - Test invoice INV-2026-1522 ([E2E] Farm Alpha, one $312.72 service line) was posted and emailed. Its row is
    `sent` with `Invoice-INV-2026-1522.pdf`, and the invoice was then voided.
  - Both calls returned 200 with no function errors logged.

---

## Money


### KI-99 — Voiding an invoice leaves two money records out of step
**MED · OPEN · money · found 2026-11-04 (Fix Delivery reviews, PR #1421) · Claude**
Both are in the live `void_invoice`, so they affect the ordinary Void Invoice button, not only Fix Delivery.
- **Write-off stays active.** Voiding a posted invoice that has a write-off sets the invoice's write-off amount to
  zero but leaves its `write_offs` record active (not marked reversed), so the customer statement can still show it.
  Until fixed, reverse the write-off before voiding. Fix Delivery refuses these invoices.
- **Credit month read in UTC.** Before reversing an applied credit, `void_invoice` checks that the credit's month
  is open using the UTC date (`applied_at::date`), not the Chicago business date. A credit applied just after
  midnight UTC on the 1st belongs to the previous Chicago month, so a closed month can be changed. Fix Delivery
  checks both dates.
- **Next step.** A reviewed migration that marks the write-off reversed when its invoice is voided and checks the
  credit month by the Chicago date (Sol-listed: money).
### KI-10 — About 69 live functions replay a saved result matched on the retry key alone
**HIGH on money paths · PARTIAL · money/inventory/database · unassigned (batch 3 remainder is next)**
When a user retries an action with a saved "retry key", these functions return the first call's saved answer
without checking that the retry is for the same person and record. Nothing is double-charged; a reused key with
a different target gives a false "success" on the wrong record. Fixed on `main`: batch 1 (`20261016060000`,
PR #942), batch 2 (`20261016140000`, PR #951), batch 3a (`20261019200000`, PR #954), batch 3b (`20261019235000`,
PR #967), batch 4a (`20261102180000`, PR #1288, applied 2026-11-02: `unpost_invoice`, `unpost_invoice_group`,
`close_accounting_period`, `reopen_accounting_period`, `transfer_invoice_to_job`, `save_field_app_invoice`,
`update_field_app_invoice_billing`, `consolidate_draft_invoices`, `update_blend_ticket_billing_status`,
`create_rebate_claim`, `transition_rebate_claim`). Batch 4b (`20261103130000`, PR #1299, applied live 2026-11-03, ledger `20261103013009`) binds
`price_order`, `update_order_items` and `mark_inventory_row_verified` (MED, PR #1042 follow-up 3; Mason: "batch
it"). Batch 4c (`20261110160000`, applied live 2026-11-05) binds the purchase-order, quote-copy, delivery, cycle-count
and blend-ticket writes: `submit_purchase_order`, `cancel_purchase_order`, `delete_purchase_order`,
`duplicate_quote`, `edit_delivery`, `reassign_delivery`, `batch_reschedule_deliveries`, `confirm_delivery`,
`create_delivery_with_items`, `create_followup_delivery`, `cancel_cycle_count`, `reverse_blend_ticket_approval`.
Accepted without a wrapper (reason): `void_invoice` (already binds its request); `save_purchase_order` (its bulk
path is bound; the single save is an edit of one record); `increment_customer_prepay`, `restore_cancelled_delivery`
and the `_section9_*` inner bodies (no app caller; only the database owner and service role can run them);
`apply_remaining_prepayments` and `batch_apply_all_prepayments` (always refused, disabled);
`admin_save_application_service` (admin-only edit of one setting row). Batch 4d (`20261114200000`, PR #1528, applied live 2026-11-06, ledger `20261106035950`) binds 25 records
functions and requires a key on each: `admin_update_profile`, `batch_approve_blend_tickets`,
`batch_reject_blend_tickets`, `bulk_create_label_drafts`, `commit_label_draft`, `create_label_draft`,
`create_blend_ticket`, `save_blend_ticket`, `save_blend_ticket_fields`, `dismiss_watchdog_flag`, `delete_vendor`,
`reactivate_vendor`, `save_vendor`, `link_fields_to_parent`, `unlink_field_from_parent`, `review_customer_fact`,
`supersede_customer_fact`, `save_blend_recipe`, `save_field`, `save_field_crop_history`, `save_field_geometry`,
`save_field_polygons`, `set_application_record_lots`, `set_field_boundary`, `set_field_override_acres`.
It also limits `save_blend_recipe` to an active admin or sales rep, as both app recipe screens already were.
`link_fields_to_parent`, `unlink_field_from_parent` and `save_field_polygons` also refuse a "performed by" naming someone
other than the signed-in user (the app always sends the signed-in user).
Batch 4e (`20261123110000`, applied live 2026-11-06, ledger `20261106154806`, after the app PR #1518 that sends a key
on the six keyless notification and applied-info calls was serving in production) binds 15 operations
functions and requires a key on each: `confirm_job_notification_sent`, `record_job_pre_notifications`,
`record_job_post_notifications`, `log_failed_notification`, `assign_job_applicator`, `dispatch_job_locations`,
`undispatch_job_locations`, `start_job`, `create_job_from_quote_section`, `update_field_app_applied_info`,
`create_quote_from_template`, `rollover_quote_to_season`, `save_quote_template`, and the two disabled bulk
prepayment functions `apply_remaining_prepayments` and `batch_apply_all_prepayments` (still always refused).
Exceptions: the three calls PR #1518 began keying (`confirm_job_notification_sent`, `log_failed_notification`,
`update_field_app_applied_info`) still accept a call with no key and run it exactly as before (no receipt). A browser
tab opened before PR #1518 can then still mark an email it already sent, log a failure, and save applied info after
its invoice. A key-carrying call is bound like the rest.
After 4e, only the accepted exceptions listed for batch 4c remain.

### KI-11 — Browser screens throw away or share their retry key (double-apply risk)
**HIGH on money paths · FIXED IN CODE 2026-11-02 (branch `claude/crx-idempotency-keys-4a3741`; live once merged) · money**
On a lost reply the app should retry with the same key. Many screens discarded the key too early or kept it across
different records, so a retry could double-apply or replay another record's result. About 14 spots were fixed in
PR #584; the rest are fixed on this branch, and every one now keeps its key until the save is confirmed. How each
key is scoped depends on whether the server binds the key to its request (KI-10):
- **Server binds the request** (`create_quick_delivery`, `batch_apply_prepayments`, `create_order_from_blend_ticket`,
  `batch_cancel_deliveries`, `batch_void_invoices`, `delete_invoices`, `complete_job`, `draw_down_quote`, `save_job`, and by
  their own argument check `allocate_payment` and `generate_finance_charges`): one key
  per form, record, or sorted set of records. An edited retry after a lost reply is refused with the committed
  result (the screen opens it, or says the earlier save went through and reloads), instead of creating a second
  one. Scoping these by payload would let an edit
  mint a fresh key and duplicate the work.
- **Server does not bind the request** (`assign_job_applicator`, `save_field`, `edit_delivery`, `link_blend_ticket_to_order`, `create_quote_from_template`,
  `rollover_quote_to_season`, `reassign_delivery`): a save that creates a record (new field, quote from
  template, season rollover) keeps one key per form or source until confirmed, so an edited retry after a lost
  reply replays the record already created instead of making a second one (a changed new-field retry opens that
  field and applies none of the edit unless the saved field and billing splits hold this retry's details); an edit to an existing record uses one key per record
  and exact request, and only the latest attempt keeps its key, so a retry never replays another record's result or an older,
  already-superseded edit.
- NewOrder (`create_direct_order`, `create_rush_order`, both bound) keeps one key per exact request on purpose:
  its below-cost approval is remembered per key, and a shared key could carry an approval to a different order.
- Saving an existing job keeps one key per exact edit: re-applying an edit to the same job is harmless, while a
  new job keeps one key and opens the committed job when an edited retry is refused.
**Partial Order across a reload (S14, 2026-11-03):** a reload forgets the in-memory key, so a rep whose
reply was lost and who reloaded made a second order with a fresh key. QuoteBuilder now keeps an unconfirmed
draw (its key and exact request) in the tab's sessionStorage (`src/lib/pendingRetry.ts`, kept no longer than
the server's 24-hour receipt) and the Partial Order dialog offers **Finish it**, which re-sends that request
with that key: the server returns the order it made, or makes it once. A typed draw also uses the kept key,
so a changed draw after a committed one is refused with that order. Cleared on success or a binding refusal.
Proof: three screen tests in `QuoteBuilder.test.tsx`; on the local test copy, a draw whose reply was dropped,
a reload and Finish it left one order and 100 gal drawn. Other screens still keep keys in memory only.
**Remaining risk:** for the unbound functions, a create retried with different details after a lost reply opens
the record already created without the later edits, and an edited retry of an existing record applies the new edit
after the old one. Neither makes a second record or moves money twice; a clear refusal needs server-side binding
(KI-10 batches 4c/4d; batch 4c binds `edit_delivery` and `reassign_delivery`), not a screen change. Once batch 4d is applied, `save_field` is bound: a changed retry
with the same key is refused, and nothing changes, instead of opening the field already created; after a
refresh the new field is in the list. Field Setup shows that refusal as the raw code
`IDEMPOTENCY_INTENT_MISMATCH` rather than the plain message in `errorSanitizer.ts` (cosmetic; follow-up). Once batch 4e is applied, `assign_job_applicator`,
`create_quote_from_template` and `rollover_quote_to_season` are bound the same way: a changed retry with the same key is
refused and changes nothing, instead of replaying the record already made; a refresh shows that record. Quotes' Convert to Order
starts a new key each time its dialog opens, which is accepted: the server answers a repeat with
`already_converted` and opens the existing order. `KNOWN_UNFIXED_SITES` in
`src/__tests__/idempotency-reset-order.test.ts` lists only three documented scanner false positives (CustomerDetail,
BulkTicketUpload, ManualTicketCreate). Proof on the local test copy, with the first reply dropped on purpose:
Payment Allocation, Quick Delivery, Invoices delete and New Order (edited to B and back to A) each retried with the
same key and the server replayed the first result. The scanner is still only a weak tripwire: it checks the order
of the reset, not whether the key is scoped correctly.

### KI-12 — Quote "Convert to Order" can leave an accepted quote with no order
**MED (latent) · CAUSE FIXED, LIVE 2026-10-27 (To-Do 1.3; PR #1105 merged as `f1503ba91`) · money/inventory/UI · Q-2026-2059 reopened to Sent 2026-11-05 (Mason)**
QuoteBuilder used to save the quote as Accepted (releasing its inventory holds) before creating the order, so a
failed second step left an accepted quote with no order. It now calls `convert_quote_to_order` on the sent or
revised quote, which marks it accepted in the same transaction as the order; a failure leaves the quote as it was
(proof: `scripts/smoke/smoke-convert-sent-quote-in-one-step.sql`). A direct `quotes.status` update by an owning
rep could flip a quote to accepted without an order (the column is writable); that path is not in the app. Fix: `20261029090000` (PR #1200) refuses it at commit (`QUOTE_ACCEPTED_WITHOUT_ORDER`); it is in the live ledger (version `20261031103934`, re-read 2026-11-04), the live refusal was not re-tested.
Q-2026-2059 (accepted, no order, no draws, never any holds; a test quote on Mason's own account) predated the fix.
Mason chose 2026-11-05 to reopen it: un-accepted through the admin Un-accept button (`revert_quote_status`) on
2026-11-05 at 10:31 PM Central (`quote_status_reverted` in `financial_audit_log` and `activity_feed`). Live re-read:
status `sent`, 0 orders, 0 holds, 0 draws; no holds re-created (not a planned quote). Its expiry date (2026-08-01) has
passed, so the nightly `auto_expire_quotes` will mark it Expired unless it is re-sent with a new date.
**The December pre-booking flow had the same gap** (raised by Maksym, checked in the code 2026-10-26): a
Planned Program quote reserves its stock with holds (`create_planned_holds`), and the trigger
`release_holds_on_quote_status_change` (latest in `20260706030000`) frees every active hold when the status becomes
Accepted. The same fix covers it: whole Convert to Order and Book as Order both now reach `convert_quote_to_order`
with no Accepted save first, so the hold release and the new order are one transaction and a failed conversion
keeps the pre-booked stock reserved. Partial Order (`draw_down_quote`) never flipped the status first. Two small database clean-ups (extra `quote_sections` privileges and a loose
`_below_cost_reason_from_json` parser) and a display-only profit mismatch are also recorded; the fixes exist only
on closed PR #397.

### KI-13 — Returns never reduce already-earned commission; commission rules unbuilt
**MED · OPEN · money · Mason decision exists (2026-08-09), not built**
Commission clawback on returns has no function or migration on `main`. Also open: `commission_payments.total_amount`
is stored as dollars with decimals (checks force clean cents, but the column breaks the integer-cents rule;
MED); two money columns (`commissions_order_profit_whole_cents_chk`, `quotes_total_cost_whole_cents_chk`) can still
hold sub-cent values, adding the checks is Mason's call (LOW-MED); the old name-reuse guard trigger
`trg_guard_recipient_name_reuse` is deliberately kept until all app versions send person IDs, so renaming someone
can make old splits refuse to save (LOW-MED).

### KI-14 — Transfer-created field invoices are always Net 30
**MED · FIXED 2026-11-06 8:54 AM Central (PR #1556, migration `20261120100000_field_invoice_due_date_follows_owner_terms`, ledger `20261106145427`) · money**
- Each field-application invoice is now due on its own owner's terms: the transfer leaves the due date blank and a
  trigger fills it from that invoice's terms (blank terms take the customer's, then Net 30). A due date typed by hand
  is marked custom (`invoices.due_date_is_custom`) and kept when terms change.
- `parse_payment_terms_days` reads "Net N" first, so `2/10 Net 30` is 30 days.
- The split editor saves per-owner terms through `update_field_app_invoice_billing(p_terms_by_invoice)`. An app tab
  opened before this change saves the PO, notes and discounts and leaves each invoice's terms and due date as they
  are (Mason, 2026-11-06: an old tab saves all but terms/due date).
- The PDF falls back to the terms' due date only for field-application invoices; Print refuses a custom due date
  left blank.
- Proof: `scripts/smoke/prove-field-invoice-due-date-follows-terms-real-schema.mjs` (Docker), live smoke chains, and
  `db-sweeps:live` after the apply (six cost-exposure keys re-read and re-keyed; no cost reaches a reply).

### KI-16 — Sub-cent and rounding gaps
**MED/LOW · mixed · money · unassigned**
- `baseUnitOfRate` (`src/lib/chemCalculator.ts:559`) drops everything after `/`, so "oz/cwt" reads as "oz".
  Saving a job with such a unit is refused by the database (`20260820120000`, PR #446, applied live per the older
  record); `_close_quote_as_applied`, the recipe-pricing path and the blend-ticket path (refuses only at billing)
  can still create such lines. MED.
- A zero-width character pasted into a rate unit makes a blend ticket un-invoiceable (fails closed; staff must
  retype). `normalize_rate_unit` does not strip invisible characters. LOW-MED.
- A job chemical line's per-unit COST is still rounded to whole cents when it is converted from the product's
  stock unit to the rate's unit (`reconcileChemAutofillUnits`, and `save_job`'s cost fill in `20261019230000`):
  $5/GAL is 3.90625¢/oz, saved as 4¢, so 400 oz shows $16.00 of cost against $15.625 and the job's margin is off
  by that much. The PRICE is no longer rounded (2026-10-23: left blank unless exact). Cost is not billed. LOW-MED.
- Split-acre shares are rounded to 2 decimals, so totals can differ from the field's acres by cents. UNVERIFIED
  (current body of `derive_customer_shares_from_fields` not located).
- Quote Builder's line math (`recalcItem`, `catalogPricePerAcre` in `src/lib/quoteCalc.ts`) multiplies and rounds
  in dollars, not integer cents. Found by CodeRabbit on PR #1078 (2026-10-23) and deferred: moving it to cents
  changes rounding on every quote line, so it needs its own money PR. LOW.

### KI-18 — Dates and seasons follow the UTC clock or the browser clock (fixed; last part `20261208100000`)
**MED · FIXED LIVE (2026-11-07, PRs #1579, #1615, #1613) · money/UI** (seasons, screens, blend-ticket year, dashboard aging, the invoice date limit, the database "today", evening hold expiry, and statement and AR aging)
- Fixed 2026-11-06 by `20261121090000` (applied live, ledger `20261106152929`, PR #1560): blend-ticket numbers take
  the Chicago year; the Financial Dashboard's AR-aging strip uses the AR Aging page's ranges on the Chicago date; the
  database refuses an invoice date more than 365 days after the Chicago date. Earlier fixes: `20261103120000`
  (`current_season()` and the `invoice_date` default) and `20261029160300` (quote, order and rebate-claim years).
- Fixed 2026-11-07 by `20261208100000` (applied live, ledger `20261107201450`, PR #1613): customer statements
  (`get_detailed_statement_data`, so single, emailed and Month-End batch statements) age by the AR Aging page's ranges,
  0-29 / 30-59 / 60-89 / 90-119 / 120+ (Mason, 2026-11-07), instead of <=30 / 31-60 / 61-90 / 91-120 / >120; and
  `get_ar_aging`'s fallback date is the Chicago date instead of the UTC `CURRENT_DATE`.
- Fixed 2026-11-06 by PR #1579: `20261204100000` (applied live, ledger `20261107041703`) moves 33 money,
  compliance and stock functions (period checks, commission dates, default quote expiry, AR reminders, license and RUP
  dates, hold and stock checks, default bill, payment and delivery dates) and `20261204110000` (applied live, ledger
  `20261107053254`) moves 13 boards and reports to the Chicago date; the database clock is UTC, so from 6-7 pm Central
  `CURRENT_DATE` was tomorrow. The overnight overdue, quote-expiry and morning-notice jobs need no change (they run
  midnight to 6 am Central).
- Fixed in `20261206110000` (applied live 2026-11-07): `_sync_job_holds` counts a hold that expires today until the Chicago day ends, and refuses a
  signed-in caller passing another user as the actor.
- Sol notes on the live batches (2026-11-07), fixed in `20261206110000` (applied live 2026-11-07): reversing a write-off or
  credit application checks only the month of the Chicago day it was made (Mason, 2026-11-07; batch 1 checked the
  UTC and Chicago days, so an evening row on a month's last day could not be reversed once the next month closed);
  the stale-quote call list uses the Chicago calendar-day age it shows, not whole 24-hour periods.

### KI-19 — Accounting-month close: edits racing a close (fixed by `20261103220000`)
**HIGH-risk lane, dormant · FIXED LIVE (2026-11-03, PR #1327) · money**
`20261103220000_period_check_takes_month_lock` makes `check_period_open` itself take the shared month lock that
vendor-bill edits already took (`20260730114102`), so all 32 callers (26 had no lock) and a close of the same month now
wait for each other: an edit racing a close waits and is then refused; a close waits for an in-flight edit. Proof:
`scripts/smoke/prove-period-check-month-lock-real-schema.mjs` (real psql sessions racing a real close, fail-first).
Known limit: callers take that lock before or after their invoice row locks, so two edits on one invoice while a close
of that past month is queued can deadlock; PostgreSQL cancels one (40P01) and nothing is written. No month was closed
live when this was written.

### KI-20 — Shelved or disabled money features
**MED · OPEN · money · unassigned / Mason**
- Prepay bulk-apply is hard-disabled with `PREPAY_BULK_APPLY_DISABLED` (`20260620200000`) because it could
  double-spend credits; real fix needs the shelved redesign. Per-invoice apply works.
- The earmark engine (`docs/roadmap/shelved-earmark-engine/`) is shelved for a full redesign (Mason, 2026-06-14);
  do not apply.
- Split billing: per-delivery split of a partly delivered order is blocked by independent rounding losing cents
  (Goal 3 pieces landed in PR #1010, per-delivery case not confirmed). UNVERIFIED. Negative-quantity credits and
  reopening a saved split set are not supported (fail closed). LOW.
- Auto-draft invoice does nothing when an applicator completes a job; policy is Mason's, switch is off. MED, dormant.
- Two commission design choices wait on Mason (do blend tickets create commissions; may applicators see a job's
  commission split). UNVERIFIED, LOW.

### KI-81 — Two invoice paths read a quote line's current price, not the price the customer was sent
**MED · OPEN (found 2026-10-25, To-Do 1.2 follow-up) · money · unassigned (Mason, 2026-10-27: fix later, not now)**
The sent-price lock (`20261027040000`, live since 2026-10-27, ledger `20261027123725`) gates Convert, Partial Order and Schedule Job, which copy quote prices into
orders and job lines. Two later paths read `quote_items.price_per_unit` live instead (read from live bodies
2026-10-25): `create_invoice_from_blend_ticket` (through `set_blend_ticket_product_quote_price` /
`_blend_quote_pick_valid_20261020`, or the first line of the job's quote section) and the field-application
invoice (`_save_field_app_invoice_impl_20260714`, `resolve_field_app_chemical_price`, which take the first quote
line on the field with no status, customer or deleted filter). After a revision that changed a price and was not
re-sent, either can bill the unsent price (with `20261029120000`, PR #1203, in the live ledger as version `20261031130629`, a price change recorded by `save_quote` is the agreed price and needs no re-send); the field-application lookup can also take a draft, declined or deleted
quote's price. Fix: read the price from the version last sent (or refuse like the lock), with a real-schema proof.

### KI-82 — The open quote screen can show a stale cost for a line it just saved
**LOW · FIX IN REVIEW (Taha, branch `taha/quote-saved-line-cost`; found 2026-10-27, Sol review of PR #1105) · money (display only)**
After Save, `src/pages/QuoteBuilder.tsx` records a new line's saved id and stored price but does not load the
cost the database recorded for that line (`quote_items.cost_at_quote_cents`). If the product's cost changed after
the page loaded, the Cost, Profit and Margin shown to an admin can differ from the saved figures until the page is
reloaded. Saved prices, costs and totals are correct; PDFs never show cost. Fix: refresh each saved line's recorded
cost after a save, and prove it on the live screen.
The fix re-reads each saved line's recorded cost (and, for a line whose cost moved, the product's cost
today) through `get_admin_cost_fields` after an admin's save, without marking the quote changed; proven on a
local replay's screen (a new line added after its product's cost rose shows the recorded cost after Save).

---

### KI-95 — Historical AR aging fails for everyone if one customer cannot be rebuilt
**MED · FIXED IN CODE (found 2026-11-02, Ponytail audit #12, confirmed by Sol) · money · report half: migrations `20261103150000` (PR #1313, applied live 2026-11-02) and `20261104120000` (PR #1332); payment half: migration `20261103220000` (live status: each one's `docs/reference/migrations.d/` record)**
**Report half — fixed by `20261103150000_ar_aging_flags_unrebuildable_customers`** (live status: its
`docs/reference/migrations.d/` record). `get_ar_aging` still refuses to rebuild a customer whose later activity makes
the chosen date unknowable, but now returns everyone else and lists that customer with no amounts and an
`unavailable_reason`; the AR Aging tab shows them in a warning ("cannot be shown as of this date") and its totals say
they are excluded. Proof: `scripts/smoke/prove-ar-aging-flags-unrebuildable-real-schema.mjs`.
**Remaining report gaps — fixed by `20261104120000_balance_reports_flag_unrebuildable_customers`** (live status: its
`docs/reference/migrations.d/` record). The rare `HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE` (two posting events on
one invoice with the same audit timestamp) is now caught per customer in `get_ar_aging`, so it flags only that customer;
and `get_customer_balance_listing` gets the same flag-don't-fail behaviour (flagged rows: every amount, count and date
blank, plus `unavailable_reason`). The Reports → Customer Balance tab lists flagged customers in a warning, keeps them out
of the table, and keeps them in the CSV with blank amounts. Proof:
`scripts/smoke/prove-balance-reports-flag-unrebuildable-real-schema.mjs`. Known over-flag (deferred, LOW impact): a
posting collision on an invoice already voided or deleted by the date still flags that customer, though the invoice is
not in the balance. It flags, never shows a wrong amount, and before this fix it failed the whole report.
**Payment half — fixed by `20261103220000_period_check_takes_month_lock`:** `allocate_payment` refuses a
`p_payment_date` after today in Central time (`PAYMENT_DATE_IN_FUTURE`), so a payment can no longer make a customer
unrebuildable on a current-date report. Neither payment screen sends a date. Proof: the KI-19 prover above.

### KI-100 — An open product page learns of a lock change only on reload or a refused save
**LOW · product UI · `20261107060000` — APPLIED LIVE 2026-11-04**
If another admin locks rates while a product page is open, the page still offers rate edits; the save is refused by the database and the page then resets the rate fields to the saved values, so typed rate edits are lost. Other edits on the page save. Source: the WP-PM-11a-1 changelog note.

### KI-103 — Bulk product import: a row with an unknown extra field previews "ready", then the save refuses the file
**LOW · OPEN, no fix planned · products/import · found 2026-11-05 (Sol LOW on #1486)**
`preview_product_import` ignores unknown top-level keys on a row, but `apply_product_setup` refuses them, so such a
file previews "ready" and then the whole save is refused with nothing written. The screen never sends extra keys,
and keys inside `insert` or `rates` are already refused by the preview. The Check File timeout first filed under
this number is fixed and live (archive, 2026-11-05).

### KI-109 — Product Master follow-ups named in the Wave 2 report but never filed
**LOW · UNVERIFIED (not re-checked since 2026-11-03) · products · source: [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md)**
- No cancel for a previewed price change set: every live test leaves one behind (WP-PM-7's live check left
  `a27b2386` in "previewed" on a test product; prices did not change).
- No product-page list of open jobs still on old label values.
- `save_job` does not itself refuse edits to a completed job. Partly covered since: `20261204120000` freezes a
  completed or invoiced job's EPA numbers.
- WP-PM-7 deferred LOWs: emoji character count, older `toFixed` displays, the raw select in the cost modal.
- "Piksi Dust Plus - 1800G Jar" is stocked in milligrams but billed by dry ounces on jobs; check its price before it
  goes on a job. Its cost basis is still an open question for Mason.

### KI-114 — Four kinds of old product rate data are wrong or have no rate basis
**MED · OPEN, planned (RT-2/RT-3) · products/rates · found 2026-11-08 ([RT-1 build sheet](../plans/2026-11-08-product-RT1-BUILD-SHEET.md) section 1)**
RT-1's draft rates (`20261229110000`, live 2026-11-10) copy these as they are; nothing here is fixed yet. RT-2 step 1
(PR #1706, open) has its unit converter live (`20261229160000`, ledger `20261110061547`); its spelling remap
`20261229170000` is not live (2026-11-10). Derive notes the basis doubts (`basis_suspect`, `unit_not_for_form`, no basis), but not the Piksi grams: its house row is an `18 mg/acre` quoting default beside an `18 g/acre` label row, so RT-3 must fix it before any draft is approved.
- Seed treatments: the 9 liquid seed treatments with `/unit` text store the per-seed-unit number as a per-acre rate
  (Ilevo 2.5 Gal: `1.18 oz` "per acre", text `1.18 oz/unit`), so a quote multiplies it by acres. RT-3.
- Liquid unit on a dry product: `Autumn Super 51 WDG` and `Cimarron Plus - 10 oz` are dry with `rate_unit = 'oz'`.
  RT-2 (spellings).
- Milligrams: the two `Piksi Dust` products store `MG` while their text says grams (`18 grams per Acre`). RT-3.
- Per ton or per gallon: `BW-NLockDown`, `NanoCote Core` and `Tempo SC Ultra` have rates with no RT-1 basis. RT-3.

### KI-110 — Three small invoicing findings from the October admin-only invoicing review
**LOW · UNVERIFIED (seen 2026-10-09 to 2026-10-13, never re-checked) · invoicing · source: [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md)**
- `_update_order_items_impl` sets `invoice_items.order_item_id = NULL` on draft invoices without locking the
  `invoices` row, so a rep's order-line edit can change that link after an admin's versioned post compared the
  invoice. No amount changes. Fix: lock the affected draft invoices `FOR UPDATE` (by id) first.
- `cancel_delivery` refused an admin's quick delivery whose draft invoice was still open
  (`ORDER_INVOICE_TERMINAL`), for an admin and a rep alike, in a container replay of the live schema. Not checked
  live.
- `finance_charges` still grants table writes to `authenticated`. Its policy is admin-only, so RLS refuses them;
  this is clean-up debt, not a hole.

### KI-111 — Field-acre billing: the real boundary-file import check is still owed
**MED · UNVERIFIED (listed as open in code on 2026-09-30) · field app · source: [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md)**
- The one check left open at the June field-acre billing go-live: import one real John Deere, FieldView or .zip
  boundary export (a test customer is fine). Confirm it bills on the file's acres, the ±10% difference flag
  appears, and redrawing the map does not change the billed acres.
- Field boundary bulk import has no Skip / Replace / Import-as-new choice at preview.
- Split draft invoices created automatically when a delivery completes raise no bell notification.
- The guided map-drawing tool has no "undo last point".

---

## Inventory and deliveries

### KI-25 — A customer receipt that fails to send after a delivery completion is not retried
**MED · OPEN (sender and app switch live; close action live in the database, not on a screen yet) · UI/database/Edge Function · Claude**
The database half is live (`20261113140000`, PR #1495): a receipt asked for at completion is recorded in the same
save in `delivery_receipt_queue`. The sender (Edge Function `send-delivery-receipts`, PR #1647) was deployed live on
2026-11-08 with `verify_jwt` off, and the office "Customer receipts to check" card is on Deliveries. The app switch
that asks for the server receipt (PR #1649) merged 2026-11-09. Not built: provider bounce handling (no email
bounces are tracked today on any path). The database half of a "mark handled" action is live
(`20261221100000_close_delivery_receipt`, ledger `20261109152447`, PR #1678), but no screen calls it yet (checked on
`main` 2026-11-10), so the points below still hold. The office
card lists every unsent receipt with no age cut-off, so one the office already handled stays listed, and a manual
Email Confirmation does not pause a worker retry (Sol MED, PR #1647), so the customer can get a second copy. Mason
chose (2026-11-08) to land the app switch first; the close action's screen is the remaining follow-up.

### KI-26 — Delivery completion-evidence leftovers
**LOW · OPEN · UI/database/process**
Following `20261022075000` (PR #1024): old app versions are refused until reloaded; offline completions queued
before the change go to review; old completed deliveries have no proof stored; some old proof scripts fail;
abandoned signature files stay stored (deleting them is out of scope); file contents are not inspected. Photo proof
is now tied to who uploaded it (LIVE 2026-11-09, ledger `20261109173810`; see KI-77). Real-phone airplane-mode test PASSED
(Mason 2026-11-06, after the narrowing below): an offline signed completion synced and showed its signature.
The four older signature policies (fixed path `signatures/<id>.png`) are narrowed by
`20261116100000_permission_tightening.sql` (Mason 2026-11-05; APPLIED LIVE 2026-11-06 12:28 AM Central, ledger `20261106062807`): insert, update and delete dropped,
and reading needs the file to be the delivery's recorded signature.

### KI-28 — Jobs assigned to a non-applicator never reach the dispatch board
**MED · FIXED 2026-11-08 5:58 PM Central (PR #1652, migration `20261215100000`, ledger `20261108235833`) · database · Claude**
The sync triggers (`20260707020000:231,296`) require an active applicator; re-activating the person later did not
add the job back. Fix: a `profiles` trigger dispatches the open jobs' undispatched locations to a person the moment
they become an active applicator, whatever their license (Mason, 2026-11-08, DECISION_LOG), and the apply backfills
any already waiting (board splits and undispatched locations left alone; a job assignment or location add at the
same instant waits for the activation instead of being missed; proof
`scripts/smoke/prove-dispatch-sync-on-applicator-qualify-real-schema.mjs`). Detection sweep:
`scripts/db-invariant-sweeps/predicates/dispatch-sync-nonqualifying-profile.sql`; 0 rows live 2026-11-08 (preventive).
Taha's review: a job reassigned to an inactive applicator keeps the old applicator's dispatch row after re-activation.
Kept as designed (Mason, DECISION_LOG 2026-11-08): both sprayers can see and start it, proved in the same script.

### KI-29 — Field-mode and inventory data decisions waiting on Mason
**LOW-MED · PARTLY RE-MEASURED 2026-11-08 · inventory/process · Mason**
Re-measured live, read-only, 2026-11-08 (no data changed): five products still flag until counted (Mason chose not to
count; no stock movement since 2026-10-07); six partially fulfilled orders (0161/0162/0172/0176/0331/0343) still
hold stock for unfilled lines; the same three deliveries are stuck (DEL-00075/00077/00082) plus nine more past their
date on confirmed orders; 19 negative inventory rows (not the same 19 as June: two are new, one is deeper) must only be
fixed from physical counts; PO-2026-0008 is a real fully-received PO with 7 short and 10 over lines, PO-2026-0015's
receipt gap no longer shows; 10 deliveries have no items (5 completed, 2 voided, 3 cancelled); one cancelled
zero-item invoice. Not re-measured (sales/billing): whole-order invoicing on 33 orders, eight SEED commission
batches. Returns/voids on Chem Man-billed deliveries stay allowed. Yes/no sheet in the side-session notes (not in
this repo).

### KI-30 — Customer/vendor/product data hygiene waiting on Mason
**LOW-MED · UNVERIFIED · database/process · Mason / unassigned**
**Vendor-name merges and category remap are closed** (Mason 2026-10-25, recorded in PR #1100; To-Do 0.12/0.16). That read-only check found no duplicate vendor names and all 595 active products in the intended 11 categories. **Still open:** junk-row deletes and remaining live-data cleanup need Mason's decisions (they change history or delete real rows). EPA registration numbers (MED, compliance data): a read-only check on 2026-11-08 against EPA PPLS found 30 wrong numbers (9 moved by EPA to a new number, 21 belonging to another brand or not in the registry) and 8 products with no number but a registry match; on 2026-11-08 those 48 products were corrected live from EPA's registry (PR #1653). 4 numbers still need a person to read the jug label. Two `epa-lookup` limits make `LabelDataQuality` misreport some numbers: a number EPA moved returns a
lookup error instead of the new number, and a three-part distributor number returns "not found" even when
valid. CRM has no data entered; 146 of 151 active customers lack a
sales rep (live read-only count, 2026-11-08). The tool exists: an admin ticks customers on the Customers list and uses
**Assign sales rep** (PR #381), so what remains is Mason choosing each customer's rep.
WP-PM-8a (2026-11-02) found 16 of 604 live products that miss its new setup checks. They stay unchanged and keep working; the list is in Mason's private Product Master review notes.

### KI-32 — Scale limits: some lists and pickers are still row-capped
**MED · PARTIAL · UI/database · Mason (Goal 4)**
Most lists now page through every row (PRs #959, #1017, #1048). The order, job and purchase-order pickers now search
the database, and cycle-count locations read every row (PR #1048). The Customers and Jobs lists now read every row,
the Jobs Applicators/Customers filters match their job-id lists on the rows read (no URL-size risk), and the order and job
pickers match a customer name in the database instead of only the first 50 matching names (2026-11-05). Crop
Programs was not capped: its programs are one settings record and its product picker searches (PR #944).
The Orders list pages in the database with the true count and total of every match (`get_orders_page`, PR #1550). Dispatch
Board still lists the newest 500 jobs but now says how many match (PRs #1537, #1538; rest waits on KI-28, issue
#1497); Call Lists say how many customers match beyond their 200 (same PRs). The PR #1048 leftovers are done: Bulk
PO/Order/Quote Import read every product and match names against all of them (PR #1441); Label Data Quality, Product
Detail vendor/maker choices and the Invoice Detail customer picker read every row (PR #1512); the Field Customer
Assignment dropdown lists an exact or starting-with name first and says "Showing 20 of N" (2026-11-06). Each was shown
in the local test copy with 1,053 products and 26 customers. The blend-ticket scanner Edge Function
(`process-blend-ticket`) now reads every active product and customer in id-ordered pages, so a scanned line can match
product 1,001 and beyond (2026-11-08; live only once the function is redeployed, which needs Mason's approval).

---

### KI-85 — Receiving offers warehouses that cannot ship
**MED · FIXED (Part A, `20261102220000` live 2026-11-02) · UI/database/inventory · Claude (2026-11-02)**
Fix: the receiving pickers and Add Inventory list only active `warehouses` rows; `receive_po_items` and
`manual_inventory_add` refuse any location but Main Warehouse with `UNKNOWN_STORAGE_LOCATION` until transfers exist; Quick Receive no longer offers
its over-receive option, which always failed (no admin reason was sent). Part B (add-warehouse admin, transfer RPC,
per-location alerts) stays deferred until a second warehouse opens. Original report:
`src/pages/PurchaseOrderDetail.tsx` (~L1855) and `src/components/receiving/QuickReceivePanel.tsx` (~L69) offer
four hard-coded locations; only Main Warehouse is in `warehouses`. `receive_po_items` stores whatever location is
sent, but every outbound path uses Main Warehouse only and no transfer exists, so stock received elsewhere can never
ship. A live check on 2026-11-02 found all 117 inventory rows at Main Warehouse, so nothing has been stranded yet.
Fix: list active `warehouses` rows only, refuse unknown locations on the server, and print the real location.
Multi-warehouse support stays (`docs/manual/DECISION_LOG.md`, 2026-11-02; checklist in `docs/workflows/INVENTORY_RULES.md`).

### KI-92 — Accepted quote with live order needs proof
**LOW · UNVERIFIED · product database · LOCAL CANDIDATE — NOT APPLIED**
The accepted-quote and live-order warning case was checked by hand only.

### KI-93 — One blend ticket can deduct its stock twice
**MED · FIXED 2026-11-04 (`20261107050000` applied live, ledger `20261105014219`; PR #1459) (found 2026-11-02, Ponytail audit #11, confirmed by Sol) · database/inventory · Claude**
A blend ticket can produce both an application record (`create_application_record_from_blend_ticket`, which
deducts stock as `job_applied`) and an order (`create_order_from_blend_ticket`, whose delivery deducts again).
Neither checks for the other, and same-operation retry protection does not cover the cross-path case. Five designs
that kept both paths were broken (parked 2026-11-04). Fix (Mason, 2026-11-04): blend tickets go through
application records only. Create order from ticket, link and Unlink refuse `BLEND_TICKET_ORDERS_DISABLED`, a table
guard refuses every link row, and the ticket screen no longer offers them. Left open by design: an ordinary order
typed for the same products is a separate sale the database cannot tell apart.

### KI-94 — Voiding a delivery can put back more reserved stock than completion took
**LOW-MED · FIXED 2026-11-04 (migration `20261106230000` applied live, ledger `20261104202037`; residual below) · database/inventory · Claude**
Completion (`supabase/migrations/20261014210000_order_invoices_rep_own_name.sql` ~L612) lowers
`quantity_prebooked` by `LEAST(delivered, prebooked)`, but `void_delivery` adds back the full delivered quantity.
Prebooked 3, delivered 10, voided: prebooked becomes 10, so available stock reads low. Fully reserved deliveries are
unaffected. Cancelling a completed delivery is refused since PR #1284, so only void remains. Fix (Option A): completion
records per delivery line what it took (`delivery_items.quantity_prebooked_released`) and void puts back exactly that.
Residual: a line completed before the migration has no record and still restores the delivered quantity; since
`20261106233000` (applied live 2026-11-04, ledger `20261104220928`; Mason chose "flag them for review") that void's ledger row is marked
`requires_review` with a note to check reserved stock. Live
read-only 2026-11-04: one delivery with stock has ever been voided (DEL-00028, 2026-03-20); nothing is corrected.

### KI-100 — A spray job could leave a booking with a remainder no Partial Order can take
**MED · FIXED: migration `20261107070000` APPLIED LIVE 2026-11-04 (ledger `20261105032430`, PR #1451) · database · found 2026-11-04 (PR #1362 review)**
Since `20261106110000` (S02) a Partial Order must be in whole hundredths, but `_sync_quote_job_reservations`
drew a job reservation unrounded (`field_app_priced_quantity`): 1 fl oz from a 10 gal booking left 9.9921875 gal,
which no draw can take, so the booking never closed. The fix keeps a booking's job draws in whole hundredths that
together match the real total applied, rounded once, and holds at least each draw in the shed. Live had no job draws on 2026-11-04, so no booking was stranded. Proof:
`scripts/smoke/prove-job-reservation-whole-hundredths-real-schema.mjs`.

### KI-101 — Voiding a delivery on a cancelled order reopens the order
**MED · FIXED: migration `20261107120000` APPLIED LIVE 2026-11-05 (ledger `20261105060300`, PR #1471); the grant item below is in `20261116100000` · database/lifecycle · found 2026-11-04 (KI-93 design review)**
`_void_delivery_replay_impl_20261015` recomputed the order's status and wrote it under the admin override without
checking for `cancelled`, so voiding a delivery of a cancelled, part-delivered order reopened it and put back the
reservation the cancel had released. Reproduced 2026-11-04 on the throwaway copy. Such orders come from cancels before
2026-07-21 (today a cancel of a part-delivered order closes the remainder and marks it fulfilled) or from the direct
status change below. The fix keeps the order `cancelled`: the voided goods go back on the shelf, the reservation is
not put back (a full cancel released it and nobody will deliver a cancelled order), the line keeps nothing left to
deliver, and the stock-ledger note says so. An order cancelled through the direct status change released nothing;
its reservation is left as it was. Live 2026-11-04: 4 cancelled orders, none with a completed delivery or
delivered quantity. Proof: `scripts/smoke/prove-void-delivery-order-status-guards-real-schema.mjs`.
- **Grant item (Mason 2026-11-05).** Signed-in admins held a direct UPDATE grant on `orders.status`, so they
  could move an order between allowed statuses with no delivery and no stock movement.
  `20261116100000_permission_tightening.sql` revokes it, and the matching INSERT grant so an order cannot be created
  already fulfilled (APPLIED LIVE 2026-11-06 12:28 AM Central, ledger `20261106062807`); the order screen's unreachable direct
  status write is removed.

### KI-102 — Voiding an order, then one of its deliveries, puts the stock back twice
**MED · FIXED: migration `20261107120000` APPLIED LIVE 2026-11-05 (ledger `20261105060300`, PR #1471) · database/inventory · found 2026-11-04 (KI-93 design review, Sol r2 #8)**
`_void_order_impl_20260714` restores delivered stock but leaves the order's completed deliveries `completed`, and
`void_delivery` checked only the delivery's own status, so voiding a fulfilled order and then one of its deliveries
put that stock back a second time and reopened the voided order. Reproduced 2026-11-04 on the throwaway copy (100 on
hand, deliver 10, void the order, void the delivery: 110 on hand, order `confirmed`). The fix refuses that delivery
void (`ORDER_VOIDED_DELIVERY_LOCKED`); nothing moves. Live 2026-11-04: 0 voided orders, 0 completed deliveries on
voided orders. Proof: as KI-101.

### KI-105 — A quote's price tier is not checked against the customer's assigned tier
**LOW today, MUST before the first regular rep · PARKED 2026-11-05 · quotes/pricing · To-Do 1.6**
Quote Builder lets any tier be picked, so a quote can be priced at a tier other than the customer's assigned one
with no warning. A screen check (a note with "Use Tier N" and a "Quote at Tier M anyway" tick box that Save
needs) is built on branch `claude/quote-tier-credit-status` and parked unmerged (Mason, 2026-11-05: screen only,
then parked until the database rule exists). Only office staff and admins quote today. Before the first regular
rep gets an account: the database must refuse a different tier from reps (admins may override). When it resumes,
also fix Sol's two MED findings on that branch: (1) the customer's assigned tier is read once, so an admin
changing it while a quote is open leaves the check comparing against the old tier; (2) "Use Tier N" on a sent
quote changes the tier label without repricing its locked lines.

### KI-108 — Five products' stored stock did not match their transaction history on 2026-11-01
**MED · UNVERIFIED (snapshot 2026-11-01 12:11 UTC, not re-checked) · inventory · source: [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md)**
The monthly integrity report (closed PR #1230) found `inventory.quantity_available` different from the
`inventory_transactions` ledger for five products. The other nine checks passed.

| Product | Ledger says | Stored | Gap |
|---|---|---|---|
| Black Strap Molasses Sugar - Tote | 675 | 2,000 | 1,325 |
| Start Right 2.0 (AgBio) - Tote | 140.19 | 670.19 | 530 |
| 2, 4D Amine 4# - 2.5 Gal | -70 | 25 | 95 |
| 2, 4D Amine 4# - Bulk | 0 | 55 | 55 |
| Start Right 2.0 (AgBio) - 2.5G | 280 | 290 | 10 |

Next step: re-run the check (the `/integrity-report` admin page shows the same check). For any product still off,
read its ledger: an `adjusted` row that changed only pre-booked stock belongs in `PREBOOK_ONLY_ADJUSTMENT_TX_IDS`
(`src/lib/reconciliation.ts`); anything else is fixed with a reviewed migration.

### KI-116 — Product Detail treats a non-product address as a load failure
**LOW · OPEN (seen live 2026-11-07, Sentry CRX-MANAGER-1T and -1J) · products-ui · source: 2026-11-10 prod spot-check**
Opening `/products/group` (no link on `main` points there; most likely typed or an old bookmark for
`/group-products`) sends "group" to the database as a product id. Two reads fail with "invalid input syntax for type
uuid" and the page shows a load failure, not "product not found". Nothing is saved or changed. Fix when next in
`src/pages/ProductDetail.tsx` (Sol-listed): check the id is a uuid before loading, or send `/products/group` to
`/group-products`.

## Database and release process

### KI-35 — Live ledger vs files on `main` is checked only by noticing
**MED · FIXED (tool), run by hand · process/database · unassigned**
Nothing compared migrations applied live with migration files on `main` (four past mismatches). Now
`npm run db-drift:live` (`scripts/check-migration-drift.mjs`, read-only) lists live rows with no file on `main`, files
on `main` never applied (parked drafts named in `scripts/migration-drift-allowlist.json` are shown apart), and live
rows whose name or SQL differs from the file, or whose SQL cannot be compared. It reuses the pending-set guard's row
matching. The 159 old rows with no file (all before the 2026-07-27 baseline; KI-62) are allowlisted by version, and 13
rows whose files had only a header comment edited after the apply are allowlisted pinned to both hashes.
First live run, 2026-11-08 about 20:40 UTC: 1174 rows vs 1087 files, 259 SQL bodies compared; one row with no
file, `20261214100000_ki30_epa_registration_corrections`, applied before its PR #1653 merged (clean against that
branch). Not yet scheduled: it needs Mason's PC token, so run it after each live apply or merge.

### KI-36 — A table lock does not serialize the OLD body of a replaced function
**MED (rule) · ACCEPTED as guidance (same as KI-61) · database · Mason (2026-09-03)**
See KI-61. The rule is not yet in the migration checklist (`docs/workflows`); it lives only in the archive entry.

### KI-37 — Parked migration draft with a fragile membership rule
**LOW · OPEN · database · unassigned**
Parked draft `20260813060000_require_completed_delivery_before_invoice_post` (staging folder, history row 877,
NOT APPLIED) selects functions by searching their body for the word "posted", which in one function is only in a
comment. Nothing is wrong today because it is unapplied.

### KI-38 — Edge Function error alerting fails quiet
**LOW · FIXED, LIVE 2026-11-06 (PR #1545; all eight Edge Functions redeployed) · tooling/process**
A missing key only logged `[SENTRY_MISCONFIG]` when an error happened, then dropped the alert. Live `SENTRY_DSN` was
confirmed set on 2026-11-05 (name only). Fix: every function calls `warnIfSentryMisconfigured()` at startup, which
logs an ERROR-level `[SENTRY_MISCONFIG]` line on every cold start when the key is missing or malformed and never
throws, so an email send or user creation still works (throwing at boot would 500 every request). The unused
throwing `validateSentryDsnOrThrow()` was removed; `src/lib/edgeSentryBootCheck.test.ts` fails if a function skips
the check. All eight functions were redeployed from main `f885e5d7a` on 2026-11-06 and checked (see
`docs/manual/CURRENT_STATE.md` › Recent production deployments).

### KI-40 — CRM Phase 5 (AI receptionist) preconditions
**LOW · OPEN (future work) · database · unassigned**
Five prerequisites before building an automated phone receptionist (service-callable customer summary, service
document ingestion, provenance-trigger handling, transcript purge, a citing design question). Not a live defect.

### KI-41 — Product roadmap items deliberately deferred
**LOW · OPEN · process · unassigned**
Grower portal; OCR auto-fill of re-entry/pre-harvest intervals (held back as a compliance risk); offline-recovery
items (photo/signature persistence, idempotent email replay) and a real-phone offline test (MED, UNVERIFIED).

### KI-83 — The `idempotency_keys` table has no TypeScript type
**LOW · FIX IN REVIEW (Taha, branch `taha/idempotency-keys-type`; found 2026-10-27, migration-drift review of `20261027040000`; predates it) · database**
`idempotency_keys` is the internal table where database functions record a retry key and its saved answer, so a
repeated request returns the first result instead of acting twice. Many functions write to it (including the
quote save re-emitted by `20261027040000`), and every column they write is in `.claude/schema-registry.json` and in
the generated `src/types/supabase.ts`, but the shared hand-written types in `src/types/index.ts` have no interface
for it. Two screens read one column of it directly (`QuickDeliveryModal.tsx` and `InvoiceDetail.tsx` check that
`request_fingerprint` exists), so nothing is broken; the gap only means the migration review's TypeScript
cross-check, which reads `src/types/index.ts`, cannot confirm those writes. Fix: confirm with the
`typescript-types-drift-reviewer` whether to add an interface or record the table as intentionally untyped.
The fix adds `IdempotencyKey` to `src/types/index.ts` with the eight registry columns, as that reviewer's
CHECK 1 asks for every table a screen reads with `.from(...)`.

---

## Tooling, guards and CI (affect the agents and the build, not customers)

### KI-45 — Hold-latch helper-report edge cases
**MED · OPEN · tooling-guards · unassigned**
PR #1084 fixed the four recognized helper-report frames that were falsely latching the session. A helper report in another text shape can still be mistaken for Mason's words (`.claude/hooks/prompt-source-lib.mjs`, text-shape rules only); message-origin support is still needed for a complete fix. Further narrowing is in open PR #1152, not counted as shipped here.

### KI-46 — A review proof can be rewritten through its Windows 8.3 short name
**MED · OPEN · tooling-guards/security · Mason (owner action)**
The saved "Sol review passed" file can be addressed via an old-style short name the guard does not recognise.
Turning off short names is a reversible system change that only Mason should make; the durable fix is to
authenticate proof contents. CodeRabbit's backstop was removed 2026-10-19, which raises exposure.

### KI-47 — Hook bypasses that remain
**MED/LOW · mixed · tooling-guards · unassigned**
- Autopilot approves these destructive spellings (`.claude/hooks/autopilot-lib.mjs:214-216`; reproduced by calling
  `autopilotDecision`, re-confirmed by a reviewer): `rm -Rf`, `rm -r -f`, `rm --recursive --force`,
  `Remove-Item -Recurse`, `git clean --force -d`, `git branch -d -f` and `git commit -n`. A fix sits on branch
  `claude/autopilot-recursive-delete-alias-20260907` (18,131-command sweep) but must be rebuilt on current `main`.
  MED.
- Bare `git clean` with a config override is not covered (`bash-safety-lib.mjs:280`). LOW.
- `review-proof-guard`: the `GIT_EXTERNAL_DIFF` separate-export form and `gh` download over a protected path are
  unblocked (item 1 fixed in PR #530). Capped by Mason's 2026-09-01 decision. LOW.
- `git config core.hooksPath` is now refused by the Claude hook (#530) but the Codex side and a CI assertion are
  missing; CI still blocks anything reaching `main`. MED.
- The push guard does not treat `core.hooksPath` or shell-form `credential.helper` as dangerous
  (`codex-push-lib.mjs:1209-1217`). MED.
- `stop-verify` PROOF matching is text-based, so a fabricated PROOF line passes. LOW.
- Nine enforcement-file patterns are missing from the `.claude/settings.json` `ask` list (F3). Probably
  superseded by Mason's "fewer prompts" direction (#956, #974); needs a decision to close or cut down. LOW.

### KI-48 — Migration-apply protections and checks with known holes
**HIGH (per older record, exposure reduced) · OPEN · tooling-guards · Mason (capped review loop)**
- Ahead-of-pending marker (parked after review round 12): the proof-folder scan in `migration-apply-lib.mjs:956-975`
  has no deadline, so a slow run past the hook limit could let an apply proceed unchecked; the marker is not bound
  to a file digest. Exposure reduced because applies go through the guarded script.
- Three apply protections exist only on closed PR #364's branch. OPEN.
- The migration-ordering check reads a local snapshot of applied migrations and cannot see applies from another
  checkout (`applied-snapshot-invalidate.mjs`); Supabase's ledger is the backstop. LOW-MED.
- The migration-drift reviewer's overload check sees only authored history, not the live catalog
  (`.claude/agents/migration-drift-reviewer.md` CHECK 2). Deferred by Mason. MED.
- Whole-body hash pins on the quote-version trust chain must be updated in the two live files together (the applied migration `20260826220000` keeps its own apply-time copy) (ACCEPTED, KI-63).

### KI-49 — Codex review tooling
**HIGH (per older record), mitigated · OPEN · tooling-guards/process · wiring a hook needs Mason's approval**
Running raw `codex review <scope>` from the repo root self-recurses, kills its own process and exits 0, which can
record a false "clean" review; the wrapper `node scripts/write-codex-push-proof.mjs` avoids it, nothing blocks the
raw form. Also: the Codex `/import` feature writes corrupted `source-command-*` adapters (commit blocker fixed,
importer cannot be turned off; since 2026-10-30 the sync warning names `--archive-imported`, which moves them to a
restorable archive, and a later import can bring new copies back; deferred, not solved: an external filesystem change
during archive creation can leave an empty directory after a rejected operation. Existing file content is retained,
and the destination is fixed under shared Git storage); `sync-agent-workflows.mjs` has thirteen
recorded limitations (lexical-only containment, junction/symlink and path-case edge cases; Mason: record, don't
patch); the guard-claim ratchet misses claims inside template strings and files outside the hook folders. Codex can
show two Stop prompts on one stop (Mason's global reminder plus the project proof check); they check different
things, and removing the duplicate needs a separate change to the global hook. Codex's guard still refuses a
single-quoted search alternation near a protected file (use double quotes or separate simple reads), and a batched
double-quoted search when the command holds shell syntax that could change how quotes pair, such as `$`, `%`, `!`, a
comment or `\"`, even when harmless (the guard's scan is deliberately conservative, not a parser; the full list is in
`docs/reference/agent-guardrails.md`; drop the comment or run the reads separately). Deferred, not solved: this change
does not establish source-content integrity for every shared hook. Runtime trust status and the guard's explicit
protected-file list are separate checks; scripts outside that list do not gain its write protection.

### KI-50 — Cloud (web/mobile) sessions cannot push or back up memory
**MED · ACCEPTED · tooling-guards · Mason (2026-08-04: leave as is)**
A credential proxy rewrites git addresses and the guards refuse (safe failure); deliver from the cloud with GitHub
tools. `scripts/backup-claude-memory.mjs:476` refuses the same way.

### KI-51 — Supplier-pricing Phase 3C containment and time-bombs
**MED · OPEN · tooling-guards · unassigned**
The trusted containment check is not a required check on `main` (rules: Vercel, Lint/Type/Test/Build, SQL
Migration Validation). The first-push ancestry cap is 4,096 commits (`scripts/check-supplier-pricing-phase3-private-artifacts.mjs:25`);
`main` has 3,032 and grows ~200/month, so about five months until every new branch push is blocked; raise it before
then. Byte/candidate scan budgets (3 GiB, 100,000) need re-measuring. Maintenance watch.

### KI-52 — Tests and tooling hygiene
**LOW · OPEN · tooling-guards · unassigned**
**Fixed 2026-11-08 (`claude/ki52-tooling-hygiene`):** `scripts/land-pr.mjs` now prints the pinned, immediate
`gh pr merge … --match-head-commit <head>` the merge guard accepts (no `--auto`); `scripts/fleet-status.mjs` runs
every Git command with `core.fsmonitor=false`; `src/lib/rlsContracts.test.ts` records `20260813080000` as applied
(live 2026-08-16, ledger `20260816174353`) with `quote_versions` INSERT `none`; `docs/reference/gotchas.md` has the
"gross margin means markup" note. **Still open:**
Page-render tests flake in the full suite (latest fix #1062; fixed case by case); `live-testdata-lib.mjs` read-side false positives were addressed by PR #1143 (merged 2026-10-27), which keeps executable DML guarded; new instances still need individual reproduction; the Phase 3
return-policy concurrency prover can't reach its chain (UNVERIFIED; PR #1110 repaired three different provers and does not establish this one's result); no static guard catches invoice-type leaks or
direct-URL edit-lock bypasses (MED, UI); extra live-sweep predicates (concurrency hotspot, more money identities)
not written; Gauntlet V2 Phase 2 unfinished (no staging database, E2E switched off, 44 page-render skips,
counts not re-measured).
Further small LOW notes from the 2026-10-13 branch salvage, carried from the archive and not re-checked: invoices
created through the order functions would be numbered INV- instead of CS-/MC- (latent; 0 of 12 live order
invoices affected); on the bulk order import,
Escape on the below-cost prompt also closes the Import Orders dialog while the upload continues out of sight
(`src/components/orders/BulkOrderImport.tsx`; a fix sits on closed PR #350's branch); the return-credit prover
is pre-apply and two test hardenings were not carried; GraphQL ref updates are not inspected locally (the
server-side ruleset is the boundary).
`src/types/supabase.ts` cannot be swapped wholesale for a fresh live type generation (checked 2026-10-26): the
generator drops hand-kept entries (the `invoice_postable_version` computed field on `invoices_postable`, which
`InvoiceDetail`, `Invoices`, `OfficeCockpit` and `OrderDetail` select; nullable columns on table-returning reports
such as `get_quote_versions`), so the typecheck fails, and it adds about 60 live helpers the file lacks, which
moves two `rpcContracts.test.ts` classifications. Records PRs add only the entries their migration changes, compared
against a live generation.

### KI-84 — The split-billing backfill smoke chain fails on current `main`
**LOW · OPEN · tooling/smoke · unassigned (Mason, 2026-10-27: noted, not now)**
`scripts/smoke/smoke-backfill-refuse-split-billing.sql` stops before `SMOKE_PASS_ROLLBACK` on a current-main
database. It completes a delivery with a direct `UPDATE`, which 20261022075000 now refuses
(`COMPLETION_EVIDENCE_REQUIRED`). It also needs the versioned `post_invoice_group` branch, using the pattern in
`smoke-field-app-split-penny-exact.sql`. This is a test gap, not a customer defect: the refusal it proves stays
live, and `prove-quote-customer-row-version-real-schema.mjs` still runs the chain in its old form on the July
catalog (#1110). Done = the chain passes on main and still fails first against 20261006200000 (CRX-LIFE-001).

---


### KI-96 — Unused code and copied helpers make every change slower
**LOW · OPEN (found 2026-11-02, Ponytail audit #17-#20) · tooling/frontend · unassigned (do last; changes no behavior)**
About 11,000 lines nothing runs: 20 one-off scripts in `scripts/smoke/`, 5 switched-off guards in `.claude/hooks/`
(never the always-kept ones in `AGENTS.md`), 3 browser-test setups and 12 committed `tmpclaude-*` files; offline
sync for eight actions the phones no longer queue (`src/lib/offlineSync.ts` ~L404-469); and two Edge Functions
nothing calls (`reset-user-password`, `setup-blend-tickets-storage`). Helpers are copied: date formatting about 78
times, money formatting in a dozen files (two print "$-5.00"), customer-notification code in both the job and
invoice pages. `src/pages/QuoteBuilder.tsx` (~6,000 lines) and the job page (~5,400) mix loading, pricing, saving,
status actions and PDF/email; moving status actions and PDF/email into their own files changes nothing for users.
Delete with a grep of every reference first; keep one copy of each helper.
**Part 1 done 2026-11-08** (`docs/changelog.d/2026-11-08-ki96-delete-unreferenced-tooling.md`): the seven
never-queued offline handlers, 8 old unreferenced proof files and the 12 `tmpclaude-*` files are gone. Still open:
the two unwired hooks (`active-area-guard.mjs`, `rls-on-new-tables.mjs`; the review-proof guard refuses shell
deletes under `.claude/hooks`), the October/November proofs nothing references, the two Edge Functions (removing
them from live is Mason's deploy action), and the helper and page-split work. All six Playwright configs are in use.
**Part 2 done 2026-11-08** (`docs/changelog.d/2026-11-08-ki96-part2-delete-unused-hooks.md`): the two unwired hooks
and one August proof are gone. The October/November proofs stay (recent work still runs them by hand), as does
`scripts/smoke/undo-paths/` (eight proofs import it). Still open: the two Edge Functions and the helper and
page-split work.

### KI-107 — Review-proof guard refuses a delete after `cd` into a worktree when any part of the command has `..` or a variable
**LOW · OPEN (rule read on `main` 2026-11-08) · tooling-guards · source: [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md)**
`review-proof-guard.mjs` refuses `cd <worktree> && <delete or move>` when any later part of the command climbs out
(for example a harmless `ls ../wt-b`), and cannot see `S=<path>; rm -rf "$S"` as a literal path. Closed PR #1536
(branch `claude/review-proof-guard-worktree-path-7639d0`, tip `b8ae8bf6e0`, two Luna rounds) judges each delete on
its own and reads such variables: of 19 real refusals on 2026-11-05, 6 pass and 13 stay refused. Mason closed it
on 2026-11-05 because that narrowing kept leaking the same class of hole; the branch is kept for its pinned test
cases only. Workaround: run a delete or cleanup as its own command, not in one that `cd`s into a worktree.

### KI-112 — A draft return-credit prover failed just after midnight UTC
**LOW · UNVERIFIED · tooling-tests · source: [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md)**
The baseline-replay version of `scripts/smoke/verify-return-credit-real-schema.mjs` (closed PR #1319) failed just
after midnight UTC with "fractional credit A PNL COGS delta=-1251". Not checked whether `main`'s live-dump version
fails the same way; it fits the known pattern of live checks that fail between 6 PM and midnight Central.

### KI-113 — The customer-document byte-boundary prover is out of date
**LOW · OPEN · tooling-tests · source: #1698 (from #1663)**
`scripts/smoke/prove-customer-document-bytes-server-only.mjs` (PR #635) builds a hand-made scratch project (a
`profiles`/`customers` fixture plus `20260717013415`, then `20260914100700`) and serves today's
`customer-document-files`. Its `--phase=after` fails on `profiles.email NOT NULL`, and today's function also relies on
later migrations (`20261013220000`, `20261222100000`) its fixture lacks, so a one-line email fix would not make it
pass. Not a customer risk today: live read-only 2026-11-09, the `customer-documents` bucket is private and no
`storage.objects` policy names it or omits `bucket_id`, so browser users reach its files only through
`customer-document-files`; the 2026-11-08 local click-through (KI-07) exercised that path. No other prover covers this
boundary. Fix when next needed: rebuild it on the real-schema harness.

### KI-115 — Many screens send database errors to Sentry as "[object Object]"
**LOW · PARTLY FIXED · observability · source: 2026-11-10 prod spot-check (Sentry CRX-MANAGER-1W, -1S)**
About 70 files under `src/` report a caught error as `err instanceof Error ? err : new Error(String(err))`. A
Supabase error is a plain object, so Sentry receives only "[object Object]" and the real reason is lost (1W was an
expected "a size changed, build a new proposal" refusal on Group Products; 1S on the Office Cockpit finance card had no
matching database error, so it was most likely a network blip). The 2026-11-10 fix makes `src/lib/sentry.ts` title
plain error objects with their own message and drop network blips, and Group Products now passes the error as-is.
Still open: the other call sites. Fix by passing the error itself to `Sentry.captureException`; many of those files
are Sol-listed, so batch them by area.

---

## Accepted risks (Mason decided to live with these; do not re-open without a new decision)

| ID | What | Why accepted |
|---|---|---|
| KI-17 | Blend-ticket linkage picks one order line per product: `link_blend_ticket_to_order` still takes `ORDER BY sort_order, id LIMIT 1`; automatic matching or splitting across tiers is not built | ACCEPTED limit (Mason 2026-11-05): the linkage is not used for money; the invoice side asks staff to pick (PRs #982, #995, #1020) |
| KI-60 | A permitted staff member can mint a temporary link to a private photo | Mason, option A, 2026-10-14 |
| KI-61 | A `LOCK TABLE` in a migration does not stop an already-running call of the OLD function body | Mason 2026-09-03; both instances applied with zero activity; future migrations of that shape need a quiet rollout and a concurrency proof |
| KI-62 | Live migration ledger has older entries with no file on `main` | Pre-existing drift, not new |
| KI-63 | Quote-version trust chain has live pins in two files (`quote-versions-rpc-owned.sql`, `quoteVersionWriteBoundary.test.ts`); migration `20260826220000` keeps its apply-time pin copy | Intentional friction; a live-pin change must update both live files, while the applied migration stays unchanged |
| KI-64 | All agents share Mason's admin GitHub identity; the manual merge override is fenced only by command matching | Mason declined a separate non-admin credential twice (2026-09-01) |
| KI-65 | The write-time actor-binding guard is bypassable by design limits | Capped by decision 2026-09-01; real controls are Codex review and post-apply sweeps |
| KI-66 | `review-proof-guard` denies destructive commands that spell out a worktree path | Mason "document, don't fix" 2026-08-20; narrowed 2026-11-03 (P3): only the worktree root, its `.claude`, an unreadable or `..` path, or a path-less wiper aimed at one still deny |
| KI-67 | `sync-agent-workflows --write` overwrites an unusable manifest; the `.agents/` drift sweep reads disk, not the git index | Mason 2026-09-03 |
| KI-68 | `adjust_inventory` accepts a retry key with control characters; a suspended second tab can resend a stale batch adjustment | Mason accepted 2026-09-20 / 2026-09-13; no caller can produce it; revisit if duplicate adjustments appear |
| KI-69 | Return-credit behaviours staff will see (late return credits stay in the current season; a funding invoice can't be deleted until the credit is voided) | Mason policy 2026-08-26 |
| KI-70 | Proof-file self-attestation; migration-source provenance closes the quiet path only; shell string-reconstruction bypasses; worktree awareness is a session-start snapshot; `npm --prefix/--workspace` escapes the script-body guard; Edge Functions and ~130 legacy reads exempt from check lint rules | Accepted residuals under the "honest mistakes, not malicious agent" model |
| KI-71 | Renaming/deactivating a profile named in a commission split fails closed; PWA needs two reloads after a deploy; ExcelJS tests slow on a cold cache; JobDetail save test must re-click | Deliberate / expected behaviour |
| KI-79 | A saved quote line forgets whether its acres were typed or filled in from the section's field (`save_quote` stores the acres, not the source; Quote Builder's `acres_source` lives only in the browser). Totals stay correct. After reopening, switching a section's field leaves those lines' acres as they were and shows "This section's saved lines keep their acres. Check them against the new field." Options weighed 2026-10-23: (1) keep as is, no cost; (2) store a typed/field flag on `quote_items`: a migration plus changes to `save_quote` (a money RPC) and every quote-copy path (duplicate, versions, rollover, template), which fall back to today's warning if they drop it; (3) save each line's field link and have the server recompute acres: a large `save_quote` rewrite, highest risk | Mason chose option 1, keep as is (2026-10-23, #1060 follow-up); revisit if reps report wrong acres after switching fields |
| KI-80 | A job line priced from a product's tier price is not re-checked when that tier price is later removed or the customer's tier changes; it is re-checked (`job_chemicals_price_required`, #1060) only when the line is next edited | Mason declined the re-check (2026-10-23, #1060 follow-up): rare case |
| KI-104 | Invoice email: the invoice page's Email button does not recognise a send made before 2026-11-05 under the old clock-based retry key, so it can send an unchanged invoice once more. The bulk Email on the Invoices list also checks the email log (a key that starts with the server-written `invoice:invoice:<id>:` prefix, to the same address, since the invoice last changed), so it skips those. A bulk skip does not see a bill-to correction made without changing the invoice; the invoice page's Email sends it. From then on the shared record key (invoice, its last change, the address and bill-to) stops repeats exactly | Mason, option A, 2026-11-05, narrowed by option A2 (To-Do 9.6): the email service change that would catch every old send was not approved |
| KI-106 | RUP sales register: an active admin can still add a row to `rup_sales_records` directly (the `rup_sales_insert` policy, older than KI-18). Such a row gets only the posted-invoice check; the sale-date, season and license checks run only in `generate_rup_sales_records`, which is the only path the app uses | ACCEPTED (Mason 2026-11-07): the register is low-importance; no extra guard wanted (Sol finding on PR #1579) |

---

## Additional open details (carried from the archive after the Luna cross-check; not re-verified in this pass)

These sub-items belong to the numbered entries above. They were found missing or blurred when a second reviewer
(Luna) compared this file with the old one. Each is an open or accepted limitation as the old file recorded it.

### KI-72 — A fix merged on `main` whose last steps are still pending (moved here from "closed")
**MED · PARTIAL · security/money · Mason**
CRX-LIFE-001, reps creating a `field_application` invoice through the order
pipeline: fix merged (PR #885, `20261006200000`, applied live per the old record). Two proof gates remain: the 29th
live-sweep predicate (`quote-versions-rpc-owned`) was declined at its prompt, and the live smoke chains need
Mason's REAL-DATA-OK.

Purchase order copy (To-Do 0.15, PRs #1114 and #1147): DONE. The `send-email` service has handled
`purchase_order` since v20 (2026-10-27) and still does on v21 (2026-11-03 02:16 UTC); Email PO Copy on
PO-2026-0030 sent and arrived on v21. See `CURRENT_STATE.md`, Recent production deployments.

### KI-73 — More field-access holes (extends KI-01; To-Do row 11.4, plus row 11.7)
**HIGH · PARTIAL · security · Mason approval to narrow permissions**
- FIXED LIVE 2026-10-26 02:10 UTC (9:10 PM Central, 2026-10-25) by part A (PR #1065, history row 980, ledger `20261026021016`): `global_search` let any
  signed-in user search customer names and contacts, order/invoice/delivery numbers and farm names, and
  `get_notes_for_entity` let any signed-in user with a record ID read its team notes. Now search returns nothing
  to field roles and notes follow the linked record (`get_notes_for_entity` runs as the caller, checked live). `team_notes` itself still admits every active profile, so the Team Board shows field roles every note;
  Mason decided 2026-10-23 to keep that for now (To-Do row 11.11, `DECISION_LOG.md`).
- Every active account reads every `customer_addresses` row (To-Do row 11.7). ACCEPTED AS IS by Mason, 2026-11-08: drivers
  keep the delivery address (FieldStop) even past the delivery date, and applicators keep theirs; no later change. Taken out of
  part C because tying addresses to `customers_select` would hide it from a driver on an overdue delivery (Sol).
- DEFERRED (LOW, Sol 2026-11-08, part C): `start_job` and `complete_job` return a matching idempotency result before
  the job-access check, so a former applicator replaying their own key gets back the earlier result (ids they already
  had). Nothing new is written. Fix: check access before the replay lookup.
- FIXED LIVE 2026-10-27 02:05 UTC (9:05 PM Central, 2026-10-26) by part B: drivers could read every customer's
  billing splits and spray-record field/acres data through `field_billing_defaults` and
  `application_record_fields` (MED); both now admit only office staff and applicators who can see the field.
- Whole-job applicators keep access to completed, cancelled and soft-deleted jobs indefinitely, and dispatch access
  can survive a job deletion; affected functions include `start_job` and `complete_job` (HIGH). FIXED LIVE 2026-11-09
  05:29 UTC (11:29 PM Central, 2026-11-08) by part C (PR #1650, ledger `20261109052957`, `20261217100000`), which ends the whole-job applicator's access when
  the job is cancelled, deleted, or completed/invoiced more than 7 days ago (new server-stamped `jobs.completed_at`), in
  `jobs_select`, every policy that reaches the job through `jobs`, and eleven functions; dispatch access, including
  the assignee's own `job_location_dispatches` row, ends on deletion or cancellation, or 7 days after the job's completion. Proven per role in a disposable
  copy (`scripts/smoke/prove-job-access-ends-with-the-job-real-schema.mjs`). Taha's review (MED): it also hid the field
  of an applicator's own spray record once the job's window ended (Record Book showed "-"); `20261220100000`
  (live 2026-11-09, ledger `20261109123130`) gives `fields_select` and `arf_select` an own-record leg
  (`scripts/smoke/prove-applicator-keeps-own-record-fields-real-schema.mjs`).
- FIXED LIVE 2026-10-27 02:05 UTC (9:05 PM Central, 2026-10-26) by part B (PR #1103, history row 985, ledger
  `20261027020546`): applicators read every `fields` row, and `field_polygons`, crop history, obstacles and
  `field_app_locations` followed the same rule (HIGH; 5 of 5 rows live for the real applicator on 2026-10-25,
  Central). After the apply the 1 active applicator sees 2 of 5 fields, drivers and entity recipients 0, admins
  and sales reps 5 of 5 (computed read-only from the live policy rules, not a signed-in test). Part B also closed: the
  `field_billing_defaults`/`application_record_fields` driver reads above; direct `field_polygons` writes by any
  applicator (made office-only); `field_app_locations`/`_shares` reads (office-only); and
  `get_job_billed_customers` letting any applicator through on a job with no whole-job applicator (NULL gate).
  Mason decided 2026-10-25 that someone sent to a job sees the entire job (`DECISION_LOG.md`), so part B also
  widens `_can_see_field`'s dispatch leg to every field of the dispatched job and keeps the job pages job-wide;
  that resolves the split-job report mismatch a per-field view would have caused. Left after part B: anon reads
  of `application_record_fields` now error instead of returning nothing (LOW, fails closed; three other field
  tables already did); a crew member
  whose role is driver keeps the crew job and its map but not the field tables (by design).
- Opposite gap: dispatch-only applicators cannot read their assigned fields' shares, application records and
  details, attachments, or job-attachment photos (LOW). Mason's 2026-10-25 decision (they see the entire job and
  ticket) means these should be widened to the dispatch route too. Part C (live 2026-11-09 UTC, PR #1650)
  gives them read-only access to those rows of the job they are dispatched to.

### KI-74 — More cost exposure and prerequisites (extends KI-02)
**MED · PARTIAL · security/money · Mason**
~~`blend_recipe_items` and cost fields reachable through field-billing and dispatch paths remain readable (HIGH).~~
**Settled by the 2026-11-02 audit (KI-02):** `blend_recipe_items` cost was closed by the column lock; field billing,
delivery and offline sync give an applicator or driver no cost; the remaining dispatch path is covered by
`20261102200000` (live 2026-11-02).
Commission amount plus rate can reveal a rep's profit, and Quick Receive reveals which open PO line is cheaper
(MED). The computed field `invoice_post_version` reads the whole invoice row, so revoking invoice columns can break
posting: the cost-column lock must ship with a column-safe version design in the same change (MED). **Done in
`20261022090000` (PR #1057, applied live 2026-10-23):** the version is a computed field, `invoice_postable_version`, on
the `invoices_postable` view (every column but `total_cost_cents`), the seven screens read it there, and the cost lock
(`20261022101000`, applied live 2026-10-25) dropped the `invoices` overload.

### KI-75 — Retry-key detail (extends KI-10, KI-11)
**HIGH on money paths · OPEN · money**
`transfer_invoice_to_job` and `update_field_app_invoice_billing` are now bound (batch 4a, `20261102180000`). Still
open: the after-lock race in `apply_credit_memo_to_invoice`. Screen-side items, closed 2026-11-02 with KI-11 (same
branch): JobDetail's reset-before-call defects are fixed. DeliveryDetail (edit, reassign, confirm, create invoice)
and FieldStop (confirm) now keep a key per record or payload. Accepted with no change: the `PrepaymentManagerPanel`
split-check modal, because batch 1 (`20261016060000`) binds `create_prepay_check_splits` on the server and the
screen already resets only after a confirmed save. Also accepted: OrderDetail. `update_order_items` keeps one key
per order, and a payload change is refused with a conflict dialog that reloads the order (by design).
`price_order` already rotates its key when the payload hash changes. Cancel and split are per-order.

### KI-76 — Quote, season, invoice and return details (extends KI-12, KI-14, KI-18, KI-20, KI-69)
**MED/LOW · OPEN · money**
- Quote re-save can still be refused when a save both deletes or switches a saved line and adds several new lines
  for the same product (LOW).
- `issue_return_credit` and the delivery-split functions can fall back to `current_season()`; from `20261103120000` (applied live 2026-11-03, ledger `20261103003731`) it reads the Chicago date, and the return-credit header dates its credit memo, due date and period check by the Chicago date too. The field-app split path still stamps its commission record with the UTC `CURRENT_DATE` (LOW).
- `get_customer_summary` and `operational_dashboard_summary` pick the season from the UTC `current_date`, so from 7 PM to midnight Central on 30 September they already count the new season (found by CodeRabbit on PR #1065, 2026-10-25; that PR keeps both bodies as live has them) (LOW).
- Transfer Net 30 (KI-14): FIXED 2026-11-06 (PR #1556); see KI-14.
- Split billing: a split can bill any customer named in editable order allocations, field owners or billing
  defaults; whether that scope is intended is Mason's open decision (MED). Any rep can read another rep's
  split-return lines and prices under `return_items_select` (LOW).
- `create_invoice_from_order` copies a blank unit, so a mono-billed order line with no unit cannot get a return
  credit (MED). A return can go stale after an earlier return is cancelled or rejected (cancel and recreate); a
  concurrent split-invoice void can leave a requested return unreceivable; credits apply manually; multi-price
  billing is credited at an average price (MED, partly by design).
- KI-69 detail: voiding a return credit is not enough; the voided credit memo must be permanently deleted before the
  source invoice can be hard-deleted or re-saved.
- Whole-order invoice quantities and unit prices are not capped server-side (MED; quantities change when PR #1174 applies). Voiding a delivery whose invoice
  is posted leaves the invoice active (MED; changes when PR #1174 applies: the delivery then cannot be voided until the invoice is voided). Removing a product from a
  scheduled delivery can leave its drafted invoice unpostable, and lowering a quantity leaves the draft over the
  delivery quantity until staff edit it (MED). Freezing a soft-deleted order can block cancelling or voiding its
  completed delivery (reversal needs a reviewed migration) (LOW). Draft invoice CS-2026-0055 is deliberately left
  (the other delivery was billed in Chem Man) (LOW). Integrity checks page by offset, so concurrent inserts or
  deletes can make a run miss or repeat a row (LOW, accepted).

- PR #1174 also preserves physical quick-delivery and follow-up completion while an edited draft needs correction; posting still rechecks the whole bill. Its split generator conserves each source quantity exactly, and the order-line and product caps have no fractional tolerance.

### KI-77 — Lists, UI and CRM details (extends KI-26, KI-30, KI-32, KI-41)
**MED/LOW · OPEN · UI/database**
The row-capped pickers listed here are fixed (see KI-32). Paging caveats: two identical reads can still miss
concurrent changes, load/count cost grows on large tables (the Orders list now reads one page at a time, but each page
still recomputes the season's line, invoice and delivery totals), more than 20 identical-name search results are hard to
reach, a trigram index may be needed (LOW). Commission Payments: an older refresh can report success after a newer
one fails (LOW). `SelectLocationsModal` map/list split stays 50/50 on tablets (LOW). CRM gaps: applicator-license
visibility on customer/prep-card/quote surfaces, a pre-quote pipeline, duplicate detection in the bulk customer
import, bulk import of sales reps from a file, outbound-email logging (MED). Bulk rep assignment exists on the Customers
list (PR #381); the customer form warns, without blocking, when a new or renamed customer has a similar name or the
same phone or email as one on file (2026-11-08). Offline recovery also lacks notification replay,
operation-specific conflict checks, automatic discovery of an office resolution on the device, a general
duplicate-action policy, and carries the risk of losing device-local work before reconnection (MED). Completion
evidence: photo proof tied to who uploaded the file — LIVE 2026-11-09 (`20261222100000`, ledger `20261109173810`): a signed-in user's new delivery
photo must name that user as uploader and a `delivery-photos` file that user owns (as signatures are checked), its
upload time is the server clock, and its delivery, file, uploader and time never change. Older photo rows are not
re-checked; storage-rule guarantees still do not cover dashboard or service-role tools (LOW). Not checked: a
user can attach a photo file they uploaded for one delivery to another delivery they may add photos to, so that
delivery's photo list shows it; `complete_delivery` still refuses it as proof (the evidence smoke files such rows
on purpose to prove that). LOW. Also deferred from #1663 (#1698): photo ownership is checked only when the photo row is
added, so if a photo file is deleted and someone else uploads a different file at the same path, the existing row keeps
the first uploader's name and time. LOW.

### KI-78 — Tooling and guard details (extends KI-04, KI-46, KI-47, KI-48, KI-49, KI-50, KI-65, KI-68)
**MED/LOW · OPEN · tooling-guards**
- CodeRabbit label gate (#516), four items: stale requested state can survive an invalid ready event; checks can be
  stale after same-head invalidation; privileged workflow actions use mutable tags; merge guards do not bind
  approval to the recorded request marker or reviewer identity (MED; relevance lowered since CodeRabbit became
  advisory).
- PR #605 hook gaps, ACCEPTED 2026-11-02: `money-safety`, `rls-on-new-tables` and `generated-column-check`
  still read only `content || new_string`, so a MultiEdit payload would go unchecked, but the current
  Claude Code has no MultiEdit tool; non-canonical path spellings can bypass path-rule matching, `.env` aliases in
  `env-guard` included (LOW). Revisit trigger: if Claude Code regains a MultiEdit tool, reopen the 2026-11-02
  acceptance for these three content guards.
- `env-guard` service-role scan: FIXED 2026-11-08 (branch `claude/guard-port-envguard-ki107-7aecfa`). An Edit is
  judged as the whole file after the edit, comments are scanned like code, and a repo-relative or upper-case `src/`
  path counts. `*.test.ts(x)` files may quote `'service_role'` (several assert database grants) but still may not
  name the key or hold a JWT-shaped literal. Still not caught (LOW): frontend files with other extensions (`.mjs`,
  `.vue`, `.html`), a key name or role built at run time from pieces, keys not shaped like a JWT, and the `.env`
  path aliases accepted above.
- Review-proof guard: besides the 8.3 short name, an interpreter can build the path, a hard link can expose the file
  outside the state directory, and an alias/junction can be swapped after the check (MED). A separate
  `export GIT_PAGER=...` can evade it, like `GIT_EXTERNAL_DIFF` (LOW).
- The three protections missing from closed PR #364: apply-time one-shot replay enforcement, fresh project-bound
  live evidence, and event-trigger/transitive-fanout coverage (HIGH per the old record, exposure reduced).
- Ahead-of-pending marker: the parked branch's file-digest binding is not rechecked at the end, and three refusal
  tests assert only exit status, so an uncaught crash passes them (LOW).
- Actor-binding guard (accepted, KI-65): hook and live sweeps share naming blind spots; rebinding, dynamic SQL and
  temp-table paths evade checks; helper delegation is not followed; migrations written outside hooked tools bypass
  the hook.
- `sync-agent-workflows.mjs` limits (KI-49): external symlink targets can pass; external `GIT_INDEX_FILE` can be
  ignored; case/Unicode staged paths can evade checks or collide; a directory-to-file change can make repair fail;
  unowned manifest paths can be deleted; fail-closed wiring lacks regression coverage; some prune tests never reach
  the prune loop; `source-command-` is treated as provenance; invalid UTF-8 can compare equal after replacement
  decoding (MED).
- Cloud sessions also fail the commit gates (not only push and backup); the only workaround is unverified (MED, KI-50).
- `inventory.quantity_available` has no CHECK constraint, so a pre-existing NaN can propagate (MED, KI-68). The
  parked control-character migration's postflight checks can be satisfied by a commented-out clause and no longer
  inspect the cutover-trigger body (LOW, only if that branch is resumed).

---

## Unverified items (could not confirm either way; treat as open until checked)

KI-16 (split-acre
rounding), KI-20 (per-delivery split, commission design choices), KI-29/KI-30
(live-data counts), KI-41 (offline recovery), KI-52 (prover, live-testdata false
positives). Live-database facts need a read-only query by someone with access.

---

## Closed in this rewrite (each with proof; full original text is in the archive)

Entries 1–6 were closed during the original rewrite; their older proof records are retained. Entry 7 was closed by the 2026-10-27 reconciliation. That reconciliation checked the live migration ledger, but did not re-run the older behavioral proofs.

1. **Staff photo buckets were publicly readable** — `20261015230000_staff_photo_storage_access.sql` and
   `20261016030000_staff_photo_buckets_private.sql`, PRs #929 and #947 (buckets read `public = false` live
   2026-10-16 per the older record).
2. **Reps could name another salesperson on invoices, orders, blend tickets and quotes** —
   `20261014210000` (PR #928), `20261015130000` (PR #933), `20261015200000` (PR #938).
3. **Free-form invoice could name any product** — `20261021050000_from_scratch_invoices_charge_lines_only`, PR #983.
4. **Split billing could not bill a field owner who is not the order's customer** — `20261021150000` and
   `20261021155000`, PR #1010 (merge `d8dd88a6d`).
5. **Order total overwritten by an unrounded sum in `_update_order_items_impl`** — fixed 2026-08-09; later bodies
   (e.g. `20260914100500:2263`) set the rounded total.
6. **`review-proof-guard` node-preload / `-pe` eval bypass (item 1 of the executor-bypass entry)** — PR #530
   (merge `26e8a40d9`); items 2–3 stay open in KI-47.

7. **KI-15, stored-profit Reports tabs** — PR #1134 merged 2026-10-27 (`cef4e3015`); `Reports.tsx` now calls `get_profitability_report` for customer, product and month groups. The PR records real-data local-app proof and paging/failure tests. Full report approval remains To-Do 10.2. Original issue and closure evidence appended to the archive.

8. **KI-85, stale sweep fingerprints on quote functions** — closed 2026-11-01 by the pin-refresh change on branch `fix/refresh-quote-sweep-pins-2026-11-01`; the 2026-11-01 live sweep adjudicated all 29 predicates `ok: true`, `complete: true`.

9. **KI-39, customer-facing PDF polish** — closed 2026-11-05: quote-PDF section notes wrap instead of overprinting (PR #1480); the year-end "Change" column shows green/red again (PR #1477). Both checked on a rendered PDF; original text appended to the archive.
10. **KI-27, an expired uncertain request locked its dialog** — closed 2026-11-05 by branch `claude/uncertain-intent-admin-clear-5591c7`: an admin-only "I checked the records — clear this" control (with a confirm) appears only once the safe retry window has passed, removes that browser's expired saved request, and is logged to Sentry. Proven on the local test app (admin clears and the form works again; a sales rep and a still-retryable request show no control) and by hook and component tests.
11. **KI-86, a direct admin turn-off skipped the warnings** — closed 2026-11-05: already fixed by `20261103100000_product_active_guard` (PR #1315, applied live 2026-11-02), whose trigger refuses any `is_active` change outside `set_product_active` with `PRODUCT_ACTIVE_RPC_REQUIRED`, so every turn-off passes the preview. Proven on the local test app: an admin's turn-off showed the "stock remains on hand" warning, and a direct admin `UPDATE` was refused.
12. **KI-87, a refused turn-off said "Product details changed"** — closed 2026-11-05: already fixed by PR #1321, which shows the database's blocker text. Proven on the local test app: a draft purchase order added after the review made Confirm show "purchase order TEST-KI87-PO" and reopen the review naming it.
13. **KI-88, Inventory loaded the whole catalog on mount** — closed 2026-11-05 by branch `claude/ki86-88-product-turnoff`: on mount the page reads only the ids of turned-off products (`select=id&is_active=eq.false`) for the Inactive label; the full catalog loads only when the Add Inventory or Create Hold picker opens. No migration. Proven on the local test app's network log (2,116 products: no catalog read until a picker opened) and by a component test.
14. **KI-05, RUP register rows for an unposted invoice** — closed 2026-11-05: `20261110140000_rup_records_require_posted_invoice` (PR #1513) applied live 2026-11-05 21:32:09 UTC (3:32 PM Central), ledger `20261105213209`. `generate_rup_sales_records` refuses an invoice that is not posted, paid or overdue (`RUP_INVOICE_NOT_POSTED`), and a trigger on `rup_sales_records` applies the same rule to a direct insert. Proven by the real-schema prover and, after the apply, the live smoke chain (`SMOKE_PASS_ROLLBACK`: a real draft invoice is refused, posting still writes one register row); live body, trigger and guard re-read after the apply.
15. **KI-89, inventory position used UTC dates** — closed 2026-11-08: already fixed by `20261204100000_ki18_batch1_chicago_today` (applied live 2026-11-06, ledger `20261107041703`), which re-emitted `_get_inventory_position_cost_impl_20261019` after WP-PM-3 with the Chicago date for season start and both hold-expiry checks. A read-only live query on 2026-11-08 found no `CURRENT_DATE` in that body or `get_inventory_position`, and the body's md5 (`6a74347a…`) is the one that migration's postflight expects. No new migration was needed.
16. **KI-90, reopen race through `set_product_active` had no automated proof** — closed 2026-11-08: `scripts/smoke/prove-product-retire-race-and-negative-stock-real-schema.mjs` replays every migration on `main` and races an order reopen against the real preview-and-confirm turn-off in both arrival orders on separate connections, with an observed row-lock wait. Reopen first: the stale preview's Confirm is refused (`PRODUCT_DEACTIVATION_BLOCKED`) and the product stays on. Turn-off first: the reopen is refused (`PRODUCT_INACTIVE`) and the order stays closed. Neither leaves an open order holding a turned-off product.
17. **KI-91, retired product with negative stock was checked by hand only** — closed 2026-11-08 by the same prover: a product at −2.5 on hand is turned off through `set_product_active` (one "stock" warning, no blocker), then stays in the inventory position report at −2.5, not flagged low, and in the admin cost report at −2.50 value; the same balance on an active product is flagged low.

Also closed inside the old file's own headings before this rewrite (no new proof needed, see archive): the
Deliveries list scheduled-delivery gap (PR #964), smoke chains rotted by the PO cost lock, the regular invoice
editor posting old amounts, the filed-season date-edit guard, the last commission-cohort migration
`20260914100900`, and the `customer-document-files` v2 redeploy.
