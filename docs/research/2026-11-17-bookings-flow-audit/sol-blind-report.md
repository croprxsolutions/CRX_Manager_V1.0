# CRX Manager business-flow audit

**The packet does not support a clean end-to-end verdict.** Chemical-sale and field-application paths both exist, but several handoffs can leave a booking different from what is ordered, applied, billed, reserved, or shown in the purchasing forecast. This is a **source-level audit of the supplied packet**, not a test of the live app.

## 1. Flow as implemented

- A rep builds a grower quote with sections, products, rates, acres, quantities, prices, and optional `needed_by_date`. `save_quote` saves the header and lines together.
- Sending creates a `quote_versions` snapshot. A sent or revised quote is treated as an open booking.
- For an existing sent line, later saves normally retain its price. An explicit price change is logged; a price increase requires a rep to tick “Grower agreed.”
- A quote marked `is_planned` gets `crop_program` inventory holds for its undrawn quantities. The section’s need date supplies the hold’s timing.
- **Chemical sales:** a rep either converts the whole booking to one order or draws selected quantities into partial orders. Both paths move quantity into `inventory.quantity_prebooked`; partial orders also update the booking draw ledger.
- A delivery is created from the order, confirmed, then completed. Completion deducts physical stock, updates delivered and remaining quantities, and normally creates a draft invoice for the delivered lines.
- A partial delivery leaves order quantity outstanding and can create delivery-remainder rows. Follow-up deliveries can bill additional delivered quantity.
- **Field application:** a planned quote section can create a scheduled job. The job copies the section’s chemicals, quantities, and prices. Active jobs hold stock and consume part of the booking’s drawable balance.
- Completing a job creates an application record and deducts its job-chemical quantities from stock. An office user can transfer the completed job to a field-application invoice; automatic drafting depends on a setting and who completed the job.
- Direct field-application invoices and blend-ticket invoices are additional paths outside the quote → order → delivery chain.
- A booking becomes `accepted` on whole conversion or when order draws consume it fully. Staff can instead close an open booking `closed_short` or `closed_by_application`.
- Those booking statuses do not, by themselves, prove delivery, application, invoice posting, or payment.

## 2. Price lock and prepay today

The operative quote price control is the **last trusted sent version**, supplemented by logged changes to existing lines. `_assert_quote_prices_as_sent` is called on the shown whole-conversion wrapper, partial draw, and quote-section job scheduling paths. Quantity, rate, and acre changes can proceed at the sent line price without another send. A higher price requires the rep’s “Grower agreed” tick; the packet shows no customer-supplied confirmation artifact.

Prepay is a **customer credit**, applied to a posted or overdue invoice for that customer. `create_prepay_credit` does not take a quote ID. `apply_prepay_to_invoice` checks customer identity, balance, and invoice status, but does not check the credit’s `quote_id` against the invoice’s booking. The UI excerpt says the assign-to-booking earmark was removed. The settlement RPC can display credits that *already have* a `quote_id`, but the supplied creation path does not establish that link. **Paying money down does not itself lock a booking price, and the shown application path does not reserve that money for the booking’s eventual invoices.**

## 3. Inventory reservation and timing today

Planned quotes use `inventory_holds`; orders use `quantity_prebooked`; active jobs use job holds. Physical stock, `quantity_available`, falls only at delivery or application. Booking draws reduce quote holds as order prebooks or job reservations take over. Manual holds have a server-side capacity check. Planned-quote and job holds are created without that same capacity refusal, while order and delivery paths warn and proceed on shortages.

`get_inventory_forecast` groups active quote holds by **section need date** and job holds by **job date**, then repeats current on-hand, prebooked, and on-order supply beside each product/month row. It does not produce a cumulative month-by-month stock balance. A quote line with no need date has a hold but no row in that forecast. Once a sale is drawn into an order, its remaining physical need is represented as undated prebooked quantity rather than a dated demand row.

## 4. Findings

1. **HIGH — An accepted booking can be changed without changing its order. Both.** `supabase/migrations/20261204100000_ki18_batch1_chicago_today.sql`, `_save_quote_below_cost_impl_20260810`: a same-status `accepted` save is allowed, and the sent-price assertion runs only when *entering* `accepted`. A rep or admin can add units or a new product to an accepted quote; the existing order stays as it was, while the booking now describes product that cannot be drawn through the normal open-booking path.

