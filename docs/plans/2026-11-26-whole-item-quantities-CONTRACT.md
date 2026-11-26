# Behavior contract: products sold by the whole item take whole quantities (2026-11-26)

Follow-up promised on #2562 (Taha's Approve: "whole-item units get their own PR to stop fractions"). Read at
origin/staging d52780188.

## Mason's decisions (2026-11-26, in the session)
- **D1 Which products:** a product whose stock unit is a count unit, `Ea` or `Unit` (the two `unit_conversions`
  rows of type `both`, factor 1). No new product setting. Products stocked by the gallon, pound or ounce (jugs,
  totes, drums sold in Gal) are unchanged: their quantity is gallons, so a fraction is not a fraction of an item.
- **D2 Where:** everywhere a quantity is entered: quote lines, order lines, delivery lines (scheduled and delivered,
  including completion).
- **D3 Existing rows:** none exist (query below), so the rule applies to new and changed figures only.
- **D4 Quote rate x acres giving a fraction** (e.g. 0.4 Unit/acre x 37 ac = 14.8): refuse with a plain message;
  nothing rounds a price on its own.

## Facts
- Every line quantity is in the product's stock unit: `a1_line_unit_is_stock_unit` (20270121110000) refuses an
  order or delivery line whose `unit_size` is not the stock unit (`inventory_unit`, else `unit_size`), and
  `a1_product_unit_keeps_open_lines` stops a product's stock unit changing while open lines exist.
- Quantity columns: `quote_items.total_units_needed`; `order_items.total_units_needed`, `quantity_delivered`
  (`quantity_remaining` is written by the order functions from those two); `delivery_items.quantity`,
  `quantity_delivered`.
