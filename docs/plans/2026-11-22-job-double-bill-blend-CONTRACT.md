# A job is billed once, even when a blend ticket billed it first (#2063, #2061) — behavior contract

Read at `origin/staging` a77855293 (2026-11-22). Status: **settled for the split-save fix (#2063)**; the transfer
hardening (#2061) is a later follow-up, built on the spray-invoice quote-price PR's transfer body after it lands.
Migration: `supabase/migrations/20270220100000_split_save_refuses_blend_billed_job.sql`. Prover:
`scripts/smoke/prove-split-save-refuses-blend-billed-job-real-schema.mjs`.

## Facts

- F1. Probe `scripts/smoke/probe-job-double-bill-blend-real-schema.mjs` (Docker, staging head):
  C1 transfer on a job whose live blend ticket is invoiced → refused `BLEND_TICKET_ALREADY_BILLED`; C2 soft-deleting
  that ticket → refused by the header-lock trigger; **C3 field-app split save for that job → accepted (the bug)**;
  C4 a rep's direct soft-delete of a billed ticket → refused.
- F2. Cause: `_save_field_app_split_invoice_impl` (newest body `20270129171000` L1054-2399, guard L1419-1464)
  checks other split sets and the job's own invoice pointer, never an invoice on a blend ticket of the job.
- F3. #2061 is unreachable today: trigger `trg_linked_blend_ticket_header_lock` on `blend_tickets` (live: attached,
  enabled `O`, 2026-11-22) refuses `deleted_at` on a ticket with a live invoice.
- F4. Reverse order is guarded: `create_invoice_from_blend_ticket` (`20270129190000` L312-339) refuses when any live
  invoice has `invoices.job_id` = the job, or the job's `invoice_id` is live, or another ticket of the job is billed.
  **Every split child carries `job_id = source job`** (`20270129171000` split body L1985-1996 insert, L2012 update),
  so a live sibling still blocks blend after its anchor is voided (Astra #4/#5).
- F5. Isolation: blend refuses anything but READ COMMITTED; split and transfer do not today.
- F6. Live, read-only as `postgres` (sees every row; RLS not forced on `invoices`/`blend_tickets`), 2026-11-22:
  0 blend tickets, 0 invoices with `blend_ticket_id`, 0 split billing sets, 0 jobs not `invoiced` that have a live
  invoice by backlink or pointer, 0 invoices with NULL status (`invoices.status` is NOT NULL). Split flag is on.
  Live split body md5 `d72ff5547170c6a4a90bce083b6d7084` (= `20270129171000` postflight); owner `postgres`.
  Indexes exist: `idx_blend_tickets_job (job_id)`, `idx_invoices_blend_ticket_id (blend_ticket_id)`.
- F7. No open PR or the spray branch re-creates the split impl (checked 2026-11-22: #2239, #2019, #2170, spray
  branch). The md5 preflight refuses the apply if anything changed it first.
- F8. Split wrapper `save_field_app_split_invoice` (`20260720233000` L1664) returns an idempotent replay before
  calling the impl; the impl only runs for new work.

## Established decisions

- One spray pass is billed once (U6 #91a/#91b guards; MASTER_FIX_PLAN item 5).
- Owner: Lane A builds #2063 (Mason, Lane A session 2026-11-22: "send our plan to astra to review and then spin
  fresh session to build it"); this supersedes the issue note naming Taha. Split fix ships first; transfer hardening
  waits for the spray PR (bug captain, 2026-11-22).

## Outcome (this PR)

- A split save that names a source job is refused with `BLEND_TICKET_ALREADY_BILLED` when any invoice that is not
  deleted and not voided/cancelled belongs to any blend ticket of that job, **deleted ticket or not** — the same
  "live bill" rule `create_invoice_from_blend_ticket` already uses for the other direction. The message carries no
  ticket number (user-typed text; Sol round 3) and names only the invoice numbers the caller may already read under
  `invoices_select` (admin, creator or salesman; Sol round 1, so a rep never learns a hidden invoice's number), and
  says to ask an admin to void or delete that blend-ticket invoice first (voiding is admin-only). The whole save rolls back (new set row, re-save clearing).
- A split save that names a source job is refused under REPEATABLE READ or SERIALIZABLE
  (`SPLIT_INVOICE_NEEDS_READ_COMMITTED`), as blend already is; PostgreSQL runs READ UNCOMMITTED as READ COMMITTED, so
  both pass. Replays (F8) and jobless splits are unaffected.
- Voiding (or cancelling/deleting) the blend invoice releases the job to the split save again.
- Nothing else changes: same signature, owner, grants, definer mode, search_path; no screen change (the split editor
  shows RPC refusals through `sanitizeError`; proof case 9).

Error precedence: the existing actor/role checks run first (an unauthorized caller learns nothing); then the
isolation check; then the existing validation and set checks; the new blend check runs right after the existing
"already invoiced" check, under the job lock. The exact-message guarantee is for an otherwise valid, authorized,
non-replay request.

## State, timing, rollout

- Existing rows: none change; live has no blend tickets and no split sets (F6), so no existing duplicate to reconcile.
- Timing: the check runs after `SELECT … FROM jobs … FOR UPDATE`, the same job lock blend takes before its check.
  Under READ COMMITTED the waiter's next statement sees the winner's committed invoice. Lock ORDER is not the same in
  both paths (split: set group → children → job → quotes; blend: ticket → quotes → job); that pre-existing order can
  in a rare interleaving end in a Postgres deadlock error that rolls one save back — never a double bill. This PR
  adds no lock. Deferred: unify order (follow-up).
- Rollout: one migration, md5 preflight on the live body, postflight md5 on the new body. Pre-apply and post-apply
  read-only check (text in the migrations.d record; live 2026-11-22: 0): count jobs billed both by a live blend invoice and a live split/transfer
  invoice — expected 0.
- Rollback: a reviewed migration re-emitting the `20270129171000` body (md5 `d72ff554…`); it touches no transfer or
  spray code, so it cannot erase the pricing change.

## Proof cases (disposable Docker Postgres, post-baseline migrations; blend invoices for B1 and M3a created through
`create_invoice_from_blend_ticket` with triggers on. Two fixtures are inserted with triggers off and are states the
app does not make today: the L4 invoice on a soft-deleted ticket, and a second live invoice on M3a made by the second
rep (standing in for a two-payer blend bill). The replay skips the few migrations the harness cannot run (storage and
staff-photo policies; named in the prover), so a pass shows the split refusal on this schema, not every live trigger.)

1. BEFORE: split save for job J billed by a live blend invoice → accepted (the bug, asserted).
2. Candidate applies; a second apply is refused by the preflight.
3. AFTER: same split save → refused `BLEND_TICKET_ALREADY_BILLED` (no ticket number); no set row, no invoice, job
   unchanged, no idempotency receipt; as an admin (sees the invoice number) and as a second sales rep who cannot read
   the blend invoice (sees "an invoice you cannot open": neither its number nor a count).
4. Void the blend invoice (`void_invoice`) → the split save for J succeeds (genuine re-bill).
5. Negative controls: job J2 with the same customer, field type and date, its ticket unbilled → split succeeds;
   J3 with one billed and one unbilled ticket → refused; a jobless split → succeeds (documented limit, Q3).
6. Legacy fixture (triggers off): a live invoice on a soft-deleted ticket of J4 → split refused.
7. Re-save rollback: a split set on J5 whose children were voided, then J5 blend-billed → re-save refused; the set's
   invoices, items, billing lines, locations and the job row are byte-identical before and after.
8. Races (two real connections): blend holds J6's lock uncommitted, split waits, blend commits → split refused;
   split holds J7 uncommitted, blend waits, split commits → blend refused `JOB_ALREADY_INVOICED`; blend holds J8 then
   rolls back → split succeeds. Split in REPEATABLE READ and SERIALIZABLE → refused; jobless split in REPEATABLE READ
   → unaffected.
9. Reverse with a live sibling: a two-customer split on J9, void the anchor child only → blend refused
   `JOB_ALREADY_INVOICED` (F4).
10. Existing chains pass before and after: smoke-per-line-split-billing, smoke-field-invoice-loop,
    smoke-backfill-refuse-split-billing, smoke-split-invoice-cross-customer-lineage,
    smoke-order-invoice-refuses-field-split, smoke-transfer-invoice-to-job, smoke-transfer_job_invoice_column_fixes,
    smoke-transfer_job_invoice_machine_fee. Already stale on today's schema (each fails in its own setup, before any
    split or blend-invoice step: pricing source, `gal/acre` rate unit, product form, missing fixtures), so the prover
    checks only that their outcome is the same before and after: smoke-save-invoice-field-app,
    smoke-field-app-split-penny-exact, smoke-blend-ticket-pricing-guards, smoke-gauntlet-core-blend-guards,
    smoke-blend-invoice-approval-binding, smoke-blend-invoice-binding-lows, smoke-blend_invoice_app_service_guard. The
    blend-ticket invoice itself is exercised by the prover's own fixtures (cases 1, 7, 8, 9).

## Astra challenge (2026-11-22, 46 findings) — disposition

| # | Disposition |
|---|---|
| 1, 45 | Fixed: the Outcome; proof 1/3. 45's isolation + "before destructive work" part: isolation adopted; the check stays after the existing job lock (moving the lock would change lock order, #15) and rollback is proven (proof 7). |
| 2 | Disproved: `invoices.status` is NOT NULL live (F6); the new check uses blend's `COALESCE(status,'')` form anyway. |
| 3 | DECISION Q1: Mason accepted 2026-11-22 (the existing rule both other paths use). |
| 4, 5 | Disproved by code: every split child carries `job_id` (F4), and blend checks any live `invoices.job_id`; proof 9. |
| 6 | Disproved for live data (F6: 0 such jobs) and pre-existing, unchanged by this PR; deferred to the transfer follow-up, which aligns the "live invoice" evidence across paths. |
| 7 | Pre-existing, unchanged (stranded pre-U6 jobs); deferred to the transfer follow-up. |
| 8 | DECISION Q4: Mason 2026-11-22, leave as is (pre-existing, unchanged). |
| 9 | DECISION Q3: Mason accepted 2026-11-22; the guarantee covers bills tied to the same job. |
| 10 | Corrected: one billing operation = one split set (any number of children) or one blend invoice or one transfer invoice; a live child keeps its operation active (F4). |
| 11 | Evidence: a billed ticket cannot change job or be soft-deleted (trigger, F3); invoices have no restore/unvoid function (grep `unvoid|restore_invoice|undelete_invoice`: none). Physical ticket delete with any invoice is blocked by live FK `invoices_blend_ticket_id_fkey` (NO ACTION, read 2026-11-22). Proof 6 covers the legacy deleted-ticket state. |
| 12 | Fixed: split with a source job refuses non-READ COMMITTED; proof 8. |
| 13 | Corrected (State, timing). |
| 14, 15 | Pre-existing lock order, unchanged (this PR adds no lock); worst case is a deadlock error that rolls one save back. Deferred: lock-order follow-up. |
| 16 | Fixed: proof 8 uses two connections, both orders, and a rollback. Transfer pairs go to the transfer follow-up. |
| 17 | Evidence: no restore/unvoid path exists (row 11). Void-then-rebill race: void takes the invoice row; the re-bill's job lock + fresh READ COMMITTED read sees the committed void or not; either result leaves at most one live operation. Proof 4 covers the sequential release. |
| 18 | Pre-existing, unchanged; out of scope. |
| 19 | Decided: isolation refusal only when a source job is named; a replay (F8) returns its stored result regardless (no new charge). Both REPEATABLE READ and SERIALIZABLE tested (proof 8). |
| 20, 21 | Unchanged by this PR: the wrapper's key store binds the request hash (F8); a refused save stores no receipt (proof 3). Transfer receipts: transfer follow-up. |
| 22 | Scope: the split path only (the one demonstrated hole, C3). Transfer and blend already carry the guard (F1, F4). A sweep of any other writer that could bill a job (order-linked route, generic invoice save) belongs to the transfer follow-up. |
| 23 | Evidence: impl is `SECURITY DEFINER` owned by `postgres`, RLS not forced (F6), so the check sees every row; proof 3 runs as a second rep. Actor/role checks precede it. |
| 24 | Evidence: the split editor sends `p_source_job_id: sourceJobId || null` and re-loads it from the saved set (`src/pages/FieldAppSplitInvoiceEditor.tsx` L387, L717, L840-859); a re-save of a sourced set with null is refused by `SPLIT_JOB_IMMUTABLE`. A jobless split is the Q3 limit. |
| 25 | Evidence: the split editor shows save errors through `splitBackendError` → `sanitizeError` (`FieldAppSplitInvoiceEditor.tsx` L166-176) in an error toast without navigating; a throwaway vitest run (2026-11-22) showed `sanitizeError` passes both new messages through whole (token prefix included, as Transfer's `BLEND_TICKET_ALREADY_BILLED` shows today). No screen change. A browser check needs a staging blend ticket; not run (named in the PR). |
| 26 | Blend wording is the blend function's; deferred to the transfer follow-up. The new split message names the specific ticket and invoice. |
| 27 | DECISION Q2: Mason accepted 2026-11-22 (message names ticket and invoice; void it or ask an admin). |
| 28 | Decided: see Error precedence. |
| 29, 42 | No duplicate can exist live (F6: 0 blend tickets). Pre/post-apply read-only reconciliation query is in the migrations.d record (live 2026-11-22: 0). |
| 30 | Proof 4 (real `void_invoice`) and proof 9 (one sibling voided, other live). |
| 31 | The legacy deleted-ticket state is unreachable (F3); its recovery belongs to the transfer follow-up. |
| 32, 33, 34 | Fixed: the new prover asserts every outcome and committed state; blend invoices come from the RPC; the legacy state is the only triggers-off fixture and is exercised against split. Transfer on it: transfer follow-up. |
| 35 | Fixed: proof 7 compares contents. |
| 36 | Fixed: proof 5. |
| 37 | Fixed: F6 lists queries' scope and role. |
| 38 | Fixed: F3/F6 live trigger binding, body md5, owner, indexes. |
| 39 | Stamp `20270220100000` sorts after every split-impl definition; F7; preflight md5. |
| 40 | Settled (Established decisions). |
| 41 | Transfer isolation is out of this PR (transfer follow-up). |
| 43 | Rollback (State, timing). |
| 44 | Indexed lookups (F6); one join under the job lock. |
| 46 | Transfer half: the transfer follow-up. Reverse half: disproved by F4/proof 9. |

## Questions for Mason — ANSWERED 2026-11-22 (Lane A session: "Yes, accept all four"; bug-captain session: "Accept all four (Recommended)")

All four recommendations below are Mason's decisions as of 2026-11-22 and are what the migration builds.

1. Q1 (#3): a blend-ticket bill counts as "billed" from the moment it exists (draft included) until it is voided,
   cancelled or deleted. Recommendation: yes — Transfer and the blend screen already use this rule.
2. Q2 (#27): who resolves a refusal. Recommendation: the message names the blend ticket and invoice number and says
   "void that invoice first if you meant to bill the job here, or ask an admin if it is not yours".
3. Q3 (#9): the guard only catches two bills tied to the same job; a bill typed without picking the job is not
   caught. Recommendation: accept.
4. Q4 (#8): an emptied split set still holds its job (pre-existing). Recommendation: leave as is; not this fix.

## Deferred (transfer follow-up, after the spray PR lands)

Transfer drops its latent deleted-ticket filter and refuses non-READ COMMITTED (#2061); align "live invoice" evidence
(#6/#7); blend's wording (#26); transfer races and receipts (#16/#20/#21); lock-order unification (#14/#15).

Sol round 2 HIGH (Mason, 2026-11-22, bug-captain session: "Ship with today's rule"): the general invoice save accepts a
blend-ticket link from its caller, so a hand-made draft can wrongly hold a job (never a double bill). This PR keeps
the live-bill rule Transfer and the blend invoice use; #2254 (owner Taha) closes the link in the general save.
