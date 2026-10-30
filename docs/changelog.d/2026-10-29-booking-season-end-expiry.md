## 2026-10-29 — Bookings run to season end unless the rep picks a date

- Mason, 2026-10-26/27: a booking runs until season end (the app's Oct 1 – Sept 30 season), staff
  can set an optional expiry date, and an alert goes out when one passes. Before this, every send
  set the expiry to today plus "Valid Days" (15).
- New migration `20261029100000_booking_season_end_expiry.sql` (row 1003 placeholder, NOT APPLIED):
  - New column `quotes.chosen_expiry_date` (empty = season end). Readable by signed-in users,
    written only through `save_quote`.
  - Every send sets the expiry to the picked date, else Sept 30 of the season the send falls in. A
    picked date that has already passed is refused (`QUOTE_EXPIRY_IN_PAST`).
  - The daily expiry run also sends the rep one "Booking past its date" alert when a part-drawn
    booking passes its date. Such a booking still never expires (A5), and planned ones never do.
- Quote Builder: "Valid Days" is replaced by **Expires: Sep 30, YYYY (season end) / Pick a date**.
  On a sent quote, a change applies at the next send. The quote PDF always shows the date.
- Unchanged: editing a sent booking keeps its expiry (#1105); undrawn bookings still expire at their
  date; every function grant; quotes already sent keep their current expiry until they are re-sent.
- Proof (local replay of main `79803bc1`, synthetic data): booking scenarios S21 (no pick → Sept 30),
  S21b (picked date kept; yesterday refused) and S21c (part-drawn past its date: stays open, one
  alert over two daily runs) went from FAIL to PASS; S05a–c (today's expiry rules) and every other
  scenario give the same result as main. Tests: `src/lib/bookingSeasonEndExpiryMigration.test.ts`
  and three new Quote Builder tests ("expiry: season end or a picked date").
