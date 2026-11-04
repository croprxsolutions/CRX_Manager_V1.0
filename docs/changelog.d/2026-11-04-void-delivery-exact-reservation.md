## 2026-11-04 — Voiding a delivery puts back only the reserved stock its completion took (KI-94)

- New migration `20261106230000_void_delivery_restores_exact_reservation.sql` (not applied; record in
  `docs/reference/migrations.d/`). Completing a delivery takes reserved stock only up to what is reserved; voiding
  it put back the whole delivered quantity, so with 3 reserved and 10 delivered a void left 10 reserved and
  available stock read 7 too low. Completion now records on each delivery line what it took
  (`delivery_items.quantity_prebooked_released`), and a void puts back exactly that. Lines completed before the
  migration have no record and keep the old restore.
- New proof `scripts/smoke/prove-void-delivery-exact-reservation-real-schema.mjs` (bug reproduced before the
  candidate; short, fully reserved, part delivered, nothing reserved and legacy cases after it).
- Seven `cost-exposure-review` keys in `scripts/db-invariant-sweeps/allowlist.json` re-keyed to their post-apply
  values (no cost field, cost read or reply path added).
- Live read-only 2026-11-04: one delivery with stock has ever been voided (DEL-00028, 2026-03-20). Nothing corrected.
