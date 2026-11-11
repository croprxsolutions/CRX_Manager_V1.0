# KI-134 stock count double-counts in-count movement — behavior contract

Read at `17ba96fbe` (origin/main, 2026-11-10). Live bodies read read-only from `rhyzpcqhnizqbxphqdkr` the same day.

## Facts (with source)

- Count creation is browser-only (`src/pages/CycleCounts.tsx` `handleCreate` ~L240-300): `next_cycle_count_number()`,
  then a table insert into `cycle_counts`, then one insert of every `inventory` row at the warehouse into
  `cycle_count_items` with `expected_qty = inventory.quantity_available` read by the browser at that moment.
- Counting: every change of the Counted box calls `update_cycle_count_item(p_item_id, p_counted_qty, p_notes,
  p_performed_by, p_idempotency_key)` (newest definition `20260831212415_guard_cycle_count_completion_revision.sql`; live md5 pinned in the
  migration). It locks the item then the parent count, refuses unless `in_progress`, sets
  `variance = counted - expected_qty`, `variance_pct`, `is_counted`, `counted_by`, `counted_at = now()`, and returns
  `{item_id, counted_qty, variance, variance_pct, is_counted, item_revision}`; the receipt is bound to actor +
  `{item_id, counted_qty, notes}` fingerprint.
- Complete: `complete_cycle_count` locks items, parent (revision check), then the counted `inventory` rows, and calls
  `_complete_cycle_count_impl`, which for every counted line with non-zero variance sets
  `inventory.quantity_available = current + variance` (refusing a negative result) and writes an `adjusted` ledger
  row. Reverse subtracts the same `variance`.
- So the adjustment is `counted - on_hand_at_creation`, applied to today's on-hand: any receipt/delivery between
  creation and the count is applied twice (KI-134).
- The screen computes and shows its own variance (`counted - item.expected_qty`, ~L480) instead of the RPC's.
- Live: 17 counts, all `cancelled`; 0 `in_progress`, 0 `completed` (read-only, 2026-11-10).
- Admins may also write `cycle_count_items` columns directly (RLS `cycle_count_items_update`: admin + in-progress).
  Admins can already adjust stock directly; this contract does not change that trust.

## Outcome and the smallest change

**Business rule:** a count line's adjustment is "what was on the shelf when it was counted" minus "what the app said
was on hand at that same moment". Stock that moves before or after that moment is not counted twice or lost.

1. `update_cycle_count_item` (one re-emit, new migration `20270103170000_...`): when `p_counted_qty` is not null,
   it first reads the line's `inventory.quantity_available` (row by `inventory_id`) and stores it as the line's
   `expected_qty`, then computes `variance` / `variance_pct` against it as today. If the line has no inventory row
   (`inventory_id` null or row gone) it keeps the stored `expected_qty` (Complete skips such lines anyway). Clearing
   a count (null) leaves `expected_qty` as it is. The result adds `expected_qty`. Nothing else changes.
   - "Counted moment" = the save. Every save of a number re-locks on-hand: entering a number asserts what is on
     the shelf now. A correction typed hours later after stock moved is treated as a recount at that time.
   - Lock order stays item -> parent -> (read) inventory, the same order Complete uses; the inventory read is a
     plain read (no lock): a delivery committing after the read is movement after the count and is kept by
     Complete's `current + variance`.
2. Complete, reverse, cancel, creation: unchanged. Complete still adds `variance` to current on-hand, which is now
   correct; its ledger note "adjusted from <expected> to <counted>" now names the on-hand at count time.
3. Screen (`CycleCounts.tsx`): after a save, show the server's `expected_qty`, `variance`, `variance_pct` from the
   RPC result instead of its own arithmetic; when an old database answers without `expected_qty`, fall back to
   `counted - variance`. Column header "Expected" becomes "On hand" with a tooltip "On hand when this line was
   counted". Works against the old and the new database, so one PR is safe.

Files: the new migration + its changelog record, `src/pages/CycleCounts.tsx` (+ its test if one covers the save),
a container prover `scripts/smoke/prove-cycle-count-onhand-at-count-real-schema.mjs`, the live smoke chain
(`smoke-specs.json` entry for `update_cycle_count_item`), `docs/manual/KNOWN_ISSUES.md`.

**Authority:** unchanged — admin only, actor bound, idempotency key required, receipt fingerprint unchanged
(`counted_qty`, `notes`, `item_id`). The browser sends only the item id and the counted number; on-hand is read by
the server.

