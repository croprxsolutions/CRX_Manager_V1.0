## 2026-11-03 — A Partial Order quantity is in whole hundredths, so a booking always closes (S02)

- New migration `20261106110000_draw_quantity_whole_hundredths.sql` (applied live 2026-11-04; record in
  `docs/reference/migrations.d/`). Booked quantities are saved to 0.01, but a Partial Order
  quantity had no step: three draws of 333.333 gal from a 1,000 gal booking left 0.001 gal that no
  draw could take, so the booking never closed and the orders billed $12,369.99. `draw_down_quote`
  now refuses a quantity with more than 2 decimal places (`BOOKING_QUANTITY_PRECISION`); 333.33 +
  333.33 + 333.34 closes the booking at exactly $12,370.00.
- Partial Order screen: the quantity box steps in 0.01 and says so before sending; the server
  refusal shows the same plain message.
- Freshness re-check (read-only, 2026-11-04 14:41 UTC): the live ledger has 1117 rows. Its newest are
  `20261106110000` (ledger `20261104112804`) and `20261106130000` (`20261104131837`); every migration on
  `main` through `20261105190000` is live, and `20261106140000` (#13) is not. `KNOWN_ISSUES.md` no longer
  calls `20261029090000` (PR #1200, ledger `20261031103934`) or `20261029120000` (PR #1203, ledger
  `20261031130629`) unapplied. `CURRENT_STATE.md` and `KNOWN_ISSUES.md` are re-stamped 2026-11-04 for the
  live ledger only; nothing else in them was re-certified.
