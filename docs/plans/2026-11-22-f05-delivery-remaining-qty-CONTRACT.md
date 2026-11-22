# F05 — An order line can never be scheduled or delivered past what was ordered (behavior contract)

Read at `origin/staging` `9a1c5b2d9`. Source: staging audit 2026-11-21 (tracker `2026-11-22-quote-to-cash-remediation-TRACKER.md`).

## Facts (with source)

- Staging, ORD-2026-0017: line ordered 2; DEL-00014 shipped 1; DEL-00015 (New Delivery screen) and DEL-00016 (Create Follow-up Delivery) each scheduled the last unit; both completed. Line now reads 2 ordered / 3 delivered; stock moved for the extra unit; a $0 draft was made.
- Staging, ORD-2026-0014: line cut from 10 to 6 while DEL-00009 still had 10 scheduled; nothing refused or adjusted it.
- `create_delivery_with_items` checks `quantity_remaining − other scheduled/in_progress lines` under `orders` + `order_items` locks (`20260518010000…:152-186`). It never reads `delivery_remainders`.
- `create_followup_delivery` (`20261204100000…:3221`) copies `delivery_remainders.quantity_remaining` into a new delivery with no check of what is already scheduled; it locks only the original delivery and the remainders. So the two paths never see each other.
- `edit_delivery` checks remaining minus other open lines (`20260611211058…:1554-1569`).
- Completion core (`20270203120000…:523-525`) adds to `quantity_delivered` and clamps `quantity_remaining` at 0 with `GREATEST`; nothing checks delivered ≤ ordered.
- `update_order_items` core (`20260617123503…:203-229`) sets the new ordered quantity without checking delivered or scheduled quantities.
- No trigger or constraint enforces delivered ≤ ordered (`20260209200000…:24-25` only enforces ≥ 0).
- Order lines and delivery lines are in the same unit (`_delivery_line_matches_order_line`, `20270126110000…:100`), which already locks the order line `FOR UPDATE` on every delivery-line insert or re-link.
- Completion screens already cap the actual quantity at the scheduled quantity (`DeliveryDetail.tsx:664`, `FieldStop.tsx:323,708`), so a driver can only over-deliver when the schedule itself is already over the order.
- "Remaining After" on a completed delivery subtracts this delivery twice (`DeliveryDetail.tsx:2636`: `ordered − prevDelivered − actual`, where `prevDelivered` already includes it).

## 1. Outcome and authority

**Outcome.** For every order line: delivered + still scheduled on open (scheduled / in-progress) deliveries never exceeds ordered. Any write that would break that is refused with a plain message naming the deliveries involved; nothing is moved, deducted or drafted.

**Smallest change.** One migration with three database triggers sharing one check (the third, for a cancelled load reopened, was added after the challenge below), so every path (New Delivery, Quick Delivery, Follow-up, edit, completion, start-and-complete, order edit, and any future path) is covered in one place instead of patching six functions:

