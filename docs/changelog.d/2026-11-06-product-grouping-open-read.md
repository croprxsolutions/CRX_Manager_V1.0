## 2026-11-06 — Admins can see whether product grouping is switched on (database)

- New migration `20261202130000_product_grouping_open_read.sql` (record in `docs/reference/migrations.d/`).
  Adds `get_product_grouping_open()`, an admin-only read of the product grouping switch, so the Group
  products screen can hide Approve while grouping is off instead of offering a button that is always
  refused. The switch stays off; turning it on is a separate, owner-approved step.
- Proof: `node scripts/smoke/prove-product-grouping-open-read-real-schema.mjs` (disposable real-schema database).
