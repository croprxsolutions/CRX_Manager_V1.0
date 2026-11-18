**PARTIAL.** V2 fixes many of the prior failure cases, but 34 prior findings remain partial or open. The most consequential gaps are the Phase A order-date rule, draw-ledger reversals, closure rules, applicator invoicing, and prepay protection.

## Prior findings

“Resolved” means v2 states a concrete rule for the prior failure scenario. It does not mean the plan is ready to build.

| # | Status | Reason if not resolved |
|---|---|---|
| 1 | RESOLVED | |
| 2 | RESOLVED | |
| 3 | PARTIAL | Undated Firm quantity is prominent and blocks a complete buy plan, but the exception does not name its owner. |
| 4 | PARTIAL | The proposed order-line delivery date has no defined source or rescheduling rule and conflicts with Phase A’s today-date rule. |
| 5 | PARTIAL | “Estimated” labels the earliest-first allocation, but Purchasing can still place the wrong section’s need in its buy calculation. |
| 6 | RESOLVED | |
| 7 | RESOLVED | |
| 8 | RESOLVED | |
| 9 | RESOLVED | |
| 10 | RESOLVED | |
| 11 | RESOLVED | |
| 12 | PARTIAL | The ledger is authoritative, but the sweep only reports drift; the plan gives no enforcement or repair rule for stored totals. |
| 13 | RESOLVED | |
| 14 | RESOLVED | |
| 15 | OPEN | Reversing a draw on short delivery is wrong while the undelivered order remains open; follow-up dating is also undefined. |
| 16 | RESOLVED | |
| 17 | PARTIAL | “Fixed rounding” does not define which section line receives a residual or prove repeated resync is stable. |
| 18 | OPEN | No shared lock order is specified for the new ledger, warning, job, cancel, and delivery writers. |
| 19 | RESOLVED | |
| 20 | RESOLVED | |
| 21 | PARTIAL | The release RPC is covered; direct updates to booking holds are not. |
| 22 | RESOLVED | |
| 23 | RESOLVED | |
| 24 | PARTIAL | Hold eligibility is aligned in words, but the separate accepted-status release trigger is omitted. |
| 25 | RESOLVED | |
| 26 | RESOLVED | |
| 27 | RESOLVED | |
| 28 | RESOLVED | |
| 29 | RESOLVED | |
| 30 | RESOLVED | |
| 31 | PARTIAL | Sharing Phase A’s PO rules still lets an overdue, unreceived PO count as supply today and suppress a warning. |
| 32 | RESOLVED | |
| 33 | PARTIAL | A trigger guard is named, but the current transition trigger returns early for admin override. |
| 34 | PARTIAL | An active invoice is required for the ready list, but qualifying invoice statuses and manual-close enforcement are undefined. |
| 35 | OPEN | The one-click close still has no valid, accurate terminal status for order-only or mixed fulfillment. |
| 36 | PARTIAL | Moving the rule to the transition trigger does not address its admin-override exit. |
| 37 | RESOLVED | |
| 38 | RESOLVED | |
| 39 | RESOLVED | |
| 40 | RESOLVED | |
| 41 | PARTIAL | A Maybe duplicate still adds could-add demand, and it can later be made Firm while the source remains open. |
| 42 | RESOLVED | |
| 43 | RESOLVED | |
| 44 | RESOLVED | |
| 45 | PARTIAL | V2 permits completed jobs without invoices but gives no durable retry rule or bounded exception to D7. |
| 46 | RESOLVED | |
| 47 | PARTIAL | `unposted` matches the existing path but conflicts with Mason’s explicit draft-invoice decision. |
| 48 | RESOLVED | |
| 49 | PARTIAL | A new actual-use record is specified, but its immutability and correction rule are not. |
| 50 | RESOLVED | |
| 51 | RESOLVED | |
| 52 | PARTIAL | Stock-unit conversion is specified; conversion into the invoice’s priced unit is not. |
| 53 | RESOLVED | |
| 54 | RESOLVED | |
| 55 | PARTIAL | V2 names the invoice’s *application date*, but does not explicitly set `invoice_date` from the legal record. |
| 56 | PARTIAL | The new season rule lacks an accounting-period and cross-season reconciliation rule. |
| 57 | PARTIAL | Clearing `invoice_id` leaves the job’s `invoiced` status, which the transfer function refuses. |
| 58 | PARTIAL | Blend-ticket exclusion remains, but an already-billed result and application-fee pricing review are not defined. |
| 59 | PARTIAL | Unlinked credit is labelled, but a payment intended to secure a booking need not be linked. |
| 60 | RESOLVED | |
| 61 | RESOLVED | |
| 62 | RESOLVED | |
| 63 | RESOLVED | |
| 64 | RESOLVED | |
| 65 | RESOLVED | |
| 66 | RESOLVED | |
| 67 | PARTIAL | The qualifying-balance formula neither defines refund accounting nor preserves protection when the credit is spent elsewhere. |
| 68 | PARTIAL | Later admin linking is offered only for open bookings; an already-expired booking has no recovery path. |
| 69 | RESOLVED | |
| 70 | RESOLVED | |
| 71 | PARTIAL | The cost guard is named, but the extent or approval rule for booked-price excess is not. |
| 72 | RESOLVED | |
| 73 | RESOLVED | |
| 74 | RESOLVED | |
| 75 | RESOLVED | |
| 76 | PARTIAL | Re-sending is stated, but the proposal, grower acceptance, and save sequence is not. |
| 77 | PARTIAL | A proof case is added; the authoritative refund/reversal accounting rule remains undefined. |
| 78 | RESOLVED | |
| 79 | PARTIAL | B prevents a completed, unbilled job reaching “ready to close,” but provides no visible B-phase exception queue. |
| 80 | PARTIAL | The matrix includes the transitions, but its stated balance equation omits closed-short quantity. |
| 81 | PARTIAL | The combined case omits the customer-supplied chemical required by the finding. |
| 82 | PARTIAL | Clock fixtures are listed without the required comparison across Purchasing, warning, and invoice dates. |
| 83 | PARTIAL | Naming a compatibility window and rollback per PR does not define feature activation or the database/screen cutover order. |

