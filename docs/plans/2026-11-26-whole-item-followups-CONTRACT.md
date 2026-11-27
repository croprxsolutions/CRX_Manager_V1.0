# Behavior contract: whole-item quantities on purchase orders, receiving, stock counts, adjustments and returns (2026-11-26)

The three follow-ups named on PR #2675 (`docs/plans/2026-11-26-whole-item-quantities-CONTRACT.md`). Read at
origin/staging 2b81bfb45 plus #2675's head (`claude/whole-unit-no-fractions`, migration 20270313003100). Builds
only after #2675 merges into staging; the new migration stacks above it.

## Mason's decisions (2026-11-26, carried from #2675)
- **D1** A whole-item product is one whose stock unit (`inventory_unit`, else `unit_size`; case and spaces ignored)
  is `Ea` or `Unit`. No new setting. The rule reads the product's stock unit now, as #2675 does.
- **D2** Everywhere a quantity is typed. #2675 did quote, order and delivery lines; this does the rest.
- **D3** New and changed figures only.
- **D4** Refuse, never round.
- **D5** (2026-11-26, on this PR) A return on a split-billed sale may be fractional: one item shared by payers is
  returned in shares. Split = `create_return`'s own share test (`_return_customer_line_share(...).share_mode`).

## Facts
- **Purchase order lines** hold their figures in the stock unit: `a1_line_unit_is_stock_unit` (20270121110000) refuses a
  PO line whose `unit_size` is not the stock unit; the per-line supplier factor has only ever been 1. The typed
  order figure is `purchase_order_items.quantity_ordered` (save_purchase_order).
- **Receiving**: each receipt entry becomes one `receiving_records` row carrying the entered `quantity_received`
  (receive_po_items, receive_po_items_with_excess_notice; inner insert last re-emitted in 20260714230000, `v_qty` per
  entry) and then raises the PO line's running `quantity_received`. A receipt reversal deletes its record and lowers
  the running total. Live has 0 receipts without a `po_item_id`.
- **Cycle counts**: the typed figure is `cycle_count_items.counted_qty`, written by `update_cycle_count_item`
  (20270203120000), stored `round(p_counted_qty, 4)`. `create_cycle_count` inserts lines with no count.
- **Stock adjustments**: typed figures enter through `adjust_inventory(p_delta)` (InventoryPage; BatchAdjustModal,
  one call per row; newest body 20270201140000) and `manual_inventory_add(p_quantity)` (InventoryPage add stock;
  newest impl `_manual_inventory_add_replay_impl_20261015` in 20261102200000). Both write an `inventory_transactions`
  row of type `adjusted`. That type is ALSO written by automatic paths (receiving and application reversals, retire,
  reconcile-negative, void order, cycle count completion and reversal), so a guard on the ledger would refuse
  automatic reversals this change does not govern. The check goes in the two typed RPCs.
- **Returns**: the typed figure is `return_items.quantity` (`numeric(10,2)`), inserted by `create_return`, which first
  refuses a figure finer than 2 places (RETURN_QUANTITY_TOO_FINE) and one above the returner's share.
  `restocked_quantity` is copied on receive, not typed.
- **Live** (rhyzpcqhnizqbxphqdkr) and **staging** (fsnjredpmakbmhwowjjt), read-only 2026-11-26, products whose stock
  unit is Ea/Unit (live 10, staging 1): fractional rows = 0 in purchase_order_items, receiving_records,
  cycle_count_items, `adjusted` transactions, all transactions, return_items and inventory. Live has no row of any of
  these kinds on those products, and no order line on them, so no split-payer sale of one.
