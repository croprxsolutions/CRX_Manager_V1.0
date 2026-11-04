# US Ag Input Retail Accounting and Business-Process Practices

Research depth note: ~21 tool calls, standard-mode searches. Several sub-topics (bill-and-hold, ASC 705 rebates, fertilizer tonnage details, custom application pricing, AgGateway, lot/unit-conversion, negative inventory, third-party finance terms) are thin or unanswered. Where a fact came only from a search-result summary rather than a fetched page, it is marked "(search summary)".

## 1. Prepays / prepaid inputs

### Takeaway
Growers prepay mainly in Q4 for tax reasons; retailers and manufacturers hold the cash as a liability (contract liability) until product is delivered/applied. Whether it is a deductible "prepaid purchase" or a mere "deposit" depends on the invoice stating a definite quantity, quality and price with no refund/substitution right. This makes the invoice wording a business-critical output of the software.

### Cited Findings
- Prepaid farm supplies must be an actual purchase, not a deposit; a purchase specifies quantity, quality and price (e.g. 30 tons lime at set price) with no right to refund or substitution; a credit held on account is a deposit — [UNL CropWatch](https://cropwatch.unl.edu/2018/prepaid-expenses)
- Three grower tests: actual purchase, business purpose (not tax avoidance alone), no material income distortion — [UNL CropWatch](https://cropwatch.unl.edu/2018/prepaid-expenses)
- 50% rule: cash-method farmers can deduct prepaid supplies only up to 50% of other deductible farm expenses; excess deducted when used — [UNL CropWatch](https://cropwatch.unl.edu/2018/prepaid-expenses); statute/Pub 225 background (search summary, archived editions): [IRS Pub 225 archive](https://webarchive.library.unt.edu/web/20130217161325/http://taxmap.ntis.gov/taxmap/pubs/p225-013.htm). Current-year Pub 225 not verified.
- CPA firm CLA: invoice must identify a specific input, quantity and unit price; "simply have a dollar amount listed is not sufficient"; prepay must be for inputs reasonably expected to be used the following year — [CLA](https://claconnect.com/en/resources/blogs/prepaid-farm-expenses-reminder-a). Another CLA piece says many invoices it reviews are really deposits (search summary) — [CLA](https://blogs.claconnect.com/agribusiness/?p=1173)
- If retailer cannot deliver and refunds next year, grower may need to amend a return (search summary) — [CLA](https://blogs.claconnect.com/agribusiness/?p=8668)
- Manufacturer/large-retailer accounting: FMC records prepayments as a liability when cash is received and recognizes revenue when shipments occur and control passes; prepayments mostly collected in Q4 for next marketing year (search summary) — [FMC 10-Q Jun 2022](https://www.sec.gov/Archives/edgar/data/37785/000003778522000075/fmc-20220630.htm)
- The Andersons: contract liabilities driven mainly by nutrient payments received before performance, revenue recognized through the application season; year-over-year changes from timing of farmer prepayments (search summary) — [Andersons 10-K FY2025](https://www.sec.gov/Archives/edgar/data/821026/000082102626000010/ande-20251231.htm)
- Andersons notes higher interest rates made customers less willing to prepay (search summary) — [Andersons FY2024 R16](https://www.sec.gov/Archives/edgar/data/821026/000082102625000050/R16.htm)
- Software behavior (Agvance): customer record shows Regular, Prepay and UAC balances plus credit limit; bookings can be flagged prepaid (P) or partial down payment (Dwn); "generic prepay" stores prepay type/price level/amount and can apply to unpaid bookings at invoicing — [Agvance Booking](https://helpcenter.agvance.net/home/regular-booking)
- Agvance: invoice discount does not apply to prepaid lines; to discount prepay, give it when the booking is entered; prepay interest can be added to prepay dollars when the payment is taken; leftover prepay can stay on the customer for future invoices (search summary) — [Agvance AR FAQs](https://agvancehelpcenter.knowledgeowl.com/home/ar-faqs)
- Agvance: voiding a prepay booking payment fails with multiple payments applied; workaround is negative booking + negative payment (shows reversal/refund is awkward in practice) — [Agvance AR FAQs](https://agvancehelpcenter.knowledgeowl.com/home/ar-faqs)
- Levridge (Dynamics 365): prepay can be applied to a sales agreement or held "uncontracted" on account; can be split between the two; at invoicing, prepay is assigned to each split member's share — [Stoneridge](https://stoneridgesoftware.com/easily-manage-splits-contracts-and-prepayments/)
- AGRIS documents accruing interest on selected prepayment types via finance charge tables (search summary) — [AGRIS docs](https://culturatech.atlassian.net/wiki/spaces/ACD/pages/877756576/Ability+to+Accrue+Interest+on+Types+of+Prepayment)
- Buyer's guide lists prepay programs, deferred payments and season-tied financing as ag-specific requirements (vendor-ish, weak) — [eathealthy365](https://eathealthy365.com/a-buyers-guide-for-ag-retail-software/)

### Inferences
- (inferred) Customer prepay = liability (customer deposit/contract liability) on retailer books; relieved to revenue only at delivery. Do not count as revenue or cash-basis sale at receipt.
- (inferred) A prepay record should be able to be (a) generic dollars on account (a "deposit" for tax purposes) or (b) tied to specific product/qty/price (booking-like "prepaid purchase"); invoices/receipts should print qty, product, unit price for (b).
- (inferred) Needs a refund-of-unused-prepay path and a year-end carry-forward report of prepay balances.

### Gaps
- No source found giving retailer-side journal entries for customer prepay in US GAAP/ASC 606 beyond manufacturer 10-Q language. No authoritative source on prepay discount/interest rates norms.
- Current IRS Pub 225 text not directly fetched.

## 2. Booking / price-locked product

### Takeaway
A booking is a committed customer quantity and price, drawn down on later invoices; software tracks Quant Left / Dollars Left and invoiced quantity. Exact ledger treatment is not documented publicly.

### Cited Findings
- Agvance booking: quantity and price committed; "Quant Left" and "Dollars Left" show remaining un-invoiced; bookings outside start/expiry dates warn but can still be invoiced; unit price defaults from quoted price, then customer price level, then list; low/high price range for unpaid market-priced products; splits divide each line by percentage among customers — [Agvance Booking](https://helpcenter.agvance.net/home/regular-booking)
- Levridge "contracts" are category-level agreements with time-bound, volume-scaled discounts drawn down by sales orders — [Stoneridge](https://stoneridgesoftware.com/easily-manage-splits-contracts-and-prepayments/)
- Manufacturer-level analog: FMC estimates variable consideration including volume thresholds and expected returns at inception, reassessing each period (search summary) — [FMC 10-Q Sep 2022](https://www.sec.gov/Archives/edgar/data/37785/000003778522000090/Financial_Report.xlsx)

### Inferences
- (inferred) Unpaid, undelivered bookings are off-balance-sheet commitments (no revenue/liability); only the paid portion (prepay) is a liability. A booking should hold: customer, product, qty, price, paid amount, qty delivered, expiry.

### Gaps
- No source on retailer inventory commitment or price-protection (price drop) practices. No public GL treatment for bookings.

## 3. Revenue recognition timing, COGS, deferred billing

### Takeaway
Large ag companies recognize product revenue at a point in time when control transfers (shipping/delivery terms), prepayments sit as contract liabilities until then. Specifics for retail bill-and-hold, delivered-not-invoiced and harvest terms were not found.

### Cited Findings
- Andersons: most ASC 606 sales recognized at a point in time tied to shipping terms (search summary) — [Andersons 10-K FY2025](https://www.sec.gov/Archives/edgar/data/821026/000082102626000010/ande-20251231.htm)
- Pay-after-harvest financing exists: John Deere "Harvest Terms" lets growers buy now, pay after harvest and lock in early-order seed discounts; FMC programs run via CFA, John Deere Financial and Rabo AgriFinance (search summary) — [Harvest Terms](https://www.mymultiuseaccount.com/harvest-terms-special/) (page later returned 404 when fetched; treat as unverified), [FMC financing](https://ag.fmc.com/us/en/product-financing)
- Agvance: marking a blend ticket "Loaded" is the event that relieves inventory; editing loaded quantities adjusts inventory (search summary) — [Agvance blend tickets](https://helpcenter.agvance.net/home/agronomy-managing-blend-tickets)

### Inferences
- (inferred) Accounting for a delivery: Dr AR (or prepay liability), Cr Revenue; Dr COGS, Cr Inventory at same event. For custom application, the product is often "delivered" when loaded/applied; the tie to the load/application event is a software-defined choice.
- (inferred) "Season/harvest terms" = payment terms/due date only; revenue still at delivery.

### Gaps
- No ASC 606-10-55-81 bill-and-hold retail source; no delivered-not-invoiced guidance found.

## 4. Split billing (landlord/tenant)

### Takeaway
Cost-share leases commonly split inputs in the same proportion as the crop; software handles this as percentage split groups per customer (per field/product) with each party getting a share of each line.

### Cited Findings
- Common crop-share lease: landlord pays inputs in same proportion as crop share; typical 50/50 (landlord pays half of seed, fertilizer, chemicals); other ratios 1/3–2/3 and 2/5–3/5 also exist; custom application often split 50/50; lime often landowner-paid; tenant sometimes pays all fertilizer in 2/3–1/3 leases (older data) — [Ohio State via UNT archive](https://webarchive.library.unt.edu/web/20090116013456/http://ohioline.osu.edu/fr-fact/pdf/0005.pdf), [Manitoba guide](https://gov.mb.ca/agriculture/farm-management/farmland-buildings/contracts-and-leases/pubs/crop-share-lease.pdf), [Illinois farmdoc fact sheet](https://farmdoc.illinois.edu/assets/management/leasing-facts-prices/Crop_Share_Lease_Fact_Sheet_2017.pdf) (search summaries; survey data partly 1970s)
- Levridge: multiple split groups with custom percentages; each order chooses which groups appear; lines allocated by percentage; prepayment assigned to each split member's share; wrong billing configuration forces credit-and-rebill — [Stoneridge splits](https://stoneridgesoftware.com/easily-manage-splits-contracts-and-prepayments/), [Stoneridge credit/rebill](https://stoneridgesoftware.com/automate-credit-rebill-process-ag-retail-levridge/)
- Agvance splits divide each line by percentage among customers — [Agvance Booking](https://helpcenter.agvance.net/home/regular-booking)
- A co-op notes agronomy and grain splits are tracked independently and customers must supply split percentages per product/service — [GCC Coop](https://www.gccoop.com/news/2023/business-units-splits-reminder)

### Inferences
- (inferred) Split percentages must sum to exactly 100% and allocate in whole cents with a remainder rule; each split party gets own invoice/AR (or a combined invoice with separate AR lines); per-product-category overrides are needed (e.g. lime or application different from chemicals).

### Gaps
- No source on how rounding remainders are handled; no source on AR split with 1099/landlord tax reporting.

## 5. Finance charges, statements, credit, third-party financing

### Takeaway
Retailers bill finance charges on overdue open accounts as an invoice line (often 1.5%/month, state-capped); third-party programs (John Deere Financial, Rabo, CFA, manufacturer programs) pay the retailer and move the receivable off its books.

### Cited Findings
- Minnesota statute allows ag retail/farm supply finance charges up to 1.5%/month or 18%/yr (2011–2017 versions; currency unconfirmed) — [MN Statutes 334.062](https://www.revisor.mn.gov/statutes/cite/334.062/pdf)
- GROWMARK FS example: 2%/month (24%/yr) on open balance; regular account charges due the 25th of the next month (search summary) — [FS Agri Finance](https://fscooperatives.com/growmarkfs/agriculture/fs-agri-finance)
- Agvance: finance charges auto-calculated but generate an invoice, so a "Finance Charge" product must exist; discount function used for early-pay discounts and small write-offs; open-item statement style lists available discounts; aging date and aging messages; prepay balance shown in aging — [Agvance AR FAQs](https://agvancehelpcenter.knowledgeowl.com/home/ar-faqs), [Agvance statements](https://agvance.net/post/multiple-statement-styles-at-the-ready)
- Agvance AR FAQ: discount on partially paid invoice is prorated — [Agvance AR FAQs](https://agvancehelpcenter.knowledgeowl.com/home/ar-faqs) (source's own example math flagged inconsistent)
- Third-party financing: FMC programs via CFA, John Deere Financial, Rabo AgriFinance; loan due date aligns with the originating retailer's CFA program (search summary) — [FMC product financing](https://ag.fmc.com/us/en/product-financing)

### Inferences
- (inferred) Finance charges are state-law capped and may need to exclude prepaid/not-yet-due items; treat as a posted invoice, not an automatic computed view.

### Gaps
- Terms of JDF/Rabo/CNH retailer-side settlement (recourse, fees, timing) not found.

## 6. Vendor rebates and manufacturer programs

### Takeaway
Rebates are accrued as reduction of COGS when purchases/sales occur, with an anticipated-rebate asset/clearing account, trued up when cash or a statement arrives.

### Cited Findings
- Agvance seed rebate method: on purchase invoice save, Dr cost of sales / Cr anticipated rebate account (accrual, doesn't change amount due); when received, Dr cash / Cr anticipated rebate; true-up difference to cost of sales. Early-pay/prepay vendor discounts: parked in rebate account then moved to cost of sales as invoices are saved — [Agvance method 3](https://agvancehelpcenter.knowledgeowl.com/home/seed-discount-method-3)
- IRS ruling about a general retailer: rebates recorded as purchases are made; substantially all applied as reduction of vendor invoices — [IRS PLR](https://www.stayexempt.irs.gov/pub/irs-wd/0605010.pdf) (search summary; analogous, not ag)
- Crop protection rebates have a history of being opaque "black boxes"; tooling (AgVend) now shows retailers expected rebate earnings — [Croplife](https://www.croplife.com/?p=74022), [AgVend](https://www.agvend.com/blog/agvend-launches-program-management-for-ag-retailers/) (search summary)

### Inferences
- (inferred) Software should record rebate programs per vendor/product with tiered thresholds, estimate accrual, and a reconciliation to vendor statements. Passing incentives to growers is a separate price/discount decision.

### Gaps
- Nothing authoritative on Bayer/Corteva/Syngenta/BASF program mechanics or ASC 705-20 specifics; no source on volume-tier uncertainty.

## 7. Returns and credit memos

### Takeaway
Retail returns of chemical depend on manufacturer/distributor return programs with windows and authorizations; retail-side restocking fees exist.

### Cited Findings
- Corteva 2023 chlorpyrifos return program took unopened/partial jugs only via distributors, paid credit on a schedule; growers returned to their retailer (search summary) — [IFCA PDF](https://ifca.com/files/23%20Corteva%20Chlorpyrifos%20Return%20Policy.pdf)
- Suterra excess channel inventory: credit within a defined window, approval request, sealed labelled bottles, prior-year product ineligible (search summary) — [Suterra](https://www.suterra.com/usa-eci-returns)
- Retailer examples: 30-day window on unopened product; 10% to 25% restocking fees (search summary) — [Ag West Supply](https://agwestsupply.com.customers.tigertech.net/return-policy/), [Advancing EcoAg](https://advancingecoag.com/refund_returns/)
- FMC estimates expected returns as variable consideration (search summary) — [FMC 10-Q](https://www.sec.gov/Archives/edgar/data/37785/000003778522000090/Financial_Report.xlsx)
- Minnesota RUP sales reports exclude returned product and report original amount distributed — [MDA](https://mda.state.mn.us/restricted-use-pesticide-distribution-guidelines)

### Inferences
- (inferred) Customer return = credit memo (reverse revenue, restore inventory at original cost if resalable) and a separate vendor return/credit to the supplier; keep both linked to the original invoice and lot.

### Gaps
- No standard-practice source on retailer reserve for returns.

## 8. Custom application, blending, delivery charges

### Takeaway
Blending/application/delivery are modeled as fee products on tickets alongside product lines; inventory relieved when the blend ticket is marked loaded.

### Cited Findings
- Agvance: blend fee is a product representing blending, delivery or equipment charge, usually in a Fee department; blend ticket prints scale stops and a custom application sheet; loading relieves inventory — [Agvance blend tickets](https://helpcenter.agvance.net/home/agronomy-managing-blend-tickets), [Blending overview](https://helpcenter.agvance.net/home/blending-overview)
- Custom application cost under crop-share lease often split 50/50 (search summary) — [Manitoba](https://gov.mb.ca/agriculture/farm-management/farmland-buildings/contracts-and-leases/pubs/crop-share-lease.pdf)
- Minnesota RUP sales report excludes products custom-applied by the dealer's own commercial applicators — [MDA](https://mda.state.mn.us/restricted-use-pesticide-distribution-guidelines)

### Inferences
- (inferred) Per-acre application fee = acres x rate; fees are non-inventory service lines, possibly taxable differently from product (see section 11).

### Gaps
- No public data on typical per-acre rates or minimum-charge conventions.

## 9. Inventory practices

### Takeaway
Blends consume component inventory when loaded; lots are optionally tracked at purchase, sale and manufacture; consignment stock stays on the supplier's books and must be segregated in counts.

### Cited Findings
- Agvance: lot numbers may be entered at purchase, sale and manufacture to maintain lot balances; blend-to-stock needs reversal via Manufacture Inventory; scale-ticket imports update product totals so inventory is relieved correctly — [Agvance blending](https://helpcenter.agvance.net/home/blending-overview) (search summary)
- Consignment: stock remains supplier-owned until sale/consumption; keep separate ledger accounts; count must distinguish owned vs consigned; cutoff matters (general, non-ag) — [Cleverence](https://www.cleverence.com/articles/for-business/consigned-inventory-4729/)
- Ag-specific: some retailers hold consignment stock with growers, hard to track (Agworld) — [Agworld](https://agworld.co/us/blog/shed-inventory-insights-for-service-providers)
- Retailers rethinking inventory as cash matters — [Croplife](https://www.croplife.com/?p=111192) (not read)

### Inferences
- (inferred) Unit conversions: store a base inventory unit plus conversion factors (gal/jug/tote, lb/bag, oz/acre rate) and compute product quantity = acres x rate / conversion; allow negative on-hand only as a flagged exception to be corrected after receipts.

### Gaps
- No source found on unit-conversion conventions, negative-inventory policy, in-transit handling or year-end count procedures specific to ag retail.

## 10. Compliance records

### Takeaway
RUP dealer sales records and applicator license checks are state-driven (not one federal rule); fertilizer tonnage/inspection fees are state-driven, typically semiannual or quarterly with per-ton fees.

### Cited Findings
- Minnesota: verify applicator license before RUP sale; record each sale by end of business day; pick-up date not order date; non-applicator pickup requires that person's name/address; exclude sales to other dealers, returns, and own-applied product; keep 5 years at each location; computer-generated reports OK — [MDA](https://mda.state.mn.us/restricted-use-pesticide-distribution-guidelines)
- Idaho 3-year retention, Kansas annual RUP report, Iowa dealer records per transaction, WV invoices may serve if kept apart (search summary) — [Idaho](https://agri.idaho.gov/main/?p=5401), [Kansas](https://www.law.cornell.edu/regulations/kansas/K-A-R-4-13-30), [Iowa](https://www.legis.iowa.gov/docs/iac/rule/04-30-2025.21.45.26.pdf), [WV](https://www.law.cornell.edu/regulations/west-virginia/W-Va-C-S-R-SS-61-12B-7)
- Federal 7 CFR 110: covers certified applicator records only (product, EPA reg no., total amount, location, area, crop, date, applicator name and cert number; keep 2 years; commercial applicator gives client copy within 30 days) — [Cornell LII 7 CFR 110.3](https://www.law.cornell.edu/cfr/text/7/110.3)
- Fertilizer tonnage: semiannual in Oklahoma (Jan/Jul), Illinois (Jun 30/Dec 31); quarterly in Mississippi and Kentucky; Washington $0.35/ton fertilizer, $0.20/ton lime, minimum $25 semiannual, late fee 10% or $50; last registrant selling to non-registrant usually reports (search summary, mixed-date statutes) — [OK](https://law.justia.com/codes/oklahoma/title-2/section-2-8-77-7/), [IL](https://ilga.gov/legislation/ilcs/documents/050500800K6.htm), [MS](https://law.justia.com/codes/mississippi/2015/title-75/chapter-47/section-75-47-11/), [WA](https://agr.wa.gov/departments/pesticides-and-fertilizers/fertilizers/tonnage-reporting)

### Inferences
- (inferred) Product master needs flags: RUP, fertilizer (with analysis and net tons), license-check-required; sales lines need captured applicator license/ID, pickup person, and date of pickup; keep records by location.

### Gaps
- Washington tonnage page fetch was navigation only; fee/date facts are from search summary. No federal dealer-level RUP recordkeeping source confirmed (EPA 40 CFR 171 not checked).

## 11. Sales tax on ag inputs

### Takeaway
Exemptions are state-specific; common pattern is seed/fertilizer/pesticides exempt to commercial producers on a seller-held certificate with renewal/retention rules.

### Cited Findings
- Vermont S-3A certificate filed with seller, renewed every 3 years, seller keeps certificates at least 3 years; Tennessee Agricultural certificate; Washington Farmer's Certificate does not expire while recurring business relationship; Louisiana R-1007; Kansas exemption covers seed, seedlings, fertilizer, insecticides, herbicides, fungicides and certain services (search summary) — [TN](https://www.tn.gov/revenue/taxes/sales-and-use-tax/exemptions-certificates-credits/agricultural-exemption.html), [WA DOR](https://DOR.WA.GOV/sites/default/files/2022-02/27-0036.pdf), [VT form](https://www.premier1supplies.com/pdfs/VermontExemptCert-Ag-P1S.pdf), [LA form](https://dam.ldr.la.gov/taxforms/1007(6_24)F.pdf)

### Inferences
- (inferred) Customer record needs: exemption cert on file, cert type/number, expiration, and per-product-category taxability, because services (custom application) and non-qualifying items may still be taxable depending on state.

### Gaps
- Treatment of custom application and delivery charges not established; per-state detail not collected. AgGateway standards not researched.
