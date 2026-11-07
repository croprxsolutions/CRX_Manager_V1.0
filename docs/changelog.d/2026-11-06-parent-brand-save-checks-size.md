## 2026-11-06 — A shared parent brand is saved only from a size still under that parent (database)

- New migration `20261203110000_parent_brand_save_checks_size.sql` (record in `docs/reference/migrations.d/`).
  `upsert_parent_brand` now also takes the size whose page is saving (`p_product_id`) and refuses with
  `PRODUCT_BRANDS_PARENT_CHANGED` unless that size is still under the parent. Before, a size moved to another
  parent after its page loaded could edit its old parent's shared brands. No released screen calls this
  function yet, and it stays refused while grouping is switched off.
- Proof: `node scripts/smoke/prove-parent-brand-save-checks-size-real-schema.mjs` (disposable real-schema
  database, including a save racing a move of the size).
