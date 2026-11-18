# Bookings, Plans, Prepay and Inventory Timing — Audit (2026-11-17)

**Scope:** how a pre-season grower plan (booking) flows to an order and delivery (chemical sales) or to a job and application (field application), how prepay and price lock work, and how inventory reserves and forecasts the product.
**Code read:** `origin/staging` at `1e55ea039` (newest code, includes work not yet live). **Live data:** read-only counts on 2026-11-17.
**Method:** Claude audited the code. Sol (gpt-6-sol, high effort) audited the same code blind, with no access to Claude's findings. Claude then checked every Sol claim against the code. Each finding below says who found it and whether it was checked.

## Bottom line

The basic pipes are connected: a booking can become one order, several partial orders, or spray jobs, and the database stops the obvious mistakes (over-drawing a booking, cutting a line below what was already drawn, billing at a price the grower was never sent). **But three things you described are not wired up the way you work:**

1. **Money down does not lock anything.** Prepay is a loose credit on the customer's account. It is not tied to a booking and has no effect on price. The price lock comes only from *sending* the quote, and it holds until the season-end expiry whether or not the grower paid.
2. **A booking reserves stock and shows in the forecast only if someone flips "Planned program" and fills in a Needed-By date on every section.** That switch is off by default and is labelled for growers who have *not* committed, the opposite of a firm booking. Without it a booking also cannot be turned into spray jobs.
3. **The forecast cannot tell you what to buy, or when.** It checks each month separately against the whole warehouse, so two months can each look covered when together they are short. Product that has already moved onto an order loses its date. Spray jobs are counted in a second, separate report.

**Live exposure today is close to zero.** Production has 7 quotes, 1 open booking, 0 planned bookings, 0 stock holds, 0 partial orders, 0 jobs made from a booking, and 1 prepay credit that is not linked to a booking. No customer has been hurt by these gaps yet. This is the right time to fix them, before the first full season runs through the app.

## How it works today (plain English)

