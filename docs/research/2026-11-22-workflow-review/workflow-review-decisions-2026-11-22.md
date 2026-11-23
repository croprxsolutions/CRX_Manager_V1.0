# Mason's decisions from the 2026-11-22 workflow review

Companion to `chemical-sales-workflow-2026-11-22.html` and `field-application-workflow-2026-11-22.md` in this folder. These are business rules, mostly not built yet. Already true today (checked 2026-11-22): decision 6 for ordinary edits (an existing line keeps its cost; a product swap or new line takes the cost sent), and decision 10 (stock shortage never blocks the driver). Corrections from the review: `review-reconciliation-2026-11-22.md`.

| # | Topic | Decision (Mason, 2026-11-22) | Lane |
|---|---|---|---|
| 1 | Rep commission payable | Only when the customer has paid, and only on what was actually billed. Not at order creation, not on planned profit. | Chemical billing: Taha's lane until 12-15 |
| 2 | Commission adjustments | Follow the money: a return or credit lowers commission; a void + corrected re-bill restores it. | Taha's lane until 12-15 |
| 3 | Field App Invoice screen | One screen for all field billing. Straight chemical the grower picks up = chemical sale (order/delivery), never a field invoice. Product we MIX (our rig or grower sprays) = Field App Invoice, with the applicator (our rig or the grower) filled in and a spray record written. Stock leaves exactly once: at mixing (blend ticket), or at invoice save when there is no blend ticket or job. | Field billing: Mason's lane |
| 4 | Job quantities | Product charge and stock follow what actually went in the tank: the mixer edits the job's product totals (planned 160 ac, mixed 162 ac -> bill and deduct 162). Sprayed acres go on the spray record and drive the per-acre application fee. | Mason's lane |
| 5 | Buying for Likely bookings | **Dropped (Mason, 2026-11-22).** No percentage setting. Mason judges how much of the Likely amount to buy himself; Purchasing keeps showing Firm ("To buy") and Likely ("Could add") as built. | - |
| 6 | Cost on an edited order | Existing lines keep their booked cost; only a newly added line takes today's cost. **Already how the app works** for edits to an existing line. | Orders: Taha's lane until 12-15 |

## Chemical sales walkthrough (Mason, 2026-11-22, second round)

| # | Topic | Decision | Lane |
|---|---|---|---|
| 7 | Close - Short with undelivered orders from the booking | Block the close and list each open order (ordered / delivered / still due, with a link) plus any unused prepay. Staff deliver it or "Cancel remaining" first; then the close goes through. Extra product priced at today's price does not block. (Astra's recommendation, accepted.) | Bookings: Taha's lane until 12-15 |
| 8 | Changing a price on a draft invoice | Allowed, but the screen shows the booked/order price beside it and requires a short reason when they differ; who, old, new and why are logged. Below-cost still needs an admin. | Chemical billing: Taha's lane until 12-15 |
| 9 | Quick Delivery for a grower with an open booking | Stronger than today's banner: a product that is on his open booking is flagged per line, and staff pick "draw from booking" (booked price, booking goes down) or "sell separately" (tier price). | Bookings/deliveries |
| 10 | Completing a delivery when stock shows short | Keep today: allow, record the negative, flag it for admin review. Drivers are never blocked by a stock shortage. (Going over the order quantity is different: decision 16.) | No change |
| 11 | Product cost from what was paid the vendor | Already decided 2026-11-04 in `docs/plans/2026-07-16-inventory-costing-plan.md` section 12 (average-cost Phase 2, fresh start from a stock count); parked until Mason's build go-ahead. | - |
| 12 | Roll over / Duplicate to next season | Copy products, sections, rates per acre and program notes only. Never copy fields (so no acres or quantities), dates, timing or confidence. Roll over asks whether to close last year's booking (decision 20). | Bookings: Taha's lane until 12-15 |

## Third round (Mason, 2026-11-23, answering the review's questions Q1-Q8)

| # | Topic | Decision | Lane |
|---|---|---|---|
| 13 | What "customer paid" means for commission (decision 1) | Only cash or prepay actually applied. A write-off or a return credit never earns commission, even though it marks the invoice paid. | Taha's lane until 12-15 |
| 14 | Cancel Remaining after a return or a cancelled/paid commission (gap 16) | Release only the undelivered part. Delivered quantities, returns and already-paid commission stay as they are. This unblocks decision 7. | Orders: Taha's lane until 12-15 |
| 15 | Draft invoice price above the booked price (decision 8) | A logged reason is enough, up or down. No "grower agreed" tick on the invoice. Below cost still needs an admin. | Taha's lane until 12-15 |
| 16 | Driver completing more than the order line says (F05 vs decision 10) | Blocked: the driver is told to call the office. Decision 10 ("never block the driver") covers only the shelf showing short. The built F05 guard already behaves this way. | Deliveries |
| 17 | Return marked Damaged or opened (gap 19) | Changing the condition to Damaged/opened clears the "restock" tick; staff can still tick it back on. No admin approval needed. | Returns |
| 18 | Bounced check from a closed month (gap 22) | Record a "returned check" entry in the current open month: the invoice becomes unpaid again (and any prepay that check funded comes off); the closed month stays closed. | Payments: Taha's lane until 12-15 |
| 19 | Order edit after commission is batched or paid (gap 5) | Refuse the edit until the payout batch is voided, like Cancel Remaining. Once decision 1 (pay on customer payment) is built, carry a correction into the next payout instead. | Orders: Taha's lane until 12-15 |
| 20 | Roll over and last year's booking (decision 12, gap 12) | Roll over shows what's still open on last year's booking and asks: close it short, or keep it open. | Bookings: Taha's lane until 12-15 |

Still open: prepay (tie to booking, price lock) - waiting on Mason's brainstorm.
