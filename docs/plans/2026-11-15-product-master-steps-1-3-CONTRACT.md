# Behavior contract: Product Master repair steps 1-3 (units, stock history, grower-share cost)

To-Do 0.17, [combined review](../audits/2026-11-13-product-master-review.md). Three draft PRs to `staging`, in order.
Facts read 2026-11-15 from `origin/staging` `8b8962d95` and the live database (read-only). Sol is owed on all three
(blocked by issue #1868).

## Facts (live, read-only, 2026-11-15)

- Every active product has a stock unit (`inventory_unit`) that is a row of `unit_conversions`; `unit_size` equals it
  on every active product (`guard_product_unit_matches_inventory_unit` keeps them matched). 0 quote lines carry a
  unit different from the stock unit.
- `unit_conversions` has 14 rows. Spellings differ in case only (oz/Oz, qt/Qt, Lb/LB); Ea and Unit are both "each".
- `inventory_units_per_supplier_unit_snapshot` (the per-line PO factor) is 1 or blank on every PO line ever written,
  and blank on every line whose unit differs from the stock unit. It has never carried a real conversion.
- Lines whose unit differs from the stock unit:
  - PO: 4 open (partially received): Powder Keg Corn "EA" (1 of 2 received), Powder Keg Soybeans "EA" ×2 (fully
    received lines on an open PO), Piksi Dust "Dry oz" 9,000 (0 received). 1 historical fully received ("oz" vs "Dry oz").
  - Orders: Piksi "Dry oz" on 1 confirmed and 2 partially fulfilled lines; 3 fulfilled lines with "Gallon ", "Gall", "oz".
  - Deliveries: Piksi "Dry oz" on 1 in-progress line (27,000), 2 completed, 2 cancelled; 3 completed misspellings.
  - Piksi's stock row is labelled "Dry oz" while the product is "MG". Powder Keg rows are "Lb".
- Mason 2026-11-13 (DECISION_LOG): "MG" is milligrams; the Piksi PO line's quantity is right and its label is wrong.
  Powder Keg Corn and Soybeans are sold by the each at current prices; stock and rate unit become Ea; on-hand 0.
- Powder Keg: form dry, container unit Ea, each in a one-size family whose rate unit is Lb, an open manual cost basis
  (migration baseline), rate lock currently off, supplier-cost-basis flag off. Corn: 1 prebooked, 1 on order.
- `product_price_per_acre` and `save_quote` treat a unit missing from `unit_conversions` as factor 1. Live: 0 products
  and 0 rate-mode quote lines use such a unit. 4 active dry products use the liquid "oz" as rate unit (RT-2 step 2).
- No `returned` history rows exist yet. Writers: receive return (+restocked), cancel return (−restocked).
  `src/lib/reconciliation.ts` and `scripts/smoke/prove-ki108-*` read `returned` as `abs()`.
- `cycle_counts.status` ∈ in_progress / completed / cancelled; 17 cancelled, 0 in progress. A count is created by
  the browser for one warehouse: one `cycle_counts` insert, then one item per inventory row at that location.
- Field-app invoice, grower-share branch (`v_chem_qty_a > 0`): cost = cost per sold unit × quantity in the rate unit.
  The billed branch converts with `field_app_priced_quantity` and refuses an unconvertible unit (PARKED-010).

## PR A — Units batch (KI-136, KI-158, KI-140, KI-137)

**Outcome.** Stock can no longer move in a unit other than the product's stock unit. One shared rule, enforced where
lines are written, so every path (screens, imports, quote conversion, RPCs) is covered without re-emitting the large
order, delivery and quote functions.

**The unit rule** (`public._unit_matches_stock_unit(line_unit text, stock_unit text)`, new, STABLE, not browser-callable):
a line unit matches when it is blank, or equal to the stock unit ignoring case and spaces, or both are rows of
`unit_conversions` with the same type and the same factor (so "Gallon" does not match "Gal", but "LB" matches "Lb").

**Changes (one migration, plus one data-correction migration):**
1. Order, delivery and PO lines: one BEFORE trigger (`a1_line_unit_is_stock_unit`, replacing `_fill_order_line_unit`)
   fills a blank unit from the stock unit (`inventory_unit`, was `unit_size`), stores a matching spelling as the
   product's own, and refuses a non-matching unit (`LINE_UNIT_NOT_STOCK_UNIT`). Checked only on insert or when the
   unit or product changes, so existing lines keep working. It reads the product `FOR SHARE`.
2. Products: a stock-unit change is refused while a line is open in another unit (`PRODUCT_UNIT_HAS_OPEN_LINES`;
   Astra finding 2). The one live open PO line with a blank unit gets its stock unit.
3. Receiving: the same PO-line trigger also fires when `quantity_received` rises, so `receive_po_items` refuses a
   legacy line whose unit does not match before any stock moves (its body is not re-emitted). No conversion: the per-line factor has never been anything but 1 (fact
   above), and converting would also need reversal, close-short, on-order and vendor-bill checks to convert.
4. On-order: unchanged function; it stays right because no open PO line can hold a non-matching unit after the
   trigger and the data correction (postflight asserts it).
5. Quote math (KI-140): `product_price_per_acre` returns NULL when the rate or stock unit is not in
   `unit_conversions` (was factor 1). A new quote-line trigger refuses a rate-mode line with a rate above 0 whose rate
   unit is not in `unit_conversions` (the exact `LOWER(unit) = LOWER(rate_unit)` join `save_quote` uses), so
   `save_quote`'s `COALESCE(factor,1)` is never reached with an unknown unit. The liquid-vs-dry type check is NOT added:
   4 active dry products are rated in "oz" and RT-2 step 2 owns them (named as remaining in KI-140).
6. Data correction (separate migration, pinned by id and current values, refuses and changes nothing on drift):
   Powder Keg Corn and Soybeans: stock unit, unit and rate unit Lb → Ea, family rate unit Lb → Ea; their stock-row
   labels Lb → Ea; their open order lines relabelled Ea (they have no open delivery line; the migration refuses if one appears). The cost basis the unit change closes is reopened
   at the same cents (per each). Piksi Dust: the open PO line, its open order and delivery lines and its stock-row label
   "Dry oz" → "MG". Quantities and money never change. Completed and cancelled history keeps its labels.

**Who may act.** Unchanged: the same roles that write these lines today. The rule is in triggers, so it binds every
caller including SECURITY DEFINER RPCs. The screen sends nothing new.

**Existing rows.** Not rewritten except the pinned relabels. Legacy mismatched lines on closed orders, deliveries and
POs are history only; a later edit that touches their unit or product must use the stock unit. Receiving refuses a
legacy mismatched open line (none remain after the data correction). Historical balances are not converted.

**Timing.** Triggers run inside the writer's transaction; a refusal rolls the whole save back. Retries replay the
same refusal. No new lock except the data correction's table locks (as RT-2a).

**Undo.** Code: re-emit the previous function bodies (rollback SQL in `scripts/smoke/`). Data: a reverse script puts
the pinned rows back.

**Delivery.** Database only, no screen change: every screen already sends `products.unit_size`, which equals the stock
unit on every active product, or a blank (now filled server-side). Free-typed units that differ are refused with a
message naming the stock unit.

**Proof cases (real-schema prover, disposable database):**
- When an order line, delivery line or PO line is inserted with a blank unit, then it is stored with the stock unit.
- When one is inserted with "Gallon" on a Gal product, or "Dry oz" on an MG product, then the insert is refused and
  nothing is written; "gal" or "GAL" is accepted.
- When a legacy open PO line in "Dry oz" on an MG product is received, then receiving is refused and stock, on-order,
  receiving records and history are unchanged; after relabelling it to MG, 9,000 is received as 9,000 MG.
- When an existing mismatched line is updated without touching unit or product (e.g. delivery completion), then it saves.
- When `product_price_per_acre` gets an unknown unit, then NULL; a known unit gives the same figure as before.
- When a quote line in rate mode has rate 10 and an unknown rate unit, then `save_quote` refuses; rate 0 saves.
- The data correction moves exactly the pinned rows, opens one Ea cost basis per Powder Keg product at the old cents,
  changes no price, rate, quantity or other product, and refuses on any drift.

## PR B — Stock-history integrity (KI-159, KI-160 part, sweep)

**Outcome.** "Stock matches history" reads a cancelled return correctly, two open counts can never correct one row
twice, and the database sweep checks stock against history every run.

1. KI-159: the readers learn the sign. `returned` becomes a signed type in `src/lib/reconciliation.ts` and in the
   prover script (receive writes +, cancel writes −). The writer is unchanged: its negative row is the true movement.
2. KI-160: a partial unique index allows one in-progress count per warehouse, and a trigger on
   `cycle_count_items` refuses an inventory row already on another in-progress count (insert, or a move to another
   count/row), serialized by an advisory lock on the inventory row. A count may be reopened only if none of its rows
   is on another in-progress count. Not in this PR (left open in KI-160): the direct `variance` UPDATE grant and the
   three-request count creation.
3. Sweep: new predicate `stock-vs-history.sql` (rows = inventory rows whose stock differs from the signed history,
   same exclusions as the browser check), keyed by inventory id only.

**Existing rows.** 0 in-progress counts; 0 `returned` rows; live stock matches history on all rows (review), so the new
predicate starts at zero (to be confirmed by running it live read-only).

**Proof cases:** reconciliation unit test (receive 10, cancel → expected 0); prover/sweep SQL against a database
with a received-then-cancelled return reports no mismatch; a second in-progress count at one warehouse is refused; an
item for an inventory row already on an open count is refused; two concurrent item inserts for one row on two counts
end with exactly one; completing a count still works; reopening a cancelled count whose rows are on another open
count is refused.

## PR C — Grower-share cost (KI-156)

**Outcome.** A chemical included in the grower's share books its cost in the product's sold unit, like the billed line.
The bill (a $0 line) is unchanged.

`_save_field_app_invoice_impl_20260714`, `v_chem_qty_a > 0` branch: convert the applied amount with
`field_app_priced_quantity` into the sold unit, refuse an unconvertible unit with the billed branch's message, store
the line's quantity and unit in the sold unit (total applied stays in the rate unit, as on the billed line), and add
`cost × converted quantity` to the invoice cost. Nothing else in the function changes. The split field-app path is
checked for the same branch; if it has it, the same fix applies there.

**Existing rows.** 0 such lines live; invoices are re-costed only when re-saved (drafts).

**Proof cases:** 16 oz/ac × 100 ac of a $30/gal product in the grower share books $375.00 cost (not $48,000); the
billed line's cost and price are unchanged; an "oz" rate on a product sold "per Ea" is refused; a manual line with
no product keeps its unit (identity).

## Open business decisions

1. **Relabel Piksi's open order and delivery lines to MG** (not only the PO line Mason named). Recommendation: yes;
   the same "quantity right, label wrong" fact, and the in-progress delivery would otherwise print "27,000 Dry oz".
   If no: only the PO line and stock label move; those lines keep printing "Dry oz", and the rules migration's
   postflight (`UNITS_POSTFLIGHT_OPEN_LINE`) would need to allow them. The built migrations take the "yes" path.
