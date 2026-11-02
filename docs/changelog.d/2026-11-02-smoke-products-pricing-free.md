## 2026-11-02 - Smoke chains create pricing-free products; CI keeps it that way

Since the 2026-07-18 pricing cutover, the database refuses a Product created with a cost or price
(`PRODUCT_PRICING_GOVERNED_PATH_REQUIRED`). Smoke chains that still did so died at setup before
testing anything.

- Repaired: `smoke-blend_invoice_app_service_guard`, `smoke-field-app-line-warehouse-vendor-glb`,
  `smoke-fuel-surcharge` and `smoke-remaining-money-inventory-hardening` create an unpriced Product,
  then price it through the app's own preview/apply pricing functions. The fee-guard chain also
  moved to ounce units and an $8.00 cost, because newer rules refuse unconvertible units and
  unexplained below-cost lines. `smoke-return-credit-chain` drops a cost it never used (that insert
  runs with triggers off). `smoke-supplier-cost-basis-phase2` drops explicit blank prices.
- Live rolled-back results on 2026-11-02: the fee-guard chain and both fuel-surcharge blocks pass.
  Three get past setup and stop at older, unrelated stale expectations: field-app (quantity 5, expected
  80, an ounce-to-pound conversion), money/inventory hardening (receiving now answers "No items
  provided for receiving"), and return-credit (delivery completion now needs confirmation evidence;
  it stops before the changed line).
- Deleted as obsolete one-off June column-fix chains that no spec runs and whose functions
  registered chains still cover: `smoke-blend_invoice_column_fix`,
  `smoke-inventory_cost_report_column_fix`, `smoke-load_recipe_column_fix`,
  `smoke-quick_delivery_column_fixes`, `smoke-split_invoices_jsonb_fix`,
  `smoke-item-profit-sameproduct-edit`, `smoke-recipe-per-unit-pricing`.
- New CI step `npm run check:smoke-product-inserts`
  (`scripts/smoke/check-smoke-product-inserts-pricing-free.mjs`) fails when any
  `scripts/smoke/*.sql` inserts a Product with a pricing column, across line breaks. A file opts
  out with `-- smoke-allow-priced-product-insert: <reason>`; four do, because they prove the
  refusal or run only before the cutover in a disposable proof database.