## State and failure

- **Existing rows:** no open or completed counts live. An `in_progress` count created before the apply keeps its
  creation-time `expected_qty` only on lines not yet re-saved; uncounted lines produce no adjustment, and each
  counted line gets a fresh on-hand at its next save. A line counted BEFORE the apply and never re-saved keeps the
  old variance (none exist live).
- **Timing:** retry with the same key replays the stored result (the old expected) without re-reading on-hand —
  correct, the operation already happened. Two admins saving the same line: item lock serialises; last save wins
  with its own on-hand. Save racing Complete: unchanged revision guard (save bumps `item_revision`; Complete
  refuses a stale revision).
- **Undo:** reverse subtracts the stored variance from current on-hand, as today.

## Proof cases (container prover, real migrated schema, real RPCs)

- P1 BEFORE the migration (fail-first): count created at 100; a receipt adds 10 (110 on hand); counter counts 110;
  Complete leaves 120 (the bug).
- P2 AFTER: same — Complete leaves 110; variance 0; no adjustment ledger row.
- P3 delivery during the count: created at 100, 10 leave (90), counter counts 90 -> Complete leaves 90.
- P4 real shrink + receipt: created at 100, receipt +10 (110), count 105 -> Complete leaves 105 (variance -5).
- P5 movement after the line is counted: count 100 at 100, then a receipt +10 -> Complete leaves 110.
- P6 retry with the same key after stock moved returns the first result and does not change `expected_qty`.
- P7 clearing a count keeps `expected_qty`; a line with null `inventory_id` keeps its stored expected.
- P8 non-admin refused; wrong actor refused; no key refused (unchanged guards).
- P9 the migration's preflight refuses if the live body drifted; a second run refuses.
- Live smoke (post-apply, rolled back): P2/P3 chain through `update_cycle_count_item` + `complete_cycle_count`.
- Browser: saving a count shows the server's on-hand and variance.

## Open business decisions

None. (Typo-correction-after-movement edge is named above; the alternative — keep the first save's on-hand — gets
a genuine recount wrong instead, and the D12 count is done with the shop quiet.)

## Cold challenge (gpt-6-astra, high, 2026-11-10; 36 findings) and how each was settled

