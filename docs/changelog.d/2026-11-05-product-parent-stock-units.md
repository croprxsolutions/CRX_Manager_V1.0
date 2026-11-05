## 2026-11-05 — Product parents: a seed or each parent's sizes share one stock unit (PAR-1 follow-up)

Migration `20261108130000_product_parent_stock_units.sql` (not yet applied live). A seed or each parent's rate is per stock unit, so adding or moving in a size stocked in a different unit (a Unit size under a Lb parent) is now refused by name instead of giving the two sizes one number in two units. Liquid and dry parents are unchanged. Proof: `scripts/smoke/prove-product-parents-real-schema.mjs`.
