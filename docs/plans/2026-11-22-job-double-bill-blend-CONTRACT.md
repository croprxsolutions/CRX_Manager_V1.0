# A job is billed once, even when a blend ticket billed it first (#2063, #2061) — behavior contract

Read at `origin/staging` 2026-11-22 (after #2222). Status: **probe done, fix not built** (waits on the
spray-invoice quote-price PR for the transfer part; see Delivery).

## Facts

- F1. Probe `scripts/smoke/probe-job-double-bill-blend-real-schema.mjs` (Docker, all 338 post-baseline
  migrations, 2026-11-22):
  - C1 control: Transfer to Invoice on a job whose live blend ticket is invoiced → refused `BLEND_TICKET_ALREADY_BILLED`.
  - C2 (#2061): soft-deleting that ticket first → refused `BLEND_TICKET_SETTLED_LIFECYCLE_INVALID`, so the transfer never sees a deleted ticket.
  - C3 (#2063): field-app split save with `p_source_job_id` = that job → **accepted**; the job is billed a second time.
  - C4: a sales rep's direct soft-delete of a billed ticket → refused (same trigger).
- F2. #2063 cause: `_save_field_app_split_invoice_impl` (newest `20270129171000` ~L1426-1464) checks the
  job's own invoice and other split sets, never a blend-ticket invoice for the job. Transfer has that check
  (`20261120100000` ~L395).
- F3. #2061 is unreachable today: `enforce_linked_blend_ticket_header_lock()` (`20260714230100` ~L120)
  refuses `deleted_at` on any ticket with a live invoice (`invoices.blend_ticket_id`, not only `payment_status`),
  and `create_invoice_from_blend_ticket` bills only undeleted tickets. Transfer's `bt.deleted_at IS NULL`
  filter is therefore latent, not live.
- F4. Reverse order is guarded: `create_invoice_from_blend_ticket` (`20270129190000` ~L312-339) refuses when
  the job has a live invoice by `invoices.job_id` or `jobs.invoice_id`; the split save sets `jobs.invoice_id`
  to its anchor.
- F5. Transfer accepts REPEATABLE READ / SERIALIZABLE; the blend invoice refuses them (`20270129190000` ~L167).
  The app runs READ COMMITTED, so this only matters for other callers (#2061 point 2).
- F6. Live (read-only, 2026-11-22): 0 blend tickets, 0 live blend invoices, 0 jobs billed both ways.
- F7. The spray-invoice branch (`claude/spray-invoice-quote-price-c2a6fc`, not yet a PR) re-creates
  `_transfer_job_to_invoice_intent_impl_20260908`, not the split save.

## Established decisions

- One spray pass is billed once (U6 #91a/#91b guards; MASTER_FIX_PLAN item 5).
- Field-application billing and blend tickets are Mason's (memory note, Taha's ownership ends 2026-12-15). **But
  #2063's issue text says Taha agreed in Slack 2026-11-20 to fix it with #2058.** Ownership is to be confirmed
  before building (Open questions).

## Outcome

- The split save refuses a source job that a live blend-ticket invoice already billed, with the transfer's
  message (`BLEND_TICKET_ALREADY_BILLED`), deleted ticket or not.
- Transfer's check also counts a live invoice whose ticket is soft-deleted (drops the latent filter), and
  transfer refuses REPEATABLE READ / SERIALIZABLE like the blend invoice. **Built on top of the spray PR's
  transfer body**, after it lands.
- Voiding the blend invoice re-opens the job to either path (unchanged).

Smallest change: one migration re-creating `_save_field_app_split_invoice_impl` with one added check (and, after
the spray PR, a second migration or the same one re-creating the transfer impl). No screen change: both
screens already show the RPC's refusal through `sanitizeError`.

## State and failure

- Existing rows: none change (F6). Re-saving an existing split set whose job a blend invoice billed is refused
  from then on; live has none.
- Timing: both paths lock the job row first (`FOR UPDATE`); the blend invoice locks the job too, so under READ
  COMMITTED one waits and then sees the other's invoice. Proof case 4 covers the order.
- Rollout: the deployed app only calls the RPCs; no ordering.

## Proof cases (disposable Docker Postgres)

1. When a live blend invoice billed job J, a split save for J → refused `BLEND_TICKET_ALREADY_BILLED`, no invoice made (C3 flipped).
2. Same with the blend invoice voided → split save succeeds (genuine re-bill still works).
3. Split re-save of its own set unaffected when no blend invoice exists (existing split chains pass).
4. Blend invoice after a split save of J → refused `JOB_ALREADY_INVOICED` (reverse order, F4).
5. After the spray PR: transfer with a live invoice on a soft-deleted ticket (fixture with the trigger off) → refused; transfer in REPEATABLE READ → refused.
6. Existing chains: smoke-per-line-split-billing, smoke-field-invoice-loop, smoke-save-invoice-field-app, smoke-backfill-refuse-split-billing, blend-invoice chains, transfer chains.

## Open questions (for the captain / Mason)

1. Ownership of #2063: the issue says Taha (Slack 2026-11-20); this sprint assigns it to Lane A. Who builds it?
2. The split-save fix does not touch any function the spray PR changes (F7). Build it now, and leave only the
   transfer hardening until the spray PR lands?