2. **HIGH — Booking revisions do not update an already scheduled job. Field application.** The same `save_quote` implementation calls `_sync_quote_job_reservations`, which reallocates holds and draws, while `create_job_from_quote_section` copied chemicals, price, acres, and job date into separate job rows. If the grower changes a product, rate, acreage, or price after scheduling, the booking changes but the existing job can still apply and invoice its earlier copy.

3. **MED — The price-change check can select the wrong “latest” change. Both.** `supabase/migrations/20261101100000_quote_price_trail_and_expiry_grant.sql`, `_assert_quote_prices_as_sent`: it selects the latest `quote_price_changes` row with `ORDER BY c.id DESC`, although IDs are not change timestamps. After two legitimate changes, UUID sort order can select the older price and refuse fulfillment with `QUOTE_RESEND_REQUIRED`.

4. **HIGH — Direct field-application and blend-ticket billing do not pass through the sent-price assertion. Field application.** `docs/workflows/QUOTE_TO_DELIVERY.md:77,291–330` names these parallel invoice paths and says they read current quoted pricing. A rep can change a quote after sending it, then bill through one of these paths without the convert/draw/job scheduling check that establishes which price the grower was sent. The exact invoice SQL was not supplied, so the packet does not show every variation of this failure.

5. **HIGH — The booking has no first-class, locked application-service fee to carry into a job. Field application.** The supplied `quotes`, `quote_sections`, and `quote_items` columns have no `application_service_id`; `create_job_from_quote_section` does not populate `jobs.application_service_id`. `transfer_job_to_invoice` computes that fee from the job’s service and the applicable rate at billing time. A grower can agree to a chemical-plus-application plan, yet scheduling the section carries only its chemicals; staff must separately set the service, and a later rate can determine the fee.

6. **BLOCKER — A down payment is not bound to the booking price it was meant to secure. Both.** `supabase/migrations/20260327200000_wave4_security_integrity.sql`, `create_prepay_credit`, has no quote parameter; `PrepaymentManagerPanel.tsx:117,336` says booking earmarking was removed. A grower pays to lock a plan, but the payment creates customer credit rather than a priced booking commitment. A still-unsent draft can continue to follow current tier prices.

7. **HIGH — Even a credit carrying `quote_id` can pay an unrelated invoice. Both.** `supabase/migrations/20260718153744_20260718124500_harden_prepay_and_payment_role_gate.sql`, `apply_prepay_to_invoice`, checks matching `customer_id` but not booking or order lineage. Staff can apply money associated with Booking A to the same grower’s unrelated Invoice B, leaving A unpaid when fulfilled.

8. **MED — Direct prepay creation has no retry key. Both.** `create_prepay_credit` takes no idempotency key. If an admin submits a down payment, loses the reply, and submits it again, this function has no shown way to recognize the first credit; two credits can be recorded for one payment. The packet does not show whether the current UI uses this RPC or another creation RPC.

9. **HIGH — Planned-booking holds can exceed stock without an override decision. Both.** `_sync_planned_holds` inserts quote holds without the free-stock check used by `create_inventory_hold`. Two planned bookings can each reserve 100 units while only 100 exist, making both appear held. Job holds similarly warn rather than refuse; this may be the intended operational policy, but these holds are not a guarantee of allocated physical stock.

10. **HIGH — A new sale can consume stock already held for another grower without an order warning. Chemical sales.** `docs/workflows/INVENTORY_RULES.md:35–49,149` and `create_direct_order` / `_convert_quote_to_order_owner_impl` / `_draw_down_quote_below_cost_impl_20260810` use available − prebooked + on-order for warnings; active holds are excluded. With 100 on hand and all 100 held for Grower A, an order for Grower B can show no shortfall and prebook the same 100.

11. **HIGH — An admin can manually release a live booking hold while its booking stays open. Both.** `supabase/migrations/20260702182000_layer2_release_hold_reject_job.sql`, `release_inventory_hold`, rejects job holds but allows `crop_program` holds. Releasing one removes the booking’s current stock protection and forecast row until a later resync, while the grower’s open booking still promises the quantity.