**Planning.** You build a quote per grower: sections (for example "Field 12, pre-emerge"), products, rate, acres and price. Sending it saves a frozen copy, and that sent price becomes the locked price. In season you can change rates, acres and quantities and keep the sent price. Raising a price needs the "Grower agreed" tick. Lowering a price or adding a product (at today's price) is allowed. A sent booking expires on Sept 30 of its season unless you pick another date.

**Chemical sales.** You either convert the whole booking into one order or take **Partial Orders** (draws) as the grower calls for product. The booking keeps a running count of what has been drawn. When an order is created, its quantity counts as "committed" in inventory. A delivery is scheduled, started and completed. Completing it takes stock off the shelf and makes the invoice. When the booking is fully drawn it closes itself. If the grower walks away, **Close – Short** releases the rest.

**Field application.** Only from a *planned* booking: **Schedule Job** copies one section into a spray job (its products, quantities, prices, one field and the Needed-By date). The job reserves the product. Completing the job takes the stock and writes the application record. **Transfer to invoice** bills it; this happens automatically only when an office user completes the job. When you are done, **Close – fulfilled by application** closes the booking by hand.

**Inventory.** There are three kinds of reservation: planned-booking holds (dated by the section's Needed-By plus 14 days), job holds (dated by the job date), and order "committed" quantity (no date). The **Forecast** tab on Inventory shows the first two by month next to today's stock, committed stock and purchase orders. The Jobs page has a separate **Projected Use Report** for unsprayed job acres.

## Gaps — ranked

Tags: **Both** = Claude and Sol found it independently. **Claude** or **Sol** = one found it and Claude checked it in the code. **Not checked** = plausible, but not traced line by line.

### A. Prepay and price lock

| # | Sev | Gap | What goes wrong | Found by |
|---|---|---|---|---|
| A1 | HIGH | Prepay is not tied to a booking or a price. The "earmark to booking" engine was shelved on 2026-06-14, and nothing ever sets the link (`prepay_credits.quote_id`). The prepay fields on the booking settlement card always read $0. | A grower pays to lock his plan, but the app records only a customer credit. Nothing shows which booking it secures, and nothing changes in the price protection. | Both |
| A2 | HIGH | Any prepay credit can be applied to any posted invoice for that customer. | Money paid down for the spring booking can be used on an unrelated fall invoice, which leaves the booking unpaid. | Sol |
| A3 | MED | The price lock depends on *sending* the quote, not on payment. A planned *draft* can be scheduled as a spray job, and that job can be billed with no sent price on record (the sent-price check skips a quote that was never sent). | A draft price that the grower never saw ends up on a spray invoice. | Sol |

### B. Reserving the product

| # | Sev | Gap | What goes wrong | Found by |
|---|---|---|---|---|
| B1 | HIGH | Only "Planned program" bookings reserve stock. The switch defaults to off, and it is required before you can schedule spray jobs. | A firm booking made in January reserves nothing and is invisible to purchasing until the product moves onto an order. | Claude |
| B2 | HIGH | A booking's hold stops counting 14 days after its Needed-By date, but the booking stays open. Planned bookings never auto-expire. | Spraying slips 3 weeks, the grower's product is no longer protected, and another sale takes it. The forecast still shows the old hold, so the two screens disagree. | Both |
| B3 | HIGH | Sales orders warn only against stock already *committed to orders*. Booking holds are ignored. | 100 gallons are held for Grower A's booking. An order for Grower B shows no shortage and takes the same 100. | Sol |
| B4 | MED | Booking holds are created even when stock is short; there is no check. | Two bookings each "hold" the same 100 units. Both look safe. | Sol |
| B5 | MED | An admin can manually release a booking's hold while the booking is still open. | The protection disappears until the next save of that booking. | Sol |
| B6 | LOW | Manual holds never appear in the forecast. | A product reserved by hand for a grower's future need has no month. | Sol |

### C. Forecasting when product is needed

| # | Sev | Gap | What goes wrong | Found by |
|---|---|---|---|---|
| C1 | HIGH | Each month is compared to the *whole* warehouse, not a running balance (`InventoryPage.tsx:1935`). Purchase orders count in every month regardless of their expected arrival date. | 100 on hand, 80 needed in March and 80 in April: both months show "covered" when you are 60 short. | Both |
| C2 | HIGH | A booking section with no Needed-By date is left out of the forecast entirely. The date box appears only when "Planned" is on. | The product is booked but purchasing never sees it in any month. | Both |
| C3 | HIGH | Once product moves onto an order (convert or partial), its date is lost. Orders have no needed-by date, and the forecast shows committed stock only as one undated number. | You cannot see that 300 gallons drawn for April delivery must arrive before April. | Both |
| C4 | MED | Two forecasts that don't agree: the Inventory Forecast (bookings and jobs) and the Jobs Projected Use Report (jobs only). Neither shows undelivered orders by delivery date. | You must stitch three screens together to decide what to buy. | Claude |
| C5 | MED | A purchase-order line received *over* its ordered quantity counts as negative "on order" in the forecast. | An over-shipment hides another PO's real incoming quantity. | Sol |
| C6 | LOW | The Projected Use Report merges products by *name and unit*, not by product. | Two different products with the same name show as one buying line. | Sol |
| C7 | LOW | The job shortage checks add stock from every location, not just Main Warehouse. | Harmless today (one warehouse only); becomes wrong once a second warehouse is added. | Sol |

### D. Chemical sales lifecycle

| # | Sev | Gap | What goes wrong | Found by |
|---|---|---|---|---|
| D1 | HIGH | **Close – Short** checks for active spray jobs but not for open partial *orders*. | A booking marked "grower walked away" still has an undelivered order holding stock and waiting to be billed. | Sol |
| D2 | MED | The booking settlement card values the remaining product at an *average* price per product. | The same product booked at two prices shows the wrong dollars left on the booking (display only; invoices are not affected). | Sol |
| D3 | LOW | The database accepts edits to an *accepted* (converted) quote. | The quote screen locks accepted quotes, so this is reachable only outside the screen. Downgraded from Sol's HIGH. | Sol (downgraded) |

### E. Field application lifecycle

| # | Sev | Gap | What goes wrong | Found by |
|---|---|---|---|---|
| E1 | HIGH | **Close – fulfilled by application** works with zero jobs, or with jobs still scheduled (only a warning). Nothing checks that anything was applied or billed. | A booking is marked done, its holds are released, and the work is never sprayed or never invoiced. | Both |
| E2 | HIGH | Finishing and invoicing every job never closes the booking itself. | Fully sprayed plans stay "open" and keep looking like open demand until someone closes them by hand. | Sol |
| E3 | HIGH | The applied acres entered at completion do not change the stock taken or the amount billed; both use the job's planned quantity. | 60 of 100 acres sprayed: the legal record says 60, but stock and the invoice say 100. | Sol |
| E4 | HIGH | Booking changes after scheduling do not reach the job (products, rates, acres, price). Two other invoice paths, blend ticket and direct field invoice, read the *current* quote price (known issue KI-81). | The grower agrees to a new rate in season, but the already-scheduled job sprays and bills the old plan. | Both |
| E5 | HIGH | Bookings do not carry the application service fee. Schedule Job copies chemicals only, and the fee is chosen at billing from that day's rate. | The agreed "chemical + application" plan can bill a different fee. | Sol |
| E6 | HIGH | Jobs completed by an *applicator* are never auto-invoiced; only office completions are (open owner decision #107). | Stock leaves and the job shows "completed", but no invoice exists until the office notices. | Sol |
| E7 | HIGH | When a job has several fields with *different* agreed $/acre overrides, the invoice falls back to the generic job price. | A grower with two field deals gets billed at neither. | Sol |
| E8 | HIGH | A multi-owner job splits *every* chemical by acre share. Chemicals are not tied to fields. | Product sprayed only on the tenant's field gets billed partly to the landlord. | Sol, not checked |
| E9 | MED | One job per booking section, using that section's single field. A *cancelled* job still blocks rescheduling (the error says "delete or cancel", but only delete works). A section without a field makes a job with no field. | Re-scheduling a rained-out spray fails; split or multi-field passes must be planned as separate sections up front. | Both |
| E10 | MED | The job invoice uses the *scheduled* date, not the date actually sprayed. | A postponed spray is invoiced under the wrong date. | Sol |
| E11 | MED | The single-owner job invoice total starts from the job's stored total, not from the sum of its lines. | If chemicals were edited without updating the total, the header and lines can disagree. | Sol, not checked |

### F. Next season (renewing a plan)

| # | Sev | Gap | What goes wrong | Found by |
|---|---|---|---|---|
| F1 | HIGH | **Roll over to season** drops each section's field and Needed-By date. On a booking with nothing drawn it also leaves the quantities blank. It does not close the old booking. | Next year's plan starts without fields or dates, so it has no holds and no forecast. The old booking can still look open. | Both |
| F2 | MED | **Duplicate** (the documented way to renew an expired quote) drops "Planned", the fields and the dates. | Same as F1. | Sol |
| F3 | LOW | The open-bookings and rollover lists show only sent and revised quotes, not drafts. | Plans still in draft don't appear in season planning lists. | Claude |

### Sol claims Claude checked and rejected

- **"The price-change check can pick the older change"**: wrong. Change ids are counting numbers in insert order, not random ids (`quote_price_changes.id` is an identity column).
- **"A retry key on Schedule Job is not bound to its section"**: wrong for current code. Migration `20261123110000` wraps the function with retry protection bound to the request.
- **"Prepay creation has no retry key"**: not relevant. The screen uses `create_prepay_check_splits`, not the function Sol read.

## Decisions only Mason can make

1. **Should every *sent* booking reserve stock and show in the forecast, or only ones marked Planned?** (Recommended: every sent booking. "Planned" then means "not committed yet".)
2. **Should money down lock the price?** Options: (a) a sent booking's price is locked until season end whether paid or not (today); (b) only a prepaid booking keeps its price after a date you pick; (c) prepay buys a discount. Should prepay be tied to one booking so it can't be spent elsewhere?
3. **Should a booking hold ever stop protecting stock while the booking is open,** or only when you close it?
4. **Should holds *block* another grower's order, or only warn?**
5. **Should jobs completed by applicators auto-create a draft invoice?** (open decision #107)

### Mason's answers (2026-11-17)

1. Every booking should count, but this needs a brainstorm first. Bookings change a lot during the season. The goal is to avoid over-ordering, and to know whether each product is needed pre-plant, in season or late summer (fungicide) so it is ordered only when needed. **Status: brainstorm.**
2. Undecided; brainstorm. What Mason wants:
   - Prepay can still pay any of the grower's charges.
   - A grower who pays down at least locks his product pricing.
   - In season, product used beyond the booking can be priced at in-season, current or the booked price.
   - If the grower switches products, Mason usually honors the prepay price on the replacement product.
   - Already built and live (`20261029110000`): a Partial Order beyond the booked amount can be priced at today's price or the booked price, chemical sales only. **Status: brainstorm.**
3. **Warn but allow** when an order would take stock held for another grower's booking (fixes B3).
4. **Yes**: a job completed by an applicator creates a draft invoice (fixes E6; closes open decision #107).

## What was not covered

- Blend-ticket and direct field-invoice bodies were read only through the docs and KI-81, not line by line.
- Nothing was run against a test database; findings come from reading code plus live counts.
- `staging` code (245 commits ahead of `main`) was audited. Some of it is not live yet.
