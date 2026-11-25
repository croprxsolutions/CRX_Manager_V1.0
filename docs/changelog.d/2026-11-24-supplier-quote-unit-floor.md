## 2026-11-24 — Supplier quotes refuse a tiny package size or conversion factor, and a cost over $10,000,000

- Migration `20270305200000_supplier_quote_unit_floor.sql` (NOT APPLIED): a supplier link's conversion factor and a
  quote's package quantity must be at least 0.001 (and not NaN), and one quote line can cost at most $10,000,000.
  The quote staging step marks such a row invalid (`PACKAGE_QUANTITY_INVALID`, new `COST_TOO_LARGE`); new checks on
  `product_supplier_links`, `supplier_price_observations` and `supplier_price_import_rows` (rows awaiting approval)
  refuse a link save, approval, correction or late quote save outside the bounds. The apply refuses if any stored row is already outside a bound (production has none). Together the bounds
  keep the converted cost per inventory unit at or below 1e15 cents, so it can no longer overflow.
- Supplier Pricing screen and error messages say the rule in plain English.
- Closes (deletes) known issues `2026-11-24-supplier-quote-tiny-conversion-factor` and `2026-11-24-supplier-quote-test-duplicate-rows`
  (the screen test now stages rows the server would not mark duplicate).
- The quote review screen warns when a pending quote's supplier is archived; approval stays allowed (Mason, 2026-11-24,
  decision log `2026-11-24-archived-supplier-quote-warning`). Closes (deletes) known issue `2026-11-24-supplier-quote-archived-vendor`.
