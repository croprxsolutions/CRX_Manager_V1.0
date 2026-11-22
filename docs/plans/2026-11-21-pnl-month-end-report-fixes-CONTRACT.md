# Behavior contract: P&L and Month-End Close report fixes (KI-125, KI-126, KI-129, KI-130)

Read at `origin/staging` `dab22364c` (2026-11-21). Live bodies of `get_monthly_summary`, `_get_bottom_line_pnl_cost_impl_20261019`
and `_close_accounting_period_replay_impl_20261015` match the newest migrations that define them
(`20270109100400_sales_tax_not_revenue.sql`; the close impl was renamed in `20261102180000_bind_money_replay_receipts_batch4a.sql`, body read live).

## 1. Outcome and authority

**Business result.** The two profit reports (Reports › Bottom Line P&L, Month-End Close summary) subtract a commission only for the
share of its sale billed in CRX in that period; fee lines' cost is not multiplied by acres twice; the close receipt counts every invoice that was posted (payments received:
moved to a follow-up after Sol round 3, see the settlement below); the AR line on Month-End Close says it is today's AR.

**Smallest change.** One new migration re-emitting three report functions plus two internal read-only helpers; one label on
`src/pages/MonthEndClose.tsx`. No table, lock, queue or flag. No invoice, billing, commission or payment writer changes.

Files: `supabase/migrations/<new>_pnl_commission_share_billed.sql`, `docs/reference/migrations.d/<same>.md`,
`docs/changelog.d/2026-11-21-pnl-commission-share-billed.md`, `src/pages/MonthEndClose.tsx` (+ its test), `KNOWN_ISSUES.md`, a smoke prover.
Sol-listed (database + money).

**Authority (unchanged).** `get_bottom_line_pnl` (SECDEF, `require_admin()`) → `_get_bottom_line_pnl_cost_impl_20261019` (invoker).
`get_monthly_summary` (SECDEF, `require_admin()`). `close_accounting_period` wrapper → impl (SECDEF, active admin). New helpers are
`STABLE`, `SET search_path = public, pg_temp`, REVOKE from PUBLIC/anon/authenticated, GRANT service_role only (same pattern as
`_invoice_sales_tax_cents_20270109`). The screen sends only dates.

## Facts (sources)

- F1 Revenue set = invoices `posted/overdue/paid`, not deleted, by `invoice_date`, total minus sales tax (`20270109100400`).
- F2 Commissions today: every commission with `order_date` in range, unless cancelled AND replaced. Order commissions have
  `order_id`, no `invoice_id`; application commissions have `job_id` + `invoice_id` (`20260707060000_u8`, `20260914100500`).
- F3 `orders.total_price` = sum of its `order_items.total_price` on all 61 live orders (no tax, no freight).
- F4 Invoice product lines have `charge_type IS NULL`; freight/fee/service/other/standing_discount/sales_tax are charge lines (CHECK on `invoice_items`).
  Legacy product lines may lack `order_item_id` (live: the one commissioned+posted order, 2 invoices summing exactly to the booked total).
- F5 Return credits (`credit_memo`) carry `order_id` and never touch commissions (`_issue_return_credit_header_only_impl_20260825`). Live: 0 credit memos.
- F6 Bill split: one order may have several payer invoices; their product lines sum to the order.
- F7 Live: 37 counted commissions on 35 orders; 1 order has recognized invoices; 0 job commissions; 0 deleted commissions.
- F8 `payments` has 0 rows; payments live in `allocation_sets` (`entity_type='payment'`, `is_active`, `total_payment_cents`,
  `payment_date` nullable → statement falls back to Chicago `created_at`). Live: 1 active set (July 2026).
- F9 Fee lines store cost already extended by acres (`is_application_fee`, quantity = acres); `save_invoice` totals and the
  below-cost trigger already use `CASE WHEN is_application_fee THEN cost_cents ELSE round(cost_cents*quantity)`.
  Live: every application service costs $0 (latent).

