## 2026-11-06 — New product and Add a size save notes in the same step (database)

- New migration `20261202110000_product_size_notes_in_one_step.sql` (record in `docs/reference/migrations.d/`).
  "New product" and "Add a size" (`create_product_with_parent`, `add_product_size`) now also take
  `quoting_notes` and `internal_notes` inside the size (`p_size`) and save them in the same step as
  the product, so a new product is never live without its notes. Each is text or null, at most 5000
  characters, stored trimmed; blank is none. Same function inputs; a call without them is unchanged
  (PR #1553 Sol round 2; Mason, 2026-11-06).
- Proof: `node scripts/smoke/prove-product-size-notes-real-schema.mjs` (disposable real-schema database).
