## 2026-10-25 — Margin floor review fixes (To-Do 0.2, Luna round 2)

Fixes found in review of the margin floor change, before it went live:

- `set_product_margin_floors` (`20261025210000_product_margin_floors.sql`, not yet applied) now
  refuses a malformed product id as `MARGIN_FLOOR_ITEM_INVALID`; before, it was reported as a
  duplicate product. The same product twice (in any letter case) is still
  `MARGIN_FLOOR_PRODUCT_DUPLICATE`.
- The product page's Margin Floor card no longer shows one product's floor on another product when
  a save or load finishes after the page has moved on; it resets when the product changes.
- Typing `15.00` against a saved 15% floor no longer counts as a change.
- Proof: `node scripts/smoke/prove-product-margin-floors-real-schema.mjs` re-run, PASS.
