## 2026-10-29 — A customer can take more than is left on a booking

- Mason, 2026-10-26/27: customers can take more than they booked; the rep sees the booked price,
  how much over and today's price, and chooses which price the extra is charged at (today's by
  default). Before this, Partial Order refused any quantity over what was left.
- New migration `20261029110000_booking_over_draw.sql` (row 1004 placeholder, NOT APPLIED):
  - Partial Order (`draw_down_quote`) accepts a quantity over what is left when the line says
    which price to use (`extra_price`: `today` or `booked`).
  - The booking part draws what is left exactly as before. The extra is written in the same step
    to its own ordinary order, at that price with today's cost; its notes name the booking and the
    booking order.
  - The booking ledger never goes over what was booked, so voids, cancels, settlement, rollover
    and the nightly check are unchanged.
  - A retry that switches the price choice is a different request and is refused; the same request
    replays the first result.
- Quote Builder, Partial Order: the quantity box no longer stops at what is left. Going over shows
  "N over the booking. Booked $X, today $Y" with a Today's price / Booked price choice. The
  success message names both orders, and both get the order confirmation email.
- Unchanged: every draw within what is left (the same request as before); a booking with nothing
  left is refused; the below-cost rule (an admin approves with a reason when a price is under
  today's cost).
- Proof (local replay of main `91487a92`, synthetic data): new booking scenarios S03 (extra at
  today's $13.99, booked part at the locked $12.37), S03b (booked price), S03c (no choice:
  refused), S03d (cancel the extra order: booking untouched), S03e (below cost: rep refused, admin
  with a reason gets both orders) and S03f (retry with the other choice refused) pass; every other
  scenario gives the same result as main. Tests: `src/lib/bookingOverDrawMigration.test.ts` and
  three Quote Builder tests ("taking more than is left on a booking").
