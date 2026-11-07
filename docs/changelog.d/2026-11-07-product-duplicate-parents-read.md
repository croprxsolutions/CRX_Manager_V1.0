## 2026-11-07 — Admins can read the duplicate product parents any time (database)

- New migration `20261206120000_product_duplicate_parents_read.sql` (record in `docs/reference/migrations.d/`).
  Adds `get_duplicate_product_parents()`, an admin-only read of the active parents that already duplicate
  one another (same EPA number, form and name), by the same rule Build uses. The Group products screen
  can then show that warning whenever it opens, not only right after Build. Grouping stays off.
- Proof: `node scripts/smoke/prove-product-duplicate-parents-read-real-schema.mjs` (disposable real-schema database).
- Applied live 2026-11-07 (ledger `20261107175628`); checked live: an admin gets the list, a sales rep is refused.
