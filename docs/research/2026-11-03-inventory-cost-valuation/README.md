# True product cost, inventory value and carrying cost: what CRX has, what the industry does, what to build

**Date:** 2026-11-03 · **Type:** research and recommendation, read-only (no app code or live data was changed) · **Builds on:** `docs/research/2026-11-03-ag-retail-software/` and the parked plan `docs/plans/2026-07-16-inventory-costing-plan.md`

---

## One-screen summary for Mason

**The short answer.** CRX knows what each product *should* cost (the price-list cost an admin sets) and what each sale *was booked at*. It does not know what the stock on the shelf *actually* cost, how old it is, what it costs to keep it there, or whether the purchase that filled a special order came in higher than the cost the sale was booked at. Industry software uses three habits: an **average cost** per product, an **expected-then-actual cost true-up** when the vendor bill lands, and **separate replacement-cost pricing**. None of the ag systems we could find publishes a carrying-cost or stock-aging feature; that part CRX would design itself.

**The five biggest findings**

1. **One cost number does three jobs.** `products.current_cost` is the pricing cost, the inventory value on today's report (a *pricing-basis valuation*) and, through snapshots, the margin cost. The cost recorded on each PO line is stored (it can come from the catalog and is not proof of a matched vendor bill) but has **no automatic** effect on value or margin; an admin can choose a received PO cost as the new price-list cost, but receiving changes nothing by itself.
2. **Special-order margins are never corrected.** There is no link between a sales order line and the PO that filled it. As a rough signal, 16% of sales lines had a different cost on the next PO for the same product (median gap about 4% when they differ). That is cost drift in general, not a count of wrong special-order margins, which cannot be counted without the link.
3. **Stock age is invisible; only a rough estimate is possible.** Inventory is one number per product per location, with no receipt dates or lots (0 of 130 receipts carry a lot number). A rough first-in-first-out estimate from receipt history is concentrated in the 181-365 day band, but it cannot establish a stock share; some stock has no receipt history, so its age is unknown. Units were not normalized, so the raw shares in section 1.3 are an unvalidated illustration, not a measurement.
4. **A good costing engine is already designed and parked.** The 2026-07-16 plan (perpetual moving average per product and location, value in cents) follows the average-cost approach ag software uses. It is a substantial change: every inventory-writing function gains a cost record, even though the screens are read-only.
5. **Vendor programs and freight are not in cost.** `rebate_programs` and `rebate_claims` exist but are empty live and never reduce cost. Freight on purchases is not tracked. Both matter in ag chem.

**What CRX has today vs. what we recommend (short version; full table in section 4)**