- Writers are many SECURITY DEFINER functions (save_quote, convert_quote_to_order, draw_down_quote,
  create_direct_order, bulk_import_order, update_order_items, create_quick_delivery, create_rush_order,
  create_order_from_blend_ticket, complete_delivery and its wrappers incl. #2562's, return paths, cancel paths).
  A row trigger covers them all without re-emitting any body.
- Screens: errors pass through `src/lib/errorSanitizer.ts`, which already keeps the server sentence for unit rules
  ("Nothing was saved. <sentence>"). Delivery completion needs a signal (nothing is queued offline); DeliveryDetail runComplete still
  refuses a fraction before calling, so the driver sees the plain message first.
- Live, read-only, 2026-11-26 (all products, active or not; stock unit = `inventory_unit`, else `unit_size`, case and
  spaces ignored): 10 products stocked in Ea/Unit; 0 delivery lines, 0 order lines, 0 quote lines on them; 0
  fractional stock rows. All five quantity columns are unbounded `numeric`.
- The app already keeps typed and figured quantities to 2 decimals (`billedLine`/`exactRound2`), and #2562 turns a
  delivered figure under 0.01 into 0 (Mason's decision B). Those rules apply to every product and are unchanged.

## Outcome
One trigger function `_enforce_whole_item_quantity()` (SECURITY DEFINER, `search_path = public, pg_temp`, no grants
to API roles), as BEFORE INSERT OR UPDATE OF the quantity columns and `product_id` triggers on `quote_items`,
`order_items` and `delivery_items`. For a product whose stock unit is Ea or Unit (case and spaces ignored), it
refuses a quantity column that is new or changed and not a whole number:
`WHOLE_ITEMS_ONLY: <product> is sold by the whole item (<unit>), so <n> can't be used. Enter a whole number.`
(quote lines add "Change the rate or acres, or type the number of items."), ERRCODE check_violation.
NULL and unchanged values pass, so history saves as before; a line whose product changes (or first gets one) has
every figure re-checked. Screens: `errorSanitizer` keeps the sentence; the
delivery screen refuses a fractional delivered figure on a whole-item line before calling, and its
quantity boxes step by 1 on those lines. No quote screen file changes (Taha's).

Who may act: unchanged; the trigger only narrows what any writer may store.

## State and failure
- Rule that always holds: a new or changed quantity on an Ea/Unit product line is a whole number. The refusal
  aborts the whole statement/transaction, so nothing partial is saved (a completion moves no stock).
- Automatic record changes: none. Nothing is rounded.
- Existing rows: none fractional (query in Facts), and the migration refuses to apply while any exist,
  naming the first ten documents (Taha's review LOW 2). It scans after creating the triggers, whose lock waits out
  in-flight writers and holds off new ones, so no line can slip in between (Luna r3). An untouched legacy order or delivery figure would still save.
- Timing: retries replay saved receipts before any write; a refused call saved nothing, so a retry is refused the same.
- Undo: cancel and Cancel remaining quantity set whole figures from whole figures.
- Product unit changed to Ea later: order and delivery lines must be closed first (existing rule). Quote lines are not
  covered by that rule, and `save_quote` deletes and re-inserts every line, so every save of a quote re-checks all of
  its lines: a quote holding an old fractional line on a product later switched to Ea/Unit cannot be saved until that
  line is made whole; the message names the product and the fix (Taha's review LOW 1; proof case 10). None exist today.

## Delivery
Database and screens ship in one PR: no screen depends on the new trigger (the delivery screen check is local), and
the trigger only refuses figures on products with no lines today, and the migration re-checks that at apply time, so
no open document or in-progress completion can hit it at rollout. `lock_timeout` 5s; triggers take a brief lock on the three tables. Rollback:
`scripts/smoke/whole-item-quantities-reverse.sql`. Touches Taha's lane
(quote and order lines): needs his Approve (`ready-for-taha`) after Sol.

## Proof cases (real migrated database, disposable)
1. Ea product: quote line 14.8 refused WHOLE_ITEMS_ONLY; 15 saves. Unit product same.
2. Gal product: quote, order and delivery lines at 2.5 save (unchanged).
3. Order line 2.5 Ea refused on insert and on update; 3 saves.
4. Delivery line scheduled 1.5 Ea refused; completion with a delivered 0.5 on a whole-item line refused with nothing
   moved (stock, order line, invoice unchanged); whole partial (1 of 2) completes.
5. A legacy fractional row (made with the trigger off) saves an unrelated column change and a rewrite of its own
   unchanged figure.
6. Retry of a completed delivery returns the saved receipt.
7. Browser: delivery screen refuses 0.5 on an Ea line with the message; error text on a quote save shows the sentence.

## Not in scope (named)
Returns (their typed amount is not checked here), purchase order lines, stock adjustments and cycle counts on Ea
products; whole-container selling for gallon products
(`is_full_tote_only` stays the only whole-tote rule).

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-26): 24 findings, settled
- 1, 2 (quote 0.999 or 1.004 settles to 1), 3 (0.005 delivered becomes 0), 4 (2.5 typed over a planned 2 clamps to
  2): refuted. What is stored, billed and moved is a whole number; the 2-decimal and under-0.01 rules are existing,
  product-wide (#2562 decision B), and the clamp shows the figure on screen.
- 5 (product changed on a line): already in the design; contract wording corrected; proof case 8 added.
- 6, 8, 9, 22 (legacy quote, re-insert of untouched legacy lines, closing legacy lines, queued offline work): refuted
  by the live query: no line of any kind exists on an Ea/Unit product. 6 also corrected in State and failure.
- 7: query re-run on all products with the unit fallback (Facts).
- 10: returns taken out of scope (the claim was unproven).
- 11 (fractional stock from receipts or counts): Mason's D2 scope; none exists; named follow-up.
- 12: sanitizer token added in this change. 13: the delivery screen reads the line's unit, which
  `a1_line_unit_is_stock_unit` keeps equal to the stock unit; proof case 1 covers case and spaces.
- 14: unknown units are already refused (QUOTE_STOCK_UNIT_UNKNOWN); a 0 is a whole number and unchanged.
- 15, 16: the storage trigger sees every writer's final figure; columns are unbounded numeric.
- 17: the product name in the message is readable by every signed-in user already; no grant changes.
- 18: an insert runs `a1_line_unit_is_stock_unit` first, which share-locks the product; a stock unit cannot change
  while open order/delivery lines exist.
- 19, 20: completion replays return the saved receipt before any write (proof 6); completion is one transaction
  (proof 4 checks stock, order line and invoice unchanged after a refusal).
- 21: the screen check reads the figures at submit, after any late edit; scheduled fractional figures cannot exist.
- 23: rollback script and lock_timeout added. 24: adopted (row guards + one screen check on delivery completion and Fix Delivery).

## Extra proof case
8. A Gal line at 2.5 re-pointed to an Ea product is refused; a line with no product getting an Ea product at 2.5 is
   refused.
9. The migration refuses the apply while a fractional line exists on an Ea/Unit product, naming the document.
10. The real `save_quote` refuses a 2.5 Unit line and saves a 3 Unit line (every save re-inserts every line).
