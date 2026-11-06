## 2026-11-06 — Each sale line has a vendor (billing plan M3, database)

- New migration `20261116110000_sale_line_vendor.sql` (not applied; record in
  `docs/reference/migrations.d/`). An order line now has a vendor, filled from the product's
  preferred vendor when the line is created, whichever path creates it. Its invoice line carries it.
  A line from before this change falls back to the product's preferred vendor.
- An admin can change a line's vendor on the sale, and a save can change it on a draft invoice, for
  when the office bills after delivery. Neither touches the product or its preferred vendor.
- Proof: billing scenario B09 passes on the local test copy (it failed before); smoke chain
  `smoke-sale-line-vendor.sql` passes. No screen yet.
