## 2026-11-25 — Order of work from Taha's chemical-side review

**Decision (Mason, reply to Taha's 2026-11-25 chemical-side review posted in #crx-work; "Yes, record them"):** Taha's chemical-side work goes in this order:
1. #2526 and #2537 (v0.2.1) first.
2. Before Dec 15: A4 (a short bill dropping off the Unbilled list; also make "billing the rest" work when the order has a whole-order invoice) plus the delivery price carry-over fix (a price change on one delivery's invoice must not be charged back on the next delivery); A2 plus decision 17 (damaged/opened returns don't restock); A3 (Cancel Remaining must not cancel a load a driver already has out); A1; decisions 8 and 15 (draft-invoice price change with a logged reason).
3. Late December: one check, several partners, covering a bounced check too (adds to `2026-11-25-taha-review-one-check-several-partners.md`).
4. January on: M16 commission, then the price lock #2437, then tying prepay to a booking, then forecasting and the next-season quoting design.

**Why:** the proven money fixes come before Dec 15; commission can wait because payouts come around August and no payout batch runs before M16 (`2026-11-25-taha-review-early-pay-no-commission.md`).
**What this forbids/implies:**
- The Ship / Spray mark is Mason's to decide later; it is not scheduled.
- Mason asked Taha to prove on a copy of the database: a two-delivery sale with a price change; a short bill recovered to the cent; Cancel Remaining after a credited return with a load still out.
- All of these are Taha's lanes until Dec 15.
