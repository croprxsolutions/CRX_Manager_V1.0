## 2026-11-23 - Delivery edit: "Unassigned" now clears the driver (screen part)

- On the office Delivery edit form, picking "Unassigned" for a delivery that has a driver now sends `p_clear_driver` to `edit_delivery`, so the driver is actually removed (before, the old driver stayed). Mason decided 2026-11-23 that the office may unassign a driver.
- Needs migration `20270225170000_edit_delivery_unassign_driver` live first (database-first PR); until then this save would be refused.
- Proof: two unit tests in `src/pages/DeliveryDetail.brandEdit.test.tsx` (the Unassigned one fails on the old screen code).
