# M9 design: refunds paid outside CRX, prepay balance check, returned checks (stage 1)

Proof (fails until the migration lands): `scripts/smoke/prove-m9-refunds-returned-checks-real-schema.mjs`.
`B:` = baseline `supabase/baselines/20260727174805_public_schema.sql.br` (decompressed line). Other refs are `supabase/migrations/`.

## 1. How money is stored today
- **Payment** = `allocation_sets` row (`entity_type='payment'`, `total_payment_cents`, `payment_date`, `is_active`) plus one `invoice_line_allocations` row per invoice. `allocate_payment` (20261103220000:88) writes both, adds to `invoices.paid_amount_cents`, sets `paid` (:268-283). Any remainder becomes a `prepay_credits` row (`source_type='overpayment'`, `allocation_set_id` = the payment) and is added to `customers.prepay_balance_cents` (:302-314).
- **Prepayment Manager check** = `prepay_credits` rows (`source_type='check'`, no allocation set), also added to the customer's balance (`create_prepay_check_splits`, B:21107).
- **Applying prepay** inserts `prepay_applications`, raises `invoices.prepay_applied_cents` and lowers the customer balance (`_apply_prepay_to_invoice_replay_impl_20261015`, 20261204100000:567-577). Applications are immutable (`trg_guard_prepay_applications_immutable`, B:60875).
- **Credit balance is recomputed by trigger**: `trg_recompute_prepay_credit_balance` (AFTER INSERT/DELETE on `prepay_applications`, B:61050) sets `balance_cents = original_amount_cents − Σ applications` (B:6596). Anything that lowers `balance_cents` directly is undone the next time that credit is applied or unapplied.
- **The customer balance is a separate cached number** that every writer adds to or takes from. `reconcile_prepay_balances()` (B:38248) silently resets it to Σ credit balances (active customers only).
- **void_payment** (`_void_payment_replay_impl_20261015`, 20261204100000:953): requires the payment's month open; lowers `paid_amount_cents` (:1003), deletes the credit's applications (:1044), sets the credit's `original_amount_cents` and `balance_cents` to 0 (:1047), lowers the customer balance (:1053), and sets the set `is_active=false` (:1056). It rewrites history, so a returned check cannot reuse it.
- **edit/delete_prepay_credit** (B:24203, B:23070) rewrite `original_amount_cents` (= new balance + applied). That is today's refund workaround, and it erases history.
- **Month-End "payments received"** `_month_payments_received_20270208` (20270224120000:106) = active payment sets by `payment_date` + `'check'` credits at **current** `original_amount_cents` by Chicago `created_at` + legacy payments. Overpayment credits are not counted again.

## 2. New tables (append-only; written only by SECURITY DEFINER functions; admin + rep SELECT, like the allocation tables in 20261022040000)
- `money_reversals`: `id`, `kind` (`'outside_refund'|'returned_check'`), `customer_id`, `entry_date` (must be in an open month), `amount_cents > 0`, `reference`, `reason`, `allocation_set_id` (returned check only; partial UNIQUE where `kind='returned_check'`, so a check can be returned once), `performed_by`, `created_at`.
- `money_reversal_lines`: `id`, `reversal_id`, `line_kind` (`'prepay_credit'|'invoice_payment'|'prepay_application'`), `prepay_credit_id`, `invoice_id`, `prepay_application_id` (UNIQUE when set), `amount_cents > 0`.

**No trigger undoes it**: the recompute becomes `balance = original − Σ applications + Σ reversed-application lines − Σ prepay_credit lines`, and the same trigger runs AFTER INSERT on `money_reversal_lines`. `original_amount_cents` is never changed, so Month-End's check figure stays as it is.

**record_outside_refund**: active admin, `p_performed_by` must be the caller, key required (`check_idempotency_intent` + `save_idempotency` + `_bind_replay_receipt_20261015`, the 20270209160000 pattern; add the operation to `src/lib/rpcIdempotencyScope.test.ts` / `rpcContracts.test.ts`). Rules: `p_refund_date` ≤ today (Chicago) and `check_period_open`; reference and reason not blank. Locks the customer, then credits with a balance (oldest `created_at, id` first, or only `p_credit_id`). Refused if the amount is more than what is available. Writes one `prepay_credit` line per credit drawn. Lowers `customers.prepay_balance_cents` by the amount; if the stored balance is lower than that, it refuses (drift) rather than flooring at 0. Also writes `financial_audit_log` and `activity_feed`.

