# Behavior contract: inventory clean-up edge cases (#1942, follow-ups of #1940)

Read at `origin/staging` 62ccaeaa2, 2026-11-19. One PR to `staging`, one new migration
(`20270129150000_inventory_edge_cases_1942.sql`), DB only plus screen error wording. No live data is changed.

## 1. Outcome and authority

Who may act is unchanged everywhere: every function below keeps its role, actor and idempotency checks, and only
`SECURITY DEFINER` functions write. The completion functions and the guard keep no app grant. `update_cycle_count_item`
keeps its `authenticated` and `service_role` execute: the count screen calls it, and it requires an admin actor itself.

### A. A delivery's stock row that does not exist yet (deadlock between two completions)
- **Fact.** `_complete_delivery_authorized_impl` (the wrapper, 20270126110000) locks the delivery. Then it locks the
  EXISTING Main Warehouse stock rows of its products, in product order.
- **Fact.** A product with no row is created by the body (`_complete_delivery_authorized_impl_20270122`). Its first
  loop does `INSERT ... ON CONFLICT DO NOTHING` with 0/0 and `manufactured_at_delivery = true`, in the order the line
  join returns. With a real-size products table that is line order.
- **Fact.** Two completions creating rows for P1 and P2 in opposite line order wait on each other's uncommitted unique
  key (`inventory_product_location_unique`) and deadlock.
- **Change.** The wrapper walks the delivery's products once, in product order. For each product:
  - While the delivery is `in_progress` (read under its lock), and the product moves stock, a missing Main Warehouse
    row is inserted first. "Moves stock" means quantity to deliver > 0, using the same text-key lookup and clamp as
    the body. The row is inserted exactly as the body would: 0/0, `manufactured_at_delivery = true`,
    `ON CONFLICT DO NOTHING`.
  - Then the product's row is locked.
- **Why it works.** Creating and locking in one ordered pass means no completion holds a later product while it waits
  for an earlier one.
- **Afterwards.** The body finds the row (0 on hand), warns short and deducts as today.
- **Not in progress.** A delivery not `in_progress` (refused by the body, or an idempotent replay) creates nothing.
  Its rows are still locked as today. The same goes for a key that already has a saved completion receipt, even on
  another delivery (Luna r3): the body answers from the receipt before its status check, so the wrapper checks no
  figures and creates no row for it.

### B. On-hand with more than 4 decimals (a count misses the counted figure)
- **Fact.** `update_cycle_count_item` (20270126110000) stores `expected_qty = round(on-hand, 4)` and
  `variance = round(counted, 4) - expected`. Complete adds the stored variance to current on-hand.
- **Fact.** On-hand is plain `numeric`, and unit conversions can give more places (1 oz = 0.0078125 Gal).
  On-hand 12.3456789 counted at 12.35 completes at 12.3499789, not 12.35.
- **Change.** `expected_qty` and `variance` become plain `numeric` (counted stays `numeric(14,4)`).
  `update_cycle_count_item` stores the exact on-hand (no rounding), so `variance = counted - on-hand` exactly.
  Complete then lands on the counted figure, plus any stock move between Save and Complete, as today.
- **Unchanged.** Its percentage and the rest of the body. The baseline is still taken when Save reaches the database.
- **Luna r1.** A non-finite on-hand is refused (`CYCLE_COUNT_ON_HAND_INVALID`), since the column no longer refuses it.
  The migration refuses to apply while an open count has saved lines (their baseline was rounded at Save, Luna r2);
  complete or cancel that count first.

### C. The `app.admin_override` escape on order-line edits
- **Fact.** `_guard_order_item_delivery_lineage` (BEFORE UPDATE OF `order_id`, `product_id` ON `order_items`) returns
  early when `app.admin_override` is on.
- **Risk.** A definer flow that sets the override could move an order line to another order or product under its
  delivery lines. The KI-161 delivery-line check covers inserts and updates of delivery lines only, so it would never
  see this.
- **Evidence that nothing needs the escape.** The only statement anywhere (baseline plus every later migration) that
  updates `order_items.product_id` or `order_id` is `_update_order_items_impl`'s product swap, which runs with the
  override off. The flows that set the override change quantities or delete delivery lines, never an order line's
  order or product:
  - complete, cancel and void delivery;
  - close remainder;
  - reverse receipt;
  - restore quote owner;
  - `_update_order_items_impl` deleting delivery lines of cancelled or voided deliveries.

  Signed-in users cannot set the setting.
