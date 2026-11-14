## 2026-11-10 — KI-108 migration also locks the cycle-count tables (not yet applied)

- `20270103150000_ki108_stock_matches_history.sql` now locks `cycle_counts` and `cycle_count_items` along
  with `inventory` and `inventory_transactions`, so a stock count started while the correction runs waits for
  it to finish instead of snapshotting the old stock (Luna round 1). Offline proof re-run: PASS.
