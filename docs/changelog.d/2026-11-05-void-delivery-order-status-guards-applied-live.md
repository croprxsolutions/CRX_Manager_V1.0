## 2026-11-05 — KI-101 and KI-102 fix is live

- `20261107120000_void_delivery_respects_voided_and_cancelled_orders` applied live (ledger `20261105060300`) before PR #1471 merged. Voiding a delivery of a voided order is now refused, and voiding one of a cancelled order keeps the order cancelled. Live smoke chain `void_delivery` passed. KI-101 and KI-102 marked fixed; revoking admins' direct `orders.status` grant (KI-101) still needs Mason's yes.
- Re-keyed the `cost-exposure-review` allowlist entries for `cancel_delivery`, `batch_cancel_deliveries` and `fix_delivery`, whose chain reaches the replaced body. The change touches only quantities and statuses, no cost columns.
