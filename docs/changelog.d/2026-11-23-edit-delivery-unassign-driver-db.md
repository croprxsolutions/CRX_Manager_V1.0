## 2026-11-23 - Delivery edit: the server can clear the driver (database part)

- Migration `20270225170000_edit_delivery_unassign_driver` (not applied): `edit_delivery` takes `p_clear_driver` (default off). On, it empties the delivery's driver after the usual checks and tells the old driver; naming a driver as well is refused (`DRIVER_CONFLICT`), and so is a delivery already started (`DRIVER_CLEAR_STARTED`; move it to another driver instead). Every call without it behaves as before. Mason decided 2026-11-23 that the office may unassign a driver.
- The Delivery page still keeps the driver when "Unassigned" is picked until the screen PR that sends `p_clear_driver` lands after this one.
- Proof: `scripts/smoke/prove-edit-delivery-unassign-driver-real-schema.mjs` shows the bug before the migration and every case after it, including the refusal on a started delivery. Record: `docs/reference/migrations.d/20270225170000_edit_delivery_unassign_driver.md`.
