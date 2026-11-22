# C3 behavior contract: delivery and stock lifecycle operations take turns (#2190)

Status: revision 3 (catalog-confirmed entry list) after the Astra cold challenge (gpt-6.2-astra high, 2026-11-22, round 1: 31 findings, 8 BLOCKER).
Read at `origin/staging` 9c82aa65e. Reserved migration stamp `20270214100000`. Gate: the migration is written only
after #2170 (job completion stock rows) merges; it does not touch #2170's function, but its prover must run on top of it.

## 1. Outcome and authority

**Business result.** Completing, cancelling, voiding and re-scheduling deliveries, completing field jobs, and voiding
orders never fail with "deadlock detected" because of each other (today PostgreSQL kills one: nothing saved, a retry
works). Scheduling a follow-up is refused when its source delivery is not a live completed delivery.

For C1 (KI-188, #2179, parked): every check C1 adds inside cancel, void or the scheduler reads a state that no other
operation on this list can change until that operation commits, so the newest-first rule Mason chose for C1
(2026-11-22, option A, `DECISION_LOG.md`) cannot be raced. C1 still owns that rule and the remainder-row fixes.

**Design (revision 2).** One transaction-wide "take turns" lock (PostgreSQL advisory lock, key `(2190, 1)`), taken as
the FIRST statement of every public entry point below, before any row lock. Two of these operations then never run at
the same time, anywhere in the company: the second waits (it does not fail) until the first commits. Each operation
takes well under a second, so the wait is normally invisible.

Why not per-row lock ordering (revision 1): the completion path already locks stock in an outer layer
(`20270213100000` L110-121, inside `_complete_delivery_period_preflight_impl`) before the wrapper revision 1 changed;
quick cancel releases reservations for all order lines, not only the delivery's (`20270126110000` L382-395); a batch
cancel holds many deliveries in one transaction (`20261102140000` L304-317); jobs lock stock in an earlier hold-sync
trigger (`20261206110000` L84-99); and a single ordered pass breaks #2170's proven mixed-writer case. Ordering every
one of these is large and fragile. One shared lock taken before all of them is small and covers them all.

**Entry points that take the lock** (each public function is renamed to a private `_<name>_entry_20270214` and a new
public function of the same name, signature, defaults, grants and comment takes the lock and calls it; no business body
changes). Confirmed from the real migrated catalog (staging 9c82aa65e, 2026-11-22): every public function whose body
calls a lifecycle body, directly or through other functions, is listed; no trigger calls one. Case 9 re-runs this
check after the migration and fails on any public caller that reaches a body without taking the lock first.

| Entry point | Who may call (unchanged) |
|---|---|
| `complete_delivery` (one live overload, 12 arguments) | admin, sales rep, assigned driver |
| `start_and_complete_delivery` | as today |
| `cancel_delivery`, `batch_cancel_deliveries` | admin, sales rep |
| `void_delivery`, `fix_delivery` | admin |
| `create_followup_delivery` | admin, sales rep |
| `complete_job` | as today |
| `void_order` | admin |
| `process_offline_action` (field app offline queue; it locks the delivery or job row and then calls
`complete_delivery` / `complete_job`, so it must take the lock before that row lock, or it would wait for its turn
while holding a row the current turn-holder needs) | as today |

Rule: the lock must come before any row lock in the whole transaction. Nested calls (`process_offline_action` →
`complete_delivery`) take it again, which is free inside one transaction. `create_invoice_from_order` and the split
invoice path only mention completion in comments and refuse orders with live deliveries; they are untouched.

Who may act is unchanged. The lock is taken before authorization, so an unauthorized caller can make others wait for
the length of its own refusal (milliseconds); it changes nothing.

**Follow-up source check.** Inside the new `create_followup_delivery` wrapper, after the lock and only when the caller
passes the existing role test and the key has no saved receipt: refuse `FOLLOWUP_SOURCE_NOT_LIVE` unless the source
delivery is `completed` and `deleted_at IS NULL`. Remainder rows are only created by completing a delivery
(`20270203120000` L578-590) and a void deletes them (`20261107120000` L272), so a non-completed source with pending
rows is legacy damage, not work. A replayed key still returns its saved receipt.

## 2. State and failure

**Rules that always hold.**
- R1. No two listed operations overlap. A later one waits for the earlier one's commit, then makes its normal decision
  on the committed state: success, its normal refusal (e.g. "only completed deliveries can be voided",
  `NO_PENDING_REMAINDERS`), or a saved receipt for a repeated key. No "deadlock detected" between listed operations.
- R2. Business bodies, arithmetic, ledger rows, receipts, invoices and notifications are byte-for-byte unchanged
  (body hashes checked before and after).
- R3. Existing refusals keep their order and messages (the lock adds only a wait). `DELIVERY_ORDER_BUSY_RETRY` stays
  where it is today: a return operation (which does not take the lock) holding the order.

**Timing.**
- Wait limit: requests from the app run under the database's statement time limit (Supabase `authenticated` role,
  normally 8 s). A request waiting longer behind a very large batch cancel fails with a timeout: nothing saved, the
  screen shows its normal error, a retry works. Accepted: rare, safe, and better than a deadlock.
- Double click / retry after timeout: unchanged idempotency; the second call waits, then gets the saved receipt.