| Capability | CRX today | Recommend | Gap |
|---|---|---|---|
| Costing method | One admin-set price-list cost | Add a separate average of recorded PO cost (parked plan); provisional until vendor bills are matched | Large |
| Sell-then-buy true-up | None; margin frozen at sale | Quantity-based link from order lines to PO and receipt lines; cost status on every receipt (provisional to settled); adjustment records from the first allocation onward | Large |
| Freight in cost | None | Add freight to receipt cost | Large |
| Rebates / programs | Manual claim log, unused, no cost effect | Accrue earned rebates into net cost, with accountant-approved estimates | Large |
| Stock age | Not known | Estimated aging report now; stays an estimate even with the engine (exact age needs lot tracking) | Large |
| Carrying / interest cost | None | Management estimate: annual rate × days held ÷ 365 × cost basis, never booked | Large |
| Replacement-cost pricing | Supplier prices stored for only 10 observations; not used in valuation | Replacement-cost view where a current, unit-matched supplier price exists; coverage shown | Small, but limited by data |
| Inventory valuation view | Quantity × price-list cost | Price-list, average recorded PO cost and replacement side by side, plus age-bucket quantities and "age unknown" | Small to large |
| Margin at quote time | Admin sees cost and margin; floors and below-cost approvals | Keep the existing approval check; add replacement cost and an aged-stock flag as advisory warnings | Small |
| Returns and credits | Return credits reverse original sale cost (since 2026-08-27) | Restore returned stock at its original cost in the engine | Small |
| Price-exposure view (CRX's own proposal, inspired by steel and fertilizer price risk) | None | (pricing-basis cost − replacement cost) × units on hand, where data allows | Small, limited by data |
| Return on stock (GMROI, dead stock) | None | Dead-stock list now; GMROI once Phase 2 gives average stock value (a full season recommended) | Small now, GMROI later |

**Borrowed from other industries:** replacement-cost margin from electrical wholesale, a price-exposure view inspired by steel and fertilizer price risk (CRX's own proposal, not a borrowed product feature), a per-receipt interest clock from equipment dealers' floor-plan financing, aging reserves and return-to-vendor windows from pharma, and GMROI from retail.

**Recommended next step:** approve **Phase 1** (reporting only, no new tables): an estimated aging report, a carrying-cost estimate and a replacement-cost column on the Inventory Cost report. Each one shows how much of the stock it can actually measure, and none gives an all-in total until units and supplier prices are cleaned up. Phase 1 alone tells you which products are old and which have no current supplier price. Then decide whether to un-park the average-cost engine (Phase 2).

**Decisions only you can make** are listed in section 7.

---

## 1. What CRX does today (evidence)

All file references are relative to the repository root. "Live" facts come from read-only SELECT queries run on 2026-11-03; only counts and percentages are reported here.

### 1.1 Costing method: one governed "pricing basis" cost

- **Where it lives.** `products.current_cost` (dollars, whole cents enforced by `products_current_cost_cent_scale_chk`) plus `products.cost_updated_date`. History is in `cost_history` and the append-only `product_cost_basis` (one active row per product; `basis_type` is `selected_supplier_price`, `actual_purchase` or `manual_override`) (`supabase/migrations/20260722015019*` l.21-80). There is no `current_cost_cents` column on `products`; an earlier research note said so in error.
- **What the cost history actually holds (live, 2026-11-04).** `cost_history` logs every change to the **price-list** cost, tier prices and margins (who, when, why, change set), admin-only under RLS, shown on the product page (`src/lib/sellPriceHistory.ts`, `src/pages/ProductDetail.tsx`). 627 rows cover 604 products from 2026-03-04 on, but 587 are a one-time starting snapshot (`20261026140000`); only 28 rows changed cost, on 23 products. `purchase_order_item_cost_changes` logs edits to PO-line cost. So CRX has a **price-list cost history** and a **PO cost edit log**, but **no history of what each unit in stock cost**; that per-unit history is exactly the parked plan's `inventory_cost_events`.
- **Who changes it.** Only the governed path `preview_product_cost_basis_changes` → `approve_pricing_change_set` → `apply_product_cost_basis_change_set` (same migration, l.642 and l.802). A trigger refuses direct writes (`docs/workflows/INVENTORY_RULES.md` "Cost-writer map").
- **Receiving does not change cost.** `receive_po_items` (last full body in `supabase/migrations/20260714230000_gauntlet_core_guards.sql` l.112-278, wrapped through `20261102220000`) writes quantities, a `received` ledger row and a `receiving_records` row; it never updates `products`. A weighted-average update on receipt was deliberately removed on 2026-03-13 (`docs/plans/2026-07-16-inventory-costing-plan.md` l.38).
- **Recorded PO-line cost is kept but isolated.** `purchase_order_items.unit_cost` (plus `cost_provenance`, `cost_snapshot_at`, `cost_needs_review`) and the admin log `purchase_order_item_cost_changes` record the PO-line cost (not a matched vendor bill). A rep-added PO line is priced at catalog cost and flagged for admin review (`supabase/migrations/20261021140000*` l.265-309). `set_purchase_order_item_costs` changes only the PO line, by design (`INVENTORY_RULES.md` l.218-224: inventory value uses catalog cost). The one bridge is manual: an admin can pick a received PO line as the new pricing basis (`basis_type = 'actual_purchase'`), which then flows into valuation and later sales. Nothing does this automatically.
- **Supplier prices.** `supplier_price_observations` (10 rows live) can be selected as a new pricing basis behind the `supplier_cost_basis_enabled` setting and a 10-product pilot gate (`20260722064814`).
- **Live data quality is good for what exists:** 596 active products, 0.2% with no cost, 1.7% with a cost older than 180 days; 0% of order lines missing a cost snapshot; 0% of PO lines awaiting cost review.

**Verdict:** CRX uses a *standard-cost-like* price-list cost set by an owner decision. Today's inventory report values stock at that cost, so it is a **pricing-basis valuation**. Standard cost can be a valid inventory method, but only when it is kept current and reconciled to what was actually paid. CRX does no such reconciliation, so this number should not be treated as the book value.

### 1.2 Sell-then-buy: what cost the margin uses, step by step

There is no special-order concept and no foreign key between a PO line and an order or quote line (`purchase_orders`/`purchase_order_items` have no order, quote or customer column).

| Step | Cost used | Evidence |
|---|---|---|
| Quote | `quote_items.cost_at_quote_cents`, stamped from `products.current_cost` on first insert, kept on re-save | `supabase/migrations/20260812115236*` header; `save_quote` chain |
| Order from quote | Copies the quote-time cost to `order_items.cost_per_unit` and `cost_at_time_cents` | `convert_quote_to_order`, `draw_down_quote` (`20260914100500`, `20260816120000`) |
| Direct order, `price_order`, `update_order_items` | Re-stamps from live `products.current_cost` at that write | trigger in `20260812115237*` l.480-500 |
| Invoice | `invoice_items.cost_cents` = order line cost | `_complete_delivery_authorized_impl` (`20261022075000*` l.819-859) |
| PO received at a different price | **Nothing changes** | receive body above; `set_purchase_order_item_costs` |

Reports then read `COALESCE(cost_at_time_cents/100, cost_per_unit)`. The quote-time warning `get_quote_cost_alerts` (`20261030090000`, applied live) tells a rep only that cost rose since quoting.

**Live drift estimate.** Matching each sales line to the next non-cancelled PO line for the same product created on or after the order (unit factor 1 only, 99 pairs): **16.2%** had a different PO cost, **8.1%** had a higher PO cost, and the median gap when different was **3.9%**. This is a same-product cost-drift proxy, not a special-order measure: the pairs include stocked sales, and without a link we cannot know which PO actually filled which sale.

### 1.3 Age, lots and traceability

- `inventory` is one row per product and location: quantities only, no dates, lots or cost.
- `inventory_transactions` has no cost and no link to a receipt.
- `receiving_records` keeps `received_at`, quantity and an optional free-text `lot_number`. Live: **0 of 130** receipts have a lot number.
- Only spray applications trace to receipts (`application_record_lots.source_receiving_record_id`, `/lot-trace`). Sales deliveries cannot.

**Live aging estimate: unvalidated raw-unit illustration** (on-hand allocated to the newest receipts first, i.e. assuming the oldest stock sold first; 66 products with stock; units not normalized):

| Age bucket | Raw unnormalized quantity share (illustration) |
|---|---|
| 0-90 days | 0.0% |
| 91-180 days | 0.3% |
| 181-365 days | 87.7% |
| Over 365 days | Not measurable yet (receipts start 2026-03-04); shows 0.0% |
| Age unknown: no matching receipt (opening stock, adjustments) | 12.0% |

13 of the 66 products with stock have no receipt history at all. Receipt and inventory units were **not normalized** (receiving adds the quantity as entered), so these shares may mix unlike units. Treat them as direction only. A real report must convert units first, or else show product-level results without a total.

### 1.4 Landed cost, vendor programs, returns, expiry

- **Freight on purchases:** none. Freight exists only as a customer invoice charge (`src/lib/invoiceChargeLines.ts`). `vendor_bills.adjustment_cents` feeds nothing in cost.
- **Rebates:** `rebate_programs` / `rebate_claims` (`20260213200000*`, page `src/pages/Rebates.tsx`) support per-unit, percent, volume-tier and flat programs, with manual per-order claims. **Live: 0 programs, 0 claims.** Nothing accrues and nothing touches cost or margin.
- **Returns to vendor:** two flags exist, `products.return_policy` and `receiving_records.is_non_returnable`, but no vendor-return transaction or costing workflow was found.
- **Customer returns:** return credits reverse the original sale's cost (`invoice_items.return_credit_cogs_cents`, `supabase/migrations/20260827041100_rebuild_return_credit_cogs_reversal.sql`). The parked plan's note about a returns-COGS defect predates that fix.
- **Vendor prepay, early-order discounts, price protection, carryover, expiry:** no tables or screens.

### 1.5 Valuation and margin reports

- **Inventory Cost report** (`Reports.tsx` → `get_inventory_cost_report`, latest body `20261103100000*` l.582-622, admin only): `quantity_available × products.current_cost`. The Inventory page total uses the same formula (`src/pages/InventoryPage.tsx` l.1200).
- **Financial Dashboard** (`financial_dashboard_summary`): floor value at catalog cost; margins from the sale-time snapshot.
- **Order-basis reports** (sales detail, summary, profitability) and **invoice-basis reports** (`get_bottom_line_pnl`, monthly summary) both use snapshot cost and can differ from each other (documented).
- **Stale Costs tab** shows how old each price-list cost is. No report shows replacement-cost value, stock age or carrying cost.

### 1.6 Context that shapes the recommendation

- The books stay in **QuickBooks Desktop** (`docs/manual/DECISION_LOG.md`, 2026-10-15). CRX numbers here are **management numbers**, not the general ledger. That gives freedom (carrying cost can be shown) and a duty (label clearly which number the accountant should use).
- A scoped, Sol-reviewed design for an average-cost engine already exists and is parked: `docs/plans/2026-07-16-inventory-costing-plan.md`.

---

## 2. How industry software handles it

Evidence quality varies sharply. Labels: **[doc]** official documentation read; **[mkt]** vendor marketing; **[3rd]** third party or search snippet only; **[inf]** our inference.

### 2.1 Ag retail systems

- **Agvance (SSI).** Cost method set per inventory department: Average, Last, Estimated Average, or Replacement Cost ([doc](https://helpcenter.agvance.net/home/hub-products)). Average is weighted, freight included and discounts subtracted ([doc](https://agvancehelpcenter.knowledgeowl.com/home/product-cost-calculation)). No FIFO or lot-layer costing found. For selling before the vendor invoice, "Estimated Average" uses the priced PO's cost at receipt ([doc](https://agvancehelpcenter.knowledgeowl.com/home/average-cost-estimated-average-cost)). For departments on Estimated Average, its gross-margin report counts the change from receipt to purchase invoice in purchases, which flows into cost of sales ([doc](https://helpcenter.agvance.net/home/inventory-position-gross-margin-report)), so the gap is caught in total. Whether individual sales are re-costed is not documented. Purchase add-on charges (freight) flow PO → receipt → invoice and are prorated by cost ([doc](https://helpcenter.agvance.net/home/add-on-charges-on-transactions)). Seed rebates and prepay discounts can be accrued as add-ons to an "anticipated rebate" account ([doc](https://helpcenter.agvance.net/home/seed-discount-and-rebate-management); [doc](https://agvancehelpcenter.knowledgeowl.com/home/accounting-qa)).
- **agre (Tronia, Canadian ag ERP).** FIFO or Average per product and location; uses an **estimated cost until actual cost arrives, then replaces it and recalculates past postings** ([doc](https://tronia.com/webhelp/inventory/Costing_Overview.htm)). Closest public model to what CRX needs for sell-then-buy.
- **iRely.** Weighted average; price as cost plus amount or percent ([mkt](https://www.agriculture-xprt.com/software/agronomy-software-507228)).
- **AgWorks, Cultura / Greenstone AGRIS, Proceed / Ag-Information:** no public costing documentation found.
- **Rebate tools** (AgVend Program Management, Smartwyre): track rebate earnings and net cost [mkt]; accrual method not described.
- **Not found for any ag system:** stock aging reports, interest or carrying-cost allocation, obsolescence reserves, expiry or registration-change handling, margin floors. Trade press describes the pressure (tight cash, high borrowing costs, generics leaving retailers "upside down" on stock) ([3rd](https://www.croplife.com/?p=111192)) but not a software answer.
- **Manufacturer side:** a major crop-protection manufacturer's annual filing treats year-end retailer programs as variable consideration accrued at best estimate ([doc](https://www.sec.gov/Archives/edgar/data/5981/000095017025100730/R11.htm)). That shows the programs are real and material. It does not settle when a distributor may book a rebate it expects to *receive*; that follows ASC 705-20 (section 2.4) and the accountant.

### 2.2 General distribution ERPs

| System | Costing methods | Sell before vendor invoice / drop ship | Landed cost | Rebates | Aging | Replacement cost |
|---|---|---|---|---|---|---|
| **Microsoft Dynamics 365 Business Central** | FIFO, LIFO, Average, Specific, Standard; per item; locked once entries exist; average is computed over a chosen period (day to accounting period) and recalculated, not a perpetual pool [doc] | Sale costed at **expected cost**; "Adjust Cost – Item Entries" forwards actual cost and later item charges to units already sold; optional expected-cost posting to interim accounts (example: 95 expected, 100 actual) [doc] | Item charges allocated to receipts [doc] | Not found | Not found | Standard cost only |
| **NetSuite** | Average (default), FIFO, Group Average, LIFO, Specific, Lot, Standard; locked once saved [doc] | Special order received into stock; drop ship has no inventory effect; receipt sets item cost; under the Advanced Receiving bill-variance workflow a later bill difference posts to variance accounts (receipt corrections can recalculate costing instead) [doc] | Landed cost feature [doc] | Accounting treatment not stated | No packaged aging report confirmed; saved searches and inventory reports exist, so an aging view can be built [doc]; unverified | Not found |
| **Infor SX.e (CloudSuite Distribution)** | Perpetual weighted average; last, standard and replacement cost fields (replacement updated by hand, import or pricing update); FIFO as a cost basis for the GL; rebate and add-on cost fields [doc] | Not confirmed | Not confirmed | Rebates **reduce cost**; under average cost, rebate subtracted at receipt [doc] | Not confirmed | Replacement-cost field and reports in official docs [doc] ([cost fields](https://docs.infor.com/csdis/2026.10/en-us/useradminlib_csd_cloud/sxepgov/iwj1503926124260.html)) |
| **Epicor Prophet 21** | Not confirmed (docs behind login) | Not confirmed | Not confirmed | Rebate module per partners [mkt] | Not confirmed | Often said to have a separate pricing cost; **unverified** |
| **SAP Business One** | Moving average, FIFO, Standard, plus serial/batch valuation [doc] | Not confirmed | Landed cost documents [doc] | Not confirmed | Not confirmed | Not confirmed |
| **Acumatica** | FIFO, Specific, Average, Standard; change only at zero on-hand [doc, MYOB-branded help] | Not confirmed | Allocate by quantity, weight, volume or cost [doc, MYOB-branded help] | Not confirmed | Not confirmed | Not confirmed |

**Two documented patterns for the cost gap.** *Re-cost:* Business Central and agre record an expected cost and, when the vendor invoice posts, push the difference to cost of goods sold for units already sold and to inventory for units still on hand. *Variance:* in NetSuite the receipt sets item cost; with its Advanced Receiving bill-variance workflow, a bill-price difference first sits in Accrued Purchases and is posted to variance accounts, while editing a receipt follows a different path that can recalculate costing ([variances](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2371184.html); [costing methods](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2191818.html)). Either way, the difference is captured and visible. Freight is treated as an allocated charge, and rebates as a cost reduction where documented. Microsoft's docs name average costing as suited to mixed material "such as chemicals."

### 2.3 Ideas borrowed from other industries

Other trades have the same mix of special orders and slow, price-volatile stock on borrowed money. Public detail is thin (most of this is third-party or marketing); the technique is what matters, and each is judged for fit.

| Technique | Industry and source | Fit for CRX | Maps to |
|---|---|---|---|
| **Choose the pricing cost per price record** (replacement, standard or "sales cost") and show margin on it | Electrical / industrial distribution: Infor SX.e [doc] ([price record cost basis](https://docs.infor.com/csdis/2025.x/en-us/useradminlib_csd_cloud/sxepgov/sx_pdsp-customer-master.html)) | **Good.** CRX already keeps price-list cost apart; add replacement cost as a second margin line | Replacement-cost pricing; margin at quote |
| **Benchmark index as the replacement reference** (daily rack or spot replacement price) | Propane and fuel: OPIS [3rd] ([OPIS rack](https://www.opis.com/product/pricing/rack/propane-daily-report/)) | **Partial.** No public ag-chem index; use the latest vendor price list as the index | Replacement-cost pricing |
| **Base price plus index-linked surcharge** | Steel service centers [3rd] ([discussion](https://eng-tips.com/threads/global-steel-surcharge.227379)) | **Partial.** Only where a vendor price sheet acts as the index | Replacement-cost pricing |
| **Lagging-cost warning:** stock bought at a high cost becomes a loss risk when achievable selling prices fall | Steel service centers [3rd] ([Argus](https://www.argusmedia.com/en/news-and-insights/market-insight-papers/lagging-indexes-driving-italian-sscs-in-the-red)) | **Good**, as the reason for a "pricing-basis vs replacement" gap column | Valuation view |
| **Price-exposure view (CRX's proposed sensitivity metric, not a documented product feature):** units on hand × (pricing-basis cost − replacement cost); "book cost" only once reconciled to QuickBooks | Fertilizer retail carries unhedgeable price risk; prepay shifts it to growers [3rd] ([Iowa State](https://crops.extension.iastate.edu/cropnews/2008/08/changes-retail-fertilizer-market-impact-producers); [StoneX](https://www.stonex.com/en-us/insights/fertilizer-inventories-run-thin-as-every-buyer-waits-for-the-last-day/)) | **Good** as a sensitivity measure; it is not a forecast loss or a write-down | Valuation view |
| **Rebate taken off cost at purchase; special pricing agreements tracked by order or invoice date** | Electrical wholesale: SX.e [doc], Epicor Eclipse [mkt] ([Eclipse](https://prep.epicor.com/en-ca/products/enterprise-resource-planning-erp/eclipse/latest-release/)) | **Good.** Corroborates the ASC 705-20 approach in 2.4 | Rebates |
| **Special-order flag on the order line with live cost and margin** | Building supply: ECI Spruce, Epicor BisTrack case studies [mkt]; invoice true-up mechanics are not public and are CRX's proposed analogy, not attributed to these products | **Good** as a concept | Sell-then-buy true-up; margin at quote |
| **Per-unit financing clock:** interest-free window, then interest by days on lot | Equipment dealers' floor-plan financing [3rd, weak] ([guide](https://beancount.io/blog/2026/07/20/outdoor-power-equipment-dealer-bookkeeping-floor-plan-financing-curtailment-manufacturer-rebates-guide)) | **Partial.** Borrow the clock and per-receipt interest accrual, not curtailment (CRX has a line of credit, not unit floor-plan) | Carrying cost; inventory age |
| **Carrying rate built from components** (capital at the real borrowing rate + storage + service + risk; capital is the biggest) | Inventory-planning tools: EazyStock [mkt] ([article](https://www.eazystock.com/blog/inventory-carrying-costs/)) | **Good.** Use CRX's own rate, not a generic 25% | Carrying cost |
| **Dead-stock cost in layers:** pricing-basis cost, carrying cost so far, opportunity cost | NetSuite guidance [3rd] ([dead stock](https://www.netsuite.com/portal/resource/articles/inventory-management/dead-stock.shtml)) | **Good**, if shown as **separate** decision measures and never added up as "inventory value" (interest would be counted twice) | Inventory age; valuation view |
| **Excess stock** = bought beyond forecast demand, net of lead time | Netstock [mkt] ([article](https://www.netstock.com/?p=489)) | **Partial.** Needs a demand forecast; seasonal ag makes that hard | Inventory age |
| **Aging reserve by category** (sell-through, days to expiry, liquidation recovery) plus **return-to-vendor** windows | Pharma and medical distribution [3rd] ([article](https://www.cleverence.com/articles/for-business/expired-inventory-5832/)) | **Good**, but return windows must be checked against each supplier agreement before a flag is built; label-year and registration changes also matter | Inventory age; valuation view |
| **FEFO** (first expired, first out) by lot | Pharma [3rd] ([article](https://www.fabrico.io/blog/fifo-vs-fefo/)) | **Partial.** Needs lots captured at receiving; worth it only where expiry or label year matters. A picking rule, not a costing method | Lot handling and expiry control; inventory age |
| **GMROI per product** (gross margin ÷ average inventory at cost) | Retail and distribution [3rd] ([SPS Commerce](https://www.spscommerce.com/community/articles/what-is-gross-margin-return-on-inventory-investment-gmroi)) | **Good** as a dashboard: it needs margin and *average* stock value over the same chosen period. A full season of history is recommended for seasonal comparison, though not mathematically required. The "2 to 3" target is a retail rule of thumb; no farm-supply benchmark found | Valuation view |
| **Capital charge on salespeople or product lines** | Only a patent found ([US10127508](https://patents.google.com/patent/US10127508)); no documented practice | **Not as pay.** Show "margin after carrying cost" internally instead | Margin at quote |

**A correction worth knowing.** Wine and spirits makers are often said to capitalize interest on aging stock. The sources found say ASC 835-20 excludes inventory routinely produced in quantity, and no source confirmed an aging exception. It does not matter for CRX, which buys rather than makes product: interest stays a management carrying charge.

### 2.4 Accounting basics in plain English

- **Inventory is carried at cost** (what you paid plus what it took to get it here, such as freight), using a cost method such as FIFO, average or specific identification (ASC 330); LIFO and standard-cost systems are also used and need their own controls.
- **Write-downs.** For inventory measured by any method other than LIFO or the retail method (so FIFO and average), inventory is carried at the **lower of cost and net realizable value** (ASU 2015-11). Net realizable value is the estimated selling price less reasonably predictable costs of completion, disposal and transportation. A write-down generally becomes the new cost and is not reversed. The exception is a recovery on the same stock in a later interim period of the same fiscal year, capped at the earlier loss. LIFO and the retail method keep the older "lower of cost or market" test. This is why aging and replacement-cost views matter. A replacement-cost drop is a **review signal**, not the test itself: the test is net realizable value, based on the achievable selling price less selling costs.
- **Vendor rebates reduce the cost of what you bought** (ASC 705-20). Volume rebates are accrued when probable and reasonably estimable, spread over the purchases that earn them; they sit in inventory while goods are on hand and move to cost of sales as goods sell. Exceptions: payment for a distinct service, reimbursement of specific selling costs, and manufacturer consideration for incentives offered to the distributor's customers, but only when every ASC 705-20-25-7 condition is met; otherwise the default purchase-price-reduction rule applies ([FASB summary](https://storage.fasb.org/BMHO20260325.pdf)); each program must be classified before it reduces inventory cost. Two questions are separate: *what* a rebate is and *when* to book it. For a binding volume program, the accountant assesses whether the rebate is probable and reasonably estimable; if so it is recognized as qualifying purchases progress toward the target ([FASB consensus](https://storage.fasb.org/abs02-16.pdf)), allocated to those purchases, and the estimate is updated.
- **Carrying cost is a management number, not a booked cost.** Interest on the money tied up in stock is an expense of the period, not added to inventory; GAAP does not capitalize interest on inventory routinely bought in volume (ASC 835-20, from secondary sources). So "true cost including interest" belongs in pricing and decision reports, never in the QuickBooks inventory value.
- **LIFO (note only, not tax advice).** LIFO can lower taxes when prices rise, but the IRS conformity rule (IRC §472(c)) requires LIFO in reports to owners and lenders too. Talk to the accountant before considering it.
- **Carrying-cost rates.** Widely repeated figures ("20-30% all-in", or component breakdowns totalling 25-55%) could not be traced to a primary source and are unverified; no ag-chem-specific benchmark was found. CRX should use **its own** rate: the line-of-credit interest rate plus a small storage, insurance and shrink allowance.
- **Aging buckets** have no standard; 0-30/31-60/61-90/91-120/120+ and 30/60/90/180+ are both common. For a seasonal business, 0-90 / 91-180 / 181-365 / 366+ (roughly "this season / last season / carryover") is the sensible choice [inf].
- **GMROI** (gross margin return on inventory) = gross margin dollars for a period ÷ average inventory at cost over the same period. Above 1 means each dollar of stock earned more than a dollar of margin. Any period works mathematically; for a seasonal business a full season of history gives the fair comparison.

---

## 3. Two flows, two cost questions

**Stocked product** asks: *what did the units on the shelf cost, how long have they sat, and what would it cost to buy them again?* Answer: moving average of recorded PO cost per product and location (settled once bills are matched), an age estimate, and replacement cost side by side.

**Sell-then-buy** asks: *the sale was booked at an expected cost; what was the actual cost when the PO came in?* Answer: link order lines to PO and receipt lines by quantity, show margin as "pending final cost" until the vendor bill is matched, then record an adjustment, never rewriting a posted invoice.

---

## 4. Full comparison: what CRX has today vs. what we recommend

| Capability | CRX today (evidence) | Industry | Recommendation | Gap |
|---|---|---|---|---|
| **Costing method** | One governed price-list cost `products.current_cost`; receiving changes no cost (`receive_po_items`, `20260714230000*` l.112-278) | Average is a documented, common option in the ag systems reviewed (Agvance, agre, iRely; agre also offers FIFO); BC, NetSuite, SX.e offer average, FIFO, standard | Keep price-list cost for pricing. Add a separate **perpetual moving average of recorded PO cost** per product and location (provisional until bills are matched in Phase 4) (the parked plan, including its unit-conversion gate, negative-stock rules, opening confirmation, cost record in every inventory writer, reconciliation guard and repack step). No FIFO layers | Large |
| **Sell-then-buy true-up** | No PO-to-order link; margin frozen at quote or order cost; PO cost changes touch nothing (`set_purchase_order_item_costs`, `20261021140000*` l.513) | BC and agre: expected cost then re-cost; NetSuite: variance accounts (Advanced Receiving); Agvance: receipt-vs-invoice gap in the margin report | Quantity-based allocation table linking order line, PO line and receipt; a provisional / partially matched / settled **cost status** on every receipt, separate from `cost_needs_review`; append-only **cost adjustment** records, starting with the initial snapshot-vs-receipt difference, forwarded through the average-cost pool by a defined process (posted invoices stay locked); separate snapshot and adjusted margin views | Large |
| **Landed cost (freight)** | None on purchases; freight only as a customer charge (`src/lib/invoiceChargeLines.ts`) | Agvance add-on charges; BC item charges; NetSuite and Acumatica landed cost | Freight line on PO or vendor bill, allocated to receipt lines by cost, flowing into average cost | Large |
| **Rebates / vendor programs** | `rebate_programs`, `rebate_claims` exist, 0 rows live; no cost effect (`20260213200000*`) | GAAP and SX.e: rebates reduce cost; Agvance: accrue to anticipated-rebate account | Classify each program, then allocate qualifying rebates to the purchases that earn them; keep estimate, actual and catch-up adjustments separate and split them between stock on hand and stock sold | Large |
| **Inventory age** | Not known; `inventory` has no dates; 0 of 130 receipts have a lot | Not documented by ag vendors | Phase 1: FIFO estimate from `receiving_records.received_at`, only where receipt and inventory quantities share a verified unit, with "age unknown" shown. Stays an estimate under Phase 2; exact age needs lot quantities captured through **every** physical movement (sales, returns, adjustments, repacks, jobs, blends, future transfers) plus an opening lot balance | Large |
| **Carrying / interest cost** | None | None found in ag software; management practice only | Management estimate: annual rate × days held ÷ 365 × cost, shown in reports, never booked | Large |
| **Replacement-cost pricing** | `supplier_price_observations` (10 rows live for 596 active products) selectable as basis behind a pilot gate; not used in valuation or warnings | Agvance offers a Replacement Cost method; SX.e has replacement-cost fields and reports | Replacement-cost column only where a current, unit-matched supplier price exists; show coverage (how many products have one); advisory margin line | Small to build; useful only as supplier prices are loaded |
| **Inventory valuation view** | `quantity_available × current_cost` (`get_inventory_cost_report`, `20261103100000*` l.582-622) | Average or FIFO value; aging reports in some systems | Price-list, average recorded PO cost and replacement side by side, plus age-bucket quantities, "age unknown" and carrying cost; rename the current one "Pricing-basis valuation"; no all-in total until coverage checks pass | Small now, large for average cost |
| **Margin at quote time** | Admin sees cost and margin; margin floors (`20261025210000`); below-cost approvals against `products.current_cost` (trigger in `20260812115237*`); rep sees only "cost rose since quoted" (`20261030090000`) | Not documented for ag vendors; SX.e chooses the pricing cost per price record; building-supply systems show live special-order margin | **Keep** the existing below-cost approval as is. Add replacement cost, aged-stock flag and "margin after carrying cost" as **advisory** warnings for admins. Showing dollar costs to reps would change the admin-only cost rule and needs a deliberate decision | Small |
| **Returns and credits** | Return credits reverse the original sale cost (`invoice_items.return_credit_cogs_cents`, `20260827041100`); no vendor returns | Pharma and ag: return-to-vendor windows | Engine restores returned stock at its original issue cost (parked plan); add vendor-return records later | Small |
| **Price-exposure view** (borrowed) | None | Steel and fertilizer retail carry price risk (the sources show volatility, not this formula) | Units on hand × (pricing-basis cost − replacement cost), per product, only where replacement cost is current and units match | Small, limited by data |
| **Return-on-stock view: GMROI, dead stock** (borrowed) | None | Retail and distribution GMROI; NetSuite and pharma dead-stock and aging reserves; return-to-vendor windows | Dead-stock list now, with pricing-basis cost and holding charge shown separately; return-window flag only after supplier terms are validated. GMROI once Phase 2 gives average stock value (a full season recommended) | Small now; GMROI later |

---

## 5. Recommendation

### 5.1 Costing method

Use a **perpetual moving average of recorded PO cost** per product and location, as already designed in `docs/plans/2026-07-16-inventory-costing-plan.md`. Its value pool is kept in integer cents, the average is derived at read time, every cost change is recorded as an event, and it starts at an owner-approved opening. Why:
- Average is a documented, common option in the ag systems reviewed (Agvance, agre, iRely; agre also offers FIFO), though the sample is too small to call it an industry norm. Business Central also supports average costing, though it computes the average over a period rather than as a perpetual pool.
- FIFO layers add a lot of bookkeeping for products that are interchangeable in the tank.
- Its screens never change prices or invoices.

In Phase 2 the engine values receipts from the PO-line cost, so the number is an **average recorded PO cost**, provisional until vendor bills, freight and rebates are matched (Phases 3 and 4). Only after that reconciliation does it become an **invoiced net acquisition cost**, still subject to freight and rebate adjustments.

It is **not** a small change. Every inventory-writing function must record a matching cost event in the same transaction. The plan also has a unit-conversion gate, negative-stock rules, a reconciliation guard and a separate repack step for custom fills. Trade-off: average cost does not track the age of individual receipts, so aging stays an estimate unless lot quantities are tracked later.

Keep `products.current_cost` as the **pricing basis**, not an inventory value. Three facts stay separate and labelled: price-list cost, average recorded PO cost, replacement cost.

### 5.2 Landed cost plus estimated holding charge, per unit

**Management decision amount = estimated net landed cost (purchase + allocated freight − expected rebate; this part is the product cost) + estimated holding charge (a period expense)**, where **holding charge = annual rate × days held ÷ 365 × (purchase cost + freight − rebate)**.

**Worked example (made-up numbers, not CRX data):** a 2.5 gallon jug.

| Item | Amount |
|---|---|
| Vendor price | $100.00 |
| Freight allocated | + $3.00 |
| Expected volume rebate | − $5.00 |
| **Net landed cost** | **$98.00** |
| Held 14 months (425 days) at 9% interest: 98.00 × 0.09 × 425 ÷ 365 | + $10.27 |
| Storage, insurance, shrink at 4% a year: 98.00 × 0.04 × 425 ÷ 365 | + $4.56 |
| **Landed cost plus estimated holding charge** | **$112.83** |
| Replacement cost today (vendor's new price, net) | $90.00 |

Selling at $115.00 shows three illustrative gross-margin views: **14.8%** on estimated net landed cost, **1.9%** as a management margin after the holding charge (interest and storage are period expenses, not product cost), and **21.7%** on replacement cost. Read together, they say holding that jug for 14 months used up most of its margin. A competitor who restocks at $90 can undercut $115, so whether $115 still sells depends on real quotes and sales, not on the replacement cost alone. Selling costs (delivery, commission) are not included. This is the comparison the report should put in front of you.

All of this is management reporting. For the books, only a complete, accountant-approved cost (purchase plus freight, less earned rebates, after any write-down) counts; interest never does.

### 5.3 Sell-then-buy

1. **Quantity-based allocation table** linking order line, PO line and receiving record with a quantity, so one PO can fill several orders, several receipts can fill one order, and partial deliveries and returns are handled. PostgreSQL enforces separate limits for ordered, received, delivered, invoiced and credited quantities in normalized units, checked in aggregate under row locks, and every write takes an idempotency key.
2. **A cost status on every receipt**, whether or not it serves an order: *provisional*, *partially matched* or *settled*. Vendor bill lines and charges (freight, credits) are matched to receipt quantities; later credits post as further adjustments. Each order allocation's "pending" status is derived from the receipts it uses. Bills, credits and freight arrive separately, so one status per PO line is too coarse. `cost_needs_review = false` is not enough, because it only means an admin entered a cost. Until those receipts are settled, the PO cost is labelled *expected* and the order's margin shows as **"pending final cost"**.
3. **Append-only, linked cost adjustment rows.** First, at allocation, record the **initial difference** between the sale's snapshot cost and the allocated receipt cost; otherwise a sale booked at $100 and filled at $110 would never be corrected. Then each later bill, credit, freight or rebate change posts a further linked adjustment. How a late change flows through the moving-average pool (later receipts, issues, returns, negative-stock repairs, rounding) needs a **deterministic cost-forwarding process** specified in the Phase 2/4 design, as Business Central's separate cost-adjustment run shows ([doc](https://learn.microsoft.com/en-us/dynamics365/business-central/design-details-cost-adjustment)); a naive split by the original receipt's remaining units is wrong. Effects post in open periods and the pool and issued costs are reconciled. Posted invoices and closed periods are never rewritten.
4. **Three margin views, never mixed:** the *snapshot margin* (today's reports, unchanged); the *adjusted order margin* (snapshot plus the initial allocation difference plus later adjustments, for the lifetime of the order); and, after Phase 2, an *inventory-cost view* from the average-cost engine. Each report says which it uses. Period reports place adjustments by effective date and must reconcile to QuickBooks before going live.
5. For unlinked historical sales, offer a read-only "likely next PO" variance report, labelled as an estimate (the proxy in section 1.2).

### 5.4 Pricing guidance

- **Keep the existing approval check.** The below-cost approval against `products.current_cost` stays exactly as it is. Two new **advisory** warnings are added, not new hard floors:
  - *below average recorded PO cost*: you are likely losing money on the stock you hold;
  - *below replacement cost*: you could not restock at this price.
- **Clearance path.** Old stock sometimes must be sold below what was paid. A clearance price below `products.current_cost` goes through the **existing** below-cost approval and reason; it is never a bypass. Net realizable value informs that decision. The new advisory warnings never add a higher-of-two floor.
- **Aging trigger.** Stock over 270 days (illustrative; Mason picks) is flagged on the product page and in a weekly list for one of: price review, transfer or promotion, or return to vendor where the program allows.
- **Carrying-cost display.** Show an **estimated holding charge** for receipt-attributed stock next to margin on admin screens, with its assumed age and cost basis stated; stock with no matching receipt shows "unknown"; decide whether reps see it (section 7).

### 5.5 Inventory valuation view

One admin report with, per product and location: quantity; value at price-list cost (today's number, renamed); value at average recorded PO cost (Phase 2, provisional until bills are matched); value at replacement cost, only where a current, unit-matched supplier price exists; **quantity** in age buckets 0-90 / 91-180 / 181-365 / 366+ and "age unknown" (bucket dollars only if labelled *quantity × stated valuation basis*, since neither cost basis identifies the cost of each surviving receipt); estimated carrying cost to date, shown separately and never added into value; and a confidence label (confirmed / estimated / needs review, from the parked plan). Each column shows its **coverage**: the share of eligible product-location rows, and of unit-normalized quantity, that it can measure. Any sum over incomplete coverage is labelled **partial**, with the excluded rows and their likely materiality shown beside it; an unqualified total appears only at complete, reconciled coverage. A note under it: "These are management views. The books use the cost basis the accountant approves, reconciled to QuickBooks, after any write-downs."

### 5.6 Phased plan

Every money piece follows the CRX Hard Rules: integer cents, logic in PostgreSQL RPCs, `p_idempotency_key` on mutating RPCs, RLS on new tables, admin-only cost access.

| Phase | What | Schema change? | Sol-required paths touched |
|---|---|---|---|
| **1. Reporting only** | Estimated aging report (FIFO from receipts, only where receipt **and** inventory quantities are verified in a common unit and reconcile to movements; "age unknown" otherwise; past quantities are never silently repaired in a report); estimated holding charge for receipt-attributed stock (assumed age and cost basis shown; unmatched stock "unknown") using one admin setting for the annual rate; replacement-cost and price-exposure columns where data allows; coverage shown on every column; dead-stock list; rename current valuation to "Pricing-basis valuation" | No new tables. New read-only admin RPCs and one setting row (a small migration) | Yes: `supabase/`, `src/pages/Reports.tsx` |
| **2. Average-cost engine** | Un-park the parked plan in full: Gate 0 unit conversion, C1 cost events in **every** inventory-writing RPC with a completeness guard and negative-stock rules, C2 opening valuation you confirm, C3 reports, C4 repack for custom fills | Yes: `inventory_cost_openings`, `inventory_cost_events`, `inventory_cost_state`; changes to every inventory-writing RPC (a substantial transactional change, though its screens are read-only) | Yes: `supabase/`, receiving, inventory |
| **3. Freight and rebates** | Freight allocation into receipt cost; rebate accrual into net cost once earned, with accountant-approved estimates (extends the parked plan, which excluded both) | Yes: freight on PO or vendor bill; program-to-purchase eligibility and receipt-allocation records; estimate, actual and catch-up adjustments split between stock on hand and stock sold (today's `rebate_claims` link only to orders and customers) | Yes: `supabase/`, `src/pages/Rebates.tsx` |
| **4. Sell-then-buy true-up** | Quantity-based order ↔ PO ↔ receipt allocation; provisional / partially matched / settled cost status on every receipt; append-only adjustments starting at allocation, with a defined cost-forwarding process; separate snapshot and adjusted margin views | Yes: allocation table, cost-status fields, linked cost-adjustment records feeding both order margin and the inventory pool | Yes: `supabase/`, money reports |
| **5. Pricing hooks** | Advisory warnings below average recorded PO cost and below replacement; clearance path; aging flags on product page and quote warnings. Existing below-cost approval unchanged | Small | Yes: `supabase/`, `src/pages/ProductDetail.tsx` |

Phase 1 can ship this season, but its usefulness depends on data cleanup: loading current supplier prices and unit conversions. Phases 2-4 each need their own plan, Luna and Sol review, and an approved migration. GMROI waits for Phase 2 average stock values; a full season of them is recommended for seasonal comparison.

---

## 6. Assumptions and unverified claims

- **Aging estimate** assumes the oldest stock sells first, ignores unit conversions between receipt and inventory units, and cannot see stock received before 2026-03-04. Negative stock, manual adds and adjustments distort it.
- **Sell-then-buy drift** pairs each sale with the next PO for the same product; it is not a true link and includes stocked sales.
- **Live apply status:** the key cost migrations cited (20260722015019, 20260812115236/7, 20261021140000, 20261025210000, 20261030090000, 20261102220000, 20261103100000) were checked as applied live. The 2026-03-13 migration that removed average-cost-on-receive is cited from the parked plan; its live ledger row was not found under that version and was not chased further.
- **Not verified:** the live value of `supplier_cost_basis_enabled`; the full latest body of `financial_dashboard_summary` after its 2026-10 wrappers.
- **Industry claims:** Prophet 21 is from partner pages only, so treat it as a lead, not fact. SX.e costing-method and replacement-cost cells use an official Infor page found in the Sol review and re-read by the author. SAP B1 and Acumatica methods come from official training and help pages. No ag vendor documents aging, carrying cost or obsolescence reserves; AgWorks, Cultura and Proceed publish nothing on costing.
- **Accounting:** ASC 835-20 treatment comes from secondary sources; exact codification paragraphs were not read except ASC 705-20-25-7 via PwC. Confirm with the accountant before any number feeds QuickBooks.
- **Other industries (2.3):** almost all third-party or marketing. Not found: Eclipse cost-field docs, BisTrack and Spruce costing mechanics, dealer floor-plan system docs, formulas from Lokad, GAINS or Inventory Planner, distributor GMROI or turns benchmarks, and any documented capital charge on salespeople.
- **Carrying-cost benchmarks** come from one unattributed industry breakdown; the rate CRX uses should be its own borrowing rate.

---

## 7. Decisions only Mason can make

- **NEEDS MASON - DECISION REQUIRED: the carrying-cost rate.** Use the line-of-credit rate alone, or that plus a storage, insurance and shrink allowance (suggested 3-5%)?
- **NEEDS MASON - DECISION REQUIRED: who sees carrying cost and replacement cost.** Admins only (today's rule for all cost numbers), or reps too at quote time? Showing reps dollar costs would change the admin-only cost rule.
- **NEEDS MASON - DECISION REQUIRED: the aging trigger.** How many days before stock is flagged for price review or return (suggested 270)?
- **NEEDS MASON - DECISION REQUIRED: un-park the average-cost engine (Phase 2)**, including the opening-valuation session where you confirm each product's starting cost.
- **NEEDS MASON - DECISION REQUIRED: extend the parked plan to freight and rebates (Phase 3).** The 2026-07-16 plan excluded them on purpose; this report recommends adding them later.
- **NEEDS MASON - DECISION REQUIRED: track lots.** Exact aging and expiry need lot numbers at receiving **and** lot quantities tracked through every physical movement (sales, returns, adjustments, repacks, jobs, blends, transfers) from an opening lot balance. Today no lots are entered, so this is a habit change as well as software.
- **Ask the accountant:** which cost basis QuickBooks should carry once CRX can produce a complete one, how to book expected rebates, and whether carryover stock needs a write-down to net realizable value.

---

## 8. Sol review

Sol (`gpt-6-sol`, high effort, read-only) reviewed this report as an independent expert in distribution accounting and ERP costing. Sol is advisory here; this is not the ship gate. Each finding was checked against the code or sources before it was accepted.

**Attempt 0 (no verdict).** Sol's read-only sandbox on this Windows machine blocked all file reads, so it gave no findings. The review was re-run with the report, the cited code excerpts, schema columns and live query results passed in as text.

**Round 1: 32 findings (0 BLOCKER, 13 HIGH, 15 MED, 4 LOW).** Sol confirmed that the worked-example arithmetic and the live percentages are correct.

| # | Sev | Finding | Outcome |
|---|---|---|---|
| 1 | HIGH | Price-list cost *is* today's inventory value; standard cost is not invalid per se | Fixed: called a "pricing-basis valuation"; standard cost valid only if reconciled (1.1, summary) |
| 2 | MED | Admin can pick a received PO cost as the basis | Fixed: "no **automatic** effect" (summary, 1.1) |
| 3 | HIGH | 16% drift is a same-product proxy, not special-order margins | Fixed (summary, 1.2) |
| 4 | HIGH | Engine does not give exact age | Fixed: aging stays an estimate; exact needs lot quantities (tables, 5.1, 7) |
| 5 | HIGH | Aging shares mix unnormalized units | Fixed: labelled direction-only; Phase 1 converts units or shows no total |
| 6 | MED | "Likely older" unsupported; 365+ is unmeasurable, not zero | Fixed: "age unknown"; inference removed (1.3) |
| 7 | MED | `return_policy` and `is_non_returnable` exist | Fixed (1.4) |
| 8 | MED | Agvance gross-margin report captures receipt-to-invoice change | Verified on the Agvance page (Estimated Average departments); fixed (2.1, section 4) |
| 9 | MED | Business Central average is period-based, not perpetual | Fixed (2.2, 5.1, summary) |
| 10 | MED | SX.e methods are documented | Verified on the Infor page; fixed (2.2) |
| 11 | LOW | SX.e replacement cost is [doc]; dead link | Fixed: link replaced (2.2, sources) |
| 12 | LOW | SAP B1 and Acumatica sources are official | Fixed: relabelled [doc]; serial/batch added |
| 13 | MED | NetSuite aging "add-on only" unsupported | Fixed: marked unverified, buildable via saved searches |
| 14 | MED | NetSuite uses variance accounts, not re-costing | Fixed: two patterns described (2.2) |
| 15 | LOW | NetSuite "bill variances" link pointed at landed-cost categories | Fixed (sources) |
| 16 | MED | Lagging-cost wording needs a selling-price assumption | Fixed (2.3) |
| 17 | MED | Dead-stock layers double-count interest | Fixed: shown separately, never totalled (2.3, 4) |
| 18 | HIGH | Write-down recovery allowed within the same fiscal year | Fixed (2.4) |
| 19 | MED | Scope of ASU 2015-11 and full NRV definition | Fixed (2.4) |
| 20 | HIGH | Don't tell the books to use the Phase 2 number | Fixed: accountant-approved, reconciled basis (5.2, 5.5, 7) |
| 21 | MED | Manufacturer's accrual doesn't set the distributor's timing | Fixed: what vs when separated (2.1, 2.4) |
| 22 | MED | Replacement cost doesn't prove $115 sells; selling costs missing | Fixed: "illustrative" views (5.2) |
| 23 | HIGH | `cost_needs_review = false` isn't vendor-bill confirmation | Fixed: separate final-cost status (5.3, 4, phases) |
| 24 | HIGH | One `order_item_id` can't model many-to-many fills | Fixed: quantity-based allocation table (5.3, 4, summary) |
| 25 | HIGH | Engine and true-up could mix cost bases | Fixed: three named margin views, period dating, QuickBooks reconciliation (5.3) |
| 26 | HIGH | New floor could bypass the governed below-cost approval; rep cost visibility | Fixed: approval unchanged; new checks advisory; access is a Mason decision (5.4, 4, 7) |
| 27 | MED | Replacement cost isn't customer willingness to pay; need clearance path | Fixed (5.4) |
| 28 | HIGH | Only 10 supplier prices; unit and age gaps make Phase 1 values partial | Fixed: coverage shown; no all-in totals until checks pass (summary, 4, 5.5, 5.6) |
| 29 | HIGH | Phase 2 omits Gate 0, negative stock, every-writer events, guard, C4 | Fixed (4, 5.1, 5.6) |
| 30 | MED | No returns row; returns-COGS status | Verified: return-credit cost reversal shipped (`20260827041100`); returns row added (summary, 1.4, 4) |
| 31 | MED | GMROI needs period averages | Fixed: deferred until a season of history (2.3, 2.4, 4, 5.6) |
| 32 | LOW | Report names "Mason" in a public repo | Rejected: the owner's name appears throughout the public repo's own guidance (for example `AGENTS.md`), and section 7 addresses him by design. No customer, supplier or live dollar figures appear |

**Round 2 (full final report, including section 2.3 and the new comparison rows): 26 findings (0 BLOCKER, 6 HIGH, 14 MED, 6 LOW).** Sol re-confirmed the worked-example arithmetic and that receiving changes no cost. All 26 were accepted and fixed.

| # | Sev | Finding | Outcome |
|---|---|---|---|
| 1 | HIGH | "Average paid cost" is wrong for Phase 2, which values receipts from PO-line cost | Fixed: renamed "average recorded PO cost", provisional until bills are matched (summary, 3, 4, 5.1, 5.4-5.6) |
| 2 | HIGH | True-up adjusts order margin but not the inventory pool | Fixed: each difference is split between stock on hand and units issued (5.3, 4, 5.6) |
| 3 | HIGH | One "final cost" per PO line is too coarse | Fixed: provisional / partially matched / settled status per receipt allocation, with later credits (5.3, 4, 5.6) |
| 4 | MED | Allocation limits omit delivered, invoiced and credited quantities | Fixed (5.3) |
| 5 | MED | 87.7% aging share has no sound denominator | Fixed: removed from summary; labelled an unvalidated raw-unit illustration (summary, 1.3) |
| 6 | HIGH | Phase 1 cannot show "cost of holding this lot" | Fixed: "estimated holding charge" for receipt-attributed stock only, with assumed age and basis; unmatched stock "unknown" (5.4, 5.6) |
| 7 | MED | Age-bucket dollars lack a cost basis | Fixed: buckets show quantity; dollars only as *quantity × stated basis* (5.5) |
| 8 | HIGH | Price-exposure formula called CRX's number "book cost" | Fixed: "pricing-basis cost" until reconciled to QuickBooks (summary, 2.3, 4) |
| 9 | MED | Rebate timing test too strict | Fixed: probable and reasonably estimable, recognized as qualifying purchases progress (2.4) |
| 10 | HIGH | Accrual fields alone can't put rebates into receipt cost; `rebate_claims` links only to orders and customers | Fixed: eligibility and receipt-allocation records plus split catch-up adjustments (4, 5.6) |
| 11 | MED | Missing third vendor-consideration exception (customer incentives) | Fixed (2.4) |
| 12 | MED | Replacement-cost drop presented as a write-down trigger | Fixed: review signal; the test is net realizable value (2.4) |
| 13 | MED | "True cost" mixes product cost with period holding expense | Fixed: relabelled landed cost plus estimated holding charge; 1.9% a management margin (5.2) |
| 14 | MED | Clearance could look like a bypass of the below-cost approval | Fixed: clearance goes through the existing approval (5.4) |
| 15 | MED | "Average is the ag norm" overstates a small sample | Fixed: "documented, common option" (4, 5.1) |
| 16 | MED | Building-supply row attributed invoice true-up to Spruce/BisTrack | Fixed: marked as CRX's analogy (2.3) |
| 17 | MED | Price-exposure "report" is not a documented product feature | Fixed: CRX's proposed sensitivity metric (summary, 2.3, 4) |
| 18 | MED | Pharma return windows assumed for ag chem | Fixed: validate against each supplier agreement first (2.3, 4) |
| 19 | LOW | FEFO mapped to costing method | Fixed: lot handling and expiry control (2.3) |
| 20 | MED | Coverage "pass" rule undefined | Fixed: row and normalized-quantity coverage with a stated threshold; partial totals labelled (5.5) |
| 21 | LOW | Age bands overlap at day 365 | Fixed: 366+ (2.4, 5.5) |
| 22 | LOW | Infor price-record link dead | Fixed: current official page (2.3) |
| 23 | MED | 25-55% carrying-cost breakdown called "typical" while unattributed | Fixed: labelled unverified (2.4) |
| 24 | LOW | GMROI doesn't strictly need a full season | Fixed: a full season recommended, not required (2.3, 2.4, 4, 5.6) |
| 25 | LOW | SX.e table row missing a column separator | Fixed (2.2) |
| 26 | LOW | A named manufacturer appears | Fixed: replaced with "a major crop-protection manufacturer's filing"; SEC citation kept (2.1, sources) |

**Round 3 (confirmation pass on the full report after round-2 fixes): 15 findings (0 BLOCKER, 6 HIGH, 8 MED, 1 LOW).** Sol confirmed round-2 fixes #6 and #10 and the arithmetic. It found the fixes for #1, #3, #5, #8 and #20 incomplete, and raised new design-precision points. All 15 were accepted and fixed.

| # | Sev | Finding | Outcome |
|---|---|---|---|
| 1 | HIGH | PO-line cost still called "what you paid"; it can come from the catalog | Fixed: "recorded PO-line cost"; reconciled figure called "invoiced net acquisition cost" (summary, 1.1, 5.1) |
| 2 | HIGH | Adjusted margin misses the initial gap when the bill equals the PO but the snapshot is lower | Fixed: the initial snapshot-vs-receipt difference is recorded at allocation (5.3, 4) |
| 3 | HIGH | Cost status tied to order allocations misses stocked receipts | Fixed: status on every receipt; order status derived from its receipts (5.3, 4, 5.6) |
| 4 | HIGH | "Split each difference" doesn't say how late costs flow through a moving-average pool | Fixed: requires a deterministic cost-forwarding process in the Phase 2/4 design (5.3, 4) |
| 5 | HIGH | A total at 95% coverage can still omit material stock | Fixed: any incomplete sum is labelled partial; unqualified totals only at complete coverage (5.5) |
| 6 | HIGH | Converting only receipt units can make aging disagree with on-hand | Fixed: both sides need a verified common unit; otherwise "age unknown" (4, 5.6) |
| 7 | MED | Summary still said "most stock" is 6-12 months | Fixed (summary, 1.3 heading) |
| 8 | MED | Lagging-cost row said "book vs replacement" | Fixed (2.3) |
| 9 | MED | Price-exposure formula missing parentheses | Fixed (summary) |
| 10 | MED | Carrying formula in summary missing ÷ 365 | Fixed (summary) |
| 11 | MED | NetSuite variance pattern needs its workflow named | Fixed: Advanced Receiving bill-variance workflow; receipt edits differ (2.2, 4) |
| 12 | MED | Customer-incentive exception applies only when ASC 705-20-25-7 conditions are met | Fixed (2.4) |
| 13 | MED | Formula still called landed cost plus holding "true cost" | Fixed: "management decision amount"; heading renamed (5.2) |
| 14 | MED | Exact lot age must cover jobs, blends and transfers too | Fixed (4, 7) |
| 15 | LOW | Cost-method list read as complete | Fixed: illustrative (2.4) |

**Where it stands.** Sol was not run a fourth time. The round-3 fixes are wording and design-spec changes to this research report; no code is affected. Round-2 HIGH findings #1 and #3 each took a second fix in round 3; those second fixes have not been re-checked by Sol. Phases 2 and 4 must each get their own plan and full Luna and Sol review before any build, and that is where these design points are proven.

## 9. Sources

**CRX:** `docs/plans/2026-07-16-inventory-costing-plan.md`; `docs/workflows/INVENTORY_RULES.md`; `docs/workflows/QUOTE_TO_DELIVERY.md`; `docs/manual/DECISION_LOG.md` (2026-10-15); migrations cited inline; `.claude/schema-registry.json`; read-only live SELECTs on 2026-11-03.

**Ag software:** [Agvance products hub](https://helpcenter.agvance.net/home/hub-products) · [Agvance product cost calculation](https://agvancehelpcenter.knowledgeowl.com/home/product-cost-calculation) · [Agvance average / estimated average cost](https://agvancehelpcenter.knowledgeowl.com/home/average-cost-estimated-average-cost) · [Agvance add-on charges](https://helpcenter.agvance.net/home/add-on-charges-on-transactions) · [Agvance seed discount and rebate management](https://helpcenter.agvance.net/home/seed-discount-and-rebate-management) · [Agvance accounting Q&A](https://agvancehelpcenter.knowledgeowl.com/home/accounting-qa) · [agre costing overview](https://tronia.com/webhelp/inventory/Costing_Overview.htm) · [iRely listing](https://www.agriculture-xprt.com/software/agronomy-software-507228) · [CropLife](https://www.croplife.com/?p=111192) · [manufacturer 10-K note](https://www.sec.gov/Archives/edgar/data/5981/000095017025100730/R11.htm)

**Business Central:** [costing methods](https://learn.microsoft.com/en-us/dynamics365/business-central/design-details-costing-methods) · [cost adjustment](https://learn.microsoft.com/en-us/dynamics365/business-central/design-details-cost-adjustment) · [expected cost posting](https://learn.microsoft.com/en-us/dynamics365/business-central/design-details-expected-cost-posting) · [adjust item costs](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-adjust-item-costs) · [drop shipment](https://learn.microsoft.com/en-us/dynamics365/business-central/sales-how-drop-shipment) · [special orders](https://learn.microsoft.com/en-us/dynamics365/business-central/sales-how-to-create-special-orders)

**NetSuite (Oracle help):** [costing](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2191818.html) · [costing methods](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2195087.html) · [landed cost](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2242662.html) · [drop ship and special orders](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2354076.html) · [special order receiving](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2356560.html) · [landed cost categories](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2417902.html) · [vendor bill variances](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2371184.html) · [inventory reports](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/bridgehead_N702958.html)

**Infor SX.e:** [vendor rebates](https://docs.infor.com/sxe/latest/en-us/sxolh/cmg1503926025323.html) · [rebate costing](https://docs.infor.com/sxe/2021.x/en-us/sxolh/paz1503926027273.html) · [cost fields incl. replacement cost](https://docs.infor.com/csdis/2026.10/en-us/useradminlib_csd_cloud/sxepgov/iwj1503926124260.html) · [GL cost options](https://docs.infor.com/csdis/latest/en-us/useradminlib_csd_cloud/sxepgov/lnz1524754116549.html) · [warehouse product cost fields (community)](https://community.infor.com/discussion/25785/update-icsw-fields-from-api)

**SAP Business One and Acumatica:** [SAP B1 valuation methods](https://learning.sap.com/courses/managing-logistics-in-sap-business-one/exploring-the-inventory-valuation-methods-in-sap-business-one) · [SAP B1 landed costs](https://help.sap.com/saphelp_sbo900/helpdata/en/1b/8ca15603a846039df2849b9343ecee/content.htm) · [Acumatica (MYOB Advanced) valuation methods](https://help.myob.com.au/advanced/Docs/Published/UserGuide/Item_Costs_Valuation_Methods_GeneralInfo.html) · [Acumatica cost of inventory](https://help.myob.com.au/advanced/Docs/Published/UserGuide/IN__con_The_Cost_of_Inventory.html)

**Agvance (added in review):** [inventory position / gross margin report](https://helpcenter.agvance.net/home/inventory-position-gross-margin-report)

**Accounting:** [ASU 2015-11 (FASB)](https://storage.fasb.org/ASU_2015-11.pdf) · [ASU 2015-11 full text (PwC)](https://viewpoint.pwc.com/dt/us/en/fasb_financial_accou/asus_fulltext/2015/asu_201511inventory_/asu_201511inventory__US/asu_201511inventory__US.html) · [vendor consideration, ASC 705-20 (PwC FSP 3.6)](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/financial_statement_/financial_statement___18_US/chapter_3_income_sta_US/36_operating_expense_US.html) · [capitalized interest (PwC)](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/property_plant_equip/property_plant_equip_US/chapter_1_capitaliza_US/13_capitalized_inter_US.html) · [26 U.S.C. §472 (Cornell LII)](https://www.law.cornell.edu/uscode/text/26/472) · [APQC carrying-cost measure](https://www.apqc.org/what-we-do/benchmarking/open-standards-benchmarking/measures/inventory-carrying-cost-percentage) (page blocked when checked)