Decisions: DECISION_LOG 2026-11-10 "Only CRX-billed"; 2026-11-13 "Split by share billed".

## Rules

R1 (KI-125) Commission counted in [start,end] = sum over counted commissions (existing cancelled/replaced filter) of
whole-cent `round(commission_cents × share)`:
- Application commission (`invoice_id` set): share 1 if that invoice is recognized with `invoice_date` in the period, else 0.
- Order commission: `B` = order booked cents (`round(total_price*100)`); `billed(d)` = product-line cents (`charge_type IS NULL`)
  (not application-fee lines, a product on the line) on the order's recognized `chemical_sale` or `misc_charge` invoices dated ≤ d, floored at 0.
  cumulative(d) = `round(commission_cents × LEAST(billed(d), B) / B)`; the period's figure is cumulative(end) −
  cumulative(start−1), so per-period rounding can never add up to more or less than the commission. When `B ≤ 0` the
  share is 1 once anything is billed (live: 3 such commissions, all $0). Clamping at B means billing over the booked
  total never counts more than 100%, and a later period's billing never changes an earlier period's figure.
- Deleted commissions are skipped; a cancelled commission is skipped when any replacement exists, deleted or not (the old report's rule, restored after Sol round 6).
- A return credit takes back the matching share of commission in its month (decided 2026-08-09, reaffirmed 2026-11-13) — DEFERRED to KI-184 by Mason 2026-11-21 after Sol round 5; this PR takes nothing back.
- Commission dates no longer matter; only the invoice dates do.
R2 (KI-126) COGS per line: `CASE WHEN is_application_fee THEN cost_cents ELSE round(cost_cents*quantity) END` in both reports.
R3 (KI-129; WITHDRAWN from this change after Sol round 3, kept as the starting point for the follow-up) Payments received in [start,end] = legacy `payments` (not deleted, `payment_date`) UNION ALL active payment
`allocation_sets` (`COALESCE(payment_date, Chicago date of this version's created_at, as the customer statement dates it)`, `total_payment_cents`); count and cents. Used by Month-End
Close and the close receipt. Close receipt counts and sums invoices `posted/overdue/paid` (still including tax: "total invoiced").
R4 (KI-130) Month-End Close label "AR Balance" → "Current AR (today)". Number unchanged.
"Commissions Earned" → "Commissions on Sales Billed" (the figure now follows billing, not booking).

## State and failure

Read-only reports: no writes, no idempotency change; the close impl's writes, locks, checks and replay are re-emitted byte-for-byte
except the summary object. A summary already saved for an idempotency key replays its old figures (expected). Old app keeps
working: same keys and shapes. Rollback: a migration restoring the three previous bodies (pinned by md5 in the preflight).

## Delivery

One DB PR into `staging` (the label change works against old and new DB). Sol before PR.

## Proof cases (local migrated DB, synthetic data, rolled back)

P1 Order booked $1,000, commission $100, nothing billed → P&L commissions $0 for every period (was $100).
P2 Same order billed $250 in Dec, $750 in Jan → Dec $25, Jan $75, full range $100.
P3 Billed $1,100 (price raised at invoicing) in one month → $100, never more; billed $600 Dec + $600 Jan → Dec $60, Jan $40.
P4 Freight/discount/tax lines do not change the share; standing discount does not reduce it.
P5 Bill split 50/50 two payer invoices same month → $100.
P6 Voided or draft invoice → no commission; a posted then paid/overdue invoice still counts.
P7 Application commission with its invoice posted in Mar → full in Mar only; invoice unposted → 0.
P8 Half the order returned (credit memo) → no commission taken back yet (KI-184; Mason 2026-11-21, Sol round 5).
P9 Fee line 100 ac × $2 cost → COGS $200 in both reports (was $20,000).
P10 Close receipt counts a since-paid or overdue invoice. (Payments received: moved to a follow-up after Sol round 3.)
P11 Rep calling either report or the close → refused (unchanged).
P12 Live read-only before/after: run the new helper's query read-only against live and compare 2026 P&L commission and Net Profit.

## Open business decisions

Q1 (WITHDRAWN: already decided 2026-08-09, returns claw back proportionally; Sol round 4) A customer returns product and gets a credit: should the P&L take back that share of the rep's commission?
- No (recommended): commission rows are not changed by returns and the rep is still paid, so the P&L keeps the expense. Revenue drops by the credit.
- Yes: the P&L shows the commission as if reduced, but the Commissions page still owes the full amount; the two disagree.

Q2 (found in the Astra challenge) An order is billed for less than it was booked and never billed further: the P&L keeps
only the billed share of its commission (e.g. booked $1,000, billed $800 → 80%), though the rep may be paid in full.
Built as the dollar share (Mason's 2026-11-13 "split by share billed"); a short-billed order's remaining share appears
if more is billed later.

## Cold challenge (Astra, gpt-6.2-astra high, 2026-11-21) settlement

50 findings. Fixed: per-period rounding (now cumulative), negative billing (floored at 0), B ≤ 0 (counts once billed),
only `chemical_sale` invoices, fee lines excluded from billed product, deleted commissions and deleted replacements,
null payment date uses the first version's date, Month-End labels. Refuted with live evidence 2026-11-21: legacy lines
without `order_item_id` still count (header `invoices.order_id` join); the return-credit COGS branch is kept; the close
body is the live body (md5 pinned); nothing writes legacy `payments` (no double count); no live payment set has a null
date; no commission has both `order_id` and `invoice_id`; no non-chemical invoice has an `order_id`. Accepted as
pre-existing: reports restate past months as billing arrives (revenue already does); `paid_count` still by order date;
Month-End has no net-profit line; voided-payment handling follows `is_active`.

## Live before/after (read-only, inlined helper logic, 2026-11-21)

Checked read-only 2026-11-21; figures are admin-only and not recorded in this public repo. Fee COGS change: none live (latent).

## Luna round 1 (gpt-6-luna xhigh, head 5beb7a77e) settlement

Fixed: the prover's missing refusal helper; legacy payment dollars are rounded to cents before the cast; the share
helper's comment now says a $0-booked order counts once its billed product total is above $0 (by design: a net
credit bills nothing). Deferred (pre-existing, named): Month-End's "N paid" still counts commissions by order date while
the dollar figure follows billing; moving it needs a rule for a partly billed, fully paid commission (follow-up). Fixed in Sol round 1: paid commissions with a nonzero amount in the period.

## Sol round 1 (gpt-6.2-sol high, base 3e5954f86) settlement

Fixed: a later downward adjustment made a period negative (billed now uses the highest cumulative amount so far, so a
period is never negative and the total never passes 100%); a nonzero commission of either sign needs the reviewed
checkbox; the screen keeps "Commissions Earned" until the database returns `commissions.basis = 'billed_share'`
(frontend-before-database safe); cents multiplied before dividing; non-finite booked totals and legacy amounts skipped;
an undated payment set uses this version's date, as the statement does; `paid_count` follows the billed share; the
prover's reuse database name is checked; rollback text. Refuted: voiding an undated payment (every writer stores a
payment date; none live lacks one). Documented, not changed: Cancel Remaining shrinks an order and its commission, which
restates earlier months exactly as the old report did; saved close receipts keep their figures. Deferred (pre-existing):
a payment recorded during a close is not reconciled against the receipt. Live 2026 figures re-run with the new rule
(read-only): unchanged from the table above.