**record_returned_check** (decision 18): same guards and idempotency. The set must be an active `'payment'` with no earlier return; `p_returned_date` must be open, ≤ today and ≥ `payment_date`. It reads the set and its allocation lines **without writing them**:
1. For each invoice it paid, lower `paid_amount_cents` by that invoice's allocation sum and set `paid` → `posted` (void_payment's CASE). Writes an `invoice_payment` line.
2. **Prepay the check funded and already applied is reversed too** (your suggestion; the money never arrived). For each application of the set's overpayment credit, lower that invoice's `prepay_applied_cents` and reopen it. Writes a `prepay_application` line. The application row stays.
3. Write a `prepay_credit` line for what is left, so the credit ends at 0. Lower the customer balance by the credit's balance before step 2 (the applied part was already taken off when it was applied).
4. Refused if that credit has refund lines: refunded cash cannot come back out of prepay, so the admin handles it by hand.
5. Header `amount_cents = total_payment_cents`. `allocation_sets`, `invoice_line_allocations`, `prepay_applications` and `accounting_periods` are never written, so the closed month's rows stay byte-identical.

**get_prepay_balance_check** (admin, STABLE, writes nothing), per customer with a credit or a non-zero stored balance (inactive customers included):
- `received` = Σ `original_amount_cents`. Void and delete already lowered these in place, so they are folded in.
- `applied` = Σ applications − reversed-application lines.
- `refunded` / `voided` = `prepay_credit` lines of refunds / returned checks.
- `expected = received − applied − refunded − voided`; `stored` = customer column; `credits` = Σ `balance_cents`.
- `difference = stored − expected`; `ok = stored = expected AND credits = expected`.

## 3. Month-End
Both functions can only date an entry in an open month, under the month lock that `check_period_open` takes (20261103220000:62). A closed month's rows and figures therefore never move. In `_month_payments_received_20270208`, add one arm: returned checks as **−amount** on `entry_date`, so the open month nets the bounce. `count` keeps counting payments received only. Refunds are not receipts. They become a separate figure, `refunds {count,total_cents}` in the summary (so in the review token), with `refunds_paid_cents` and `returned_checks_cents` added to `close_receipt`. Proof case 5 pins the netting.

## 4. Read paths to touch
- **A/R aging, today**: no change. Invoices reopen through `balance_cents`, and the prepay column reads the customer balance.
- **A/R aging, past date**: `statement_customer_has_later_balance_activity` (20260803221244:165) gets a `money_reversals` arm (`created_at` after the cutoff), so an older date flags the customer as void does today.
- **Statement** (`_get_customer_statement_scoped_impl`, 20261204110000:1262): add a "Returned check <ref>" row on `entry_date` for +(invoice_payment + prepay_application lines). The October payment and "Prepay Applied" rows stay.
- **Prepay history / Prepayment Manager** read `prepay_credits` directly (balances right automatically). The new history rows come from `money_reversals` (screen stage).
- **Reconciliation**: `checkInvoicePayments` (src/lib/reconciliation.ts:278) must subtract `invoice_payment` lines. It also appears to miscount voided payments today (not confirmed).

## 5. Risks
1. The recompute change runs on every apply, unapply and void path. Prove apply, batch apply, void_payment and invoice void (20261204100000:5615) on the new formula.
2. `void_payment` must refuse a returned set (it would reverse twice) and a set whose credit has refund lines (forcing `original=0` would drive the balance negative). `edit_prepay_credit`'s balance change and `delete_prepay_credit` must refuse credits with M9 lines.
3. Invoice void refuses while an active set has allocations on the invoice (20261204100000:5553). A returned set stays active, so its reopened invoice cannot be voided. If that guard is taught about returns, the void must also skip the returned set's allocation rows and the reversed applications it would otherwise delete (:5591-5611). M9 leaves the refusal in place.
4. A bounced Prepayment Manager check (no allocation set) is not covered by `record_returned_check(p_allocation_set_id)`.
5. A reopened past-due invoice goes to `posted`, not `overdue` (as void does). Whether something resets `overdue` is not confirmed.
