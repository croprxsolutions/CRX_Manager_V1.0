**LOCAL CANDIDATE — NOT APPLIED.** M9, refunds paid outside CRX + prepay balance check + returned (bounced) checks (Mason's decision 18): `20270225110000_m9_refunds_and_returned_checks.sql` (SQL sha256: `ddab40c491889043d2d600c84ec904aad2f3e5ddd90385ef8a80a10582161d48`). It must apply after `20270224120000_month_close_payments_received_recheck` (its preflight requires `_month_close_figures_20270208`).

**Preflight** pins nine function bodies (md5 of prosrc without CR). For each it also pins the owner, SECURITY DEFINER, search_path, grants, number of defaults, volatility, and an md5 of the argument list with default expressions and result. The bodies:
- `_recompute_prepay_credit_balance` `62822c67…`
- `_void_payment_replay_impl_20261015` `249d13c9…`
- `_edit_prepay_credit_replay_impl_20261015` `366db16a…`
- `_delete_prepay_credit_replay_impl_20261015` `bcb90bd2…`
- `_month_payments_received_20270208` `b090a4ff…`
- `_month_close_figures_20270208` `b20bcd3b…`
- `statement_customer_has_later_balance_activity` `92ec7763…`
- `_get_customer_statement_scoped_impl` `ee463c1b…`
- `void_invoice` (wrapper) `2b1be1b7…`

It also refuses an extra overload, pins `financial_audit_log_operation_type_check` (md5 `424d2bb0…`), and requires the recompute trigger to exist and be enabled.

**New tables**
- `money_reversals`: a refund or a returned check. `entry_date` is in an open month. `bank_returned_date` is set for returned checks only; it may be in a closed month and is ≤ `entry_date`.
- `money_reversal_lines`: what was taken per credit, invoice payment or prepay application. The FK to the application has no cascade.
- Both are append-only by trigger, RLS on, SELECT for active admins and reps, no API-role writes.

**New internal helpers** (no API role may call them): `_prepay_credit_reversed_20270225` and `_prepay_credit_computed_balance_20270225`.

**Replaced bodies** are each the pinned body plus inserted M9 blocks only, proven byte for byte by the postflight:
- The recompute adds reversed applications back and takes lines off, and also runs AFTER INSERT on lines.
- void_payment refuses a returned payment and one whose prepay was refunded.
- Edit refuses a balance change, and delete refuses, for any credit a reversal names.
- void_invoice refuses `INVOICE_HAS_RETURNED_PAYMENT`.
- Month-End nets returned checks out of payments received (not counted as payments; other rows counted as before) and adds the `refunds` / `returned_checks` figures plus the `refunds_paid_cents` / `returned_checks_cents` receipt keys.
- The A/R tripwire learns returned checks.
- The statement adds a "Returned check" row and a $0 "Refund paid (outside CRX)" row, each with its amount in the description.

**New RPCs** (active admin only; EXECUTE for authenticated and service_role):
- `record_outside_refund(uuid,bigint,date,text,text,uuid,uuid,text)` and `record_returned_check(uuid,date,text,uuid,text,uuid)`: key required, using `check_idempotency_intent` + `save_idempotency` + `_bind_replay_receipt_20261015`.
- `get_prepay_balance_check(uuid)`: read-only.

The audit CHECK gains `prepay_refunded_outside` and `payment_returned`. A second apply stops at `M9_PREFLIGHT: already applied`. No existing row changes.

**Sol round 1** (26 findings on dc98cd286):
- HIGH 1–6 fixed:
  - Only a check payment can be returned.
  - A Prepayment Manager check returns all its buckets together at its face value.
  - An edited or deleted check credit is refused.
  - Every credit a reversal names is guarded.
  - The refund asserts that its draw covers the amount.
  - Invoice void gives a clear refusal.
- MED 7–16 fixed:
  - Return locks in void_payment's order: payment, credits, month, invoices in one sorted pass, customer. A two-session proof covers it.
  - A refund draws only credits received by its date and refuses a drifted credit.
  - An undated payment falls back to its Chicago creation day.
  - Reconciliation subtracts returned checks.
  - A paid invoice reopens as overdue when past due.
  - The balance check lists per-credit mismatches.
  - The bank date is kept separately from the open-month entry date.
- LOW 17–20 and 24–25 fixed.
- **Accepted LOWs:**
  - L21: JSON cents above 2^53 lose precision in JavaScript.
  - L22: the dollar text in descriptions can round at bigint extremes.
  - L23: the balance check's lifetime sums can overflow at bigint extremes.

  These match every existing money RPC.
  - L26: the legacy `payments` table's whole-cent invariant. It predates M9, and M9 does not change that arm.

**Proof:** `node scripts/smoke/prove-m9-refunds-returned-checks-real-schema.mjs` prints M9_REFUNDS_RETURNED_CHECKS_PROOF_PASS. It runs 11 cases, including the recompute on apply, batch apply, invoice void and void_payment, and a two-session return/void race. The prover applies M9 on its own to a snapshot of the chain just before it.

**Rollback:** a follow-up migration, valid only while `money_reversals` is empty.
- Re-create the nine bodies pinned above and restore the audit list.
- Drop the three RPCs, the three helpers (including `_money_reversals_append_only_20270225`), the trigger `trg_recompute_prepay_credit_balance_m9`, and both tables.