- **Change.** Re-emit the guard without the early return; everything else is identical. A reviewed data correction
  that must move such a line disables the trigger explicitly, as 20270121100000 does its guards.

### D. Astra 13: stale line ids in a partial completion
- **Fact.** `p_quantities` is keyed by delivery-line id. The body ignores a key that is not one of this delivery's
  lines, and delivers in full any line without a key. A JSON-null figure also delivers in full.
- **Evidence on callers.**
  - `DeliveryDetail.tsx:1202` and `FieldStop.tsx:405` send either no `p_quantities` (full delivery) or one number for
    EVERY line they loaded (`Object.fromEntries(items.map(...))`). `deliveryQtys` is `Record<string, number>`.
  - The offline queue stores the same object (`offlineReceipts.ts:64`), and `process_offline_action` passes
    `request_payload->'quantities'` through.
  - No caller sends a sparse object.
- **Change.** While the delivery is `in_progress` and `p_quantities` is not SQL NULL, the wrapper checks two things.
  1. It refuses `DELIVERY_QUANTITIES_INVALID` unless `p_quantities` is a JSON object whose every value is a JSON
     number. JSON null, an array, and a blank or text figure are all refused.
  2. It then refuses `DELIVERY_QUANTITIES_STALE` unless the keys are exactly this delivery's line ids. Keys are compared
     as text, exactly as the body looks them up, so an extra key, a missing line, or other letter case is refused.

  Both refusals are `check_violation`, and nothing moves. The screen says to reload. SQL NULL (full delivery) behaves
  as today.
- **Offline receipts (corrected after Sol r1).** A queued offline receipt calls `complete_delivery` without completion
  evidence, so since 20261022075000 it stops at `COMPLETION_EVIDENCE_REQUIRED` before reaching D's checks.
  `process_offline_action` (20260714203709) then marks it `needs_review` (`PAYLOAD_INVALID`, office review) with its
  quantities and signature kept, as today. D's refusal is reached by the screens' online completion. Were the queue
  to send evidence later, D's refusal (also `check_violation`, class 23) lands in the same office review.

### E. Astra 36: the same product on two lines can go short without a warning
- **Fact.** The body's first loop compares each line's quantity with on-hand on its own, before any deduction. Two
  lines of 6 against 10 pass, stock goes to -2, and there is no warning and no review flag.
- **Change.** Re-emit the body (md5-pinned, under its current name `_complete_delivery_authorized_impl_20270122`) with
  one change in that loop:
  - Before the loop, sum what the delivery takes of each product, using the same lookup and clamp.
  - In the loop, compare on-hand with that product's total, and warn and count once per product, whatever the line
    order.
- **Result.** Two lines of 6 against 10 now warn once ("need 12, only 10 on-hand"). Both lines' `delivered` rows carry
  the review flag, as for any short product. A single line behaves as before. Completion still goes ahead (U9
  warn-not-block, unchanged).

## 2. State and failure
- **Existing rows.** No row is rewritten. The count columns widen in place (removing a numeric typmod needs no table
  rewrite). Old stored expected and variance values keep their 4 places. Missing stock rows are created only by a
  completion, as today. No existing delivery, ledger row or flag is rewritten, so a past two-line shortage stays
  unflagged.
- **Open counts at apply.** A count line saved before the apply keeps a 4-place baseline rounded from on-hand at Save,
  so the migration refuses to apply while an open count has saved lines, until it is completed or cancelled
  (Luna r1, r2).
  - Pre-apply read-only check (UNVERIFIED): `SELECT count(*) FROM cycle_counts WHERE status = 'in_progress'`,
    expected 0.
- **Timing.**
  - Two completions sharing products, with or without stock rows: one waits, with no deadlock.
  - A retry of a completion returns its saved receipt before any new check, because the wrapper's checks and row
    creation run only while the delivery is `in_progress`, and the receipt is checked before the body's status check.
- **Rollout.** The deployed screens send every loaded line id with a number. Only a stale screen, or an offline receipt
  for a delivery edited in the meantime, sees the new refusal.