12. **HIGH — A planned line without a need date is absent from the timing forecast. Both.** `_sync_planned_holds` sets `expires_at` from `needed_by_date + 14 days`; a missing date yields null. `get_inventory_forecast` requires `ih.expires_at IS NOT NULL`, and `InventoryPage.tsx:476` uses that RPC. The stock may be held, yet purchasing sees no month in which it is needed.

13. **HIGH — A booking can remain open after its timed stock hold ceases to count. Both.** `_sync_planned_holds` gives the hold an expiry 14 days after need; `docs/workflows/INVENTORY_RULES.md:165–170` says expired holds no longer count. `auto_expire_quotes` deliberately skips all planned quotes. If application or delivery slips past that window, the booking and locked price remain open while its reservation no longer protects today’s free stock. `get_inventory_forecast` can still display the active-flagged hold in its old month because it does not filter out elapsed expiry dates.

14. **HIGH — Drawing a chemical sale removes its need date from demand forecasting. Chemical sales.** `_draw_down_quote_below_cost_impl_20260810` prebooks the order and consumes the quote hold; the shown order fields and inserted order items do not retain `quote_sections.needed_by_date`. `get_inventory_forecast` has no order-demand rows. Purchasing can see the prebooked total but cannot tell *when* the drawn product must arrive.

15. **HIGH — Monthly forecast rows are not a running purchasing plan. Both.** `supabase/migrations/20261204110000_ki18_batch2_chicago_boards.sql`, `get_inventory_forecast`, repeats today’s available/prebooked/on-order figures for every month; `InventoryPage.tsx:1959` compares demand to those figures row by row. With 100 units available and 80 needed in each of two months, each month can look covered although total demand is 160. Supplier PO expected-delivery dates are not allocated to forecast months either.

16. **MED — Over-received PO lines can reduce the forecast’s on-order number. Both.** `get_inventory_forecast` sums `quantity_ordered - quantity_received` directly; `docs/workflows/INVENTORY_RULES.md:51–55` specifies `GREATEST(...,0)` per line. A line ordered for 100 and received at 110 contributes −10, offsetting another PO’s genuine outstanding 10 and understating incoming supply.

17. **BLOCKER — Seasonal rollover does not build a usable new reservation or settled quantity. Both.** `supabase/migrations/20261015200000_quotes_rep_own_name.sql`, `rollover_quote_to_season`, creates a planned draft without calling `_sync_planned_holds` or settling quote header totals. On an undrawn source it also inserts copied lines without `total_units_needed`. A rep rolling a booked plan into next season can receive a draft with no active new holds and no shown booked quantity until a separate save recalculates it.

18. **HIGH — Rollover loses field and timing and leaves the source open. Both.** The same `rollover_quote_to_season` copies sections without `field_id` or `needed_by_date` and does not close the source quote. A spring field plan rolled forward loses its field and target date; if staff later rebuild new holds, the old open booking can still reserve or represent the same product until separately closed.

19. **HIGH — Duplicating a planned booking drops its planning identity. Both.** `supabase/migrations/20260812115236_quote_items_cost_at_quote_snapshot.sql`, `duplicate_quote`, does not copy `is_planned`, `field_id`, `needed_by_date`, or section header notes. Using Duplicate to renew a grower program produces an ordinary draft without the old reservation, purchasing date, or field link. The function also copies stored line prices; the packet does not show that today’s price is applied before this new draft is sent.

20. **HIGH — Some open bookings remain drawable past their quoted expiry. Both.** `auto_expire_quotes` skips planned quotes and partly drawn quotes, while `_draw_down_quote_below_cost_impl_20260810` and `create_job_from_quote_section` check status but not `expires_at`. A season-old planned booking can remain `sent` and be drawn or scheduled at its retained price unless staff explicitly close or revise it.

21. **HIGH — A planned draft can be applied and billed before being sent. Field application.** `create_job_from_quote_section` accepts a planned `draft`; `_assert_quote_prices_as_sent` returns immediately if no sent version exists. The grower can be charged from a job created off an internal draft price with no sent-price record.

