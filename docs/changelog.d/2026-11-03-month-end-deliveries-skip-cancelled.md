## 2026-11-03 - Month-End Close: cancelled and voided deliveries no longer block "Deliveries completed"

Migration `20261105130000_month_end_deliveries_skip_cancelled.sql` redefines `get_monthly_summary` so `deliveries.count` leaves out `cancelled` and `voided` deliveries. Before, a month with any cancelled delivery could never show "Deliveries completed" as done (to-do 3.9). Only that one count changes; the signature, SECURITY DEFINER, `search_path`, admin-only `require_admin()` gate, owner and grants stay as installed by `20260827041000`, and pre/postflight checks pin both function bodies.
