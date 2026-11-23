# M9 design: refunds paid outside CRX, prepay balance check, returned checks (stage 1)

Migration: `supabase/migrations/20270227140000_m9_refunds_and_returned_checks.sql`. Proof: `scripts/smoke/prove-m9-refunds-returned-checks-real-schema.mjs` (written first; 16 cases now).

**Sections 1–6 are the stage-1 design. Sections 7–10 (Sol rounds) override them where they differ: for example a refund is dated today with an optional `p_paid_on`, not `p_refund_date`.**
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

## 2. New tables (append-only; written only by SECURITY DEFINER functions; admin-only SELECT since Sol round 4)
- `money_reversals`: `id`, `kind` (`'outside_refund'|'returned_check'`), `customer_id`, `entry_date` (must be in an open month), `amount_cents > 0`, `reference`, `reason`, `allocation_set_id` or `prepay_credit_id` (returned check only, exactly one; each has a partial UNIQUE, so a payment or a Prepayment Manager check comes back once), `performed_by`, `created_at`.
- `money_reversal_lines`: `id`, `reversal_id`, `line_kind` (`'prepay_credit'|'invoice_payment'|'prepay_application'`), `prepay_credit_id`, `invoice_id`, `prepay_application_id` (UNIQUE when set; FK with no cascade, so a reversed application can never be deleted), `amount_cents > 0`.

**No trigger undoes it**: the recompute becomes `balance = original − Σ applications + Σ reversed-application lines − Σ prepay_credit lines`, and the same trigger runs AFTER INSERT on `money_reversal_lines`. `original_amount_cents` is never changed, so Month-End's check figure stays as it is.

**record_outside_refund**: active admin, `p_performed_by` must be the caller, key required (`check_idempotency_intent` + `save_idempotency` + `_bind_replay_receipt_20261015`, the 20270209160000 pattern; add the operation to `src/lib/rpcIdempotencyScope.test.ts` / `rpcContracts.test.ts`). Rules: `p_refund_date` ≤ today (Chicago) and `check_period_open`; reference and reason not blank. Locks the customer, then credits with a balance (oldest `created_at, id` first, or only `p_credit_id`). Refused if the amount is more than what is available. Writes one `prepay_credit` line per credit drawn. Lowers `customers.prepay_balance_cents` by the amount; if the stored balance is lower than that, it refuses (drift) rather than flooring at 0. Also writes `financial_audit_log` and `activity_feed`.

**record_returned_check** (decision 18): same guards and idempotency. Takes `p_allocation_set_id` (an active `'payment'`) or `p_credit_id` (a Prepayment Manager `source_type='check'` credit), exactly one, with no earlier return. `p_returned_date` must be open, ≤ today and ≥ the day the check was received. It reads the source **without writing it**:
1. For each invoice it paid, lower `paid_amount_cents` by that invoice's allocation sum and set `paid` → `posted` (void_payment's CASE). Writes an `invoice_payment` line.
2. **Prepay the check funded and already applied is reversed too** (your suggestion; the money never arrived). For each application of the set's overpayment credit, lower that invoice's `prepay_applied_cents` and reopen it. Writes a `prepay_application` line. The application row stays.
3. Write a `prepay_credit` line for what is left, so the credit ends at 0. Lower the customer balance by the credit's balance before step 2 (the applied part was already taken off when it was applied).
4. Refused if that credit has refund lines: refunded cash cannot come back out of prepay, so the admin handles it by hand.
5. Header `amount_cents` = `total_payment_cents` (payment) or the credit's `original_amount_cents` (Prepayment Manager check; one bucket per return). `allocation_sets`, `invoice_line_allocations`, `prepay_applications` and `accounting_periods` are never written, so the closed month's rows stay byte-identical.

**get_prepay_balance_check** (admin, STABLE, writes nothing), per customer with a credit or a non-zero stored balance (inactive customers included):
- `received` = Σ `original_amount_cents`. Void and delete already lowered these in place, so they are folded in.
- `applied` = Σ applications − reversed-application lines.
- `refunded` / `voided` = `prepay_credit` lines of refunds / returned checks.
- `expected = received − applied − refunded − voided`; `stored` = customer column; `credits` = Σ `balance_cents`.
- `difference = stored − expected`; `ok = stored = expected AND credits = expected`.