**Named limits (pre-existing, not made worse).**
- Writers outside the list (receiving, cycle counts, returns, blend tickets, transfers) do not take the lock; a
  deadlock between one of them and a listed operation is as possible as today. Returns vs completion (Astra 6) is one.
- Legacy remainder-row damage (rows linked to dead deliveries, a pending row already linked, a terminal order with
  pending rows, the queue showing a row it cannot schedule) is C1's scope (Astra 10, 15, 16, 17, 19).
- Undoing a delivery that already has a live follow-up: C1's newest-first rule (Mason option A). Until C1 ships, a
  void after scheduling still leaves the follow-up scheduled, exactly as today (Astra 2).

**Existing rows.** No data changes. Read-only check before apply, rows listed for the office (expected few or none):
`SELECT d.id, d.delivery_number, d.status, r.id AS remainder_id, r.quantity_remaining FROM delivery_remainders r JOIN deliveries d ON d.id = r.original_delivery_id WHERE r.status = 'pending' AND (d.status <> 'completed' OR d.deleted_at IS NOT NULL);`
The deployed app needs no change; `FOLLOWUP_SOURCE_NOT_LIVE` gets a plain message in `src/lib/errorSanitizer.ts`.

**Undo.** Rollback script restores the previous public functions (drops the lock wrappers, renames the entries back,
restores grants and comments) and is proven by calling every entry after reversal.

## 3. Delivery

One database PR into `staging`: migration, reverse script, prover, ledger record, sanitizer message. No screen depends
on it.

## 4. Proof cases (real migrated database in a network-disabled container, invented rows; never live)

`scripts/smoke/prove-one-lock-order-real-schema.mjs`. Every race uses observed lock waits (`pg_stat_activity`
`wait_event_type = 'Lock'` for the named session) instead of sleeps alone, and checks exact error text
(`deadlock detected` = SQLSTATE 40P01). Each case runs BEFORE the migration (failure expected) and AFTER on fresh rows.

1. #2190: completion Y passes its existing-row lock while A has no row; A appears; completion Z (A, B, other order)
   locks A then B. Before: one gets `deadlock detected`. After: Z waits on the take-turns lock; both finish; one A row;
   A and B down by both deliveries.
2. Completion X2 (order O2) holds stock P2 and is paused; void D2 on O2 starts. Before (observed): the void is refused
   `DELIVERY_ORDER_BUSY_RETRY` (or a deadlock). After: the void waits for the completion and then succeeds;
   P2 = start − X2 + D2.
3. Void V3 (order O3a, Q3 and P3) and completion C3 (order O3b, P3 and Q3). Before: deadlock (or the test records
   that the loop order did not produce one). After: both finish; P3 and Q3 = start + 4 − 6 each (start measured right
   before the race).
4. Void of ancestor F4 paused while holding O4; scheduler from G4 starts. Before: the scheduler decides before the
   void commits. After: the scheduler waits for the void, then decides on the committed state (G4 still completed:
   follow-up created; checked after both commit).
5. Voided or soft-deleted source with a pending row: scheduler refuses `FOLLOWUP_SOURCE_NOT_LIVE`, writes nothing;
   the key saved before the void still returns its saved follow-up.
6. Job completion (with #2170) and delivery completion sharing products, one missing: both finish; #2170's own
   prover still passes after this migration.
7. Batch cancel of two deliveries racing a completion that shares their products: both finish.
8. Each entry point, single session, before and after: same rows, ledger, receipt (fingerprint), same refusal for a
   rep voiding, a driver cancelling, an unassigned driver completing.
9. Migration: refuses unexpected starting functions and a second apply; postflight checks every wrapper's security,
   search_path, grants (authenticated/service_role as before, never anon/PUBLIC) and that each private entry is not
   callable by app roles. Reverse restores the previous functions and every entry still works after it.

Observed before the migration (dev run, 2026-11-22): case 1 `deadlock detected`; case 2 busy-retry refusal; case 3 no
inversion on this plan; case 4 the scheduler creates the follow-up alongside the void; case 5 a voided source is
scheduled (`new_deliveries=1`); 5b replay ok. `ONE_LOCK_ORDER_BEFORE_PASS`.

Pass markers: `ONE_LOCK_ORDER_BEFORE_PASS` (cases on today's code) and `ONE_LOCK_ORDER_PROOF_PASS` only when every
case above ran after the candidate, including 6 and 9.

## Astra round 1 dispositions

- Fixed by the redesign: 1, 4, 5, 7, 8, 11 (no new row lock ordering), 12, 13 (lock is a wait, not a refusal),
  14 (R1 now states the normal post-wait outcomes), 21 (operations named as they are), 24, 25, 28 (adopted).
- C1 scope, decided by Mason (option A, newest first): 2, 3, 9, 10. C1 scope, open there: 15, 16, 17, 19.
- Proof fixes: 22 (observed waits, exact errors), 23 (fingerprints per entry), 26 (reverse then call), 29 (case 3
  arithmetic), 30 (pass marker only after every case), 31 (check state after both commit).
- 6: pre-existing (completion already waits for the order while holding its delivery today); named limit.
- 18: no new row creation; unchanged.
- 20: privileges are unchanged; case 8/9 run as the `authenticated` role with the real profiles.
- 27: partly adopted (live check lives in the scheduler's entry, no body re-emit).

## Open business decisions

None. (Operations queueing one at a time is a technical trade-off with no customer-visible effect beyond a sub-second
wait; the rare timeout is a safe failure.)
