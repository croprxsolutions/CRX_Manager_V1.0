# Behavior contract: follow-up remainders survive cancel and void (KI-188, #2179)

Read on `origin/staging` `84e8df019` (2026-11-22). Lane C of the 2026-11-22 high-bug sprint. Revision 4, after three
cold challenges (Astra, gpt-6.2-astra high, 2026-11-22: round 1 BLOCKED with 54 findings, round 2 24, round 3 57 with
3 BLOCKER) and Mason's decision at the round cap (2026-11-22, option A, "Cancel newest first"; DECISION_LOG.md). The short-stock half (#2135) moved to
its own contract and PR (`2026-11-22-single-short-stock-warning-CONTRACT.md`).

## Facts (with source)

- `delivery_remainders`: every column but notes/unit_size/followup NOT NULL with foreign keys (original delivery,
  order, order line, customer, product); `quantity_remaining > 0`; status pending/scheduled/fulfilled/cancelled
  (`20260225200000` L102-117). Rows are written only by completion (one per short line, `original_delivery_id` = the
  completed delivery, `pending`; `20270203120000` ~L572-586).
- `create_followup_delivery(original)` (`20261204100000` ~L3221-3345) turns every `pending` row of one original into
  lines of a new delivery F: `scheduled`, `followup_delivery_id = F`. Scheduling does not change the order line's
  `quantity_remaining`; only completion lowers it (`GREATEST(remaining - delivered, 0)`, `20270203120000` ~L523).
- Completing F marks its rows `fulfilled` (~L597-600) and writes F's own short lines as new rows with original F
  ("successor rows").
- Cancel (`20270126110000` L263-473) runs on scheduled/in-progress deliveries only; an in-progress delivery's
  recorded `quantity_delivered` goes back to stock and to the order line (~L337-347). It locks the order (~L354), may
  auto-cancel a quick-delivery order (~L399), then touches only rows whose ORIGINAL is the cancelled delivery
  (~L431-432; completed deliveries cannot be cancelled, so these are normally none). Rows scheduled on the cancelled
  delivery stay `scheduled` forever: the bug.
- Void (`20261107120000` L63-365, admin only) gives each line's delivered quantity back to the order line unless the
  order is cancelled (~L264-269), then deletes EVERY row whose original is the voided delivery (~L272), including
  rows a later delivery G still holds or delivered. Rows the voided delivery fulfilled stay `fulfilled`: the bug.
  A voided order refuses earlier (`ORDER_VOIDED_DELIVERY_LOCKED`, ~L129-149).
- The queue (`src/pages/DeliveryRemainders.tsx`) defaults to `pending`, shows Schedule only for `pending` rows with no
  follow-up link; it fetches on open (no live refresh).
- Live had no remainder rows on 2026-11-21 (`docs/audits/2026-11-21-quote-to-invoice-audit-verification.md`).
- `update_order_items` and every other order edit never touch `delivery_remainders` (grep of all migrations): a
  pending row keeps its quantity whatever happens to the order line afterwards, today.
- A follow-up delivery is created with `is_quick_delivery` false, so cancel's quick-order branch (~L356-420) never
  runs for a delivery that carries remainder rows.
- Completed deliveries cannot be cancelled (`20261102140000`, `DELIVERY_COMPLETED_USE_VOID`).

## 1. Outcome and authority

- **Outcome.** Cancelling a follow-up delivery, or voiding a completed one, puts the remainder rows it carried back
  on the Delivery Remainders queue as `pending`, so dispatch can schedule them again. Nothing is queued for an order
  that is cancelled, voided or deleted, or an original delivery that is.
- **Business rule.** Reopening is the exact undo of `create_followup_delivery`: the row goes back to `pending` with
  the link cleared and the **same quantity**, the state it was in before it was scheduled. No quantity arithmetic, no
  merging, no re-pointing.
- **New refusal: newest first (Mason, 2026-11-22).** Cancelling or voiding a delivery is refused with
  `FOLLOWUP_STILL_OPEN`, naming the deliveries, while ANY later delivery in its follow-up chain is still live (any status but
  cancelled or voided; nothing in the app soft-deletes a delivery, so a soft-deleted one still counts as live). The check walks the whole chain through every remainder link, whatever the
  row's or the middle delivery's status, so a live grandchild behind an already-closed child still blocks. Staff undo
  the newest trip first. Reopening only happens in that clean case. (Today voiding first deletes the rows the later
  delivery carries and loses those units on its reversal.)
- **Who may act** is unchanged (cancel: admin and sales rep as today; void: admin). The two private bodies keep EXECUTE
  revoked from PUBLIC and the API roles. No new function.