- **Undo (revised after Sol r1).** The rollback script first checks the four bodies are still #1942's, refusing with
  nothing replaced if a later change touched one. It then restores the four previous bodies (md5-checked).
  - The two count columns stay plain `numeric` with their finite check. Narrowing them back would round away the exact
    baseline and adjustment of counts saved under #1942, which Complete and a later reversal use.
  - The restored function stores 4 places again, which plain `numeric` holds unchanged.

## 3. Delivery
One DB PR to `staging`, plus the new messages in `src/lib/errorSanitizer.ts` (shown only when the database refuses).

## 4. Proof cases (real-schema prover in Docker, test data)
- **A, the race.** Two completions share two products with NO stock rows, in opposite line order, and run at once.
  The race sessions are held to the line-order plan, and a slow test insert trigger makes the overlap happen every run.
  - Before: one dies in a deadlock.
  - After: both finish (one waits). Each ends at minus its quantities on rows flagged `manufactured_at_delivery`, with
    its delivered rows flagged for review.
- **A, the retry.** A retry of a completed delivery returns its receipt and creates no stock row, even for a product
  it now lists.
- **B.** On-hand 12.3456789 counted at 12.35 by the signed-in admin and completed:
  - before: 12.3499789;
  - after: exactly 12.35, with the exact on-hand stored;
  - a stock move of +1 between Save and Complete still carries through (13.35).
- **C.** An override-on update of an order line's product or order, with a delivery line, is refused
  (`ORDER_ITEM_DELIVERY_LINEAGE_LOCKED`). Without delivery lines it saves, and a quantity change still saves.
- **D.** Refusals, each caught as the offline queue catches it, leave nothing moved or created:
  - a key that is not a line, a missing line, or a key in other letter case is refused (`DELIVERY_QUANTITIES_STALE`);
  - JSON null, an array, or a blank or text figure is refused (`DELIVERY_QUANTITIES_INVALID`).

  A payload naming every line with a number completes as today.
- **E.** Two lines of 6 of one product, 10 on hand:
  - before: no warning;
  - after: one short warning ("need 12, only 10") and both delivered rows flagged for review;
  - stock is -2 either way.

  Exactly enough (12), a partial that fits (6 + 4), or one line at zero: no warning. A partial one short (6 + 5): warns.
- **Function settings and undo.**
  - Functions stay `SECURITY DEFINER` with `search_path = public, pg_temp` and no anon execute.
  - Only `update_cycle_count_item` keeps `authenticated` execute.
  - A second apply refuses.
  - The table refuses a non-finite baseline from any writer.
  - The rollback refuses while a body has drifted, then restores the old bodies and keeps a 7-place baseline exact.
- **Race overlap.** The proof checks that both completions' transactions were open at the same time.

## Cold challenge (gpt-6.2-astra high, 46 findings): how each was settled

**Corrected in the contract and code**
- #28 (BLOCKER): D must also catch a missing line, not only an extra key.
- #31: malformed payloads are refused.
- #32: key matching is exact text.
- #5: the grant wording is fixed.
- #22: the override census now includes the delivery-line deletes.
- #7, #44: A and E use one ordered per-product pass.
- #37, #38: E warns once per product, independent of line order.
- #41 (BLOCKER), #42: the rollback no longer refuses on extra places. Revised after Sol r1: it keeps the exact columns
  instead of rounding them.

**Settled by evidence**
- #30, #33: both screens send every line or none.
- #34: an offline receipt reaches office review with the receipt kept (`process_offline_action`, 20260714203709),
  today for missing completion evidence (see D, corrected after Sol r1).
- #36: a refusal moves nothing (proof case D).
- #2: a replay is answered from the receipt before the status checks.
- #23: the postflight checks the trigger is attached and enabled.

**Covered by proof cases:** #11; #12 (a deterministic race with a slow insert trigger and the line-order plan); #39; #43.

**Out of this scope.** These are unchanged behaviour, not made wrong by #1942: #1, #3, #8, #9, #17, #19-#21, #24, #29
and #40. (#29: a changed quantity on a kept line id is still clamped.)

**Follow-up candidate outside inventory scope.** #27: `_update_order_items_impl` loads an existing item by id alone.
Not checked here.

**DECISION labels re-examined.** #4 and #26 are technical. #17 and #40 keep today's rules. #34 is answered by the office
review path. None needs Mason.

## Open business decisions
None. D's refusal (stop, reload, re-enter; offline receipts go to office review) replaces a silent full delivery of the
wrong figures. The completion still never blocks on stock.
