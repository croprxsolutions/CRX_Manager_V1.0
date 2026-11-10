# KI-76: invoice lines with no unit (and the season item) — behavior contract

Read at `origin/main` 8617d3725; live read-only checks 2026-11-10. Scope set by the coordinating session after round 1:
fix the delivery side too, filling a blank unit from the order line, then the product; a blank unit must never stop a
driver from completing a delivery; refuse later with a message staff can act on; keep the order-invoice refusal.

## Facts

- **Season item is already fixed live.** `20261204110000_ki18_batch2_chicago_boards.sql` (applied) re-emitted
  `get_customer_summary` and `operational_dashboard_summary` with the Chicago date; its own container prover proved the
  7:30 pm CDT season-end case. Live bodies contain `America/Chicago` and no `current_date` / bare `now()`.
- **Returns match on the order line's unit.** Every return path keys the return line on
  `coalesce(order_items.unit_size, 'ea')`; `_issue_return_credit_impl` refuses `RETURN_CREDIT_UNIT_MISMATCH` when the
  posted invoice line's unit differs; `guard_return_credit_lineage` requires a credit line's unit to equal its source.
- **Where blank invoice units come from.** Completing a delivery (`_complete_delivery_authorized_impl`) and
  `_create_invoice_for_unbilled_delivery_impl_20260718` copy `delivery_items.unit_size` onto the draft invoice line;
  `_create_invoice_from_order_impl_20260718` copies `order_items.unit_size`. Completion only creates drafts; posting
  is a separate step. Live: 6 of 406 delivery lines have no unit; no delivery line has a unit its order line lacks or
  differs from; no invoice line's product differs from its order line's product.
- **Order lines cannot be edited once delivered.** `_update_order_items_impl` refuses any order not `confirmed` or
  `pending`, and the API role cannot update `order_items` directly. So "set the order line's unit" is not a fix staff
  can reach after delivery; setting the product's unit (Products page) and saving the draft invoice is.
- **`create_invoice_from_order` cannot bill a product line today**: it refuses an order with any active delivery,
  and the delivered cap refuses any line beyond completed deliveries. Live has never had an invoice from it.
- **Live blank units (2026-11-10).** Invoice lines: 5 of 30 (4 NULL, 1 empty). Only 2 are on open invoices: drafts
  CS-2026-0056 and CS-2026-0070, each tied to an order line with no unit, on a product sold in `Gal`. The other 3 are
  voided, or field-application / misc lines with no order line. Order lines with no unit: 5, all on fulfilled orders.
- **Precedent.** `20261118110000_sale_line_vendor.sql` fills a blank `vendor` on order and invoice lines with BEFORE
  triggers; this change follows the same shape.

## Contract

A unit is **blank** when it is NULL or only spaces, tabs, line breaks or non-breaking spaces.

1. **Order line fill.** An order line inserted, or whose product changes, with a blank unit takes the product's unit
   when the product has one. Never refuses. Other updates never touch it (no backfill by side effect).
2. **Invoice line fill.** A sale line tied to an order line (`order_item_id` set, no return-credit source, quantity not
   negative) inserted, or whose unit or order line is written, with a blank unit takes the order line's unit, else the
   order line's product unit. Never refuses. Trigger `a0_fill_invoice_line_unit` sorts before every other BEFORE
   trigger on `invoice_items`, so their checks see the final unit.
3. **Delivery completion never fails on a unit.** Neither fill can raise; nothing new runs on `deliveries` or
   `delivery_items`; the container proof completes deliveries with every trigger enabled.
4. **Posting refusal.** Any update moving an invoice (not a credit memo) from a non-financial status into `posted`,
   `paid` or `overdue` is refused (`INVOICE_LINE_UNIT_MISSING`, naming the lines) while a positive, non-credit sale
   line tied to an order line still has a blank unit. Trigger `zz_refuse_post_blank_unit_line` has no column list and
   sorts after the other status triggers, so a status set by an earlier trigger is still checked. Staff fix: set the
   product's unit, save the draft (the fill runs again), post. A group post refuses as a whole, naming the invoice.
5. **Order invoice refusal (kept).** `create_invoice_from_order` refuses an order with a line with no unit
   (`ORDER_LINE_UNIT_MISSING`) before writing anything; the same request key works once the unit is set.
