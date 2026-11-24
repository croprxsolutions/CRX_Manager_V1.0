## 2026-11-24 - #2367: a product's rate unit must be one field-app invoices can price

- Migration `20270301130000_product_rate_unit_invoice_guard.sql` (Mason's night-run decision D4): saving a product, adding or moving a size, or importing a product now refuses a rate unit that field-app invoices cannot convert to the unit the product is sold in (`PRODUCT_RATE_UNIT_NOT_INVOICEABLE`), so an invoice line can no longer be refused later for that reason. Products already in that state stay editable (a change that leaves the rate unit, sold unit and form alone is never refused); 0 live products are in that state today.
- For a group on its approved rate, a size that would make switching back to the old rate impossible cannot join or change (`PRODUCT_PARENT_SIZE_NOT_RESTORABLE`); the switch back itself is never refused by this guard.
- No row, grant or policy changes. Proof: `node scripts/smoke/prove-product-rate-unit-guard-real-schema.mjs` (`PRODUCT_RATE_UNIT_GUARD_PROOF_PASS`, local Docker, every migration replayed).
- Not verified: the staging database (applied by the staging DB job after merge); two sessions racing a size join and a switch (the row lock is by design).