22. **MED — Cancelling a quote-section job does not free that section for a replacement job. Field application.** `create_job_from_quote_section` rejects any non-deleted job with the same `quote_section_id`, regardless of its status, although its error says “Delete or cancel.” A rep cancels a postponed job and tries to reschedule from the same booking section; scheduling is refused until the old job is also deleted.

23. **HIGH — A quote section with no field can create a field-application job. Field application.** `create_job_from_quote_section` inserts `job_fields` only when `quote_sections.field_id` exists, with no refusal otherwise. A rep schedules an application from a section lacking a field; the job can enter the completion/invoice path without a field-specific application location or reliable field acres and service-fee basis.

24. **HIGH — Actual applied acres do not reconcile chemical stock or billing quantities. Field application.** `_complete_job_replay_impl_20261015` accepts `p_applied_info.field_acres` for the application record but deducts the full `job_chemicals.quantity`; `_transfer_job_to_invoice_intent_impl_20260908` bills the job chemicals and planned `job_fields.acres_to_treat`. If 60 of a planned 100 acres are sprayed and 60 actual acres are entered, the legal record can say 60 while stock and invoice still reflect the 100-acre plan.

25. **MED — A job invoice uses the planned job date rather than the recorded application date. Field application.** `_complete_job_replay_impl_20261015` computes and stores actual `application_records.application_date`; `_transfer_job_to_invoice_intent_impl_20260908` writes `invoices.application_date = v_job.job_date`. A postponed spray appears on its invoice under the earlier scheduled date.

26. **MED — The single-owner job invoice does not reconcile its header to its chemical lines at transfer. Field application.** `_transfer_job_to_invoice_intent_impl_20260908` initializes `total_amount_cents` from `jobs.total_price_cents`, then builds invoice lines from the current `job_chemicals`. If chemicals were edited without a matching job-total update, the amount due differs from the sum of its lines. The packet lacks the job editor and all job-total triggers needed to determine how often that precondition occurs.

27. **HIGH — Single-owner per-acre overrides can disagree with invoice product lines. Field application.** In `_transfer_job_to_invoice_intent_impl_20260908`, the single-owner path always inserts priced chemical lines, then replaces the invoice header amount with the `invoice_shares` override amount. A grower with an all-inclusive $/acre override can see chemical lines totaling one amount while the invoice header and share demand another; posting may reject it or issue inconsistent paperwork, depending on missing post guards.

28. **HIGH — Different per-field overrides can be silently ignored in a single-owner job. Field application.** The same transfer function retains `price_override_cents` only when the grouped owner has exactly one distinct override; otherwise it falls back to percentage of `v_job.total_price_cents`. A grower with two fields priced at different agreed $/acre rates can receive an invoice based on the generic job price rather than either field agreement.

29. **HIGH — One job cannot allocate different chemicals to different owners’ fields precisely. Field application.** The multi-owner branch of `_transfer_job_to_invoice_intent_impl_20260908` splits each job-wide chemical quantity and price by every owner’s share of total job acres. `job_chemicals` has no field link in the supplied schema. If Product A is sprayed only on the tenant’s field and Product B only on the landlord’s, this path distributes both products to both payers.

30. **HIGH — Applicator-completed jobs are not automatically invoiced. Field application.** `_complete_job_replay_impl_20261015` attempts automatic transfer only for admin/sales completions; for an applicator it logs `auto_draft_skipped`, even when the setting is on. The job is marked completed and stock is removed, but an office user must find and transfer it to bill the grower.

31. **BLOCKER — “Closed by application” does not prove application or billing. Field application.** `supabase/migrations/20260703200000_layer2_close_quote_as_applied.sql`, `close_quote_as_applied`, allows closing with **zero** jobs or with scheduled/in-progress jobs; the latter produces only a warning. It checks no completed application quantity or invoice. A rep can mark a planned booking fulfilled, release its remaining quote holds, and leave work unapplied or unbilled. The direct status trigger `_enforce_quote_status_transition` also lacks those RPC-specific conditions.

