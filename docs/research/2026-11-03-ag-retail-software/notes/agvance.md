# Agvance (SSI) - ag retail ERP research notes

Method note: only public pages. The official public help center (helpcenter.agvance.net, mirrored at agvancehelpcenter.knowledgeowl.com) was the main source. Articles are individual pages, some 200-970 days old, so menu paths may have changed. ssiag.com is NOT SSI (it is an unrelated Swiss company); SSI's site is agvance.net. Some pages could not be reached (TrustRadius 403; a few help URLs 404). Some help-center claims below come from search-result digests rather than the full page; those are labeled "search digest".

## 1. Company background, market share, deployment, product lineup

### Takeaway
SSI (Software Solutions Integrated, LLC), Shelbyville IL, founded about 1981, sells Agvance, a full ERP for ag retailers and co-ops (Accounting, Agronomy, Energy, Grain, Grower360), plus a separate EnergyForce brand. Self-reported: 700-750 retail customers, 23-25K users, 53% of the CropLife100. Legacy Windows client (on-prem or SSI-hosted) with a newer AWS-hosted web suite (SKY) layered alongside.

### Cited Findings
- SSI marked 45 years in 2026; founder Pam Rincker (now President/CEO) wrote a custom billing program for a local fertilizer dealer; Agvance brand created mid-1990s; now building cloud solutions. - [agvance.net 45 years](https://agvance.net/post/software-solutions-integrated-llc-celebrates-45-years)
- 200+ staff, mostly Shelbyville IL, second office in Avon IN; 25,000+ users, 750 ag retail businesses, 3,800+ locations in US and Canada (SSI's own figures). - [agvance.net 45 years](https://agvance.net/post/software-solutions-integrated-llc-celebrates-45-years)
- A Dec 2025 post is quoted in search results as 700+ businesses, 47 states plus Canada, 23,000+ users; counts vary by publication date. - [about-ssi (search digest)](https://agvance.net:443/about-ssi)
- 53% of the largest ag retailers on the most recent CropLife100 are SSI customers; SSI says it helps manage over 450M of 900M US farmable acres (company claims, Aug 2025). - [agvance.net 450M acres](https://agvance.net/post/ssi-serves-over-450-million-of-the-900-million-farmable-acres-in-the-u-s)
- Product lineup: Agvance modules Accounting, Agronomy, Energy, Grain, Grower360; separate EnergyForce brand. - [agvance.net why-agvance](https://agvance.net/why-agvance)
- Agvance SKY = cloud suite of web/mobile apps hosted on AWS; SSI handles hosting, updates, backups, DR; SaaS pricing includes hosting; SOC 2 Type 2; SKY is set up alongside the existing Windows Agvance with no downtime. Named SKY apps include Order, Dispatch, Analytics, Ledger (12 apps total per article; full list not on page), plus Grower360 for growers. - [Why Agvance SKY](https://helpcenter.agvance.net/home/why-agvance-sky)
- Windows still required for some setup (June 2026 SKY note: new NMI payment option needs setup in Agvance Windows). - [June 2026 SKY release notes (search digest)](https://agvancehelpcenter.knowledgeowl.com/home/june-2026-sky-release-notes)
- Other SKY apps seen in help titles: SKY Customer, SKY Admin, SKY Energy, SKY Warehouse, Blend Shed (Dispatch). - [Blending Videos index](https://helpcenter.agvance.net/home/blending-videos); [Accounting Videos index](https://agvancehelpcenter.knowledgeowl.com/home/accounting-videos)
- Grower360 = customer portal/app: balances, cash bids, field maps/activity, scale tickets, contracts, ordering field work. - [Why Agvance SKY](https://helpcenter.agvance.net/home/why-agvance-sky); [App Store](https://apps.apple.com/us/app/id1485782487)
- SSI offers API developer resources, and an "API lock" is used at month end. - [agvance.net](https://agvance.net/post/ssi-serves-over-450-million-of-the-900-million-farmable-acres-in-the-u-s); [EOM process](https://helpcenter.agvance.net/home/full-accounting-end-of-month-process)

### Inferences
- Inferred: the CropLife100 share is a share of the largest retailers, not of all US retailers; true overall market share is unknown, but entrenchment among large co-ops is plausible.
- Inferred: Windows-desktop heritage (Windows vs SKY naming, API lock, database-image backups, run-time error codes) means the accounting core is a classic client/server app; SKY is a web front end on the same data.

### Gaps
- No independent market-share figure found. Pricing not public.
- Whether Grower360/Dispatch run without SKY hosting not confirmed. No product named "SKY Mobile" found; a mobile field app called Inform was mentioned in one search digest only (unverified).
- SSI ownership/revenue: directories disagree; omitted.

## 2. How modules connect, and one sale end to end

### Takeaway
Document chain: Sales Order/Plan/Recommendation -> Booking (optional, prepay/price lock) -> Delivery Ticket or Blend Ticket (inventory moves when marked Loaded) -> Invoice (imports the loaded ticket; hits A/R and revenue) -> Payment -> statements/finance charges. Each stage is a separate record with its own status.

### Cited Findings
- SKY Customer order types: Bookings (prepaid money must be tied to a booking: real product at special price, or generic prepaid item), Plans (nutrient recs, field plans, quick sales order), Blends, Deliveries, Sales Orders (made in Windows Planning or SKY Order; import into Delivery Ticket, Booking or Field Plan; once imported marked processed and cannot be imported again), Product Delivery Orders (energy), Work Orders (field-staff services such as scouting/soil sampling; saved as Delivery Tickets and dispatched via SKY Dispatch). - [Orders - SKY Customer](https://helpcenter.agvance.net/home/orders)
- Delivery Ticket records inventory movement before billing. Header: customer/split, field, ticket #, ordered/loaded dates, pickup vs delivered, Loaded flag, On Hold (blocks billing), assigned user, ship-from location, dispatch info, blend product set; imports from bookings, plans, scale tickets, sales orders, Agrian recommendations, rollup kits. Lines: gross/tare/net, load amount/unit, optional lot number, crop code, container ID, technology license #, picked/backorder flags (a loaded ticket saved with a backorder creates a new unloaded ticket for the remainder). - [Delivery Tickets](https://helpcenter.agvance.net/home/add-delivery-ticket)
- Statuses/locking: Unloaded = no inventory effect and cannot be invoiced; Loaded = inventory affected on save, one inventory-detail audit row per line; On Hold blocks billing; a ticket transferred to field history while unprocessed cannot be edited; Voided marks it voided+invoiced and reverses postings. Positive qty is outbound. - [Delivery Tickets](https://helpcenter.agvance.net/home/add-delivery-ticket)
- A loaded ticket must be imported into an invoice (prevents double inventory adjustment); invoice then affects A/R, and inventory only if quantity changes at invoicing. Unloaded tickets do not affect inventory or customer G/L balance. Editing a loaded blend adjusts inventory and leaves an "edited after loaded" trail. Pending Usage report projects on-hand from unloaded deliveries/blends. - [Delivery Tickets](https://helpcenter.agvance.net/home/add-delivery-ticket); [Managing Blend Tickets (search digest)](https://helpcenter.agvance.net/home/agronomy-managing-blend-tickets); [Adding Blend Tickets (search digest)](https://helpcenter.agvance.net/home/adding-blend-tickets)
- Automated blender integration: importing a completed blender file marks the ticket Loaded and relieves inventory. - [Import Automated Blender Done Files (search digest)](https://helpcenter.agvance.net/home/managing-blend-tickets-import-automated-blender-done-files)
- Blend tickets import into invoicing without re-keying; multiple tickets can combine on one invoice (search digest). - [Prepaying Products on Blend Ticket (search digest)](https://helpcenter.agvance.net/home/prepaying-products-on-blend-ticket)
- Blend ticket pricing: priced by product or by analysis. A "NaN.00" import error arises if a product has zero price (quote a price on the ticket); error 3021 if no products in the Product Set are marked Invoice. - [A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs)
- Invoice entry is the same function whether from imported Delivery/Blend/Energy tickets or direct; invoice numbering is per location (counters at Setup/Locations, Preferences tab); recurring invoices exist; Extra Charges give percentage taxes (sales/local, fertilizer, underground water); POS warnings by customer/product class can warn or stop; discounts for early pay or small over/under payments; rollup kits. - [Posting Invoices](https://helpcenter.agvance.net/home/posting-invoices)
- Location pref "Do not honor quoted Delivery Ticket and Blend Ticket" stops ticket pricing flowing to the invoice; "Price By" can be Products, Blended Analysis, Guaranteed Analysis, or Elements. - [Location Preferences](https://helpcenter.agvance.net/home/location-preferences)
- Blend to Stock: formulate a blend into inventory instead of invoicing (from weights or from automated blender file); marks ticket Processed, raises finished-product on-hand, lowers each raw material, updates finished product Average and Last cost from raw material cost, writes inventory detail for finished and raw. - [Blend to Stock](https://helpcenter.agvance.net/home/add-blend-tickets-blend-to-stock)
- Manufactured-inventory formulas relieve raw ingredients either at manufacture time or at billing, set per formula; moves cost from ingredient COGS to finished-product COGS. - [Inventory Posting and Income Statement](https://helpcenter.agvance.net/home/inventory-posting-and-the-income-statement); [Delivery Tickets](https://helpcenter.agvance.net/home/add-delivery-ticket)
- Shipping Order Manager produces unloaded delivery tickets; "Blend Shed" in SKY Dispatch handles warehouse blending. - [Ship Order Manager (search digest)](https://helpcenter.agvance.net/home/ship-order-manager); [Blending Videos index](https://helpcenter.agvance.net/home/blending-videos)
- Agrian recommendation numbers can become the Delivery Ticket control number (compliance/recommendation link). - [Location Preferences](https://helpcenter.agvance.net/home/location-preferences)
- A Product Rebate report uses the federal permit on the invoice (restricted-use permit tracking): missing permit fixed by editing the invoice; ship-to and federal permit default from the first customer in the billing split. - [A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs)
- Season/month-end tasks include Transfer Field History and Import Chemical Database Data (product safety information). - [EOM process](https://helpcenter.agvance.net/home/full-accounting-end-of-month-process)

### Inferences
- Inferred: ticket-then-invoice separation lets the warehouse load product before billing; "loaded but not invoiced" is a first-class state (Delivered Product Analysis, unprocessed-ticket checks). A small app needs a comparable "shipped, not yet billed" state.
- Inferred: loaded-ticket edits are allowed but audited, rather than hard-locked.

### Gaps
- No public detail found on custom application/applicator billing screens, restricted-use recordkeeping fields, or precision-ag (prescription/variable-rate) data flow; none on dispatch routing/map UI beyond titles.
- Full blend formulation screens (analysis targets, filler, surfactants) not retrieved beyond titles.

## 3. Bookings, prepay, price lock, split billing, credits, finance charges, rebates

### Takeaway
Bookings are the price-lock and prepay vehicle; any prepay money must sit on a booking (product-specific or generic). Invoice lines show whether product was relieved from a booking and whether it was paid. Splits bill one job to several parties by inventory department. Finance charges and credits are ordinary invoices/credit invoices.

### Cited Findings
- Rule: any prepay money received must have a Product Booking. - [Prepaying Products on Blend Ticket (search digest)](https://helpcenter.agvance.net/home/prepaying-products-on-blend-ticket)
- Invoice line status: blank (no booking), Paid (prepay used), Book (unpaid booking used), Dwn (down-payment booking used), Book/Paid (prepay used and a book-only booking relieved for quantity). - [Invoicing Bookings / Prepay (search digest)](https://helpcenter.agvance.net/home/invoicing-bookings-prepay)
- Pricing: a price on a booking is honored at invoicing unless Retain Invoice Price is checked; invoice discounts do not apply to prepaid lines, so give any discount when the booking is entered. - [Posting Invoices](https://helpcenter.agvance.net/home/posting-invoices); [A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs)
- Prepaid blend: create blend ticket, print Consolidated Blend (priced by product) or Product Analysis Recap (priced by analysis), then add a Booking (A/R / Product Bookings) with those products/qty/prices. - [Prepaying Products on Blend Ticket (search digest)](https://helpcenter.agvance.net/home/prepaying-products-on-blend-ticket)
- Generic prepay: Prepay Types are set up (all products or by classification); a generic booking with Price Level None auto-combines with an unpaid product-specific booking on one invoice line (Book/Paid); saving the generic booking records the payment through Receive Payment on Account; invoicing relieves the product booking and reduces the generic prepay balance. - [Generic Prepay with Unpaid Bookings](https://agvancehelpcenter.knowledgeowl.com/home/generic-prepay-unpaid-bookings)
- Voiding a booking payment is blocked when multiple payments are on one booking; workaround is a negative booking plus negative payment. Voiding an invoice can leave a "booking has been invoiced" message; an admin utility ("Open a Booking") repairs it. Paid invoices "are not to be voided"; COD payments cannot be voided/reversed. - [A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs); [Posting Invoices](https://helpcenter.agvance.net/home/posting-invoices)
- "Move A/R Prepay" at month end moves prepay to a separate G/L account and reverses automatically at close; "Transfer Customer Prepay" needs a valid prepay product per location; "End of Prepay Season" cleans up expired bookings. - [EOM process](https://helpcenter.agvance.net/home/full-accounting-end-of-month-process); [A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs)
- Bill splits: up to three named splits (S-1 Standard, S-2, S-3), each with its own percentages and linked to inventory departments; names are system-wide and assigned to farms/fields (Hub / Setup / Bill Split Arrangement); the name (10 chars) prints above the percentages. Mirror example: landlord/tenant 50/50 except chemicals 60/40 and custom application 100% tenant (search digest). - [Bill Split Arrangements](https://helpcenter.agvance.net/home/bill-split-arrangements); [mirror](https://agvancehelpcenter.knowledgeowl.com/home/bill-split-arrangements)
- Split invoices print a "This Invoice is Shared With" area; each line can carry its own split; ship-to, federal permit and salesperson default from the first/primary split customer. A split listing the same customer twice causes a duplicate-key error (energy). - [A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs)
- Credit Invoice (A/R > Invoice > Credit): enter positive quantities, system negates them; updates inventory and customer balance; prints "Credit Memo"; used for returns/billing errors in a prior month. "Reconcile Credit Invoices" applies credits/unapplied cash oldest-to-newest to open invoices by posting a zero-dollar payment; run before finance charges and statements. Credits can also be applied via Payments with pay method Adjustment. - [Credit Invoices](https://helpcenter.agvance.net/home/credit-invoices)
- Price correction without moving inventory: new invoice with negative qty at old price and positive qty at new price, comment "Price Adjustment". - [A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs)
- Finance charges: computed on open invoices dated/due on or before a cutoff; whole-number rate (monthly or annual), customer override on the Credit tab (999 excludes), minimum charge, minimum eligible balance, optional inclusion of old finance charges, prepay, unapplied cash; creates an invoice of a flagged "Finance Charge" inventory item with status OpenFC, posting to that item's income account; Review vs Automatic modes, Pre-Scan report; void in same month, reverse if prior month. Separate "Invoice Late Charges" tool and memo invoices exist. - [Finance Charges](https://helpcenter.agvance.net/home/finance-charges); [Posting Invoices](https://helpcenter.agvance.net/home/posting-invoices)
- Statements are a month-end run (usually three runs) and cannot be regenerated after the new month begins, so they are archived. - [EOM process](https://helpcenter.agvance.net/home/full-accounting-end-of-month-process); [Finance Charges (search digest)](https://helpcenter.agvance.net/home/finance-charges)
- Discount in payment-on-account is prorated for partially paid invoices. - [A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs)
- Other billing: equal/budget billing memo invoices, tank rent/lease invoices; Farm Plan (John Deere) payments move A/R off the merchant's books. - [Posting Invoices](https://helpcenter.agvance.net/home/posting-invoices)
- Vendor seed rebates/discounts: handled with Purchase Add-on Charges (negative rate) that accrue to an "anticipated rebate" G/L account and a rebate vendor. On purchase invoice save: debit cost of sales, credit anticipated rebate; actual rebate arrives: debit cash, credit anticipated; difference to cost of sales; add-on affects product Last/Average cost. Early-pay prepay: debit A/P, credit anticipated rebate. - [Seed Discount Method 3](https://helpcenter.agvance.net/home/seed-discount-method-3)

### Inferences
- Inferred: no dedicated vendor "program/incentive" engine surfaced publicly; rebates appear modeled as add-on charges plus manual journal entries (absence of evidence only).
- Inferred: a booking is a price/quantity claim; unpaid bookings act as quantity commitments, paid bookings as a customer-owed balance, relieved on invoice.

### Gaps
- Exact GL entries for receiving prepay (deposit/liability account) and relieving it at invoice were not stated in retrieved pages. "Deferred billing"/revenue recognition for prepaid-not-delivered product not found. Returning booked product or refunding prepay not found. Consignment not found.

## 4. Accounting logic: GL, inventory valuation, period close

### Takeaway
Full GL. Two inventory-posting modes: Summarized (asset accounts move only when "Post Inventory to G/L" runs, usually monthly) and Transactional (every sale/purchase/adjustment posts as it happens). Revenue posts at invoice; COGS is largely derived from inventory value change rather than per-line.

### Cited Findings
- Invoicing credits each department's Sales/Income account; Sales Register totals should match. Purchase invoicing debits COGS/Purchase directly and updates Average and Last cost; other transactions move COGS indirectly by changing on-hand. - [Inventory Posting and Income Statement](https://helpcenter.agvance.net/home/inventory-posting-and-the-income-statement)
- Post Inventory to G/L: sets inventory asset accounts to company-owned inventory value = (on hand + unprocessed loaded delivery/blend tickets - unprocessed purchase receipts) x chosen cost (department-level cost, weighted average, last purchase price, or replacement cost); JE reverses prior value and books new; COGS is the offset; one JE per department unless "post as one". An optional JE for unprocessed purchase receipts debits inventory, credits estimated A/P, with its reversal in a Future Journal posting next month. - [Posting Inventory](https://helpcenter.agvance.net/home/posting-inventory)
- Inventory adjustments do not hit GL directly; they change the value used by the next post, so large adjustments distort months unless adjusted to physical before posting. - [Inventory Posting and Income Statement](https://helpcenter.agvance.net/home/inventory-posting-and-the-income-statement)
- Profit Margin (PM) departments (non-transactional companies): COGS posted from sales analysis margin %, not physical value. - [Posting Inventory](https://helpcenter.agvance.net/home/posting-inventory)
- Purchase receipts: entered by bill of lading before the vendor invoice; increase on-hand; limited edits (errors need void and re-entry); can link to PO releases; Estimated Average departments update average cost on receipt: ((old qty x old $) + (new qty x new $)) / (old + new); optional "Accrue Estimated Payable": debit inventory asset, credit Estimated A/P, auto-reversed when the purchase invoice is entered; an invoiced receipt cannot be voided until its invoice is voided; add-ons and freight roll into cost. - [Purchase Receipts](https://helpcenter.agvance.net/home/purchase-receipts-in-agvance)
- Inventory adjustments leave an audit trail in Inventory Detail; value hits asset and cost of sales accounts. Average cost is weighted; last cost replaces. - [Inventory Adjustments (search digest)](https://helpcenter.agvance.net/home/inventory-adjustments)
- Month-end checklist: Accounting Checkup Report (G/L, customers, vendors, inventory, budget billing in balance); clearing accounts; Inter-Company Transfers cleared via purchase invoice; inventory quantity and cost adjustments; API lock; recurring JEs and A/P bills; reconcile credit invoices; finance charges; Move A/R Prepay; energy budget memo invoices; verify unprocessed tickets and receipts; Post Inventory to G/L; archive registers, statements, balances, trial balance, GL detail, balance sheet and income statement; back up database; End the Fiscal Month (all users logged out; at least 1,000 blank journal entries reserved for adjustments except month 12). - [EOM process](https://helpcenter.agvance.net/home/full-accounting-end-of-month-process)
- Tie-outs: customer current balances = G/L A/R (prepay may be separate); aged balances = current balances; vendor balances = G/L A/P; unpaid A/P bill list = vendor balances; Inventory Company-Owned Statement = inventory asset G/L; Checkup report all balanced. - [EOM process](https://helpcenter.agvance.net/home/full-accounting-end-of-month-process)
- A nonzero "Agvance Clearing 9999######" balance usually means a process was not completed correctly. - [EOM process](https://helpcenter.agvance.net/home/full-accounting-end-of-month-process)
- Non-inventoried application service items carry a deliberate negative on-hand equal to acres spread, reset after fiscal year. - [Inventory Adjustments (search digest)](https://helpcenter.agvance.net/home/inventory-adjustments)

### Inferences
- Inferred: summarized posting means interim margin by product is not exact until month-end post; a small app wanting per-sale COGS should copy Agvance's transactional mode.
- Inferred: the fiscal-month close is a hard checkpoint with equality tie-outs, a pattern worth automating as reconciliation checks.

### Gaps
- Exact debit/credit for invoice (A/R, tax liability, sales) and payment not stated in retrieved text. Consignment and in-transit vendor-owned stock not found beyond the "Company-Owned Inventory" naming (implies other-owned stock is tracked separately; inferred).

## 5. Inventory

### Takeaway
Multi-location with Inter-Company Transfers (ICT), optional lot numbers with negative-lot controls, average/last/replacement costs, blends as manufactured-inventory formulas, and per-location switches to block negative on-hand.

### Cited Findings
- Location prefs: Disallow Lot Balance Negative (No Checking / Warning Only / Disallow Save) for invoices and separately for manufacturing; stop invoices, purchase receipts, ICTs and voids that would cause negative on-hand; auto-create an ICT when a delivery ticket ships from a different location (ticket won't load if ICT would go negative); replacement cost fields 2-4; print lot # and attributes on invoices. - [Location Preferences](https://helpcenter.agvance.net/home/location-preferences)
- Company-Owned Inventory Statement is the valuation report; Pending Usage shows projected on-hand; repackaging/mini-bulk flags exist. - [Posting Inventory](https://helpcenter.agvance.net/home/posting-inventory); [Delivery Tickets](https://helpcenter.agvance.net/home/add-delivery-ticket)
- Inventory is organized in departments, which drive sales/COGS/inventory accounts and bill-split membership; a "Sell From Dept ID" option allows company-wide sales. - [Delivery Tickets](https://helpcenter.agvance.net/home/add-delivery-ticket); [Bill Split Arrangements](https://helpcenter.agvance.net/home/bill-split-arrangements)

### Inferences
- Inferred: negative on-hand is permitted unless a location checkbox blocks it; lots have a separate three-level control.

### Gaps
- Unit conversion (billing unit vs inventory unit) only hinted ("Billing Unit", "Load Amount/Unit"); in-transit and consignment not documented in retrieved text.

## 6. Screen and navigation patterns (in words)

### Cited Findings
- Windows client is menu-driven by module then function, written in paths such as Accounting / A/R / Invoice, Accounting / A/R / Product Bookings, Inventory / Delivery Ticket, Inventory / Purchase Receipts, Blending / Edit / Blend to Stock, Accounting / G/L / Post Inventory to G/L, Accounting / End of Periods / Fiscal Month; a "Hub" holds shared setup (Hub / Setup / Bill Split Arrangement) and Setup / Locations has tabs (Preferences, G/L Posting, Invoice, Delivery Ticket, Inventory). Shortcut icons exist (e.g. Add Invoice). Invoices are grids of product lines with a Level column that opens a booking-detail popup; Apply then Save buttons; lines carry status codes. - [Location Preferences](https://helpcenter.agvance.net/home/location-preferences); [Generic Prepay](https://agvancehelpcenter.knowledgeowl.com/home/generic-prepay-unpaid-bookings); [A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs)
- SKY apps are role-based web apps: Order (sales/office), Dispatch (navigation overview, Blend Shed), Warehouse, Customer, Admin, Energy, Analytics, Ledger. - [Why Agvance SKY](https://helpcenter.agvance.net/home/why-agvance-sky); [Blending Videos index](https://helpcenter.agvance.net/home/blending-videos)

### Gaps
- No YouTube transcripts/chapters retrieved (no video access); help video index pages were nearly empty. Screens described only from article text.

## 7. Customer praise and complaints

### Takeaway
Independent review data is thin; nothing reliable surfaced on Reddit, TrustRadius, or G2.

### Cited Findings
- G2 shows 0 reviews for Agvance Suite and none for Agvance Grain; one Softwarefinder review gives all-10 scores; the listing's generic cons ("requires careful data input", "needs variable setup time") look like template text rather than reviewer quotes. - [Softwarefinder](https://softwarefinder.com/enterprise-resource-planning-software/agvance-accounting/reviews); [G2 Agvance Suite](https://www.g2.com/products/agvance-suite/reviews)
- A 2019 SoftwareConnect review (per search summary) called the energy and accounting modules clunky. - [SoftwareConnect](https://softwareconnect.com/reviews/agvance-accounting/)
- Glassdoor employee (not customer) rating 4.4 from 19 reviews. - [Glassdoor](https://www.glassdoor.co.nz/Reviews/Agvance-Reviews-E1468406.htm)
- Pain points visible indirectly in help FAQs: paid invoices discouraged from voiding; booking payments hard to void; many error codes around blend ticket import, prepay transfer, tickets; month-end relies on a long manual checklist and clearing-account watching. - [A/R FAQs](https://helpcenter.agvance.net/home/ar-faqs); [EOM process](https://helpcenter.agvance.net/home/full-accounting-end-of-month-process)

### Inferences
- Inferred: dense checklists and workaround recipes (negative booking to void, price-adjustment invoice) suggest strong accounting integrity at the cost of rigidity and training burden. This is inference from documentation, not customer testimony.

### Gaps
- No genuine customer praise/complaint corpus, case studies, or co-op job postings naming Agvance workflows found (one job-posting search returned nothing on Agvance).
