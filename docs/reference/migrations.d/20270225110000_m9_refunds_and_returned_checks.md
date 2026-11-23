**LOCAL CANDIDATE — NOT APPLIED.** M9, refunds paid outside CRX + prepay balance check + returned (bounced) checks (Mason's decision 18): `20270225110000_m9_refunds_and_returned_checks.sql` (SQL sha256: `4b484dfce67888e775c41702b233553aac1b581e0e8bb27bd4668a5b7d24d45c`). It must apply after `20270224120000_month_close_payments_received_recheck` (its preflight requires `_month_close_figures_20270208`).

**Preflight** pins nine function bodies (md5 of prosrc without CR). For each it also pins the owner, SECURITY DEFINER, search_path, grants (compared as a set), number of defaults, volatility, and an md5 of the argument list with default expressions and result. The bodies:
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
- `money_reversals`: a refund or a returned check. `entry_date` is always the day it was recorded (Chicago), an open month. `occurred_on` is the bank's return date (required for a return) or the day a refund was paid outside CRX (optional). It may be in a closed month and is ≤ `entry_date`.
- `money_reversal_lines`: what was taken per credit, invoice payment or prepay application. The FK to the application has no cascade.
- Both are append-only by trigger, RLS on, SELECT for active admins and reps, no API-role writes.

**New internal helpers** (no API role may call them): `_m9_check_records_20270225` (the integrity gate), `_prepay_credit_reversed_20270225`, `_prepay_credit_computed_balance_20270225` and the statement-level line trigger function `_recompute_prepay_credits_from_lines_20270225`. API roles also lose EXECUTE on `_recompute_prepay_credit_balance` (a trigger fires without it; service_role keeps it).

**Replaced bodies** are each the pinned body plus inserted M9 blocks only, proven byte for byte by the postflight:
- The recompute adds reversed applications back and takes lines off. A statement-level trigger (`trg_recompute_prepay_credits_m9`) recomputes each credit that new lines name, once per INSERT.
- void_payment refuses a returned payment and one whose prepay was refunded, and locks its invoices in one id-ordered pass.
- void_payment, edit and delete also set `customers.updated_at` when they change the cached balance (no trigger does).
- Edit refuses a balance change, and delete refuses, for any credit a reversal names.
- void_invoice refuses `INVOICE_HAS_RETURNED_PAYMENT`, for an active admin only; anyone else gets the void's own refusal.
- Month-End nets returned checks out of payments received (not counted as payments) and counts one payment per Prepayment Manager entry. It adds the `refunds` / `returned_checks` figures plus the `refunds_paid_cents` / `returned_checks_cents` receipt keys.
- The A/R tripwire learns returned checks, only for invoices the return touched. A never-applied credit zeroed by a return no longer trips its credit-timestamp test.
- The statement adds a "Returned check <ref>" row and a $0 "Refund paid (outside CRX) <ref>" row. Neither shows the staff reason.

**New RPCs** (active admin only; EXECUTE for authenticated and service_role):
- `record_outside_refund(uuid,bigint,date,text,text,uuid,uuid,text,boolean)` (the last argument confirms a second refund with the same reference and amount) and `record_returned_check(uuid,date,text,uuid,text,uuid)`: key required, using `check_idempotency_intent` + `save_idempotency` + `_bind_replay_receipt_20261015`.
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

**Sol round 2** (28 findings on 0ed3d7c9d):
- HIGH 1–4 fixed:
  - A return refuses a drifted credit.
  - A return refuses when invoice-payment lines plus credit lines differ from the face value (`RETURNED_CHECK_DOES_NOT_ADD_UP`). Application lines are not added again: a credit's removal line already holds its applied part.
  - The recompute trigger function loses API-role EXECUTE.
  - The prover's reuse mode refuses an unlabelled container, or one without the snapshot, before it drops anything.
- MED fixed:
  - M5: an undated payment is refused.
  - M6: the void guard applies only for an active admin.
  - M7: void_payment locks its invoices in one id-ordered pass.
  - M8: a Prepayment Manager check is the buckets of its one writer call (its `prepay_credit_created` audit row). Without exactly one such row the return is refused (`CHECK_BUCKETS_UNKNOWN`).
  - M9: a duplicate refund needs `p_allow_duplicate_reference`.
  - M10: an overpayment credit is eligible from its payment date.
  - M11: a backdated refund is refused if a drawn credit was edited after that date.
  - M12: only drawn credits are drift-checked.
  - M13: the tripwire flags only invoices the return touched.
  - M15: reconciliation ignores allocations of inactive payment sets.
  - M17: the fallback applies only to error codes 42P01 / PGRST205.
  - M18: one aggregated pass and one statement for application lines.
- LOW fixed: L23 (grants compared as a set), L24 (the prover replays up to M9 only), L25 (the three skip lists pin this file's sha256), L26 (fixed dates in the date cases), L27 (the two-session proof polls lock waits) and L28 (changelog wording).
- **Accepted in round 2:**
  - M14: invoice void stays refused while the returned payment is on the invoice (Taha's default 5).
  - M16: reconciliation runs its reads separately, as it does today, so a return committing between them can show a passing discrepancy.
  - L19–L22: the same accepted bigint and legacy-cents limits as round 1.

**Sol round 3** (30 findings on d029c9a4a). The scattered legacy-consistency checks are replaced by one integrity gate, `_m9_check_records_20270225`. Both RPCs run it after their locks and before any write, on exactly the records they touch. Anything that disagrees is refused `RECORD_NEEDS_HAND_CHECK: <code>`:
- `CUSTOMER_MISMATCH`: the payment, its allocation rows and invoices, credits or applications belong to another customer.
- `CHECK_BUCKETS`: a bucket the Prepayment Manager entry lists is missing, foreign or no longer a check.
- `CREDIT_DELETED`: a credit has a `prepay_deleted` audit row. Notes text is no longer used.
- `CREDIT_AMOUNT_EDITED`: a credit's original amount was edited.
- `PAYMENT_TOTALS`: `total_allocated_cents` ≠ the allocation rows, an allocation row has no invoice, or allocated + overpayment originals ≠ `total_payment_cents`.
- `INVOICE_PAID_MISMATCH` / `INVOICE_PREPAY_MISMATCH`: exact equality with the active payment allocations / applications, less earlier returns.
- `CREDIT_DRIFT` and `STORED_BALANCE_LOW`.

Also in round 3:
- **Refunds** are dated today, with an optional `p_paid_on` (any past date, kept). The receipt-date, edited-after-date and closed-month refund rules are gone.
- **Duplicate refunds** are same customer + reference, any amount.
- **Grouping:** the edit/delete guard and Month-End group Prepayment Manager checks by their entry's audit row.
- **Bank date:** a Prepayment Manager return takes any bank date up to today. A Record Payment's bank date stays ≥ its payment date.
- **Reconciliation:**
  - It counts only allocations of existing, active payment sets.
  - Each check has its own try.
  - The missing-table fallback is removed (the app deploys after the DB apply).
- **Receipts** add `prepay_balance_debited_cents`.
- **Migration hygiene:** the audit CHECK is asserted to be a superset of the old list, the temp helpers are dropped at the end, and the new tables and the append-only helper are owned by postgres.
- **L23 (accepted):** the public `edit_prepay_credit` / `delete_prepay_credit` wrappers (20261016060000) check the caller and the intent-bound key (`check_idempotency_intent`) before calling the internal impls, which no API role can execute. So the impls' older key-first replay cannot be reached with another credit's key.
- **Accepted, round 3:**
  - M13: reconciliation's separate reads, as M16 before.
  - L18–L21: bigint and legacy-cents limits.
  - L28: reuse mode trusts the snapshot it built.
  - L29: the skip-list hashes are taken over raw bytes, so a CRLF checkout trips the guard: the safe direction.

**Proof:** `node scripts/smoke/prove-m9-refunds-returned-checks-real-schema.mjs` prints M9_REFUNDS_RETURNED_CHECKS_PROOF_PASS. It runs 13 cases, including the recompute on apply, batch apply, invoice void and void_payment, and a two-session return/void race. The prover applies M9 on its own to a snapshot of the chain just before it.

**Rollback:** a follow-up migration, valid only while `money_reversals` is empty.
- Re-create the nine bodies pinned above and restore the audit list.
- Restore the recompute's EXECUTE grants.
- Drop the three RPCs, the five helpers (including `_money_reversals_append_only_20270225`), the trigger `trg_recompute_prepay_credits_m9`, and both tables.