6. **Returns.** Unchanged. A line whose order line has a unit (every new line on a product with a unit) is credited.
   A line whose order line is blank (existing lines, or lines on a product that had no unit when ordered) gets the
   product unit for billing, but its return still reads the blank order line and is refused
   (`RETURN_CREDIT_UNIT_MISMATCH`), exactly as today, with today's message.
7. **Existing rows.** No backfill. The 2 open drafts are listed in KI-76 for Mason. Once this is live, posting either is
   refused until a staff member saves it (it then takes `Gal` from the product); a return on them stays refused.
8. **Authority.** New trigger functions: SECURITY DEFINER, `search_path = public, pg_temp`, owner `postgres`,
   schema-qualified table names, EXECUTE revoked from PUBLIC, anon, authenticated and service_role. The order invoice
   function keeps its settings and grants (CREATE OR REPLACE).
9. **Delivery.** Database plus two new screen messages in `src/lib/errorSanitizer.ts`. Works with the deployed app.
10. **Rollback.** A reviewed migration that drops the three triggers and functions and re-emits `20260827041400`'s
    order-invoice body (md5 `454e04c4…`).

## Proof cases (container: `scripts/smoke/prove-order-invoice-blank-unit-real-schema.mjs`)

Every flow runs through the real RPCs as the signed-in user (the API role), rolled back; every trigger is on.

- Delivery, new order line with no unit (product `gal`): before, invoiced blank, posts, return refused; after, the
  order line and invoice line get `gal`, it posts and the return is credited.
- Same with a tab-only unit: before, posts and credits with a tab; after, filled as above.
- Product with no unit: after, the delivery still completes, the draft stays blank, posting is refused with the
  message; once the product has a unit and the draft is saved, it posts (return stays refused, as today).
- Existing order line with no unit (written before the change): after, the invoice line gets the product unit and
  posts; the return stays refused, as today.
- `gal` line: unchanged before and after.
- Order invoice: before, each line is billed with its unit as is; after, a NULL or spaces-only line is refused and a
  two-line order is refused with the readable message, writes nothing, and bills with the same key once fixed. (The
  delivered cap is switched off inside these rolled-back probes only, because no order passes it today.)
- A second apply refuses at the preflight; settings and grants unchanged; the new functions are definer, pinned path,
  no API execute.

## Cold challenge

- **Round 1** (Astra, gpt-6-astra high, 25 findings, order-invoice design): writing `ea` was a guess (accepted:
  refusal); empty units count as blank (accepted); delivery paths copy the delivery unit (accepted, now in scope); no
  backfill (accepted); idempotency of a refused call (proved); rollback named.
- **Round 2** (Astra, gpt-6-astra high, 17 findings, this scope):
  - #1, #2 (product fallback leaves the invoice unit unlike the return's order-line key): accepted as a known limit,
    not a regression. The return is refused today for every blank order line; the product fallback is kept because
    order lines cannot be edited after delivery, so without it posting would strand the invoice. #2's case (order and
    invoice both an identical empty string, credited today) has 0 live rows; new lines get the product unit at insert.
  - #3 (delivery unit differs from a filled order unit), #4 (invoice product differs from order product): 0 live rows
    each; the fallback uses the order line's product first.
  - #5 (fill mutates a posted source line): `trg_refuse_posted_invoice_child_write` already refuses writes to lines of
    a posted invoice; the fill only writes the row being written.
  - #6, #8, #9 (trigger order and status set by another trigger): fill renamed `a0_` (runs first), refusal renamed
    `zz_` with no column list (runs last, any update); credit lines are set by the credit RPC itself, not a trigger;
    the proof completes deliveries with every trigger on.
  - #7 (credit lines refused at post): fixed; credit memos and lines with a credit source are not checked.
  - #10 (posted header then lines): `trg_refuse_posted_invoice_child_write` refuses lines on a posted invoice; the
    transition list now covers any non-financial status into posted/paid/overdue.
  - #11 (line insert racing a post), #14 (order line racing the order invoice): same exposure as every existing
    post-time line check; not widened here (LOW, noted).
  - #12 (group post): refuses as a whole with the invoice named; staff fix and repost.
  - #13 (paid): payments run in the same transaction, so a refusal rolls back atomically; no payment is recorded
    against a refused invoice.
  - #15: the order-invoice probe is labelled an isolated test of the refusal.
  - #16: blank now includes tabs, line breaks and non-breaking spaces; proved with a tab.
  - #17: table names are schema-qualified; the functions follow the repo's definer pattern.
