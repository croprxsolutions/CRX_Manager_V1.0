# Chemical sales: final plan (2026-11-25)

This is the single plan for how chemical sales should work, from quote to payment to return. It merges these sources:

- **PR #2304** (22–23 Nov, draft, never merged): Mason's decisions 1–20 and the 30 ranked gaps. Everything still current from it is carried into this file.
- **Taha's review** (25 Nov PDF, "CRX Chemical side review"): he checked all 30 gaps against the code and proved 4 new problems (A1–A4) on a test copy of the database. He also proposed designs for forecasting, commission (M16), prepay and returns.
- **Mason's answers to Taha** (#crx-work, 25 Nov, 10:20 and 11:11): the business answers and the order of work. These answers are recorded one decision per file in PR #2559 (merged: commission in August, one check for several partners, decision 6 correction) and PR #2584 (open: the rest of the answers).
- **Still-current plans this file builds on, not replaces:** booking confidence rules `docs/plans/2026-11-20-booking-confidence-rules.md`, the purchasing build queue `docs/plans/2026-11-20-inventory-purchasing-and-bookings-PLAN.md`, the stock-hold rules in `docs/plans/2026-11-17-bookings-phases-B-C-prepay-PLAN.md` (Phase B only), and the season price lock `docs/plans/2026-11-24-customer-price-lock-design.md` (#2437).

Where they disagree, Mason's 25 Nov answers win, then Taha's proven findings, then the 22 Nov sheet. Taha is sending a dated plan on 26 Nov. That plan sets the dates; this file sets the rules.

## 1. How a chemical sale should work (the target)

| Step | Rule | Source |
|---|---|---|
| Quote / booking | A sent quote with gallons set aside, drawn down over several orders. Price order: (1) prepaid booking price, (2) sent quote price, (3) season price lock (#2437), (4) today's tier price, with manual prices flagged. | 17 Nov rule; Taha D |
| Next season | No copying last year's numbers. A new quote starts from last season's booking or a saved template. Products, rates and notes fill in at the grower's current tier price. Acres are left blank. Section names become a pass dropdown (Corn/Soybean × Pre-emerge, Post-emerge, Fungicide, In-furrow fertilizer, Side-dress, Other). A top line shows last season's acres per crop: the largest single pass, not the sum. Nothing counts in purchasing until acres are entered. | Mason 25 Nov (replaces Taha's "copy as draft"); decision 12 still holds |
| Roll over and last year's booking | Shows what is still open on last year's booking and asks: close it short, or keep it open. | Decision 20 |
| Booking confidence | Firm = the grower said yes: it buys and holds stock. Maybe = possible: shown as a planning total, never buys or holds. Blank ("Just quoting") counts nothing. **Likely is removed.** Not built yet: the app still offers Likely until the switch-on step in the purchasing plan runs. | 20 Nov confidence rules |
| Purchasing | Purchasing shows "To buy" (Firm plus orders) by date. No percentage setting; Mason judges extra buying. | Decision 5; 20 Nov rules |
| Stock holds | Only Firm holds stock, until it is delivered or closed. Selling stock held for another grower warns by name, then allows. | Gaps 2–3 (11-17 design) |
| Order | Booked lines keep the booked price and booked cost. **An edit never re-costs a line, including the edited line.** Only a new product line or a product swap takes today's cost. The kept cost is enforced on the server and shown on the line. | Decision 6 + Mason's A1 change |
| Edit after commission is batched or paid | Refuse the edit until the payout batch is voided. After M16, the correction rides on the next payout instead. | Decision 19 |
| Cancel Remaining | Releases only the undelivered part. Delivered quantities, returns and paid commission stay as they are. **It never cancels a load a driver already has out.** | Decision 14; gap 20; Mason's A3 check |
| Close-Short | Blocked while orders from the booking are still open. It lists each open order and any unused prepay. Leftover prepay becomes general credit or a refund. | Decision 7; Taha |
| Quick Delivery with an open booking | Per line: "draw from booking" (booked price) or "sell separately" (tier price). | Decision 9 |
| Delivery | A stock shortage never blocks the driver: the shortage is recorded and flagged for admin review. Going over the order quantity is blocked, and the driver calls the office. | Decisions 10, 16 |
| Invoice price | A draft invoice price can change, with the booked price shown beside it and a logged reason, up or down. Below cost needs an admin. | Decisions 8, 15 |
| Billing what was delivered | The Unbilled list compares delivered and billed quantity per line. A short bill stays on the list ("4 of 10 not billed") with one click to bill the rest. That click also works when the order has a whole-order invoice. | Taha A4; gap 17; Mason's check |
| Multi-delivery price | A price change on one delivery's invoice must not be charged back on the next delivery. | **Mason's new item** (`_allocated_delivery_cents`) |
| Inactive customer | Cannot be invoiced or posted until reactivated. Credit memos and payment corrections are still allowed. | Mason 25 Nov (v0.2.1, #2526) |
| Payment | One check can pay several partners' invoices, and a bounce of that check is covered. Until it is built, enter the same check number as a separate deposit on each partner. | Mason 25 Nov |
| Bounced check from a closed month | Recorded as a "returned check" entry in the current month, so the closed month stays closed (M9 is built and goes live with the next release). | Decision 18 |
| Commission (M16) | Earned only from cash or prepay actually applied, on billed profit. Write-offs, return credits and **early-pay discounts earn nothing**. Returns, voids and bounced checks lower it. A void plus a correct re-bill restores it. **No payout batch can run until M16 is live.** The first rep payout is around August. | Decisions 1, 2, 13; Mason 25 Nov |
| Prepay | Tied to a booking. While tied prepay remains, that booking's prices hold, and the prepay pays that booking's invoices first. | Taha D; Mason agreed the order of work |
| Returns: credit amount | Credit from the **exact posted invoice line** (or staff pick it), built on #2537's `priced_from`. Never the order price, and never a "newest invoice" default. | Taha A2 + Mason's change |
| Returns: damaged | Marking a return Damaged or opened clears the restock tick. Staff can tick it again. | Decision 17 (**Mason's new item**) |
| Returns: duplicates | A new return waits while an older uncredited return of the same product and order is still pending. Only as narrow as built (it fires only when tax or a standing discount is on the invoice). | Mason 25 Nov (v0.2.1, #2537) |
| Ship / Spray mark | Mason decides later. | Mason 25 Nov |

## 2. Order of work (Mason's order, 25 Nov)

1. **v0.2.1: #2526 and #2537.** Land these once they are reviewed.
2. **Before Dec 15**, in this order:
   1. A4 (short bill stays on the Unbilled list) and the delivery price carry-over fix.
   2. A2 (return credits the invoice line) and decision 17 (damaged returns don't restock).
   3. A3 (Cancel Remaining after a return or commission change, never touching a load that is out).
   4. A1 (edits never re-cost lines).
   5. Decisions 8 and 15 (draft invoice price with booked price shown and a reason).
3. **Late December:** one check, several partners (with bounces), alongside Taha's split-return work.
4. **January on:** M16 commission, then the season price lock (#2437), then the prepay tie, then forecasting and the next-season quoting design above.

**Proofs Mason asked for**, each on a test copy of the database:

- a two-delivery sale with a price change
- a short bill recovered to the cent
- Cancel Remaining after a credited return, with a load still out

## 3. Still open (decisions for Mason)

| # | Question | Recommended answer |
|---|---|---|
| O1 | Decision 19 (refuse an order edit once commission is batched or paid) was on Taha's before-Dec-15 list but not on yours. | Not needed before Dec 15, because no payout batch can run until M16 is live. Let it ride with M16 in January. |
| O2 | Taha's forecasting model (Firm / Possible, the booking line itself is the reservation, one "available" number on every screen) versus your 20 Nov rules (Firm / Maybe / Just quoting). The two mostly agree: both drop Likely, and both let only Firm buy. | Keep your 20 Nov names and blank = Just quoting. Take Taha's "booking line is the reservation" and "one available number". Settle it in January with forecasting. |
| O3 | Tied prepay: pay only that booking's invoices, or that booking first and then anything? | That booking first, then anything. Money is never stranded. |
| O4 | Does any prepay keep the price, or only above a share of the booking (for example 25%)? | January, with the prepay tie. |
| O5 | Should a partner ever be credited for gallons they weren't billed for (the 60/40 example)? | No. Keep today's refusal: it keeps the money right. |
| O6 | A season-locked price below today's cost blocks a spray-job invoice, because there is no admin override there. Field side is your lane. | Add an admin approval on job invoices, the same as chemical invoices, before #2437 ships. |
| O7 | Small questions Taha will include in tomorrow's plan: job-invoice cents, your quoting idea, the release pin. | Answer when the plan arrives. |
| O8 | A date for the v0.2.0 items Taha listed (#2066, #2091, #2097, #2089). | Confirm in his dated plan. |

## 4. Known gaps not yet in anyone's schedule

These are from the #2304 sheet, and none of them was disputed. Each needs a slot in Taha's dated plan or a decision to park it.

| Gap | What | Rule |
|---|---|---|
| 2 / Taha B | New Order and Quick Delivery ignore stock held for another grower's booking. | Warn by name, then allow. |
| 10 | Quick Delivery doesn't draw from the booking. | Decision 9. |
| 15 | Live Month-End shows about $0 received. | The fix is on staging; it ships with the next release. |
| 18 | The same check can be entered in both payment screens. | One check-number check across both. |
| 21 | Month-End can close with unbilled deliveries. | The close checks for unbilled deliveries. |
| 23 | A Quick Delivery invoice is dated when it was created, not when it shipped. | Date it at completion. |
| 24 | Quick Delivery starts with sales tax off. | Rare, so it goes with the sales-tax work. |
| Taha B | Draft POs aren't taken off "To buy", and undated Likely lines show nowhere. | Goes with January forecasting. |
| 25–28, 30 | Small technical fixes (voided credits, Month-End display, the tier price race, retry key). | Technical fixes; Taha schedules them. |
| 29 | Split-payer returns finer than hundredths. | Accepted as-is. |

## 5. What changed from the 22 Nov sheet (PR #2304)

- **Decision 6 was wrong.** The sheet said an edit keeps cost "already". Taha proved every line is re-costed (a line nobody touched went from $36.47 to $41.47). The fix is A1.
- **Return credit uses the order price** (A2), so a grower can be credited more than they paid. This was a new finding.
- **Gap 16 confirmed** (A3) and **gap 17 confirmed** (A4), both proven on a test copy of the database.
- **Commission moved** from before Dec 15 to January, because payouts happen around August and no payout batch can run until M16 is live.
- **Roll over** is replaced by the "start from last season" quoting design. Taha's "copy as draft" idea is declined.
- **Prepay example corrected:** 60 gal × $40 = $2,400, which is more than the $2,000 prepay.
- **Confidence:** the 22 Nov sheet described Firm / Likely / Maybe as built. The direction is your 20 Nov rules: Likely goes away.

## 6. Docs cleaned up with this plan

- Removed `docs/research/2026-11-25-workflow-review-decision-6-correction.md`: its content is in section 5 above. Git history keeps it.
- `docs/plans/2026-11-17-bookings-phases-B-C-prepay-PLAN.md` is marked partly superseded: its prepay and price-lock parts are replaced. Phase B (stock holds) is still used by the purchasing plan.
- PR #2304 (the 22 Nov sheet) is superseded by this file and can be closed unmerged.
- Kept on purpose: build contracts and audits for work already shipped (`docs/plans/*-CONTRACT.md`, `docs/research/2026-11-17-bookings-flow-audit/`). They are records of what was built, and code and migrations point to them. They are not direction.
