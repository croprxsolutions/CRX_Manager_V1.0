# Agvance deep dive (gap-fill on first pass)

Method: public help center only (helpcenter.agvance.net and its knowledgeowl mirror). Facts below come from fetched pages; items marked "search digest" come only from search-result summaries. Pages vary in age (some 2023-2026), so menu paths may have changed.

## 1. Void or reverse an invoice

### Takeaway
Agvance has two distinct mechanisms. VOID (current fiscal month only) wipes the invoice from the customer account, inventory and GL and reopens the source tickets; the invoice vanishes from the statement. REVERSE (any month, even paid) keeps the original and creates a negating invoice in the current month, so both show on the statement. Bookings/prepay effects of void/reverse are NOT described on that page.

### Cited Findings
- Void is only for invoices saved in the current fiscal month; prior-month invoices must be reversed. Path: Accounting / A/R / Invoice, select invoice, Void. - [Void/Reverse Invoice](https://helpcenter.agvance.net/home/void-reverse-invoice)
- Void reverses all postings to the customer account, inventory and GL; Delivery/Blend/Energy tickets used to build the invoice are reopened; the voided invoice does not appear on the customer statement. - [Void/Reverse Invoice](https://helpcenter.agvance.net/home/void-reverse-invoice)
- Voided invoices show in red on the Select an Invoice window; fields cannot be edited on the Void window; a reason may be entered. - [Void/Reverse Invoice](https://helpcenter.agvance.net/home/void-reverse-invoice)
- Reverse: original stays in its original fiscal month; a new offsetting invoice with the same products/prices and negated quantities is created in the current month; reverses customer, inventory and GL postings; tickets reopen; both original and reversal print on the statement; both show red in the invoice picker. Reverse is allowed at any time regardless of paid status. - [Void/Reverse Invoice](https://helpcenter.agvance.net/home/void-reverse-invoice)
- Accounting Preference (A/R tab) "Do Not Mark Reversing Invoices as Paid": off = original and reversal both marked Paid on save; on = both stay Open. After a reversal, neither the original nor the reversal can be voided. - [Void/Reverse Invoice](https://helpcenter.agvance.net/home/void-reverse-invoice)
- Audit trail: Location Preference "Require a reason when invoice is voided or reversed" makes a reason mandatory; reason shows when the document is reopened; the Batch Void Invoices utility (Hub / Admin Utilities / Accounting / A/R Utilities) gets a Void Reason field. - [Void/Reverse Invoice](https://helpcenter.agvance.net/home/void-reverse-invoice)
- COD invoices cannot be voided or reversed (built for pay-before-leaving); paid invoices are "not meant" to be voided. - [Void/Reverse Invoice](https://helpcenter.agvance.net/home/void-reverse-invoice)
- Prepay-related reversal: a credit invoice created by Transfer Customer Prepay can be voided/reversed to return the dollars to the booking only if End of Prepay Season has not been run. - [Transfer Customer Prepay](https://helpcenter.agvance.net/home/transfer-customer-prepay)
- Work orders (saved as delivery tickets) also have Reverse and Void in the ellipsis menu. - [Work Orders - SKY Customer](https://helpcenter.agvance.net/home/customer-work-orders)

### Inferences
- Inferred: the void-vs-reverse split follows the month-close lock: current month may be erased, closed months only get an offsetting entry. A mirror rule for CRX: closed-period documents are never deleted, only offset.
- Inferred: void "reopens tickets" so shipped-not-billed product returns to the unbilled queue; inventory is therefore not re-adjusted at void time (the ticket still holds the inventory movement) - not stated on the page.

### Gaps
- The article does not state what happens to bookings, prepay balances or equal-billing accounts on void/reverse (it lists an equal-billing article as related). The first-pass notes record a "booking has been invoiced" message after void and an admin "Open a Booking" repair utility ([A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs)).
- No detail on a log table beyond the reason field.

## 2. Bookings, generic prepay, GL, refunds, expiry

### Takeaway
Booking types: unpaid (price lock + quantity), prepaid, down payment, generic prepay (lump sum). Matching at invoice is by a fixed precedence. Leftover prepay at season end is moved (via a credit invoice) to the regular balance, unapplied cash, another customer, or refunded by an auto-printed check. Explicit debit/credit accounts for receiving prepay were not published.

### Cited Findings
- Booking types: product-specific unpaid (locks price, tracks quantity, no money); product-specific prepaid (reduces customer Prepay balance); Down Payment (partial payment locks price, no further payments after save); Generic Prepaid (lump sum, applied automatically at a designated Price Level). - [Invoicing Bookings](https://helpcenter.agvance.net/home/invoicing-bookings)
- Invoice line "Level" column shows Book, View or Quote; an invoice cannot be saved if a line shows View. Status column: Paid, Book, Dwn, Book/Paid. If a booking does not fully cover a line, Split / Partial / Steal options decide the remainder. Charging a different price needs Retain Invoice Price checked. - [Invoicing Bookings](https://helpcenter.agvance.net/home/invoicing-bookings)
- Relief: "Unbook Line" untags bookings on one line, "Unbook Invoice" untags all; "Prepay Book Only" handles a book-only booking plus prepaid dollars on one line. - [Invoicing Bookings](https://helpcenter.agvance.net/home/invoicing-bookings)
- Expiry: bookings carry start and expiration dates, but "Expired Bookings can still be used on an Invoice" (an expired one may show View in the Level column). - [Invoicing Bookings](https://helpcenter.agvance.net/home/invoicing-bookings)
- Matching precedence at invoice: (1) product-specific bookings by field, (2) product-specific bookings, (3) generic/classification bookings, (4) generic/generic (all products). Matching uses Inventory Department Category + Product ID, else Department ID + Product ID. - [Bookings Hierarchy](https://agvancehelpcenter.knowledgeowl.com/home/bookings-hierarchy); [Generic Prepaid Bookings (search digest)](https://agvancehelpcenter.knowledgeowl.com/home/generic-prepaid-bookings)
- Generic prepay: created under Product Bookings with Generic Prepay checked, a Prepay Type (set up at Accounting / Setup / A/R / Generic Prepay Types), Price Level, and Prepay Amount; cannot be split between customers (search digest). Unapplied cash can also fund a booking via Payments or Payment on Account. - [Prepay & Bookings index](https://helpcenter.agvance.net/home/prepay-bookings); [Generic Prepaid Bookings (search digest)](https://agvancehelpcenter.knowledgeowl.com/home/generic-prepaid-bookings)
- Season end options for leftover prepay: leave it in Prepay for next season, move to Regular balance, or refund by check. - [Prepay & Bookings index](https://helpcenter.agvance.net/home/prepay-bookings); [Transfer Customer Prepay (search digest)](https://helpcenter.agvance.net/home/transfer-customer-prepay)
- Transfer Customer Prepay setup: per Location choose a non-inventory "Prepay Product" and a "Prepay Vendor" (one dedicated refund vendor recommended). - [Transfer Customer Prepay](https://helpcenter.agvance.net/home/transfer-customer-prepay)
- Transfer to Regular: one invoice with offsetting negative and positive lines; the positive line is marked Paid using paid booking; result is a credit invoice on the regular account. To Unapplied Cash: apply that credit invoice in Payments with pay method Adjustment and no amount. - [Transfer Customer Prepay](https://helpcenter.agvance.net/home/transfer-customer-prepay)
- Refund creates three entries: a Transfer Prepay Invoice, a negative Adjustment payment against the credit invoice, and a Quick Check to the Prepay Vendor (auto-printed); the check debits the GL account assigned to the Adjustment pay method, offsetting the adjustment posting. Undo by voiding all three; a transfer-to-regular can be undone only before End of Prepay Season runs. - [Transfer Customer Prepay](https://helpcenter.agvance.net/home/transfer-customer-prepay)
- Transfer to another customer: credit invoice on source, negative Adjustment payment, then a Paid Booking on the receiving customer with Adjustment pay method. - [Transfer Customer Prepay](https://helpcenter.agvance.net/home/transfer-customer-prepay)
- Month-end "Move A/R Prepay" and the "End of Prepay Season" process: see first-pass notes ([EOM process](https://helpcenter.agvance.net/home/full-accounting-end-of-month-process)).

### Inferences
- Inferred: prepay is held as a separate customer balance (own card in Grower360, own GL account via Move A/R Prepay), and refund is deliberately routed through invoice + payment + check so every step is an auditable document, never a direct balance edit.
- Inferred: expiry is informational (warns, does not block).

### Gaps
- GL accounts debited/credited when prepay is received and when applied at invoice: not published in pages retrieved.
- Booked-but-undelivered product at year end (deferred revenue / commitment treatment): not found.

## 3. Lot numbers and unit conversion

### Takeaway
Product has an Inventory Unit (stock/sold quantity) and a separate Billing Unit (price), joined by a Billing Divisor. Lot numbers are optional on delivery ticket lines with negative-lot controls per location.

### Cited Findings
- Inventory Unit = unit for quantity sold, purchased and on hand (printed on invoice, e.g. 5500 lbs or 2.75 tons); Billing Unit = unit the price is quoted in; Billing Divisor = number of inventory units per billing unit (2000 for lbs priced per ton); Unit Weight = pounds per inventory unit; Package Units/Size feed delivery tickets, hazmat papers, tonnage-tax report. - [Product Setup in Accounting](https://helpcenter.agvance.net/home/product-setup-in-accounting)
- Pounds-to-tons: set a unit ID "Tns" in Company Preferences and choose it as inventory unit; pounds typed on delivery tickets convert automatically and inventory is relieved correctly (search digest). - [Convert Pounds to Tons](https://agvancehelpcenter.knowledgeowl.com/home/convert-pounds-to-tons-automatically)
- Rate per acre: product Blend Setup tab holds Rate/Acre Units, a Recommended Rate/Acre defaulted when added to a field plan or blend ticket, and a Rate to Blending ratio (rating units per blending unit; a Ratio Wizard calculates it). Density defaults suggested: 10 lb/gal liquid (search digest). - [Product Setup in Accounting](https://helpcenter.agvance.net/home/product-setup-in-accounting)
- Seed/Lots tab holds lot info and a Calculate button for lot quantities; flags Is Bio Tech and Is Insect Resistant. - [Product Setup in Accounting](https://helpcenter.agvance.net/home/product-setup-in-accounting)
- Delivery ticket line carries optional lot number; location prefs control negative lot balance (warn/disallow) and print lot # on invoices (first-pass, [Delivery Tickets](https://helpcenter.agvance.net/home/add-delivery-ticket), [Location Preferences](https://helpcenter.agvance.net/home/location-preferences)).
- Consignment is a checkbox on the product Profile tab; consignment items can optionally appear on inventory statements. - [Product Setup in Accounting](https://helpcenter.agvance.net/home/product-setup-in-accounting)

### Inferences
- Inferred: acres x rate/acre -> quantity in blending unit -> converted to inventory unit through the ratios above; exact calc order not documented.

### Gaps
- In-transit inventory: nothing public found. Vendor returns: searched, no Agvance page found (only other vendors' results); first-pass notes say purchase receipt errors need void and re-entry. Credit-invoice mechanics for customer returns are in first-pass notes.

## 4. Custom application

### Takeaway
Custom application is a flag on the invoice/ticket plus services (work orders) that become delivery tickets, dispatched to an applicator app that records job data and signatures. Public pages do not document the acres-to-charge calculation.

### Cited Findings
- A "custom applied" checkbox sits on the Additional Info window of an invoice or delivery ticket, and on the General tab of blend tickets (search digest; the same flag exempts a transaction from permit checking, see section 5). - [Agvance Ops / custom application (search digest)](https://agvancehelpcenter.knowledgeowl.com/home/hub-products-regulation-of-restricted-product)
- Work orders are started from the Fields tab in SKY Customer, are saved in Agvance Windows as Delivery Tickets, then dispatched through SKY Dispatch; searchable by work order #, service name, ticket date, user. - [Work Orders - SKY Customer](https://helpcenter.agvance.net/home/customer-work-orders)
- Work Order Service setup: service name and type (required), description, associated products picked from the Product Master location, active toggle. - [Work Order Services](https://helpcenter.agvance.net/home/work-order-services)
- Apply app: receives assigned work orders, messages and files from Dispatch; applicator can start/edit/complete jobs, record compliance data, and capture e-signatures permanently linked to custom application records. - [Apply App on phones](https://agvance.net/post/apply-app-from-agvance-is-now-available-on-phones)
- Apply fact sheet: work order list in priority order, job status updates, crop/application zone, product densities and blend info. - [Apply fact sheet](https://agvancehelpcenter.knowledgeowl.com/home/apply-fact-sheet)
- A Dispatch setting lets applicators change acres on a ticket and recalculate total product, and edit product rates/totals or add products (search digest). - [Dispatch company settings (search digest)](https://agvancehelpcenter.knowledgeowl.com/home/apply-tab-company-settings-sky-dispatch)
- An Acres Applied dashboard totals acres for blend tickets completed from Apply/Dispatch (search digest). - [Apply app search digest](https://agvancehelpcenter.knowledgeowl.com/home/apply-fact-sheet)
- Non-inventoried application service items carry a deliberate negative on-hand equal to acres spread; custom application charges can be split 100% to tenant in a bill-split example (first-pass notes).
- Applicators are managed in SKY Dispatch (add/edit/deactivate, app permissions); one cannot be deactivated with active assigned jobs (search digest). - [Applicators - SKY Dispatch](https://agvancehelpcenter.knowledgeowl.com/home/applicators-sky-dispatch)

### Inferences
- Inferred: because a work order is a delivery ticket, the application job and the product/service charge share one record, so the blend ticket link is the ticket (blend jobs complete through Apply/Dispatch).

### Gaps
- No page found on how acres x rate prices the service line, or on the applicator license fields captured per application record.

## 5. RUP / EPA, applicator license at sale

### Takeaway
Agvance checks a customer's unexpired federal/state permit at sale for restricted-use products, with configurable Don't Check / Warn Only / Disallow, and exempts custom-applied transactions.

### Cited Findings
- Product Safety tab: EPA #, Federally Restricted and Potentially Hazardous ratings, State Restricted (per-state list), Re-Entry Interval hours. EPA # prints on tickets and optionally invoices. - [Product Setup in Accounting](https://helpcenter.agvance.net/home/product-setup-in-accounting)
- Permit checking applies to invoices, delivery tickets and blend tickets. Federal permits live on the customer profile (up to 500); state permits can be tied to specific products or all. Source mode: Federal, State, or Both; level: Don't Check / Warn Only / Disallow (set in Company Preferences, Customer tab). - [Regulation of Restricted Product](https://agvancehelpcenter.knowledgeowl.com/home/hub-products-regulation-of-restricted-product)
- A permit's expiry must be on or after the transaction date; with several valid permits the user must pick one, a single valid permit auto-selects; the selected permit prints on documents; custom-applied transactions are not checked. - [Regulation of Restricted Product](https://agvancehelpcenter.knowledgeowl.com/home/hub-products-regulation-of-restricted-product)
- "Available for Distribution" check (needs a DOT regulatory database) tests whether a product may be sold into the destination state (ship-to, field, grower, location, in that order); no state found = save blocked. Quick Tickets have their own RUP setting with less thorough checking. - [Regulation of Restricted Product](https://agvancehelpcenter.knowledgeowl.com/home/hub-products-regulation-of-restricted-product)
- Federal permits cover EPA-defined restricted-use sales; state-issued applicator licenses are generally also kept in the federal permit area. - [Federal and State Permits (search digest)](https://helpcenter.agvance.net/home/federal-and-state-permits-in-agvance)
- Minnesota and Michigan restricted-use pesticide reports exist; permit names/numbers separated by a pipe; others may use "Include All States". - [Regulation of Restricted Product](https://agvancehelpcenter.knowledgeowl.com/home/hub-products-regulation-of-restricted-product)

### Gaps
- No public page on a federal RUP records report beyond MN/MI; Federal and State Permits page itself returned 404 on direct fetch (digest only).

## 6. Credit limits, holds, statements, aging

### Takeaway
Credit checking runs at customer selection on tickets/invoices, with Warn Only, Stop Sale, or Stop with Password, and loaded-unbilled tickets count against available credit.

### Cited Findings
- Checking is active once Date Opened on the customer Credit tab is filled; % of Limit and aging-based checks are set in Preferences, A/R tab, Credit Management. - [Credit Checking](https://helpcenter.agvance.net/home/credit-checking)
- Run on selecting a customer on blend tickets, delivery tickets, invoices, energy delivery orders and mobile energy tickets. Behaviors: Warn Only, Stop Sale, Stop with Password. - [Credit Checking](https://helpcenter.agvance.net/home/credit-checking)
- Past-due aged balances trigger a warning or stop before product selection. - [Credit Checking](https://helpcenter.agvance.net/home/credit-checking)
- Loaded unprocessed delivery tickets reduce available credit (customer quote price, else department cost x quantity); blend tickets valued by a quoting basis; saved invoices reduce credit; over-limit invoices post to an Over Credit Limit Invoices report. - [Credit Checking](https://helpcenter.agvance.net/home/credit-checking)
- Statement styles: Open Item and Combo statements, saved style "Sets", run by customer class, selected or all customers; growers can view/download PDF in Grower360. - [Statement styles post (search digest)](https://agvance.net/post/multiple-statement-styles-at-the-ready)
- Statement archiving and finance-charge/reconcile-credit order: first-pass notes.

### Gaps
- Hold Credit Status behavior and password ownership not covered on the page.

## 7. Dispatch and Grower360

### Takeaway
Dispatch shows job grids, a map, schedule/priorities and applicator assignments; Grower360 shows balances and recent activity cards.

### Cited Findings
- Dispatch: blend and delivery jobs in grids with dispatch comments; priority levels with color and label; real-time vehicle positions on maps via Razor/Samsara; AI scheduling suggestions for delivery routes that dispatchers review and save; dispatchers assign/reorder jobs directly on applicator devices; Satloc assigns aircraft; vehicle compartments for capacity; messaging with attachments to applicators/drivers; tender drivers schedulable. - [SKY Dispatch](https://helpcenter.agvance.net/home/sky-dispatch); [Dispatch search digest](https://helpcenter.agvance.net/home/slingshot-sky-dispatch)
- Applicator location history shown as map breadcrumbs filtered by date/time (search digest). - [Applicators - SKY Dispatch](https://agvancehelpcenter.knowledgeowl.com/home/applicators-sky-dispatch)
- Grower360 Overview: cash bids and grain balances (only with Agvance Grain), balance cards for Regular, Prepay and Budget, and recent Payments, Invoices, Scale Tickets, Field Applications and Requested Orders with "See More". - [Grower360 Overview](https://helpcenter.agvance.net/home/g360-overview-page)
- Growers can pay by ACH or card, reorder from invoice/booking/plan, request field services and tank refills (search digest). - [Grower360 fact sheet](https://helpcenter.agvance.net/home/grower360-fact-sheet)

### Gaps
- Job status value list not described in public pages.
