## 2026-11-02 - Stock is frozen while a cycle count is open

Migration `20261103110000_freeze_stock_during_cycle_count`: while a count is open, the products it counts cannot be shipped, received or adjusted at that location. Before this, stock that moved during a count was counted twice. Starting a count is now a single server call that snapshots stock. Completing a count whose snapshot no longer matches the current system stock is refused, and a warehouse can have only one open count. Details: `docs/reference/migrations.d/20261103110000_freeze_stock_during_cycle_count.md`.
