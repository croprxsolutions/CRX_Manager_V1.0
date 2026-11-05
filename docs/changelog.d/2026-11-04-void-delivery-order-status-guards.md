## 2026-11-04 — Voiding a delivery respects a voided or cancelled order (KI-102, KI-101)

- New migration `20261107120000_void_delivery_respects_voided_and_cancelled_orders.sql` (record in
  `docs/reference/migrations.d/`). It re-emits only `_void_delivery_replay_impl_20261015`, the body behind
  `void_delivery`:
  - KI-102: voiding a delivery whose order is already voided is refused (`ORDER_VOIDED_DELIVERY_LOCKED`). The order
    void already put that stock back; before the fix the delivery void put it back a second time and reopened the
    voided order.
  - KI-101: voiding a delivery of a cancelled order keeps the order `cancelled`. The goods go back on the shelf, but
    the reservation is not put back and the line's remaining quantity is not raised, since a full cancel already
    released the reservation and zeroed what remains, and nobody will deliver a cancelled order. (An order
    cancelled through the direct status change released nothing; its reservation and remaining quantity are left
    as they were.) Before the fix the order was reopened with the reservation restored.
  - Every other void is unchanged (same stock, status and ledger as before), and so are the grants.
- New proof `scripts/smoke/prove-void-delivery-order-status-guards-real-schema.mjs`: both bugs reproduced on a
  throwaway copy before the candidate, fixed after it, and three normal voids identical before and after.
  `prove-void-delivery-exact-reservation-real-schema.mjs` now allows this later file, which keeps its quantities.
- Live read-only 2026-11-04: 0 voided orders; 4 cancelled orders, none with a completed delivery or delivered
  quantity. Nothing to correct.
- Not in this change (needs Mason's yes, a permissions change): revoking signed-in admins' direct UPDATE grant on
  `orders.status` (KI-101).