- Screens show server refusals through `src/lib/errorSanitizer.ts`, which keeps the `WHOLE_ITEMS_ONLY` sentence (#2675).

## Outcome
One rule and one message, reused from #2675:
`WHOLE_ITEMS_ONLY: <product> is sold by the whole item (<unit>), so <n> can't be used. Enter a whole number.`
(check_violation). Nothing is rounded. Gal/Lb/oz products are unchanged.

Covered (typed figures that move or promise stock): PO ordered quantity, each receipt, count, adjustment, manual add,
return quantity (except a return on a split-billed sale, D5). Not covered (named): reorder point and minimum stock (planning thresholds, not stock), field
application quantities, and every automatic movement or reversal.

Smallest change, one migration:
1. Helper `_assert_whole_item_quantity(p_product_id uuid, p_qty numeric, p_hint text DEFAULT NULL)`: #2675's product
   lookup (FOR SHARE), finite-whole test and raise, in one place. No API role may call it.
2. `_enforce_whole_item_quantity()` (#2675's trigger) re-emitted to call the helper and to know four more tables:
   `purchase_order_items` [quantity_ordered], `receiving_records` [quantity_received], `cycle_count_items`
   [counted_qty], `return_items` [quantity]. Same semantics: a new or changed figure, or every figure when the
   product changes. Quote, order and delivery behavior, including the quote hint, is unchanged.
3. Triggers `a3_whole_item_quantity` on those four tables (BEFORE INSERT OR UPDATE OF product_id and the columns).
   Receipts are checked one by one, so a reversal (a delete) is never refused and the PO line's running received
   total is not checked.
4. `adjust_inventory` and `_manual_inventory_add_replay_impl_20261015` re-emitted unchanged except one helper call on
   the typed figure, after the receipt replay and the record lookup, before any write.
5. Each replaced function is pinned: the preflight refuses unless its body md5 (carriage returns removed) is the
   expected one; the postflight checks the new bodies, owner, grants, security mode and settings did not move. The
   reverse script pins the new bodies the same way before restoring.

Expected files: the migration; `scripts/smoke/prove-whole-item-followups-real-schema.mjs`;
`scripts/smoke/whole-item-followups-reverse.sql`; `scripts/local-app/e2e/whole-item-followups.spec.ts`; changelog and
migrations.d ledger records; this contract. One screen line: Cycle Counts showed a refused count raw
(`error.message`); it now goes through `sanitizeError`, as the other three screens already do.

Who may act: unchanged. The rule only narrows what a writer may store; the helper runs after each RPC's own
authorization, so a refused caller learns nothing new. Row triggers also catch any direct table write.

## State and failure
- Rule that always holds: a new or changed typed figure above on an Ea/Unit product is whole. A refusal aborts the
  whole call: nothing saved, no stock moved, no receipt.
- Earlier refusals keep precedence (authorization, RETURN_QUANTITY_TOO_FINE, over-share returns, billed-PO edits,
  line-unit mismatches); the new sentence is proved on otherwise valid requests.
- Stored precision: counts keep their 4-place rounding and returns their 2-place column; a figure such as 3.99999
  stores 4. What is stored and moved is whole; those product-wide rounding rules are unchanged (#2675 settled the
  same for quote and delivery figures). A billed PO line resent within the existing tolerance keeps its stored whole.
- Automatic record changes: none.
- Existing rows: none fractional (Facts); the postflight refuses the apply while any PO ordered figure, receipt, count
  or return line on an Ea/Unit product holds a fraction or a non-finite value, naming the first ten documents, as
  #2675 does. A legacy fraction elsewhere saves unrelated edits.
- Fractional stock from out-of-scope paths (e.g. a field application leaving 1.5 Ea): a typed +0.5 is refused; the
  office corrects it with a cycle count (counting 2 completes with its +0.5 variance; completion is not checked).
- Retries: a successful call's receipt replays before the check. A refused call saved nothing; its retry is judged
  afresh.
- Undo: receipt reversal, count reversal, return cancel and PO close-short write no checked figure, so they work as
  today whatever the history.
- Locks: the helper share-locks the product row, as #2675 does, after each RPC's existing locks.

## Delivery
One PR: no screen depends on the migration. Brief trigger creation on four tables, `lock_timeout` 5s. Rollback:
reverse script restores #2675's function body, drops the four new triggers and the helper, restores the two RPC
bodies. Returns are next to Taha's return-credit work (#2537 changes credits, not return_items quantities): label
`ready-for-taha`.

## Proof cases (disposable real-schema prover unless marked; fixtures satisfy every earlier guard)
1. PO: `save_purchase_order` with a 2.5 Ea line refused with the sentence, no PO; 3 saves; a Gal line at 2.5 saves.
   A PO with a legacy fractional line (made with triggers off) saves a header change through the real save.
2. Receiving through `receive_po_items` on a 3 Ea line: 0.5 refused, nothing received; two entries 0.5 + 0.5 in one
   call refused; 1 + 1 in one call saves two receipts; reversing one receipt works. Excess-notice path on a 4 Ea
   line already holding a legacy 2.5 received: 1.5 refused, nothing moved; 2 saves (4.5 of 4).
   Gal receipt of 0.5 works.
3. Count: `update_cycle_count_item` 4.5 on an Ea line refused; the whole on-hand saves; Gal 49.5 saves. A count of 2 on Unit stock of 1.5
   completes (+0.5 variance), and its reversal works.
4. `adjust_inventory` -0.5 and +0.5 on Ea refused, stock and ledger unchanged; -1 works; Gal -0.5 works; a retry of a
   success returns its receipt.
5. `manual_inventory_add` 2.5 on Ea refused, no inventory row; 2 works.
6. `create_return` of 0.5 on a delivered 2 Ea line refused, no return; 1 works. On a split-billed sale a 0.33 Ea
   return line saves; the same line on an unsplit sale is refused (D5).
7. Re-pointing a Gal PO line at 2.5 to an Ea product (unit changed too) is refused with the sentence.
8. The apply is refused while a fractional Ea PO line exists, naming it; a second apply is refused by the preflight.
9. No API role can call the helper or trigger function; the two RPCs keep their grants and owners.
10. Rollback restores the earlier bodies, leaves #2675's quote/order/delivery rule working; a second run is refused.
11. Browser (local walkthrough, `whole-item-followups.spec.ts`): Inventory adjust, cycle count, return and receive each
    show the sentence for 0.5 on an Ea product, save nothing, and accept a whole figure. Adjust, return and receive keep
    the typed 0.5; Cycle Counts clears the box, as it already does for any refused count.

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-26): 29 findings, settled
- 2, 12 (receiving checked on the running total; reversal blocked): DEFECT, fixed: receipts are checked one by one,
  `quantity_received` on the PO line is not checked. 3: example removed. 13, 22: wording corrected.
- 26: each replaced function pinned both ways. 5, 28: precedence named; proofs on otherwise valid requests.
- 1, 4, 20 (rounding before storage): refuted: what is stored and moved is whole; existing product-wide rules.
- 6, 7, 11, 16, 18, 19, 24: proof cases 1, 2, 6, 9, 11 run the real RPCs and screens; Batch Adjust is one call per
  row with its own message (existing behavior for any refusal).
- 9, 15, 21: D1 classifies by the product's current stock unit, as #2675; live has no order lines on these products.
- 10: same postflight as #2675 (Mason D3, Taha LOW 2). 25: postflight re-checks at apply. 23, 27: same as #2675.
- 8: scope named in Outcome. 17: count is the office path (State). 29: adopted for the two RPCs; row triggers kept
  where they replace re-emitting large RPC bodies and also cover direct table writes.
- 14: open decision below.

## Targeted re-check of the receiving change (Astra high, 2026-11-26): 5 findings, no defect
- 1, 2 (another receipt path; entries merged or split before the insert): proof case 2 runs the real receive RPCs with
  two entries for one line in one submission (0.5 + 0.5 refused; 1 + 1 saves two receipts); browser writes to
  `receiving_records` are revoked. 3: the only reversal deletes the receipt; no partial reversal exists.
  4: adopted in proof case 2. 5: the same apply-time gate as #2675 (D3); live has no such receipts.

## Luna round 1 (gpt-6-luna xhigh, head 7c319ecbe, 2026-11-26): no BLOCKER or HIGH, 2 MED refuted
- 1 (a count of 3.99999 is rounded to 4 before the check): refuted; the same as Astra 1, 4 and 20 (State and failure):
  `update_cycle_count_item`'s 4-place rounding is the existing product-wide rule, and what is stored and moved is whole.
- 2 (a product changed from Gal to Ea keeps fractional history): refuted; a product's stock unit cannot change once it
  has PO lines, receipts, returns, order or delivery lines, stock movements or an active hold (`PRODUCT_UNIT_HAS_HISTORY`,
  20270201130000), so the case cannot arise for the figures this change covers.

## Luna round 2 (gpt-6-luna xhigh, head 8820775d8, 2026-11-26): no BLOCKER or HIGH, 2 MED refuted
- 1 (count 3.99999 rounded to 4): refuted; repeat of round 1 finding 1 (existing 4-place rule, what is stored is whole).
- 2 (split-return exemption skips the check, so a direct write could exceed a share or hold NaN): refuted; app roles
  cannot write `return_items` directly (20260715203911), and `create_return` caps each payer at their share
  (RETURN_QUANTITY_EXCEEDS_BILLED_SHARE) and refuses NaN as over-delivered (NaN sorts above every number). The
  whole-item rule never owned share caps; owner-level writes bypass every trigger alike.

## Business decisions settled on this PR
- **Split-payer returns of a whole item.** Mason chose to allow fractions (D5): a sale split between payers is
  returned in shares. The trigger and postflight skip return lines whose sale is split by `create_return`'s own test;
  `create_return` still caps each payer at their share.
