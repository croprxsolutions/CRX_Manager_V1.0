**LOCAL CANDIDATE — NOT APPLIED.** `20261108130000_product_parent_stock_units.sql` (SQL sha256: `a90f65c81e301ea1c2e0087f5cf3d931981e29e6031261127e2d296a60b532d5`). PAR-1 follow-up, from the Codex App review of PR #1501. REQUIRES `20261108120000_product_parents` (live); its preflight pins the two installed helper bodies it replaces, so against anything else the one-transaction apply changes nothing.

What it does:
- A seed or each parent's one rate is per stock unit (PAR-1 previews and saves it in each size's `inventory_unit`). A parent holding a 50 Lb bag and a size stocked as Unit would give 30 Lb/acre to one and 30 Unit/acre to the other. Adding a size (`add_product_size`, through `_insert_parent_size`) and moving one (`preview_move_product_size` and `move_product_size`, through `_product_size_move_refusal`) now refuse a size whose stock unit differs from the parent's other sizes, ignoring case and spaces: `PRODUCT_PARENT_UNIT_MISMATCH: every size of "<parent>" is stocked in <unit>; a seed or each parent's rate is per stock unit`. Liquid and dry parents are unchanged; their rate unit converts.
- New private `_product_parent_unit_refusal(product_parents, text, uuid)` (SECURITY DEFINER, `search_path = public, pg_temp`, no API-role EXECUTE). Re-issued private `_insert_parent_size` and `_product_size_move_refusal` (same signatures, grants re-asserted, postflight checks them).

No table, row or public function changes, and no grant on an existing object. Live had no parents when this was written (read-only count, 2026-11-05).

Rollback: re-issue both functions from `20261108120000_product_parents.sql`, then `DROP FUNCTION public._product_parent_unit_refusal(public.product_parents, text, uuid);`.

Proof: `node scripts/smoke/prove-product-parents-real-schema.mjs` installs it right after PAR-1 and prints `PRODUCT_PARENTS_PROOF_PASS` (a Unit size refused on a Lb seed parent, a second Lb size accepted, a move into a Unit seed parent refused).
