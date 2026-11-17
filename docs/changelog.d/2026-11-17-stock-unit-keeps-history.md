## 2026-11-17 — Once a product has history, its stock unit is fixed (Sol HIGH on the units batch)

- `20270121120000_stock_unit_keeps_history.sql` (new, not applied live): a stock-unit change (other than case or
  spacing) is refused (`PRODUCT_UNIT_HAS_HISTORY`, naming up to 5 records) once the product has any order, delivery,
  purchase-order or return line or receiving record. Before, only open lines and stock were checked, so after a change
  an approved return could not be received (`RETURN_CREDIT_INVENTORY_UNIT_MISMATCH`) and a received purchase-order line
  could not be undone. Screens already cannot change a stock unit (setup guard); this makes the rule hold for data
  corrections too. No data changes.
- Contract: `docs/plans/2026-11-17-stock-unit-keeps-history-CONTRACT.md` (challenged by Astra; the first, narrower
  draft was replaced). Proof: `node scripts/smoke/prove-units-batch-real-schema.mjs` (cases H0, H1, R;
  UNITS_BATCH_PROOF_PASS). Rollback: `scripts/smoke/stock-unit-history-guard-reverse.sql` (proven), before the
  units-batch reverses.
