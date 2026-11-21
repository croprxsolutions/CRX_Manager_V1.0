## 2026-11-21 - #2018: drivers can list open deliveries and take one for themself (database part)

- Migration `20270204120000_driver_available_deliveries.sql` adds `get_available_deliveries_for_driver()`: an active driver only (everyone else refused) gets up to 20 open deliveries (unassigned, scheduled, not deleted), soonest first, with only number, date, customer and top farm group. Mason decided 2026-11-21 that every driver may see these. The deliveries read rule is unchanged.
- `reassign_delivery` (driver branch only) now locks the delivery before checking it, refuses deleted deliveries, and lets a driver assign a delivery only to themself. Two drivers taking one delivery at once: the first gets it, the second is refused. Admin and sales rep reassigning is unchanged.
- No data changes. The current app never calls the new function, so it is safe before the screen change. The screen switch ships in a follow-up PR after this is on the staging database.
- Contract: `docs/plans/2026-11-21-driver-available-deliveries-CONTRACT.md`.
- Proof: `node scripts/smoke/prove-driver-available-deliveries-real-schema.mjs` (`DRIVER_AVAILABLE_DELIVERIES_PROOF_PASS`).