## Luna round 3 (gpt-6-luna xhigh, head 679960192) settlement

Three MED, all refuted with live evidence 2026-11-21 (validated constraints). A legacy payment of minus infinity:
`chk_payment_amount` (amount > 0). A NaN or infinite commission amount: `commissions_commission_amount_whole_cents_chk`
(finite, whole cents). A NaN or infinite booked order total: possible under `orders_total_price_non_negative`, but 0
live orders have one; such a total is unusable for a share, so the commission counts in full once the order is billed
(by design, documented in the helper; it never hides a cost). No code change.

## Sol round 2 (gpt-6.2-sol high, head 9b9ac1b2b) settlement

Fixed: (HIGH 1) an order's product lines on a Misc charge invoice count toward its billed share (a draft may switch
between the two types and keep the lines; credit memos still do not, Q1); (HIGH 2) Prepayment Manager checks count as
payments received on the Chicago day recorded, one split check as one payment; overpayment credits stay out (their cash
is in the payment); exact half-up rounding in integers; legacy payments rounded per row as the statement does; a missing
start date gives $0 commission; allowlist wording names the real helper. Refuted again (live evidence): voiding an
undated payment (no writer leaves it undated); a non-finite booked total counts in full (0 live; never hides a cost).
Open for Mason (HIGH 3): the close does not re-check that its figures still match what the admin reviewed. Same gap
already exists for invoice totals; a fix changes the close call itself. Recommendation: accept now, follow-up adds a
"figures changed since you reviewed" check to the whole close. Live 2026 figures: unchanged (no live misc-charge order
lines or prepayment checks).

