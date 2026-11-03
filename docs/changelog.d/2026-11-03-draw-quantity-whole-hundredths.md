## 2026-11-03 — A Partial Order quantity is in whole hundredths, so a booking always closes (S02)

- New migration `20261104160000_draw_quantity_whole_hundredths.sql` (NOT APPLIED; record in
  `docs/reference/migrations.d/`). Booked quantities are saved to 0.01, but a Partial Order
  quantity had no step: three draws of 333.333 gal from a 1,000 gal booking left 0.001 gal that no
  draw could take, so the booking never closed and the orders billed $12,369.99. `draw_down_quote`
  now refuses a quantity with more than 2 decimal places (`BOOKING_QUANTITY_PRECISION`); 333.33 +
  333.33 + 333.34 closes the booking at exactly $12,370.00.
- Partial Order screen: the quantity box steps in 0.01 and says so before sending; the server
  refusal shows the same plain message.
