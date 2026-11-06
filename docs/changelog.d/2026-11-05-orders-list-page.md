## 2026-11-05 — The Orders list can read one page at a time with true totals (Goal 4, database half)

- New migration `20261116120000_orders_list_page.sql` (not yet applied): read-only `get_orders_page` applies the Orders screen's season, filters, search and sort in the database and returns one page of rows plus the count and cent total of every matching order. It runs with the caller's own permissions (SECURITY INVOKER), so each role sees exactly what the screen shows it today. Nothing calls it yet.
- Proof script `scripts/smoke/prove-orders-list-page-real-schema.mjs` (scratch container, 5,250 orders, compared with the screen's previous browser logic) and live smoke chain `smoke-goal4-orders-page.sql`.
- The Orders screen switches to it in a separate PR after this is live.