## 2. State rules

0. Cancel or void D: first the newest-first refusal above, after the existing status, lock and return checks and
   before any write.
1. Cancel D (scheduled or in progress): every row with `followup_delivery_id = D`, status `scheduled` → `pending`,
   link cleared, quantity unchanged; → `cancelled`, link kept, when the order or the row's original delivery is
   cancelled, voided or deleted. Runs inside cancel's order lock, after its existing remainder updates.
2. Void F (completed): after the existing give-back and the
   existing delete of F's own rows, every row with `followup_delivery_id = F`, status `fulfilled` → `pending` (or
   `cancelled`) as in rule 1. A void on a cancelled order does not raise the line (existing rule), so its rows close.
3. Rows of other deliveries, other statuses, and legacy stuck rows are not touched.

Why the quantities add up: a row's quantity is what the original was short. Scheduling moved it onto D unchanged;
D's give-back (cancel of in-progress, or void) restores exactly what D delivered to the order line; D's own short
rows (void only) are deleted as today, and with the refusal none of them is still held by a live delivery. So the
queue shows the original's shortfall again, once.

## 3. Timing, retries, legacy, undo

- Same transaction and lock order as today: the refusal only reads; the reopen statements run after the order row
  lock the bodies already take and touch only rows linked to the delivery being reversed (which the body has
  locked). No new locks. Known limit: a follow-up created from a later chain delivery at the same instant as this
  cancel/void is not seen by the read; the same instant race exists today and is part of C3 (#2190).
- Replay with the same key returns the saved receipt and writes nothing (existing wrappers; proved for both).
- Legacy rows already stuck (`scheduled` on a cancelled delivery, `fulfilled` on a voided one) are not rewritten; the
  postflight prints `LEGACY_STUCK_REMAINDERS: n` for the apply record. Live had no remainder rows on 2026-11-21.
- Undo: the reverse script restores both bodies byte for byte. Rows reopened meanwhile stay `pending`, which the old
  code treats as ordinary queue rows.
- Out of scope, unchanged: a pending row is not resized when the order line changes later (true of every pending
  row today, finding 1/15 of round 2); concurrency of completion against cancel (C3, #2190).

## 4. Delivery

One migration (`20270213110000`) re-emits both bodies with the added statements, md5 baseline preflight (also refuses
if an API role can run either body), autocommit refusal, md5/owner/definer/search_path/effective-grant postflight
(anon, authenticated, service_role). The reverse script has the same autocommit and drift refusals and its own
postflight (`REVERSE_OK`). `src/lib/errorSanitizer.ts` maps the refusal to plain English.
F05 (quote-to-cash remediation) adds triggers on `delivery_items`/`order_items`; this file adds none, but both bodies
already update `order_items` when called, so F05's triggers fire inside cancel and void, and on
`create_followup_delivery` when dispatch re-schedules a reopened row.

## 5. Proof cases (real migrated DB, `scripts/smoke/prove-followup-remainders-real-schema.mjs`)

Order line 10, O delivered 4 of 10 (row R: 6 pending). F = follow-up of R. Through the public RPCs as the admin.

1. Cancel scheduled F: R pending 6, link cleared; re-scheduling makes one line of 6; same key same delivery; fresh key
   `NO_PENDING_REMAINDERS`; replaying the cancel returns the same receipt and leaves the replacement as it is.
2. Cancel in-progress F with 2 recorded delivered: line back to 4/6, R pending 6.
3. Void fully delivered F: line 4/6, R pending 6; same void key replays with no change; re-schedule gives 6.
4. Void F that delivered 4 of 6 (its short row S 2 pending): S deleted, R pending 6 (not 8).
5. S scheduled on G: void F refused, nothing changes; cancel G (S pending 2); void F: R pending 6.
6. S delivered by G: void F refused; void G (S pending 2); void F: R pending 6.
7. Legacy: G cancelled under the old code with S left `scheduled`: void F allowed, R pending 6.
7b. Chain O, F, G, H with G closed (legacy) but H live: void F refused, naming H, nothing changes.
7c. Hand-made (the database keeps a completed delivery from going back to scheduled): a scheduled F whose own row is
    linked to a younger live delivery: cancel F refused, naming that delivery, nothing changes.
8. Order cancelled, void F: line not raised, R cancelled, re-schedule refused.
9. Order cancelled, cancel F: R cancelled.
10. Cancelling an unrelated delivery changes no remainder row.
11. Driver cancel and rep void refused with no change; no API role can run either body.
12. Before the candidate the bug reproduces (cases 1, 3, and old void deleting S); apply refuses autocommit and a
    second apply; reverse refuses autocommit and a second run, restores both bodies byte for byte (`REVERSE_OK`);
    the candidate re-applies.

## Challenge settlement

Round 1 (54 findings, BLOCKED) led to revision 2 (exact undo with caps and merging). Round 2 (24 findings) showed
the caps, merging and re-pointing were themselves the defect source (findings 1-7, 9-14, 17). Revision 3 removes
all of them: no quantity arithmetic, no merge, no re-point, no helper function.

- 1, 15 (demand fell): the row returns at the quantity it had before scheduling, exactly as if it had never been
  scheduled; pending rows are never resized by order edits today (fact above). Not widened here.
- 2, 3, 5, 6, 7 (multi-source, edits, merge, unit size, queue age): no merge or kept arithmetic remains; each row
  returns as itself with its own unit size, product and created date.
- 4 (displaced claims): no capping, nothing is discarded.
- 8 (terminal holder): the refusal ignores cancelled/voided holders; case 7.
- 9 (void of a root with a live child): refused; cases 5 and 6.
- 10 (cross-order lineage): the statements match only on `followup_delivery_id` = the reversed delivery and read the
  row's own order and original; no cross-row arithmetic.
- 11 (pending with a link): not touched (rules match `scheduled`/`fulfilled` only).
- 12 (provenance): no re-pointing; rows keep their original.
- 13, 14 (locks): only rows linked to the locked delivery are written; no other delivery's pending rows are locked.
- 16 (quick branch): follow-ups are never quick deliveries (fact above).
- 17 (helper grants): no helper; postflight checks the two bodies' grants.
- 18 (refusal before writes): the void refusal runs before any write; replay proved for void (case 3) and cancel
  (case 1 scheduler replay plus existing cancel replay).
- 19 (autocommit): marker check split from the read, the house pattern; proof asserts the refusal message.
- 20 (legacy count): reported, not used as proof of no loss; live had no rows.
- 21 (rollback): reopened rows stay valid pending rows under the old code.
- 22, 23: proof runs apply, reverse, re-apply, and each case reads row identity, status, link and quantity.
- 24: round 1's 53/54 settled by revision 2's rewrite; this list replaces it.

Round 3 (57 findings, 3 BLOCKER) hit the review-round cap; Mason chose option A (newest first). Settled here:
blocker 16 (live grandchild behind a closed child: whole-chain walk, case 7b), 34 (reverse autocommit: marker and
postflight), 19 (missing delivery number: falls back to the id), 21 (cycles: UNION stops), 31 (cancel replay: case 1),
35/36 (grants: preflight and postflight check anon, authenticated and service_role), 53 (F05 wording). Blocker 26
(completion against void lock order) is the existing void body's lock order, unchanged here, and is C3 (#2190).
The remaining findings concern legacy or hand-made states (stale links, cross-order rows, in-progress amounts) that
live does not contain (no remainder rows on 2026-11-21) and the newest-first rule prevents from now on.

Round 1 on the newest-first mechanism (Astra, 58 findings, 3 BLOCKER):
- Blocker 2, blocker 21, findings 3/19 (soft-deleted deliveries): "live" now means any status but cancelled or voided;
  a soft-deleted delivery blocks. No code path soft-deletes a delivery (grep of migrations and `src/`).
- Blocker 21 otherwise: a closed (cancelled or voided) later delivery holds no rows of its own (cancelled ones never
  completed; void deletes its own rows), so no scheduler can start from it.
- Blocker 1, findings 4/5/7/10-12/41/45 (states made by the old code or by hand: severed or stale links, cycles,
  cross-order rows, status mismatches): live had no remainder rows on 2026-11-21, and with this change cancel/void
  no longer create them. Not handled beyond the refusal.
- 46: case 7c now links to a younger delivery and checks it is named. 50: the role refusals must be the role checks.
- 33 (`fix_delivery`): it calls `void_delivery` with PERFORM (`20261106150000` L468); the refusal raises and rolls
  the whole correction back, and the same plain-English message shows.
- 14-17, 25, 28-30 (order edits, in-progress amounts, completion/void arithmetic, lock order, replay binding): existing
  behavior of the unchanged parts of these bodies and of the wrappers; out of scope here (C3 #2190 covers locking).

**Parked (Mason, 2026-11-22):** Astra round 2 on this mechanism (66 findings, 3 BLOCKER: links already deleted by the
old void, the scheduler racing a reversal, a SQL client that continues after errors) hit the cap. C1 waits for C3
(#2190: locking and a scheduler status re-check), then re-runs its review on that base.

## Open business decisions

None left. Mason decided the newest-first rule on 2026-11-22.
