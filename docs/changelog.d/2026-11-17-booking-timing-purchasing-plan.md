## 2026-11-17 — Booking sections get timing and confidence; a read-only purchasing plan

- New migration `20270125173000_booking_timing_purchasing_plan.sql` (not applied live; record in `docs/reference/migrations.d/`). Needs `20270125110000` (PR 1a) first.
- Each booking section can say when it is needed (pre-plant, in-season, late summer) and how sure the grower is (firm, likely, maybe). Existing bookings start unset.
- An old open booking page cannot wipe those picks: its save is refused with a plain "reload" message once a section has them.
- New read-only `get_purchasing_plan`: for each product, what is booked, already promised (orders, jobs, holds), in stock and on order, and what is still to buy and by when. Firm needs without a date and lines in a unit that does not match the product's stock unit are listed apart so nothing is silently miscounted. Admin and sales reps only.
- The screens (booking picks, Purchasing tab) come in PR 2. Proof: container prover plus two rolled-back chains. Not yet verified on staging.
- Luna review: a draft Planned booking's stock hold now counts as promised (it was missed). Open order and PO lines are already in the stock unit (a trigger since `20270121110000` refuses any other unit), so they need no conversion.