## 3. Month-End
Both functions can only date an entry in an open month, under the month lock that `check_period_open` takes (20261103220000:62). A closed month's rows and figures therefore never move. In `_month_payments_received_20270208`, add one arm: returned checks as **−amount** on `entry_date`, so the open month nets the bounce. `count` keeps counting payments received only. Refunds are not receipts. They become a separate figure, `refunds {count,total_cents}` (plus `returned_checks {count,total_cents}` for display) in the summary, so the review token covers them, with `refunds_paid_cents` and `returned_checks_cents` added to `close_receipt`. Proof case 5 pins the netting.

## 4. Read paths to touch
- **A/R aging, today**: no change. Invoices reopen through `balance_cents`, and the prepay column reads the customer balance.
- **A/R aging, past date**: `statement_customer_has_later_balance_activity` (20260803221244:165) gets a `money_reversals` arm (`created_at` after the cutoff), so an older date flags the customer as void does today.
- **Statement** (`_get_customer_statement_scoped_impl`, 20261204110000:1262): add a "Returned check <ref>" row on `entry_date` for +(invoice_payment + prepay_application lines). The October payment and "Prepay Applied" rows stay. A refund shows as "Refund paid (outside CRX) <ref>" with $0 effect.
- **Prepay history / Prepayment Manager** read `prepay_credits` directly (balances right automatically). The new history rows come from `money_reversals` (screen stage).
- **Reconciliation**: `checkInvoicePayments` (src/lib/reconciliation.ts:278) must subtract `invoice_payment` lines. It also appears to miscount voided payments today (not confirmed).

## 5. Risks
1. The recompute change runs on every apply, unapply and void path. Prove apply, batch apply, void_payment and invoice void (20261204100000:5615) on the new formula.
2. `void_payment` must refuse a returned set (it would reverse twice) and a set whose credit has refund lines (forcing `original=0` would drive the balance negative). `edit_prepay_credit`'s balance change and `delete_prepay_credit` must refuse credits with M9 lines.
3. Invoice void refuses while an active set has allocations on the invoice (20261204100000:5553). A returned set stays active, so its reopened invoice cannot be voided. If that guard is taught about returns, the void must also skip the returned set's allocation rows and the reversed applications it would otherwise delete (:5591-5611). M9 leaves the refusal in place.
4. A bounced Prepayment Manager check (no allocation set) is not covered by `record_returned_check(p_allocation_set_id)`.
5. A reopened past-due invoice goes to `posted`, not `overdue` (as void does). Whether something resets `overdue` is not confirmed.

## 6. Stage 2 defaults (built; each goes to Taha for a final OK and is easy to change)
1. Month-End nets returned checks into payments received (−amount on `entry_date`, not counted as a payment) and adds the refunds figure and the two close-receipt keys.
2. Statement: refund info row, $0 effect.
3. Bounced Prepayment Manager checks are in scope (`p_credit_id`). Its applications are reversed, the rest is zeroed, and it is refused if refunded. One return per credit.
4. Guards: `void_payment` refuses a returned payment or one whose prepay was refunded. `edit_prepay_credit` refuses a balance change on a credit with M9 lines; the same balance is treated as a notes/reference-only edit, because the screen always sends the balance. `delete_prepay_credit` refuses.
5. Invoice void keeps refusing while the returned payment's allocations exist. When a returned check reversed an invoice's application, the void stops at the FK (`money_reversal_lines_prepay_application_id_fkey`): a raw message, but nothing changes.