32. **HIGH — Completing and invoicing all jobs does not itself close the booking. Field application.** `_complete_job_replay_impl_20261015`, `_transfer_job_to_invoice_intent_impl_20260908`, and the supplied job lifecycle triggers update jobs, holds, draws, and invoices, but show no transition of the parent quote to `closed_by_application`. A fully applied and billed plan can remain an open `sent`/`revised` booking until a separate manual close.

33. **HIGH — “Closed short” can leave live drawn orders to deliver or bill. Chemical sales.** `supabase/migrations/20260706030000_closed_short_booking_closure.sql`, `close_quote_as_short`, checks active jobs but not linked order fulfillment or invoices. Staff can mark a partly drawn grower booking abandoned while its confirmed draw order still prebooks stock and awaits delivery or billing.

34. **HIGH — Booking settlement money can be materially wrong. Both.** `supabase/migrations/20260702180000_layer2_rollover_settlement_job_aware.sql`, `get_booking_settlement` and `get_open_booking_rollover`, value remaining units at a product-wide weighted average and provisional job draws at the *current quote* average. For 100 units at $1 and 100 at $2, drawing the $1 tier leaves $200 of booked product, but the card values the remaining 100 at $1.50. A later quote price change can likewise make the displayed value of an already priced job differ from its invoice.

35. **MED — Job shortage and dispatch checks can count stock that cannot ship. Field application.** `get_job_inventory_shortfalls` and `get_dispatch_stock_status` aggregate inventory across locations, whereas `docs/workflows/INVENTORY_RULES.md:275–282` says jobs ship from Main Warehouse only. Stock in another or legacy location can make a Main Warehouse shortage look covered.

36. **MED — The projected-use report can merge distinct products with the same name and unit. Field application.** `src/lib/projectedUseReportData.ts:212–237`, `buildProjectedUseReportData`, keys totals on `product_name` and unit, not product ID or SKU. Two distinct purchasable products sharing a display name and unit become one purchasing line.

37. **MED — Manual holds are absent from the dated demand forecast. Both.** `get_inventory_forecast` includes only `crop_program` and `job` holds, while `InventoryPage.tsx:658–662` creates manual holds with optional expiry. Staff can reserve product for a named grower’s future need using a manual hold; free stock falls, but the forecast shows no month or quantity for that commitment.

38. **LOW — Quote-section job retries are not bound to their requested section. Field application.** `create_job_from_quote_section` reads an idempotency result by key and operation before checking the quote or section and stores only `job_id`. If a key is reused for a different section or quote, the call can return the earlier job ID as though the new scheduling request succeeded.

## 5. What the packet cannot settle

- **What is deployed now.** The packet includes migrations dated after the stated current date of November 17, 2026. A live migration ledger and `pg_proc` definitions would establish which findings describe production versus source awaiting deployment.
- **Which public overloads and wrappers callers can reach.** The packet shows older public function bodies beside newer private implementations for conversion, delivery completion, job completion, and prepay application. Live function signatures, grants, and wrapper definitions would establish the exact active call chain.
- **Whether posting catches every inconsistent invoice.** The posting functions, invoice constraints, and full direct field-application/blend-ticket invoice bodies were not supplied. Those would show whether the price and line/header mismatches above issue a wrong invoice or fail before posting.
- **Whether job edits always recalculate job totals.** The full job editor, write RPCs, and job-total triggers would settle Finding 26’s precondition.
- **How credits acquire `prepay_credits.quote_id`, if at all.** The full prepay creation/edit RPCs and their UI would settle whether any current workflow still earmarks money despite the removed panel action.
- **Whether operational queues reliably catch unbilled work.** Full cockpit/watchdog definitions and live counts of completed jobs without invoices, accepted bookings with undelivered orders, and open bookings with expired holds would show the current exposure.
- **What `get_inventory_position().planned_qty` includes.** Its body would settle whether the Inventory page’s `holds_qty + planned_qty` display duplicates any planned demand.

**Recommended next step:** use the live function definitions and a small set of read-only reconciliation queries to confirm deployment and count affected bookings, then fix the closure, prepay, and forecast handoffs first.

VERDICT: FINDINGS 38
