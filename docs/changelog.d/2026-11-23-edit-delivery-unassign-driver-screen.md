## 2026-11-23 - Delivery edit: "Unassigned" now clears the driver (screen part)

- On the office Delivery edit form, picking "Unassigned" over the driver the form opened with now sends `p_clear_driver` and `p_expected_driver` (that driver) to `edit_delivery`, so the driver is actually removed (before, the old driver stayed). Mason decided 2026-11-23 that the office may unassign a driver.
- If dispatch changed the driver while the form was open, the server refuses the whole save and the form says so; a form that opened with no driver never clears one (a Take Delivery made meanwhile survives the save). Unassigned is disabled on a started delivery, and a current driver missing from the driver list stays shown.
- Needs migrations `20270225170000_edit_delivery_unassign_driver` and `20270226163000_edit_delivery_expected_driver` live first (database-first PRs); until then this save would be refused.
- Proof: unit tests in `src/pages/DeliveryDetail.brandEdit.test.tsx` (the Unassigned one fails on the old screen code).
