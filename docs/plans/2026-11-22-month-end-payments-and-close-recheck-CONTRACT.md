# Behavior contract: Month-End payments received (KI-129 / #2195) + close re-check (#2175)

Read at `origin/staging` def05e704 (branch `claude/lane-b-2195`, cut 2026-11-22). One PR: DECISION_LOG 2026-11-21 ("month close keeps
saving the figures current at the click") says the payments-received follow-up must include the close re-check.

## Facts (source)

- `get_monthly_summary` (newest body `20270206110000_pnl_commission_share_billed.sql` §2) totals `payments` (legacy table;
  0 rows live) and the close impl `_close_accounting_period_replay_impl_20261015` (same file §4) sums `payments` with **no
  `deleted_at` filter**. Live (read-only, 2026-11-22): 0 legacy payments, 1 active `allocation_sets` row of
  `entity_type='payment'`, 1 `prepay_credits` row (`overpayment`, made by that payment), 0 prepay checks.
- Record Payment = `allocate_payment`: one `allocation_sets` row, `entity_type='payment'`, `total_payment_cents` = the check,
  `payment_date` always set (defaults to Chicago today, `check_period_open` under the month lock). Any part not applied to
  invoices becomes a `prepay_credits` row `source_type='overpayment'` with `allocation_set_id` = that set.
- Void = `void_payment`: sets `allocation_sets.is_active=false` (row kept).
- Prepayment check = `create_prepay_check_splits`: one or more `prepay_credits` rows `source_type='check'`, no allocation set,
  no date column but `created_at` (all splits of one check share `created_at`, `customer_id`, `reference_number`).
  `edit_prepay_credit` rewrites `original_amount_cents` (= new balance + applied); `delete_prepay_credit` sets
  `original_amount_cents` = amount already applied (0 if none). Neither takes the month lock.
- Statement (`20261103120000` §statement) already uses allocation sets (`is_active`, `entity_type='payment'`) + live legacy rows.
- Screen `src/pages/MonthEndClose.tsx`: shows `get_monthly_summary`; payments and commissions need a "reviewed" tick (screen
  only); `close_accounting_period(p_period_end, p_performed_by, p_idempotency_key)` saves its own receipt figures.

## Outcome and authority

1. **Payments received** (summary `payments.count/total_cents` and receipt `payments_received_cents`) = one helper
   `_month_payments_received_20270208(start, end)`:
   - active `allocation_sets` `entity_type='payment'`, `COALESCE(payment_date, Chicago created_at date)` in the month:
     `total_payment_cents` (the whole check, including any overpayment part);
   - prepayment checks: `prepay_credits.source_type='check'`, Chicago `created_at` date in the month, current
     `original_amount_cents` > 0; one check = distinct (customer, created_at): every split of one check is written by one call, so shares `created_at` (transaction time); the reference is left out because an edit can change it on one split;
   - legacy `payments` with `deleted_at IS NULL`, `payment_date` in the month (unchanged rounding).
   Overpayment prepay credits are NOT added again (already inside their payment). Credit memos, prepay applications and
   write-offs are not money received.
2. **Close re-check**: `get_monthly_summary` adds `review_token` = md5 of every period figure it shows except today's AR,
   plus the figures the close receipt saves. `close_accounting_period` gains `p_reviewed_token text`,
   `p_payments_reviewed boolean`, `p_commissions_reviewed boolean`. Under the month lock it recomputes the same figures once
   and **refuses** (`CLOSE_FIGURES_CHANGED`) when the token differs or is missing; refuses (`CLOSE_REVIEW_REQUIRED`) when
   payments exist and `p_payments_reviewed` is not true, or commission is non-zero and `p_commissions_reviewed` is not true.
   The receipt is built from that same computed set, so what was compared is what is saved. The screen, on that refusal,
   reloads the figures, clears the ticks, and says the figures changed.
3. Who may act: unchanged (active admin for summary and close; wrapper + impl both check). New helpers: no grants to
   `anon`/`authenticated`/`PUBLIC` (SECURITY DEFINER callers only). Screen values: period end and token are compared, never
   trusted for figures; actor is `auth.uid()`.
4. Files: new migration `supabase/migrations/20270208140000_month_close_payments_received_recheck.sql` + record + changelog,
   `src/pages/MonthEndClose.tsx` (+ test), prover `scripts/smoke/prove-month-close-payments-recheck-real-schema.mjs`,
   contract tests that pin the close signature, KI/plan docs.

## State and failure

- No automatic record changes. Close still writes only `accounting_periods` + the replay receipt.
- Signature change: the 3-argument `close_accounting_period` and its impl are dropped and recreated with the 3 new
  defaulted arguments (no overload left). The already-deployed screen calls with 3 arguments → gets `CLOSE_FIGURES_CHANGED`
  (token missing) until the new screen deploys; month close is a once-a-month admin action, so this short window is
  accepted (stated in the PR).
- Replay: a retry with the same key returns the saved receipt without re-checking (the fingerprint stays actor + period
  end), so a timed-out successful close still replays even if figures moved after it.
- Timing: double click / retry → same key → replay. Two admins → month lock + "already closed". Figures edited between
  page load and click → refused, screen reloads. Edit racing the close itself → impl computes once, compares and saves
  that one set (READ COMMITTED within one statement).
- Existing rows: legacy deleted payments stop counting (live: none). Saved receipts are never rewritten.
- Undo: reopen unchanged.

## Delivery

One PR: `close_accounting_period` and `get_monthly_summary` are already live (the name stays), so CI's live-function list
passes before the apply; split not needed (memory rule exception for already-live functions).

## Proof cases (real migrated DB, disposable container, rolled back)

1. Month with one active allocation-set payment ($1,500.00, $300 of it overpayment), one voided set, one deleted legacy
   payment, one live legacy payment ($50.00), one prepayment check split in two buckets ($200 + $100), one deleted prepay
   check (nothing applied), one overpayment credit → summary payments = 3 payments, $1,850.00; before the migration it
   showed the legacy total only.
2. Close with the token from the summary + both ticks → closes; receipt `payments_received_cents` = 185000.
3. Change one figure (edit the prepay check) after reading the token → close refused `CLOSE_FIGURES_CHANGED`, period stays open.
4. Missing token (old 3-argument call) → refused.
5. Payments present, `p_payments_reviewed` false → `CLOSE_REVIEW_REQUIRED`; commission non-zero and not ticked → same.
6. Retry with the same key after a successful close, after a figure changed → same receipt replayed.
7. Sales rep → refused for both; anon cannot execute; helpers have no `authenticated` grant.
8. Browser (local app against the local/staging DB, never production): summary shows the allocation-set payment; a stale
   close shows the "figures changed" message and reloads.

## Open business decisions

1. **Prepayment checks in "payments received"** (DECISION_LOG 2026-11-21 asked for a rule). Options: (a) count each
   prepayment check in the month it was entered, at its current amount (an edit or delete later changes that month's
   screen figure, never a saved close receipt); (b) leave prepayment checks out (only Record Payment money counts).
   **DECIDED (Mason, 2026-11-22): (a)**, "yes should count as payment received" (DECISION_LOG 2026-11-22).

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-22, 56 findings) and how each settled

