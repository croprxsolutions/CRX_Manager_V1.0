## 2026-10-27 — Records: `last_charged_prices` applied live (row 994, PR #1119)

- `20261027060000_last_charged_prices` applied live 2026-10-27 16:03:49 UTC (ledger `20261027160349`) before
  PR #1119 merged as `36167c12e`. The live `name` keeps the authored basename, so the disk file keeps its name (B7).
  `docs/reference/migration-history.md` row 994 now says APPLIED LIVE, with a new top live-ledger capture (1070 rows).
- `.claude/schema-registry.json` rebuilt from live introspection (high-water `20261027160349`): adds
  `price_tier_at_sale` on `order_items` and `invoice_items` with their range CHECKs, and every other migration
  applied since the last rebuild (rows 985 to 994).
- `src/lib/rpcContracts.test.ts`: `write_product_pricing_history` leaves `MUTATOR_INVENTORY_EXEMPT` (its pre-apply
  window ended when row 993 applied), worded as in PR #1148, which makes the same change.
- `src/lib/costFields.ts`: `price_tier_at_sale` joins `ORDER_ITEM_COLUMNS` and `INVOICE_ITEM_COLUMNS` (a non-cost
  column; the migration granted it the same read access as the tables' other non-cost columns). The rebuilt registry
  made `costFields.test.ts` refuse the unclassified column. Checked live: both lists read as `authenticated` with no
  permission error. No screen writes these tables directly, and the stamp trigger replaces any sent value.
- `docs/manual/TO_DO_LIST.md`: 0.3 now says live.
- Verified live (read-only): the two columns, the four functions' definer rights, search path and grants, and both
  stamp triggers enabled.