Contract changes from the challenge:
- **Clean cutover (#22, #23):** the migration's preflight refuses while any `in_progress` count holds a counted line
  (counted under the old rule), so no Complete ever mixes both rules and no old-rule receipt is replayed into an
  open count. Prover P8. Live: 0 open counts.
- **Column wording (#18):** the header says "On hand" with the tooltip "On hand in the app. Entering a count compares
  it with on hand at that moment." (uncounted lines still show creation-time on-hand, which the tooltip does not deny).
- **Proof (#34):** P4 now has a non-zero adjustment (shelf 97 of 100) followed by a receipt and a stock-out (103).

Disproved with evidence (live bodies read 2026-11-10, not the packet's migration excerpt):
- #10 `complete_cycle_count` refuses a NULL `p_expected_item_revision` (`CYCLE_COUNT_REVISION_REQUIRED`).
- #28 the live trigger `trg_bump_cycle_count_item_revision` is BEFORE INSERT/UPDATE/DELETE and refuses unless the
  parent is `in_progress`; #29 live `_complete_cycle_count_impl` / `_reverse_completed_cycle_count_impl` are as the
  contract states (adds / subtracts `variance`, refuses a negative result, one transaction).
- #19 the screen fallback runs only when a number was saved and the server returned a variance; a clear keeps the
  line's `expected_qty`.
- #30 `quantity_available` is on hand (holds are `quantity_prebooked`, a separate column); Complete already uses it.
- #24 the migration is applied live before the screen merges (ship.md), so new screen + old database does not occur;
  an old open tab against the new database shows its own variance until the count is reopened, while the server
  stores and applies the correct one.

Timing guarantee, stated narrowly (#1, #2, #20): stock movement POSTED in the app before a line's count is saved is in
its baseline; movement posted after is kept by Complete. Physical movement that is not yet posted when the counter
looks at the shelf cannot be seen by any server design; the window shrinks from "the whole count" to "the seconds
between looking and typing". Count procedure (D12): post receipts and deliveries for a product before counting it.

Pre-existing, unchanged by this fix, out of scope (each would be its own change): per-keystroke saves and a partial
number being completed by another admin (#3, #4); delayed save responses / stale observation from a second admin
(#6, #11, #12); two open counts on the same product (#7); admin direct table writes to count lines and parent status
(#8, #9 — admins can already adjust stock directly); a line with no inventory row (#13, #14); browser-side count
creation not being one transaction, pagination membership, stock added after creation (#15, #16, #17); ledger note
wording (#21); reverse semantics after later movement or counts (#31, #32); same-key concurrency (#27 — the shared
`check_idempotency_intent` path every RPC uses); lock graph (#33 — unchanged: the save adds one unlocked read).
#25 rollback: re-create the 20260831212415 body; lines saved meanwhile keep their recorded on-hand, which the old body
also accepts. #35 the live smoke chain is one `DO` block ending in `SMOKE_PASS_ROLLBACK`. #36 (explicit "Record count"
button with a movement pause) declined: a larger UI change; the stated procedure gives the same result for D12.

Business decision raised (#5, #26): what does changing a count number later mean? Recommendation and default built:
**every save is a fresh look at the shelf**, compared with on hand at that moment. Alternative: keep the first
on-hand for later edits (a typo fix hours later stays right, a genuine recount after stock moved goes wrong).

## Build-time reviewer findings (rls-security, migration-drift, compliance; 2026-11-10; 0 BLOCKER / 0 HIGH)

- Rounding: live has an on-hand with more than two decimals (1 of 117 rows). The save rounds on hand and the count to
  two places before the arithmetic, so the stored row, the result and Complete's added variance agree (prover P9).
- A `variance_pct` beyond `numeric(8,2)` (tiny on hand) is left empty instead of making the count unsavable (P9).
- Cutover race: the migration takes `SHARE ROW EXCLUSIVE` on `cycle_count_items` before the preflight.
- Pre/postflight: `complete_cycle_count` md5 is now pinned too; postflight checks search_path and the new body.
- Screen: a saved count answered with no variance is a failed save (toast, failed-write marker), not a clean line;
  the old-receipt fallback rounds to cents; header "On hand at count". Tests: `CycleCounts.onHandAtCount.test.tsx`,
  `cycleCountOnHandAtCount.test.ts`.
- Left as is (pre-existing, admin-only): admins can write count-line columns directly (RLS); the
  `idempotency-body-check: exempt` marker stays because key handling is byte-identical to the live body.

## Luna round 1 (gpt-6-luna xhigh, head 0609cc609; 0 BLOCKER / 0 HIGH / 2 MED)

- Deferred: on hand with more than two decimals (1 of 117 live rows) leaves Complete less than 0.005 off the count,
  because `variance` is `numeric(10,2)` and Complete adds it to the unrounded on hand. The residue existed before this
  fix; removing it means widening the count-line columns, its own change.
- Refuted: "a late response overwrites a newer save". Writes for one line are chained (`itemWriteQueuesRef`,
  `previous.catch(() => undefined).then(...)` in `updateCountedQty`), so save B starts only after save A has
  answered; responses cannot arrive out of order.

## Sol round 1 (gpt-6-sol high, head a7c941a09; 2 HIGH / 1 MED)

- HIGH 1 fixed: the save now reads the line's inventory row `FOR SHARE` (after the item and parent locks, Complete's
  order; receipts and stock-outs lock only inventory), so a change still in flight commits first and is in the
  baseline. Prover P10 holds a stock change open while the count is saved.
- HIGH 2 (movement posted between looking at the shelf and saving the number is treated as before the count): the
  residual window named above under "Timing guarantee". No server design can see when the shelf was looked at; this
  fix shrinks the window from the whole count to the seconds between looking and typing. Raised to Mason as a
  business acceptance with the D12 procedure (post receipts and deliveries for a product before counting it).
- MED 3 = Luna round 1 deferral (sub-cent residue when on hand has more than two decimals).

## Luna round 2 (gpt-6-luna xhigh, head 6cf0867eb; 0 BLOCKER / 0 HIGH / 3 MED)

- Fixed: the result's `counted_qty` is rounded to two places, as stored and as the variance uses (the fingerprint
  keeps the raw value, as before). The input box keeps what the person typed.
- Deferred (pre-existing, #6/#11/#12 above): a late response for a line another admin saved meanwhile can show the
  older value until refresh; the database holds the last save.
- Business decision (= Sol round 1 HIGH 2): movement posted between looking at the shelf and saving.
