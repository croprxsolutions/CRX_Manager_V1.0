**LOCAL CANDIDATE — NOT APPLIED.** M9, refunds paid outside CRX + prepay balance check + returned (bounced) checks (Mason's decision 18): `20270227140000_m9_refunds_and_returned_checks.sql` (SQL sha256: `3233f1ef1dfe39d2d12b6b0e06b28ce0b9196e72b938168b9affcd5d9b59c2bc`). It must apply after `20270224120000_month_close_payments_received_recheck` (its preflight requires `_month_close_figures_20270208`).

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
- Both are append-only by trigger, RLS on, SELECT for active admins only (Sol round 4), no API-role writes.

**New internal helpers** (no API role may call them): `_m9_check_records_20270225` (the integrity gate), `_prepay_credit_reversed_20270225`, `_prepay_credit_computed_balance_20270225` and the statement-level line trigger function `_recompute_prepay_credits_from_lines_20270225`. API roles also lose EXECUTE on `_recompute_prepay_credit_balance` (a trigger fires without it; service_role keeps it).

**Replaced bodies** are each the pinned body plus inserted M9 blocks only, proven byte for byte by the postflight:
- The recompute adds reversed applications back and takes lines off. A statement-level trigger (`trg_recompute_prepay_credits_m9`) recomputes each credit that new lines name, once per INSERT.
- void_payment refuses a set that is not a payment (`NOT_A_PAYMENT`), a returned payment and one whose prepay was refunded, and locks its invoices in one id-ordered pass.
- void_payment, edit and delete also set `customers.updated_at` when they change the cached balance (no trigger does).
- Edit refuses a balance change, and delete refuses, for any credit a reversal names.
- void_invoice refuses `INVOICE_HAS_RETURNED_PAYMENT`, for an active admin only; anyone else gets the void's own refusal.
- Month-End nets returned checks out of payments received (not counted as payments) and counts one payment per Prepayment Manager entry. It adds the `refunds` / `returned_checks` figures plus the `refunds_paid_cents` / `returned_checks_cents` receipt keys.
- The A/R tripwire learns returned checks, only for invoices the return touched. A never-applied credit zeroed by a return no longer trips its credit-timestamp test.
- The statement adds a "Returned check <ref>" row and a $0 "Refund paid (outside CRX) <ref>" row. Neither shows the staff reason.

**New RPCs** (active admin only; EXECUTE for authenticated and service_role):
- `record_outside_refund(uuid,bigint,date,text,text,uuid,uuid,text,boolean)` (the last argument confirms a second refund with the same reference, any amount) and `record_returned_check(uuid,date,text,uuid,text,uuid)`: key required, using `check_idempotency_intent` + `save_idempotency` + `_bind_replay_receipt_20261015`.
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

**Sol round 4** (25 findings on 1a2887f0f). Taha chose option A (23 Nov): a strict whole-customer gate. A read-only live count found 1 customer with prepay, 1 credit, 1 payment set and no customer failing a check.
- HIGH 1–3 fixed:
  - H1: a Prepayment Manager return refuses unless each bucket is in exactly one entry and no bucket entered with them (same customer, reference, entry time) is missing from every entry (`CHECK_BUCKETS`), and the buckets add up to the entry's `total_cents` (`CHECK_FACE_VALUE`).
  - H2: `CREDIT_SOURCE_MISMATCH` (any credit of the customer whose payment is another customer's, not a payment, or voided with money left) and `APPLICATION_CUSTOMER_MISMATCH` (any application of the customer's credits on another customer's invoice).
  - H3: `CREDIT_DRIFT` covers every credit of the customer, and `STORED_BALANCE_MISMATCH` refuses when the stored balance is not the credits' total (low or high). `STORED_BALANCE_LOW` stays as the last line.
- MED fixed:
  - M4: void_payment refuses a non-payment set (`NOT_A_PAYMENT`).
  - M6: a return refuses a draft, unposted, voided, cancelled or deleted invoice (`RETURN_INVOICE_NOT_OPEN`).
  - M15: the two tables are readable by active admins only. No rep screen reads them; the statement reads them as definer.
- LOW fixed: L18 (`-infinity` dates refused, `BAD_VALUE`) and L25 (this record's duplicate-refund wording).
- **Not changed, round 4:**
  - M5: the `GREATEST(…, 0)` clamps are in the pinned pre-M9 void/edit/delete bodies; M9 only inserts blocks (the postflight proves it). M9's own writers never clamp, and once a clamp hides drift the whole-customer gate refuses every refund and return and the balance check reports it.
  - M7: invoice void stays refused after a return (Taha's default 5).
  - M8: a void racing a return can still stop at the FK with a raw message; nothing changes (as round 2).
  - M9, M10: Month-End count edge cases (one entry per audit row; a bucket in two entries). Per Taha's brief; the writer never puts a bucket in two entries, and a return now refuses one.
  - M11: the A/R tripwire's credit-timestamp exception can miss an application removed by an invoice void between the cutoff and the return. Narrow; left for the A/R stage.
  - M12: reconciliation's separate reads (as rounds 2 and 3).
  - M13, L19, L20: bigint limits (as rounds 1–3).
  - M14: legacy fractional-cent payments predate M9 (as round 1 L26).
  - L16: no index for the Month-End bucket lookup; volumes are tiny. Add one if the close review slows.
  - L17: a FIFO refund locks every positive credit of the customer; the whole-customer gate reads them all anyway.
  - L21: `p_paid_on` has no default (it sits before required arguments); the screen sends null.
  - L22, L23: proof hygiene (actor-forgery and cross-operation replay cases; two runners on one reused container).
  - L24: CRLF checkouts trip the skip-list hashes: the safe direction (as round 3 L29).
- Sol round 5 (24 findings on d09368a8b, the whole branch after round 4). HIGH 1–2 fixed, with cheap MED/LOW fixes:
  - H1: `CREDIT_SOURCE_UNKNOWN` (a credit that is neither an overpayment linked to its payment nor an unlinked check) and `SOURCE_PAYMENT_TOTALS` (every active payment behind the customer's credits must add up, so a credit its payment never funded is refused).
  - H2: an entry's buckets must be one receipt (one reference and one entry time), else `CHECK_BUCKETS`.
  - M4: an allocation row of $0 or less fails `PAYMENT_TOTALS` / `SOURCE_PAYMENT_TOTALS`.
  - M14: the preflight also pins the recompute trigger's shape (AFTER INSERT OR DELETE, FOR EACH ROW, no WHEN).
  - L18: a payment dated `-infinity` is refused as undated. L23: changelog wording. L24: this rollback's drop order.
  - Not changed: M3 (another customer's money on a touched invoice; split billing can legitimately bill another customer, so a strict rule needs Taha's call), M8 (a refund's credit timestamp can flag an older A/R date as unrebuildable: the safe direction), and the repeats of round 4's not-changed items (M5–M7, M9–M13, L15–L17, L19–L22).
- Sol round 6 (30 findings on eaf1d3ff1). HIGH 1–2 fixed, with two cheap MEDs:
  - H1: an unlinked check credit needs exactly one `prepay_credit_created` entry (`CREDIT_SOURCE_UNKNOWN`), so a refund cannot draw a check with no evidence of receipt.
  - H2: no active payment may put $0 or less on an invoice a return touches (`INVOICE_NEGATIVE_ALLOCATION`), so a return never drives paid below zero.
  - M3: the entry must be this customer's and carry the check's reference (`CHECK_BUCKETS`).
  - M4: every credit a source payment minted must be that payment's customer's (`SOURCE_PAYMENT_TOTALS`).
  - M15 / L30: rollback drop order and the design note's stale stage-1 sections (marked superseded).
  - Not changed (MED): M5 split billing across customers is refused by `CUSTOMER_MISMATCH` (strict by Taha's option A; a cross-customer bounce is recorded by hand); M6 an invoice void racing a return can deadlock (one side aborts and nothing is saved; needs a lock-order change in the inherited void path); M9 editing an untouched sibling bucket after a refund still rewrites a closed month's receipt (the pre-M9 edit path; the guard covers buckets a reversal names); M13/M14 reconciliation tolerance and reversed-application cross-check (pre-M9 report behaviour); and repeats of round 4–5 items (M7, M8, M10–M12, M16, L17–L29).
- Sol round 7 (on 9d1df5ae1; Taha chose option A for its two HIGHs, round 8 builds it):
  - H1 (a refund drew a check credit whose entry belongs to another customer or records less) and H2 (one split check recorded as two entries returned below face value): one whole-customer rule, `CHECK_ENTRY_MISMATCH`, used by refunds and returns alike. Every `prepay_credit_created` entry naming a check credit of the customer must be this customer's, list only this customer's unlinked check credits with the entry's reference and one entry time, add up to its recorded `total_cents`, and leave no check credit of the same receipt (customer, reference, entry time) outside it.
  - M7 (sibling buckets of a split receipt stayed editable): the edit / delete guard (`_prepay_credit_reversed_20270225`) also refuses a bucket whose entry has any bucket with a refund or return line or a return header, so one refunded bucket freezes the whole receipt.
  - Consequences (Taha accepted them as Sol r8 MED 9 and MED 10, see round 9): two Prepayment Manager entries with one reference in one transaction (same entry time) can no longer be returned (they cannot be told apart; Month-End still counts two). A customer with any check credit whose amount was edited or deleted (the old refund workaround) now fails the entry total, so their refunds and returns are refused until checked by hand.
  - Not changed: the other round-7 MEDs repeat earlier not-changed items (return / invoice-void deadlock, stale FIFO draw set, A/R tripwire edges, Month-End grouping, cross-customer split billing, invoice void after a return, reconciliation snapshot, tolerance and unlinked allocations, clamps).
- Sol round 8 (31 findings on ae96d080d). Round 9 fixes its three HIGHs (Taha, 24 Nov):
  - H1: a creation entry matches a credit only when its `credit_ids` is an array containing that id (`jsonb_typeof = 'array'` and `@>`, never the `?` key operator), in the gate, the return's entry lookup and the edit / delete guard. An entry recorded for the customer whose `credit_ids` is not an array of distinct ids is refused (`CHECK_ENTRY_MALFORMED`). Month-End's grouping keeps its read-only lookup.
  - H2: an entry that lists the same credit twice is refused (`CHECK_ENTRY_MISMATCH`).
  - H3: the refund now locks every credit of the customer, in id order, in its first statement (before the month and the customer, as void_payment takes credits first). Chosen over re-checking in edit / delete because those paths already lock their credit before the M9 guard: a sibling edit or delete now waits on the refund's lock and then sees its lines, with no new lock step in the inherited bodies and no new lock order. It also closes MED 4 (an older credit restored mid-refund waits instead).
  - Accepted (Taha): MED 9 (two same-reference entries in one transaction block the customer) and MED 10 (a credit edited before M9 blocks that customer's refunds and returns). Reason: after Mason's live reset all prepay is cleared, and new checks are written by the current writer in the correct shape (one entry per call, distinct ids, its total), so neither can arise from new data.
  - Not changed: the other round-8 MEDs and LOWs repeat earlier not-changed items.
- Stamp: `20270225110000` was restamped to `20270227140000` (after staging's newest, `20270227110000`; `20270226213000` was taken by #2331).

**Proof:** `node scripts/smoke/prove-m9-refunds-returned-checks-real-schema.mjs` prints M9_REFUNDS_RETURNED_CHECKS_PROOF_PASS. It runs 17 cases (case 14 holds the round 4 and 5 refusals, case 15 round 6's, case 16 round 8's, case 17 round 9's, including a two-session refund / sibling-edit race), including the recompute on apply, batch apply, invoice void and void_payment, and a two-session return/void race. The prover applies M9 on its own to a snapshot of the chain just before it. It records `20270227110000_delivery_driver_checks_need_a_driver` in the ledger instead of replaying it (its preflight pins a body that the ledger-only `20261217100000` sets; delivery driver checks only), pinned to its reviewed bytes.

**Rollback:** a follow-up migration, valid only while `money_reversals` is empty.
- Re-create the nine bodies pinned above and restore the audit list.
- Restore the recompute's EXECUTE grants.
- Drop both tables first (their four append-only triggers and `trg_recompute_prepay_credits_m9` go with them), then the three RPCs and the five helpers (including `_money_reversals_append_only_20270225`).
