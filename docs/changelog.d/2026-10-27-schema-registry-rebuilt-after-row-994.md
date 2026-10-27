## 2026-10-27 — Schema registry rebuilt from live after `last_charged_prices` (row 994, PR #1119)

- `.claude/schema-registry.json` rebuilt from live introspection (high-water `20261027160349`, 1070 ledger rows /
  1063 names): adds `price_tier_at_sale` on `order_items` and `invoice_items` with their range CHECKs, and every
  other migration applied since the last rebuild (rows 985 to 994). Row 994's own record is PR #1153.
- `src/lib/rpcContracts.test.ts`: `write_product_pricing_history` leaves `MUTATOR_INVENTORY_EXEMPT` (its pre-apply
  window ended when row 993 applied), worded as in PR #1148, which makes the same change.
- `src/lib/costFields.ts`: `price_tier_at_sale` joins `ORDER_ITEM_COLUMNS` and `INVOICE_ITEM_COLUMNS` (a non-cost
  column; the migration granted it the same read access as the tables' other non-cost columns). The rebuilt registry
  made `costFields.test.ts` refuse the unclassified column. Checked live: both lists read as `authenticated` with no
  permission error. No screen writes these tables directly, and the stamp trigger replaces any sent value.