- **Corrected:** prepay-check grouping drops the reference (#2; an edit to one split's reference would make two payments);
  the screen enables Close only with a review token for the selected month and tells "figures changed" apart from
  "confirm a tick" and "reload, the app was updated" (#22, #23, #46); the token includes the period start and end, so a
  token for another month or a partial range never passes (#27); proof adds splits written by the real
  `create_prepay_check_splits` sharing `created_at` (#4), a partial delete, an edit, a voided payment, a null payment date
  near Chicago midnight, a today's-AR-only change that must not block the close, an inactive admin, and the replay after
  a refused stale close (#6, #13, #28, #29, #42, #43).
- **Disproved:** #8 (a later void rewrites a closed month): `_void_payment_replay_impl_20261015` calls
  `check_period_open(payment_date)` (`20261204100000` line ~994), so a closed month's payment cannot be voided.
  #9 legacy rounding: `payments.payment_date` is `date`; per-row rounding (the summary's) is kept; live has 0 rows.
  #10–#12 legacy/historical shapes: live read-only 2026-11-22: 0 legacy payments, 1 allocation set (dated), 1
  overpayment credit linked to it, 0 prepay checks. #36 one snapshot: the impl reads the figures once into one value and
  builds both the comparison and the receipt from it. #38 precedence: "already closed" is checked before the review checks.
  #30: helpers are granted only to service_role (as the KI-125 helpers), the impl to nobody; the prover checks the ACLs.
  #47: the new screen on an old database cannot close (no token in the old summary → Close stays disabled).
- **Re-labelled DECISION (to Mason, one question):** #1, #5, #6, #7 — whether prepayment checks count, at their current
  amount, in the month entered.
- **Declined / follow-ups (not this fix; each predates it):** #16–#19 the deliveries and needs-pricing checklist items are
  screen-only (a server rule for them is a new business rule); #20–#21 the receipt keeps its own invoice/order/delivery
  bases (now covered by the token, so a change to them still refuses); #24–#26 the review is of displayed totals, with the
  same predicates on both sides; #34/#37 a prepay check edited after the close changes the month's screen figure, not the
  saved receipt (same as every other figure today, DECISION_LOG 2026-11-21); #39–#41 replay after a reopen is unchanged
  behavior; #50 true two-session races: the month lock already serializes every month-dated writer
  (`check_period_open`); prepay edits are not month-dated. #54/#55 smaller designs: the shipped design already uses one
  private figures function for summary and close; the audit-log-based prepay count needs its own historical proof and is
  not smaller.
