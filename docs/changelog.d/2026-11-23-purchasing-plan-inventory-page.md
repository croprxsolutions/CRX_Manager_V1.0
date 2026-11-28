## 2026-11-23 - #2388 Sol HIGH 2: the purchasing plan honours the Inventory page setting

- Migration `20270228210000_purchasing_plan_requires_inventory_page.sql`: `get_purchasing_plan` now refuses a sales rep whose Inventory page is turned off in Settings > Page Access (`PAGE_ACCESS_DENIED: inventory`). Before, that rep could still call it and read planned bookings (customer, product, quantity) and PO coverage. Admins, and reps with Inventory on, see the plan exactly as before; no planning or booking logic changed.
- The shared page check `_require_page_access` (KI-119) now also knows the `inventory` page, with the same rule as the report pages.
- Proof: `node scripts/smoke/prove-purchasing-plan-inventory-page-real-schema.mjs` (`PURCHASING_PLAN_INVENTORY_PAGE_PROOF_PASS`, local Docker).
- Not verified: the staging database (applied by the staging DB job after merge).
