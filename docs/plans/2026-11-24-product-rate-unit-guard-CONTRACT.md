# Product rate-unit guard (#2367) — behavior contract

Written 2026-11-24 (night run P2). Decision D4 (Mason, 2026-11-23): new writes that give a product a rate unit
field-app invoices cannot convert are refused; existing such products stay editable; the PR lists the live
products in that state.

## Problem

A field-app invoice line copies the product's default rate unit and prices it in the unit the product is sold in
(`field_app_priced_quantity(qty, rate_unit, sold_unit, form)`, a fixed list of spellings). When that returns NULL the
invoice save refuses the line (`FIELD_APP_UNIT_UNCONVERTIBLE`). Today nothing stops a product from reaching that
state: a new size sold in a unit the group's rate unit cannot reach, a size added while the group is on its approved
rate (it copies the approved unit), a rate cleared to blank that keeps its unit, or a new standalone product.

## Live read (2026-11-24, select only)

- 601 products have a rate unit; **0** have one field-app invoices cannot convert to their sold unit (the
  function's rules evaluated inline). So the "live products in that state" list for the PR is empty.
- 0 groups are on their approved rate (458 on legacy).

## Rules

"Invoiceable" for a product = its rate unit is blank, OR its sold unit (`inventory_unit`) has no letter or digit (the
invoice save refuses that product whatever its rate, a separate problem), OR `field_app_priced_quantity(1, rate_unit,
inventory_unit, product_form)` is not NULL. The rate value is ignored: a blank rate that keeps its unit is still
judged, since the invoice editor still offers that unit.

1. **Every write path, one place.** A `BEFORE INSERT OR UPDATE` trigger on `products` refuses
   `PRODUCT_RATE_UNIT_NOT_INVOICEABLE` (naming the product, its rate unit, sold unit and form) when the new row is not
   invoiceable AND (it is an INSERT, OR the update changes `rate_unit`, `inventory_unit` or `product_form`). This
   covers Add a size (the copy from the parent), new standalone products and imports (`apply_product_setup`), rate
   corrections (single and parent), Move a size (its copy), the rate switch both ways, and direct column writes from
   the product page (sold unit, form).
2. **Existing products stay editable.** An update that changes none of the three columns is never refused, so a
   product already in that state (none live today) can still have its name, price or anything else edited. Changing
   it to another non-invoiceable combination is refused; changing it to an invoiceable one is allowed.
3. **Switching back stays possible.** While a group uses its approved rate, each of its sizes must stay switchable
   back: the group's old rate unit (the `legacy` unit in the promote event that the switch back restores; blank on a
   seed/each group; a seed/each size's own stock unit) must pass the switch back's own unit check
   (`_product_rate_unit_ok`, replacing the size's current unit, as `_rate_cutover_plan` checks it) AND be invoiceable
   on that size. Checked (a) when a size joins the group (`BEFORE INSERT OR UPDATE OF product_id, parent_id` trigger
   on `product_parent_members`, judged as the size will be after the copy; it takes the group row `FOR SHARE`, so a
   switch running at the same time either sees the new size or is waited on), and (b) when a size's rate unit, stock
   unit, unit size or form changes (the `products` trigger). This matters most for a group whose approved rate is
   blank: its sizes have no rate unit, so rule 1 alone would let a size's sold unit change to one the old unit cannot
   be invoiced on (the rate lock does not guard a blank rate). Refusal `PRODUCT_PARENT_SIZE_NOT_RESTORABLE` ("switch
   the group back to its old rate first"). Move a size into or out of an approved group is already refused.
4. **A switch back is never refused by rules 1 or 3.** Switching back puts each size's own old unit back. A row
   written inside a switch back is skipped only when all hold: the transaction holds the switch's pass for the row's
   group (`product_rate_cutover_passes`, written by `commit_parent_rate_cutover` before it writes rates), the group is
   still `approved` (the commit marks it `legacy` only after the rates are written; a promote runs while it is
   `legacy`), and the row's new rate unit is exactly its restore target from rule 3. A promote is judged by rule 1
   like any write.
5. **Order.** Rule 1 runs as the last `products` trigger (name sorts after the existing `trigger_zzzzz_*`), so it
   judges the row after every earlier trigger filled or normalized units (e.g. seed/each rate unit from stock unit).

## Not changed

No row is written. `field_app_priced_quantity`, `_product_rate_unit_ok`, the switch functions and every policy and
grant stay as they are. The guards are SECURITY DEFINER trigger functions no API role can call.

## Rollback

Its own reviewed migration: drop the two triggers and the four functions.

## Settled in the cold challenge (Astra, 2026-11-24, 16 findings)

Fixed: a blank approved rate let a size's sold unit change (#1: rule 3 also runs on size edits); one restore-target
calculation, seed/each as the switch back does it (#3, #11); the switch-back skip needs the exact restore target (#4);
the join takes the group row lock (#5) and also runs on membership updates (#6); R4 reworded (#7); preflight pins
`field_app_priced_quantity` and `_product_rate_unit_ok` by md5 and requires the 20270227 planner (#10); postflight
checks the guard sorts last (#13), grants and settings (#14); bad rows are planted before the candidate (#16).
Refuted: unit-conversion edits (#2; `unit_conversions` cannot change while rates are locked, and rates stay locked
while any group uses its approved rate); a promote with no per-acre default writes no unit (#9); no `ON CONFLICT`
write on products (#12). Kept by design: a sold unit with no letter or digit passes (#8; the invoice save refuses that
product whatever its rate, a separate problem); the invoice rules are inlined by calling the function, pinned by
md5 (#15).

## Proof (Docker prover, invented data)

`scripts/smoke/prove-product-rate-unit-guard-real-schema.mjs`. MG (milligrams) is the live example: the rate-unit check
converts lb to MG, field-app invoices cannot. R1 add a size sold in MG to a lb group → refused, nothing saved; R2 the
same group with a Dry oz size → added; R3 a new product through the import path with lb on MG → refused, blank → saved;
R4 a blank rate that keeps lb on MG → refused; a converting unit or blank rate and unit → saved; R5 Move an MG size
into a lb group → refused; R6 a product already bad before the guard → a note edit saves, another bad unit refused, a
fix saves; R7 groups on their approved rate: an MG size cannot join a blank-approved lb group, an existing size's sold
unit cannot change to MG (refused today by the earlier sold-unit freeze, before this guard; its leg is a backstop), a good size joins and switching back restores the old rate on every size; a pre-guard bad
unit is put back by switching back (rule 4); R8 the migration writes no rows, a second run refuses, no API role can
execute the guard functions. Not proven: two sessions racing a join or a size edit against a switch (the row locks are by design).

## Luna round 1 (2026-11-24)

HIGH: the products trigger read the group without a lock, so a size edit that waited for a switch could still see the
group on its old rate and skip rule 3. Fixed: it reads the group `FOR SHARE`, like the member trigger, so it waits for
the switch and then sees the group as the switch left it. A size edit that already holds its row while a switch waits
for it ends in a database deadlock error for one of the two, which saves nothing; the user retries.
