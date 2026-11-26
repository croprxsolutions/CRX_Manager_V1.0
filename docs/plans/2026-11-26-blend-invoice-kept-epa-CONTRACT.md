# Blend-ticket invoices use the job's kept EPA number: behavior contract

Read at `origin/staging` `d52780188` (2026-11-26). Source: Q1 of Taha's 26 Nov audit, "Should blend-ticket invoices
for a job also use the job's kept EPA number?" Mason, Slack 2026-11-26: "Yes, every invoice for a job should show the EPA
number that was actually sprayed, blend-ticket invoices included." Reuses the settled #2341 contract
(`docs/plans/2026-11-24-job-invoice-kept-epa-CONTRACT.md`); only what is new is below.

## Facts (with sources)

- Blend-ticket invoice: `create_invoice_from_blend_ticket`, newest body `20270129190000` (postflight md5
  `bb6bc77e136759aba8c592741160f35e`). Its two chemical-line inserts (the $0 "included in grower share" line and the
  priced line) send no `epa_registration`; `_fill_invoice_line_epa` (20261207113000, BEFORE INSERT OR UPDATE) then fills
  the catalog's current number.
- A blend invoice sets `blend_ticket_id`, never `job_id` (same file, invoice insert). The ticket's job is
  `blend_tickets.job_id`; `blend_ticket_billed_keeps_job_20270129` stops it changing while a live invoice points at the
  ticket. Billing locks the job `FOR UPDATE` when the ticket has one.
- `_capture_invoice_line_rup` (newest body `20270303100000`, md5 `263009a66a66952f30f9237d5dd3edc8`) finds a line's job
  only through `invoices.job_id`, so a blend line is always captured under the catalog's number.
