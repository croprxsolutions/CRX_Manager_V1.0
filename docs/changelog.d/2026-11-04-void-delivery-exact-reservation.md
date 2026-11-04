## 2026-11-04 — Voiding a delivery puts back only the reserved stock its completion took (KI-94)

- New migration `20261106230000_void_delivery_restores_exact_reservation.sql` (applied live 2026-11-04, ledger `20261104202037`; record in
  `docs/reference/migrations.d/`). Completing a delivery takes reserved stock only up to what is reserved; voiding
  it put back the whole delivered quantity, so with 3 reserved and 10 delivered a void left 10 reserved and
  available stock read 7 too low. Completion now records on each delivery line what it took
  (`delivery_items.quantity_prebooked_released`), and a void puts back exactly that. Lines completed before the
  migration have no record and keep the old restore.
- New proof `scripts/smoke/prove-void-delivery-exact-reservation-real-schema.mjs` (bug reproduced before the
  candidate; short, fully reserved, part delivered, nothing reserved and legacy cases after it).
- Seven `cost-exposure-review` chains reach the re-emitted functions; their allowlist keys are re-keyed from a live
  sweep after the apply (no cost field, cost read or reply path added).
- Live read-only 2026-11-04: one delivery with stock has ever been voided (DEL-00028, 2026-03-20). Nothing corrected.
- Follow-up migration `20261106233000_void_delivery_flags_legacy_reservation.sql` (applied live 2026-11-04, ledger `20261104220928`; record in
  `docs/reference/migrations.d/`), Mason's choice "flag them for review": voiding a line completed before the fix
  (no record) still puts back the whole delivered quantity, but its stock-ledger row is now marked
  `requires_review` with a note that reserved stock may be too high. Quantities are unchanged. The proof above
  covers it (only the legacy void row is flagged). Three chains reaching the void (`cancel_delivery`,
  `batch_cancel_deliveries`, `fix_delivery`) are re-keyed from a live sweep after that apply.