1. **Delivery line trigger** (`delivery_items`, before insert, or update of quantity / order line / delivery): when the parent delivery is scheduled or in progress and the line's scheduled quantity goes up (or the line is new or re-linked), lock the order line and refuse if `delivered + other open lines for this order line + this line > ordered`. Error `DELIVERY_OVER_ORDER`.
2. **Order line trigger** (`order_items`, before update of delivered or ordered quantity):
   - delivered goes up and delivered + other open loads ends above ordered → refuse `DELIVERY_EXCEEDS_ORDER` (completion is rolled back whole: no stock move, no draft). Revised after the challenge (#1) and Mason's 2026-11-22 "yes": checking delivered alone let one load use units another open load held.
   - ordered goes down and ends below `delivered + open scheduled` → refuse `ORDER_LINE_BELOW_DELIVERIES`, naming the open deliveries to edit or cancel first.

Screen PR (separate, no database dependency): fix "Remaining After" on completed deliveries; show the new refusals in plain words where the screens already show RPC errors.

Files: `supabase/migrations/<new>_f05_order_line_quantity_guard.sql`, `scripts/smoke/prove-f05-order-line-quantity-guard-real-schema.mjs`, reverse script, changelog + migration ledger docs, `src/lib/rpcContracts.test.ts` if error codes are listed there; screen PR: `src/pages/DeliveryDetail.tsx`.

**Authority.** Unchanged. Triggers add a refusal only; who may schedule, edit, complete or change orders stays with the existing RPCs. Triggers are `SECURITY DEFINER`, `search_path = public, pg_temp`, EXECUTE revoked from everyone (trigger-only).

**Screen values.** None new. Quantities and order-line links are checked against the database rows, not the screen.

## 2. State and failure

**Automatic record changes.** None. The app stops and explains; staff edit or cancel the extra delivery, or raise the order line, then retry. Stopping is the recommended rule because staff keep a safe way to finish (edit delivery, cancel delivery, Create Follow-up after the other load is cancelled).

**Rules that always hold.** Each refusal is a `RAISE` inside the same transaction as the write, so stock, remainders, invoice drafts and history roll back with it. Receipt emails are queued in that transaction (`delivery_receipt_queue`), so they roll back too.

**Existing rows.** Triggers fire only when a quantity goes up (delivery line) or when delivered rises / ordered falls (order line). Already-over rows (staging ORD-2026-0017) are left as they are and can still be reduced, cancelled or voided. Readers are unchanged.
- Before live apply, read-only checks (run by the apply step, not now): count order lines with `quantity_delivered > total_units_needed`, and order lines where `quantity_delivered + open scheduled > total_units_needed`. The second set are open loads that will be refused at completion until the office trims them; that list goes to Mason with the apply.
- The already-deployed app keeps working: it calls the same RPCs; only the refusal is new.

**Timing.**
- Standard schedule vs follow-up at the same time (the F05 race): both lock the same order line row (existing line-match trigger, plus the new trigger), so the second waits, then sees the first's committed line and is refused.
- Order cut vs scheduling at the same time: the order edit holds the order line lock; the schedule waits, then sees the new ordered quantity.
- Two completions of loads for one line: the order line update serializes them; the second is refused if it would pass ordered.
- Retry with the same key after a refusal: the refusal is not saved as a success, so a retry re-checks and is refused again (or succeeds if staff fixed the cause). Same key after success replays as today.
- Deadlock risk: scheduling and edits add no new lock order (same delivery → order line order as the line-match trigger). Rare new pairs exist: restoring a cancelled load (service role only, no screen) against closing an order's remainder, a completion, or a line change on that same load (Luna r1; a cancelled load's lines are already refused or fail at once by the parent-lock trigger's NOWAIT). Postgres cancels one side and nothing is half-saved; same class as the completion-vs-scheduling cross-order Mason accepted (DECISION_LOG 2026-11-18 #1940). The apply locks the three tables up front in completion's order with a 5-second wait limit.

**Undo.** Cancel and void lower quantities, so they are never blocked by the new triggers.

## 3. Delivery

Database PR first (target `staging`, Sol required: migration + inventory). Screen PR for "Remaining After" can go any time; it does not depend on the database change.

## 4. Proof cases (disposable Postgres via the real-schema prover; then staging app)

1. ORD-2026-0017 replay: order 2, deliver 1, schedule last unit through `create_delivery_with_items`, then `create_followup_delivery` for the same remainder → follow-up refused `DELIVERY_OVER_ORDER`; nothing created.
2. Reverse order (follow-up first, then New Delivery) → New Delivery refused (existing check), follow-up stands.
3. Legacy double schedule already present (two open loads for one unit, created with the trigger disabled): completing either → refused `DELIVERY_EXCEEDS_ORDER`, naming the other load (Mason, 2026-11-22); nothing kept by the refused call; after the office cancels one, the other completes. An in-progress load cannot be edited, so the message says cancel, not reduce (rls-security-reviewer M1).
4. Order cut 10 → 6 while 10 scheduled → refused `ORDER_LINE_BELOW_DELIVERIES`; after editing the delivery to 6, the cut succeeds.
5. Order cut below delivered (no open loads) → refused.
6. Partial completion (schedule 10, deliver 6) → allowed; remainder 4 created; follow-up for 4 allowed.
7. `edit_delivery` raising a line past what is left → refused; lowering → allowed.
8. Quick Delivery and start-and-complete still succeed on normal inputs.
9. Same idempotency key retried after a refusal → refused again, no receipt saved; distinct keys from two sessions at once → exactly one succeeds (two psql sessions).
10. Cancel and void of an already-over legacy delivery → allowed.
11. Staging app (synthetic QA fixture, after staging apply): reproduce case 1 through the New Delivery screen and the Create Follow-up Delivery button; the second shows the refusal; database unchanged.

## Challenge (Astra `gpt-6.2-astra` high, 2026-11-22, 43 findings) and settlement

The design above was revised; the migration implements the revision.

- **#1 BLOCKER (fixed):** a delivered rise was checked only against ordered, so it could use units held by another open load. Now one rule everywhere: `delivered + open loads ≤ ordered`, checked when delivered rises (completion marks its own load completed first, `20270203120000…:505-525`, so it is not counted twice). Case 3b.
- **#2 BLOCKER (fixed):** `restore_cancelled_delivery` (`20260714220000…`, service role only, no screen) and any later path can reopen a cancelled load. New header trigger checks the reopened load's lines. Case 3c.
- **#3 (fixed):** order-line check also runs on insert. Case 3d.
- **#4 DECISION → settled by the stop rule:** two open loads already holding the same unit: neither completes until the office cancels the extra one (cancel is allowed for scheduled and in-progress loads by admin/sales rep). Chosen because it never moves stock twice and staff keep a safe action. Listed for Mason below.
- **#9 (corrected):** Follow-up does take the order-line lock (through the line-match trigger) but never checks capacity after it; New Delivery does see a committed Follow-up. The fix is the capacity check after the lock.
- **#11, #12, #35 (fixed):** messages name the product, the numbers and the other open loads, tell the driver to ask the office, and no longer suggest raising the order.
- **#19 (fixed):** helpers are `VOLATILE` and read after the lock in a separate statement; the two-session race (case 9b) proves the waiting session sees the first commit.
- **#40 (fixed in part):** the migration prints how many lines already have open loads past their order; the apply step reports that list before live apply.
- **Declined / out of scope, with reason:**
  - #7, #8 (which counter is authoritative; stored `quantity_remaining` vs ordered − delivered): existing drift, not changed here; New Delivery and Edit keep their own earlier check, the trigger is the backstop.
  - #10 (Edit Delivery cannot shrink a load that is still over): existing Edit behaviour; staff cancel the extra load instead.
  - #13, #14 (voiding a legacy over-delivery leaves the wrong remaining; whether the extra unit really left): legacy cleanup, staging only so far; tracked as follow-up F05b with the live count.
  - #15–#18 (stale pending remainders, Follow-up order-status check, partial Follow-up): existing remainder lifecycle; F05b.
  - #21, #23 (deadlock between completion and order edit): no new lock order; Postgres cancels one and nothing is half-saved (Mason accepted, DECISION_LOG 2026-11-18 #1940).
  - #28 (driver sees other delivery numbers): only loads of the same order and customer; acceptable.
  - #32, #33 ("Remaining After" meaning): screen PR shows remaining as of now on completed loads; handled there.

## Open business decisions

1. **Answered — Mason, in chat, 2026-11-22: "yes".** (#4) When two open loads already hold the same units from before this fix, should completing either one be refused until the office cancels the extra load? **Recommended: yes.** Effect: a driver with such a load is told to call the office; no stock moves twice. (Alternative: first load to complete wins and the other is refused — the driver of the second load finds out only at the farm.)
