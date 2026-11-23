**LOCAL CANDIDATE — NOT APPLIED.** M9, refunds paid outside CRX + prepay balance check + returned (bounced) checks (Mason's decision 18): `20270225110000_m9_refunds_and_returned_checks.sql` (SQL sha256: `975dbdd977ae17d3eaee61acaf6841abfda0ef3bbb3296cba523a6ba400c37ae`). It must apply after `20270224120000_month_close_payments_received_recheck` (its preflight requires `_month_close_figures_20270208`).
- **Preflight** pins these eight function bodies (md5 of prosrc without CR) with owner, SECURITY DEFINER, search_path, grants, defaults and volatility, and refuses an extra overload:
  - `_recompute_prepay_credit_balance` `62822c67…`
  - `_void_payment_replay_impl_20261015` `249d13c9…`
  - `_edit_prepay_credit_replay_impl_20261015` `366db16a…`
  - `_delete_prepay_credit_replay_impl_20261015` `bcb90bd2…`
  - `_month_payments_received_20270208` `b090a4ff…`
  - `_month_close_figures_20270208` `b20bcd3b…`
  - `statement_customer_has_later_balance_activity` `92ec7763…`
  - `_get_customer_statement_scoped_impl` `ee463c1b…`

  It also pins `financial_audit_log_operation_type_check` (md5 `424d2bb0…`).
- **New tables.** `money_reversals` (refund or returned check, dated in an open month, at most one return per payment and per Prepayment Manager credit) and `money_reversal_lines` (per credit, invoice payment or prepay application; the FK to the application has no cascade). Both are append-only by trigger, RLS on, SELECT for active admins and reps (`is_admin() OR is_sales_rep()`), no API-role writes.
- **Replaced bodies.** Each is the pinned body plus inserted M9 blocks only, and the postflight proves that byte for byte.
  - The recompute adds reversed applications back and takes reversal lines off, and also runs AFTER INSERT on `money_reversal_lines`.
  - The void, edit and delete guards.
  - Month-End nets returned checks out of payments received and adds the `refunds` / `returned_checks` figures plus the `refunds_paid_cents` / `returned_checks_cents` receipt keys.
  - The A/R tripwire learns returned checks.
  - The statement adds the "Returned check" and $0 "Refund paid (outside CRX)" rows.
- **New RPCs.** `record_outside_refund(uuid,bigint,date,text,text,uuid,uuid,text)`, `record_returned_check(uuid,date,text,uuid,text,uuid)` and `get_prepay_balance_check(uuid)`: active admin only. The two writers require the key and follow `check_idempotency_intent` + `save_idempotency` + `_bind_replay_receipt_20261015`. EXECUTE for authenticated and service_role.
- **Audit CHECK** gains `prepay_refunded_outside` and `payment_returned`.
- A second apply stops at `M9_PREFLIGHT: already applied`. No existing row changes.
- **Proof:** `node scripts/smoke/prove-m9-refunds-returned-checks-real-schema.mjs` (M9_REFUNDS_RETURNED_CHECKS_PROOF_PASS, 9 cases, including the recompute on apply, batch apply, invoice void and void_payment).
- **Rollback:** a follow-up migration, valid only while `money_reversals` is empty. It re-creates the eight bodies pinned above, restores the audit list, and drops the three RPCs, the trigger `trg_recompute_prepay_credit_balance_m9`, both tables and `_money_reversals_append_only_20270225`.