## Defects in v2 and remaining contract gaps

These are plan findings from the supplied packet; no app or database was run.

| # | Severity | Location | Failure scenario → suggested fix |
|---|---|---|---|
| 1 | BLOCKER | A-R4, plan 187; Phase A contract 71, 185–215; schema `order_items` 14 and `deliveries` 2 | An August order has no `order_items.delivery_date`; two deliveries may have different `scheduled_date` values. The proposed line date cannot be read or rescheduled as stated. Define how each open order-line remainder gets its date, then amend Phase A’s explicit today-date rule and proof. |
| 2 | HIGH | A-R3, plan 186 | Two growers have undated Firm demand for the same product. Purchasing shows “N units” without identifying whom to contact. Include grower and booking in the blocking exception. |
| 3 | HIGH | A-R5, plan 188; Phase A contract 66–69 | March and August each book 100; the rep draws 100 from August during Phase A. An earliest-first estimate makes Purchasing treat March as drawn and may defer a March purchase. Keep unattributed demand in an explicit uncertain bucket until B records its source. |
| 4 | BLOCKER | B1, plan 195; `_complete_delivery_authorized_impl` 8485–8488, 8535–8549 | An order for 100 delivers 60 and leaves 40 open. V2 says short delivery reverses 40 ledger units while the open order still demands 40, creating both a booking remainder and order demand. Reverse only when an order-line obligation is cancelled or closed; keep delivery progress separate. |
| 5 | HIGH | B1, plan 195; `_sync_quote_job_reservations` 3708–3723 | A completed job physically applied 60 units. Treating “job delete” as an unconditional ledger reversal restores 60 to the booking without restoring stock or undoing its invoice. Reverse active reservations on cancel/delete; retain completed consumption and use an explicit correction path. |
| 6 | BLOCKER | B1 save, plan 198; Phase A contract 28, 34–40, 196–203; `_save_quote_below_cost_impl_20260810` 363, 403–418, 541–584 | Phase A’s save deletes and reinserts sections and lines under reused IDs. V2 forbids doing that for drawn lines, but specifies no replacement save algorithm. Define in-place updates for referenced lines and a controlled migration from Phase A’s save behavior. |
| 7 | HIGH | B1 ledger, plan 194 | A writer updates the new ledger but fails before or omits one legacy total update; the sweep reports drift after an availability or booking decision has used that total. Derive reads directly from the ledger or enforce transactional reconciliation and specify repair. |
| 8 | HIGH | B1 jobs, plan 199–201; `_sync_quote_job_reservations` 3785–3813, 3862–3909 | Several small converted job amounts round across two quote lines. “Fixed rounding” does not say which line owns the last hundredth; a resync can shift it and change a later order’s priced tier. Define deterministic per-line residual assignment and stable resync behavior. |
| 9 | MED | B1 backfill, plan 196 | A deployed draw has a nonzero legacy total but its source line no longer survives. The backfill stops and leaves no approved correction or cutover path. Define how such rows are quarantined and reconciled before activating ledger reads. |
| 10 | HIGH | B2 holds, plan 202–205 | A Firm line has 100 undrawn units and therefore no draw-ledger row. “Dates and section shares come from the ledger plus the section date” cannot derive its 100-unit need. Calculate shares from each quote line’s booked quantity minus attributed draws and closed-short quantity. |
| 11 | HIGH | B2 eligibility, plan 206; `_sync_planned_holds` 3972–3978; `release_holds_on_quote_status_change` 4095–4100 | An accepted booking with no order gets a Firm job. Even after changing hold sync eligibility, the status-change trigger still deactivates its holds on acceptance. Update both paths with one shared eligibility rule. |
| 12 | HIGH | B2 release, plan 207; `release_inventory_hold` 4662–4679 | An admin directly updates `inventory_holds.is_active=false` for an open booking. The RPC refusal never runs, so protection disappears. Guard direct updates at the database write boundary under the applicable grants. |
| 13 | HIGH | B2 rollout, plan 205; `_sync_planned_holds` 4015–4028; `_sync_job_holds` 4270–4275 | A Firm need slips more than 14 days. During a rollout that retains old expiry dates, stock checks stop counting its hold even though D5 says it remains protected. Specify the exact reader and writer cutover transaction or compatibility rule before enabling Firm holds. |
| 14 | MED | B6 warehouse, plan 220; schema `inventory` 5 | A second inventory location is inserted. The plan’s “second active warehouse” check has no defined `active` warehouse field or scope. Define the enforced location predicate and apply it to inventory and stock readers. |
| 15 | HIGH | B3 warning, plan 210–213; Phase A contract 81–83, 213; `_recompute_po_on_order_for_products` 8905–8913 | A PO due yesterday is still unreceived. Phase A counts it as arriving today, so a competing sale may get no warning despite no stock on hand. Treat overdue unreceived supply as uncertain for the warning, or explicitly show the at-risk shortage. |
| 16 | HIGH | B3 locking, plan 213; `draw_down_quote` 1743–1756, 1890–1897; `_sync_job_holds` 4208–4219; `cancel_order` 7077–7086 | A new product lock acquired before a quote lock can oppose a job or draw path that already holds job/quote before inventory. Both wait and deadlock, or a warning reads before the competing commitment. Specify one lock order for every affected writer, including missing inventory rows. |
| 17 | BLOCKER | B5 close short, plan 217; Phase A contract 64–70; `get_booking_settlement` 5175–5186 | Book 100, draw 60, close 40 short. A separate `closed_short_qty` leaves `booked − draws = 40`, so Purchasing and settlement still report 40 owed unless every remainder reader subtracts it. Define `booked = drawn + closed_short + remaining` across holds, buying, rollover, save, and proof. |
| 18 | HIGH | B5 trigger, plan 218; `_enforce_quote_status_transition` 1035–1052 | A status transition under `app.admin_override` returns before the proposed open-order or active-job checks. A booking can close and release holds with work still open. Put invariant checks before that exit and test privileged paths. |
| 19 | HIGH | B5 applied close, plan 216–218; `close_quote_as_applied` 4802–4823 | A completed job has no active invoice. The ready list hides the close button, but a direct/RPC close can still set `closed_by_application` because v2 names no invoice guard for that transition. Enforce active invoice-group evidence at the transition boundary. |
| 20 | HIGH | B5 ready list, plan 216 versus v1 51 | All booking lines are drawn into an open, undelivered order. V2’s ready rule checks lines and jobs but drops v1’s “every order fulfilled,” so it can invite closure before delivery. Require all source orders resolved before showing or permitting close. |
| 21 | BLOCKER | B5 one-click close, plan 216; quote statuses, schema extract 41 | An order-only booking is fully delivered. Neither `closed_by_application` nor `closed_short` describes it, and `fulfilled` does not exist. Specify a neutral terminal status and its transitions, or channel-specific close rules that accurately represent mixed work. |
| 22 | HIGH | B7 rollover, plan 223–225 | The new Firm booking is sent, then the rep is asked to close the old Firm remainder. Until that click, Purchasing counts both; if the old booking has an open order/job, closing is refused indefinitely. Make the handoff of only the free remainder atomic or explicitly suppress the overlapping new demand. |
| 23 | MED | B7 duplicate, plan 225, 279; Phase A contract 77–89 | Duplicating a Maybe booking adds its quantity to could-add demand; changing the copy to Firm while the source is open can add committed demand too. “Never counted twice” is false. Link the copy to its source and require a replacement decision before counting overlapping demand. |
| 24 | HIGH | C1, plan 234, 276; Mason D7, audit 118 | Mason asked for a **draft** invoice on applicator completion. V2 specifies `unposted`, which has different office workflow semantics. Preserve draft or obtain an explicit owner decision changing that outcome; name the exact resulting status in proof. |
| 25 | BLOCKER | C1, plan 231–233, 276 | Invoice creation fails on a completed job. V2 leaves it completed and unbilled, contradicting “every completed job is invoiced,” without a retry trigger, owner, or deadline. Define a durable bill-required record, idempotent retry, alert, and explicit exception state. |
| 26 | HIGH | C1 internal builder, plan 230; `_transfer_job_to_invoice_intent_impl_20260908` 5780–5793 | An applicator’s completion calls the existing core. That core independently checks `auth.uid()` for admin/sales rep and rejects the applicator. Extract a narrowly scoped trusted builder and retain role checks on the public transfer entry point. |
| 27 | HIGH | C1 rebill, plan 235; `_transfer_job_to_invoice_intent_impl_20260908` 5801–5804 | Voiding an invoice clears `jobs.invoice_id`, but the job remains `invoiced`; a fresh retry key still hits “Job already invoiced.” Define and permit the status reset, invoice-group void semantics, and exactly-one-active-group check. |
| 28 | BLOCKER | C2 actuals, plan 237–239; `_sync_quote_job_reservations` 3740–3757, 3791–3806, 3836–3867; `_complete_job_replay_impl_20261015` 9990–9993 | A job planned for 100 uses 60. Saving `job_chemical_actuals` before status does not change reservation sync, which still reads `jc.quantity=100`; stock and invoice can read 60 while booking draw stays 100. Make completion sync read the frozen actuals. |
| 29 | HIGH | C2 units, plan 237–239; invoice transfer 5970–5979, 6205–6213 | A job line is priced per pint and actual use is entered as 2 gallons. Converting once to stock gallons does not define the quantity multiplied by the pint price; billing can be eightfold wrong. Persist original, stock, and priced quantities with one explicit conversion and cent-rounding rule. |
| 30 | HIGH | C2 actuals, plan 237; `_complete_job_replay_impl_20261015` 10181–10187 | A customer-supplied chemical has actual use recorded. A generic “stock reads actual-use” implementation deducts CRX inventory for product the grower supplied. Explicitly retain the customer-supplied exclusion while including it in the legal record and zero-priced invoice line. |
| 31 | HIGH | C2 owner shares, plan 237; invoice transfer 5967–6018 | A chemical is applied only to one of two owners’ fields. A per-job chemical actual plus field acres cannot identify that field, yet v2 says owner shares read actuals. Either add per-field chemical use or state and enforce the uniform-application limit; otherwise owner invoices misallocate product. |
| 32 | HIGH | C2 overage, plan 239, 259 | An applicator uses 20 units beyond the booking. V2 says every completion creates an invoice but the extra line awaits office pricing; it does not say whether an unpriced invoice is created or how posting is blocked. Define a `pricing_pending` line/group state and an office resolution path. |
| 33 | HIGH | C3 dates, plan 241; v1 90; invoice transfer 5951–5961, 6184–6202 | A job is sprayed across Chicago midnight or backdated into a prior season. V2 sets application date and season but leaves `invoice_date` ambiguous, and the current transfer uses today. Set all three from the frozen legal date under an explicit accounting-period rule. |
| 34 | HIGH | C4 conflict, plan 242 | A grower-approved price change is found during applicator completion. “Invoicing stops” leaves the completed job unbilled, with no durable office decision or retry step. Route it to a priced-review state and resume one invoice group after the office chooses the authorized price. |
| 35 | HIGH | P1 historical link, plan 248–252; v1 123 | A grower prepaid before launch and the intended booking already expired. Admin linking “later” cannot use v1’s open-booking picker, and no reopening rule exists. Add a controlled historical-link and benefit-review path. |
| 36 | HIGH | P2 provenance, plan 255; `_draw_down_quote_below_cost_impl_20260810` 3205–3231 | Excess product creates an order with `quote_id=NULL` and only free-text booking notes. A later invoice cannot reliably derive the “source booking” v2 promises. Persist a typed source-booking ID on the extra order/line and carry it to invoice lines. |
| 37 | BLOCKER | P3 qualification, plan 258; Mason’s prepay wishes, plan 111–115 | A linked $5,000 prepay is spent entirely on another charge, as Mason allows. Remaining balance plus spent **on this booking** becomes zero, so its booked prices lose protection despite money down being paid. Keep protection after authorized cross-booking spending; end it only under a defined refund/reversal policy or explicit release. |
| 38 | HIGH | P3 qualification, plan 258; `_recompute_prepay_credit_balance` 6735–6746 | A payment is refunded without removing an invoice application. The shown balance formula is `original − applications`; v2’s qualification may still see positive value and protect prices. Define refund/chargeback ledger effects and derive qualification from settled payment value. |
| 39 | MED | P4, plan 259 versus v1 129 | A nonprepaid booking uses extra product. V1 defaults it to today’s price; v2 says excess defaults to the selected line’s booked price without the prepay condition. That silently extends a concession. Restore the conditional default and require the rep’s explicit choice for other discounts. |
| 40 | BLOCKER | P5, plan 261–264; `_save_quote_below_cost_impl_20260810` 690–715 | Swapping X for newly added Y does not produce a `quote_price_changes` row: the loop records price changes only for an existing same-product line ID. Adding a `reason` column alone cannot log “prepay swap.” Use a dedicated swap record or explicitly insert a linked provenance event. |
| 41 | HIGH | P5, plan 262; `_assert_quote_prices_as_sent` 922–965 | The rep sends the new Y line and can then schedule/draw from that sent version; “the grower sees and accepts” is not an actual acceptance gate. Define when confirmation is required, how it is recorded, and which actions wait for it. |
| 42 | HIGH | P5 quantity, plan 261; `_save_quote_below_cost_impl_20260810` 594–683 | X has 100 acres × rate, 60 drawn, and the rep removes only 40 undrawn units. `save_quote` recomputes `rate_acres` quantity from acres × rate, potentially restoring 100 or changing billed acreage. Define a line-level swap/closed-short adjustment preserving the drawn line and its rate, acres, and price provenance. |
| 43 | HIGH | Proof additions, plan 266–269 | A close-short case has 100 booked, 60 drawn, 40 closed short. The stated `booked = remaining + surviving draws` assertion fails despite a correct close. Include `closed_short_qty`; add the omitted customer-supplied chemical and compare Purchasing, warning, and invoice clock results. |
| 44 | HIGH | B→C rollout, plan 215–216, 228–235 | B ships while applicator completion can still produce no invoice. The B ready list excludes that booking, but the “Completed, not billed” list arrives only in C. Put the unbilled exception view and recovery action into B’s compatibility window. |
| 45 | HIGH | Rollout, plan 205, 226, 270 | A database PR changes draw or hold interpretation before all old callers switch. Merely naming a compatibility window and rollback does not prevent a legacy screen from showing false availability. Specify per-PR reader/writer compatibility, feature activation order, backfill gate, and rollback behavior. |
| 46 | MED | B1 jobs, plan 199–201; `_create_job_from_quote_section_replay_impl_20261015` 3598–3617 | A section has chemicals booked against different line acreages. Scaling every chemical from one pass-acre figure can overallocate a line whose booked acreage is smaller. Require each line’s pass quantity or define scaling from that line’s own acres and cap it independently. |

OPEN-PRIOR: 34
VERDICT: FINDINGS 46