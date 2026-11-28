## 2026-11-24 - #2394 follow-up: the Inventory Forecast honours the Inventory page setting

- Migration `20270302140000_inventory_forecast_requires_inventory_page.sql`: `get_inventory_forecast` (the Inventory page's Forecast tab) now refuses a sales rep whose Inventory page is turned off in Settings > Page Access (`PAGE_ACCESS_DENIED: inventory`), the same check #2394 added to the purchasing plan. Before, that rep could still call it and read the business-wide planned demand, stock and PO coverage. Admins, and reps with Inventory on, see the forecast exactly as before; no forecast logic changed.
- Stock position (`get_inventory_position`) is unchanged and stays open, because New Order, Quick Delivery, Receiving and other screens read it.
- Proof: `node scripts/smoke/prove-inventory-forecast-inventory-page-real-schema.mjs` (`INVENTORY_FORECAST_INVENTORY_PAGE_PROOF_PASS`, local Docker).
- Not verified: the staging database (applied by the staging DB job after merge).