## 7. Sol round 1 rules (built)
1. Only a Record Payment with `payment_method='check'` can be returned.
2. A Prepayment Manager check is every bucket its one Prepayment Manager call wrote (the call's `prepay_credit_created` audit row lists them; round 2). Its face value is the buckets' total. It is refused if any bucket was edited (`prepay_edited` changing the original amount), deleted, refunded or already returned.
3. `p_returned_date` is the bank's date: ≥ the day the check was received and may be in a closed month. An undated payment is refused (round 2). The entry is dated today, in an open month.
4. Lock order matches void_payment: payment → credits → month → invoices (one sorted pass) → customer. A refund locks credits → month → customer.
5. A refund draws only credits received on or before its date. It is refused when a drawn credit's stored balance differs from its rows.
6. A reopened invoice goes overdue when its due date is before today in Chicago, the same rule as reverse_write_off. Only paid → owing counts as reopened.

## 8. Sol round 2 rules (built)
1. A return must add up: invoice-payment lines + credit lines = face value. Each credit line already holds its applied part once that part is counted back. Otherwise the return is refused and handled by hand.
2. A refund's credits are eligible from their receipt date: the payment date for a Record Payment's prepay, the entry day for a Prepayment Manager check. A second refund with the same reference (any case) and amount needs `p_allow_duplicate_reference`.
3. Reconciliation counts only allocations of active payment sets. Its returned-check ledger is treated as empty only when the table is missing (42P01 / PGRST205).

## 9. Sol round 3 rules (built)
1. **One integrity gate** (`_m9_check_records_20270225`) replaces the scattered legacy checks. A refund or return refuses `RECORD_NEEDS_HAND_CHECK: <code>` unless everything it touches agrees: customer, check buckets, deleted/edited credits, payment totals, exact invoice paid/prepay amounts, credit drift and stored balance.
2. **Refunds** are dated today. `p_paid_on` keeps the outside date. A second refund with the same reference needs confirming.
3. **One Prepayment Manager entry is one check** (its audit row) everywhere: return, edit/delete guard, Month-End count.

## 10. Sol round 4 rules (built; Taha's option A, 23 Nov)
A read-only live count found 1 customer with prepay, 1 credit, 1 payment set and no customer failing a check, so the strict gate costs nothing for the Dec 15 trial.
1. **The whole customer must agree** before a refund or a return writes. The gate adds, after its touched-record checks: `CREDIT_SOURCE_MISMATCH` (a credit's payment is another customer's, not a payment, or voided with money left), `APPLICATION_CUSTOMER_MISMATCH` (a credit applied to another customer's invoice), `CREDIT_DRIFT` (any credit of the customer against its own rows) and `STORED_BALANCE_MISMATCH` (stored balance ≠ the credits' total). A drifted credit the refund does not draw now blocks it too.
2. **A Prepayment Manager check is all of its entry.** Each bucket is in exactly one `prepay_credit_created` entry, no check bucket with the same customer, reference and entry time is missing from every entry (`CHECK_BUCKETS`), and the buckets' amounts add up to the entry's `total_cents` (`CHECK_FACE_VALUE`). A partial bucket list is refused, never understated.
3. A return refuses an invoice that is draft, unposted, voided, cancelled or deleted (`RETURN_INVOICE_NOT_OPEN`).
4. `money_reversals` and `money_reversal_lines` are readable by active admins only. Reps still see the statement rows (the statement reads them as definer). No screen reads them as a rep; the Integrity report is admin-only.
5. `void_payment` refuses a set that is not a payment (`NOT_A_PAYMENT`).
6. A paid-on or bank date of `-infinity` is refused (`BAD_VALUE`).
7. Round 5 (whole branch after round 4): every credit has a known source (`CREDIT_SOURCE_UNKNOWN`) and every active payment behind the customer's credits adds up (`SOURCE_PAYMENT_TOTALS`); an entry's buckets are one receipt (one reference, one entry time); an allocation row of $0 or less is refused; the preflight pins the recompute trigger's shape; a payment dated `-infinity` is undated.
8. Round 6 (last advisory round): an unlinked check credit needs exactly one creation entry, and that entry must be the customer's and carry the check's reference; a source payment's credits must all be its customer's; a return refuses when an active payment puts $0 or less on an invoice it touches (`INVOICE_NEGATIVE_ALLOCATION`).
9. Round 8 (Taha's option A for round 7's two HIGHs): every Prepayment Manager entry naming a check credit of the customer must be one whole receipt of this customer: its buckets are this customer's unlinked checks with its reference and one entry time, they add up to its recorded total, and no check credit of that receipt sits outside it (`CHECK_ENTRY_MISMATCH`, refunds and returns). Refunding or returning any bucket freezes the amounts of all its siblings (edit / delete guard).
10. Stamp moved to `20270227140000` (after staging's `20270227110000`).