## Luna round 4 (gpt-6-luna xhigh, head c2567643a) settlement

One MED, refuted with live evidence 2026-11-21: half-up rounding of a negative commission. `chk_commission_amount`
(commission_amount >= 0, validated) means no commission is negative; the screen's either-sign checkbox covers a
period figure, not a stored amount. No code change.

## Sol round 3 (gpt-6.2-sol high, head fece391d1) settlement

Fixed: (HIGH 3) only lines with a product count as billed product; a legacy untyped charge has none (live: every
product line on an order invoice has a product). Stop rule (AGENTS.md: one mechanism, a new HIGH in three rounds):
payments received produced a new HIGH in rounds 1, 2 and 3 (undated void, prepayment checks, close re-check, editable
prepayment buckets). It is removed from this change; Month-End and the close receipt read payments exactly as before
(HIGH 1 and HIGH 2 no longer apply). KI-129 payments stays open as a follow-up needing Mason's rule for prepayment
checks and a close-time re-check. MED: exact live figures removed from tracked docs. Other MEDs (non-finite legacy
values, paid-count wording) as settled in earlier rounds.

## Sol round 4 (gpt-6.2-sol high, head c59ec573f) settlement

Fixed: (HIGH 1) a return credit takes commission back in proportion (DECISION_LOG 2026-08-09 and 2026-11-13; the build
had Q1 backwards); (HIGH 3) even approximate live profitability removed from tracked docs. Open for Mason (HIGH 2, the
third round for one mechanism): Month-End Close records whatever the reports show at the click; nothing re-checks the
figures the admin reviewed (true of every close figure before this change). Recommendation: accept now, follow-up
adds a reviewed-figures check to the close. MEDs: non-finite booked total (refuted, 0 live); same-day versus next-day
negative sale line (legacy shape only; the invoice writer refuses negative prices); paid count reflects current status
(display count); prover reuse guard and synthetic bill split (proof-scope notes, not product behavior).

## Sol round 5 (gpt-6.2-sol high, head 99d6d5535) settlement

Two new HIGHs, both in the return clawback: return credits include sales tax and reflect discounts that the sales share
does not; billing above the booked total absorbs a later return before the cap. The fourth round in a row with a new HIGH
in this calculation, so the stop rule applied and Mason chose (2026-11-21, "Yes ship without, log as a follow up task"):
no return clawback in this PR; KI-184 carries it (DECISION_LOG). P8 now expects nothing taken back. MEDs: header-only
older credit memos and the net-zero Month-End checklist no longer apply (no clawback, so a period is never negative and
a net $0 means no commission); non-finite booked total refuted as before (deliberately counts in full, 0 live rows);
the prover's reuse path removed (it now always builds its own throwaway container). LOWs: a paid November invoice added
to the receipt case; the rounding helper's refusal probed; the round-4 decision wording says what the receipt holds; the
migration reference again says a period is never negative, which is now true.