- `_job_kept_epa(job, product)` (20270303100000): the kept number, else NULL (none kept, kept with no number, "Not
  recorded"). Kept rows are insert-only.
- The invoice PDF prints the line's own number (`invoicePdf.ts`); editor re-saves send it back unchanged.
- The parent EPA correction refuses while a size has open work (20270309140000): a scheduled or in-progress job, a
  completed job not yet billed, an unbilled or unrecorded ticket not covered by such a job, a draft or unposted
  invoice. So a corrected number reaches a blend invoice through, for example: bill and post, correct, void, re-bill;
  or the named gaps in `known-issues.d/2026-11-26-par1-epa-open-work-gaps.md`.
- Kept rows are written when a spray is saved or the job is finished (20261204120000), insert-only, first number wins,
  one per job and product.

## Outcome

An invoice made from a blend ticket carries, on each chemical line and its restricted-use capture/record, the number the
ticket's job kept for that product; when the job kept no number for it, or the ticket has no job, the catalog's number,
as today. Same rule as Create Invoice (#2341).

Smallest change, one migration `20270311140000_blend_invoice_kept_epa.sql`, no screen change:

1. `create_invoice_from_blend_ticket` re-emitted from 20270129190000; its two chemical inserts send
   `_job_kept_epa(v_ticket.job_id, v_btp.product_id)` (NULL → the line trigger fills the catalog's number as today).
2. `_capture_invoice_line_rup` re-emitted from 20270303100000; the job is `COALESCE(invoices.job_id, ticket's job_id)`.
   Unchanged: only a line whose own number equals the kept number takes it.

Who may bill, prices, costs, quantities, approvals, idempotency and the actor check are unchanged (the proof checks the
body is byte-identical apart from the two values). No caller sends an EPA number; the server derives it.

Not changed: Split Billing (#2457, Mason: non-issue); `_fill_invoice_line_epa` (a blank line added by hand keeps today's
number, as #2341 settled for Create Invoice, Sol r1); application records; printouts; existing rows.

## State and failure

- Existing rows: none change. Live, read-only 2026-11-26: 0 `job_product_epa` rows, 0 blend invoices whose ticket has
  a job, blend body = the pinned md5. The preflight stops while any live blend invoice (not voided, cancelled or
  deleted) bills a product its job kept a number for: there is then something a person must reconcile first, because a
  line, its capture and a hand-added line can each differ and no column says which wrote a line (Astra 1-5, 7-9).
- Timing: the file locks `jobs` IN EXCLUSIVE MODE (as #2341), so a bill holding a job finishes first and later bills
  wait. Residual (as #2341): a bill already inside the old body when the file runs finishes with the old body; apply
  outside office hours. Double click / retry: the existing idempotency key path, unchanged. A ticket billed before its
  job's first spray is saved bills under the catalog number; the correction refuses while that job is scheduled or in
  progress, so the spray then keeps that same number. A ticket billed after a spray is saved (job still in progress)
  takes the kept number.
- Undo: void is unchanged. A re-bill is a new lookup against the ticket's job and product at that time (the number that
  job sprayed). Restricted-use record voiding on unpost/void is unchanged (#2341).
- Rollout: database only; the deployed app sends and reads nothing new.
- Rollback: a reviewed migration, before any rollback of 20270303100000, pinning this file's bodies and re-emitting the
  two predecessors. A line written meanwhile and later re-saved re-captures under the old rule.

## Known limits (inherited from #2341, unchanged)

- A ticket line whose product id is not the one the job sprayed (another size, a substitute) finds no kept row and
  takes the catalog number: the settled "no kept number" fallback.
- One kept number per job and product (the first recorded).
- A line typed by hand with a third number keeps it on the line; its capture uses the catalog facts (#2341 Sol r1).
- No screen or RLS change: billing and capture run as SECURITY DEFINER; reps never read `job_product_epa`.

## Proof cases (`scripts/smoke/prove-blend-invoice-kept-epa-real-schema.mjs`, Docker, real migrated schema)

Spray recorded under the old number, catalog corrected, then the ticket billed as the signed-in admin:

- When a sprayed job's ticket is billed, then the line and capture show the kept number (before: the new one), for one
  grower and for two growers sharing the field.
- When the product's kept registration is restricted use and the corrected one is not, then the posted invoice makes a
  restricted-use record under the kept number (before: none).
- The $0 included-in-grower-share insert gets the same value, but cannot be reached: per-acre grower-share prices are
  refused since 20270224110000, so it has no proof case.
- When the job kept the product with no number, or is "Not recorded", or the ticket has no job, then the catalog number.
- When a line is added by hand afterwards, then it keeps today's number (as Create Invoice).
- When an invoice has no job or ticket, then it is captured exactly as before.
- When a live blend invoice already bills a product its job kept a number for, then the apply stops; invoices of a job
  that kept no number, or of a ticket with no job, do not stop it.
- Control: Create Invoice on a sprayed job still writes and captures the kept number through the changed capture.
- The new blend body equals the pinned body with only the two values removed (billing untouched).

## Challenge (Astra gpt-6.2-astra high, 2026-11-26): 45 findings, settled

- Fixed in the file: preflight now refuses any live blend invoice billing a kept product (1-5, 7-9, 15, 45);
  `_job_kept_epa` owner/ACL checked (42); residual in-flight race and rollback order stated (32, 39, 40).
- Fixed in this contract: kept rows also appear on spray save (10); correction guard described exactly (21); re-bill is
  a new lookup (36); known limits named (12, 13, 25).
- Added proof: two growers (30); Create Invoice control through the changed capture (31).
- Refuted with evidence: 11 (correction refuses while the job is scheduled/in progress, 20270309140000 L14); 14 (a kept
  row exists only if sprayed, which is the number to show); 16 (jobs.invoice_id is Create Invoice, already #2341; the
  sales-order path refuses blend billing); 41 (`LOCK TABLE` outside a transaction block errors, and the xid check is
  in the same file); 19, 43 (the real-schema prover runs triggers, posting and records end to end).
- Inherited from #2341, unchanged by this file (17, 18, 22-24, 26-29, 33-35, 37, 38): the capture rule, editor save,
  posting and voiding paths are not touched; their proofs stand in the #2341 prover.
- 6 (already-issued invoices): none exist (0 blend invoices with a job, live 2026-11-26); "existing rows: none
  change" stands. 20 (reachable workflow): the prover edits the catalog directly, as #2341's did; the bill-post-
  correct-void-re-bill path reaches the same database state.
- 44 declined: two calls of a STABLE helper keep the body diff to two values.

## Open business decisions

None (Mason answered Q1).
