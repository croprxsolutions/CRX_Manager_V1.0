# CRX Manager bug sweeps, 2026-11-10 (read-only), handoff for Claude

Source: CODING AGENT (Grok Bot), three read-only sweeps of main as of 2026-11-10. No code, data, PRs or comments were changed.
Scope excluded: chemical sale and field application flows.

> **Public copy (2026-11-10).** This repository is public. Per AGENTS.md (Public security write-ups, Knowledge Vaults)
> this copy leaves out exploit-level detail for access holes that are not fixed yet, one customer record id, one
> rep's page list, product costs and prices, and company-wide money totals. Every finding, severity and fix idea is
> kept. The full original stays in Mason's private copy outside the repo. Findings are logged as KI-119 to KI-149 in
> [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md); Mason's questions are To-Do decisions 15 to 26 in
> [`TO_DO_LIST.md`](../TO_DO_LIST.md).

## What Claude should do
1. Save this file at docs/manual/sweeps/bug-sweeps-2026-11-10.md.
2. Log each finding below as a new KI entry in docs/manual/KNOWN_ISSUES.md (skip any that duplicate an existing KI and cross-reference it instead). One docs-only PR. No code fixes, no live data changes, no migrations.
3. Keep Mason's open questions (end of each section) in TO_DO_LIST.md or the PR body so he can answer them.
4. Follow AGENTS.md and .claude/commands/ship.md. Don't touch Taha's PRs. Don't --no-verify, --admin, or force-push.

## Recommended fix order (after logging)
1. P&L commission line (sweep 3, #1): headline profit off by six figures. Needs Mason's answer to Q1 first.
2. Cycle count drift (sweep 1, #1): must be fixed before the pre-season physical count.
3. PO close-short (sweep 2, #1): stale on-order quantity is hiding stock warnings.
4. Page Access is UI-only (sweep 3, #2) and rep-editable credit settings (sweep 3, #4).

---


---

# SWEEP FILE: product-inventory-cost-2026-11-10.md

# Bug sweep: Product Master, inventory and cost tracking (2026-11-10)

Read-only. Repo `croprxsolutions/CRX_Manager_V1.0` at `main` a1ba9e63 (2026-11-10 2:36 PM CT). Live Supabase
`rhyzpcqhnizqbxphqdkr`: plain SELECTs plus catalog reads (`pg_get_functiondef`) and one call of the pure
`_calculate_product_pricing` function. Nothing was written. No customer names below. Live function bodies were
read from the database, so they match what runs today.

Base: `https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/`

## How the system is meant to work (from AGENTS.md, DECISION_LOG, INVENTORY_RULES, the plans)
- Stock lives in `inventory` per product and location (Main Warehouse only). Every change writes an `inventory_transactions` row, and all the math happens in the database.
- Shortages warn and never block (2026-10-15).
- Cost is one catalog cost per product (`products.current_cost`). It is a price-list basis, not what the stock cost. Purchase-cost tracking is parked (D12, 2026-11-04). Receiving never changes cost.
- Sale-side cost snapshots run quote, then order, then invoice. Below-cost needs admin approval.
- Pricing changes only go through the governed preview and apply path.
- Before the season, the D12 short list covers: a controlled physical count with a cutoff, verified units for stocked products, a return to POs and receiving in CRX, and relabelling "Inventory Value" as a pricing-basis value.

## Ranked findings

### 1. HIGH: A stock count double-subtracts (or double-adds) anything that moved while the count was open
- **What breaks:** a count compares what staff counted with the on-hand captured when the count was created. On Complete it adds that difference to today's on-hand. Example: the count opens at 100, a 10-unit delivery goes out, and staff count 90 on the shelf. The count records -10 and turns today's 90 into 80. The system is now 10 short with nothing actually missing. A receipt during the count inflates stock the same way.
- **Why HIGH:** D12 makes the pre-season physical count "the foundation" (with a cutoff and in-count receipts and deliveries "accounted for"). The 19 negative rows are to be fixed only from it. The code does nothing to enforce or detect movement during a count, and it silently gets the number wrong.
- **Where:**
  - `_complete_cycle_count_impl` sets `v_new_qty := quantity_available + variance`. Body: `supabase/migrations/20260501120000_field_app_workflow_phase17.sql` ~L103, renamed in `20260714221000_order_and_cycle_count_concurrency_guards.sql`.
  - `update_cycle_count_item` computes `variance := counted - expected_qty`.
  - `src/pages/CycleCounts.tsx` L286 captures `expected_qty` in the browser at creation.
  - Links: [phase17](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20260501120000_field_app_workflow_phase17.sql#L103), [CycleCounts.tsx#L286](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/CycleCounts.tsx#L286).
- **Evidence:** read from the live bodies. Live today has 0 completed counts (17 cancelled), so no damage yet.
- **Smallest fix:** when a count line is saved, record the locked on-hand at that moment and compute the variance against that. Alternatively, have Complete refuse (or list for confirmation) any product with a physical ledger row since the count started. The second option also gives the D12 cutoff a real check.

### 2. MED: Bottom Line P&L and Month-end summary will count application-fee cost acres x acres
- **What breaks:** a fee line stores its cost already multiplied by acres (extended), while the quantity is the acres. Both reports compute `cost_cents x quantity` for every line, so a fee's cost is multiplied by acres again. Example: 100 acres at $2/acre cost would show $20,000 of COGS instead of $200. Gross and net profit for the month would be badly understated.
- **Why MED:** it is wrong money on the owner's P&L, but it is latent. All 4 live application services have cost $0/acre today. It turns on the moment a real cost is entered.
- **Where:**
  - `_get_bottom_line_pnl_cost_impl_20261019` and `get_monthly_summary`, in `supabase/migrations/20261106150000_fix_delivery_one_screen.sql` L608 and L572 ([link](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261106150000_fix_delivery_one_screen.sql#L572)).
  - The writers store extended cost: `_save_field_app_invoice_impl_20260714` (`v_fee_cost := safe_cents_qty(cost_per_acre, acres)`, quantity = acres), `create_invoice_from_blend_ticket`, and `_save_field_app_split_invoice_impl`.
  - `save_invoice`'s own header total and the below-cost trigger already special-case fees (`CASE WHEN is_application_fee THEN cost_cents ELSE cost_cents*quantity`).
- **Evidence:** read from the live bodies. Live has 1 fee line, on a voided invoice, with cost 0.
- **Smallest fix:** use the same `CASE WHEN ii.is_application_fee THEN ii.cost_cents ELSE ROUND(ii.cost_cents*ii.quantity) END` in both reports. Add a prover with a costed fee line.

### 3. MED: "Inventory Value" subtracts negative stock, so it reads about a tenth low today
- **What breaks:**
  - The Inventory page card and the Reports Inventory Cost total are quantity x catalog cost summed over every row, including the 19 rows below zero.
  - Live (SELECT): the negative rows take about 11% off the positive-stock value.
  - One stocked row has no cost and counts as $0.
  - The page card also adds unrounded browser floats.
- **Where:**
  - [`src/pages/InventoryPage.tsx#L1235`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/InventoryPage.tsx#L1235).
  - `_get_inventory_cost_report_cost_impl_20261019` ([`20261103100000_product_active_guard.sql#L597`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261103100000_product_active_guard.sql#L597)).
- **Note:** the 19 negative rows themselves are KI-29. The valuation netting is not filed. D12 item 7 (relabel) is not built either.
- **Smallest fix:** value only rows above zero, show negative quantity separately (as the parked Phase 1 plan already specified), and list "no cost" rows as unknown rather than $0.

### 4. MED: Receiving adds the typed number whatever unit the PO line is in
- **What breaks:** `receive_po_items` adds `quantity` straight to `quantity_available`. It never checks that the PO line's unit matches the product's stock unit. PO lines also take their unit from `products.unit_size`, not the stock unit (`PurchaseOrderDetail.tsx` ~L2154). If 3 bags are received against a product counted in pounds, stock goes up 3 lb.
- **Evidence (live SELECT):**
  - Of 102 received PO lines, 4 were received in a different unit: 3 "EA" lines into Lb-stocked products, and 1 "oz" into a "Dry oz" product.
  - 44 lines were received with a blank unit.
  - The conversion snapshot trigger (`capture_purchase_order_item_cost_snapshot`) already detects the mismatch (it leaves the factor NULL), but nothing acts on it.
- **Why MED:** D12 sends purchasing back through CRX before the season, so this path is about to be used heavily.
- **Where:** `_section9_receive_po_items_serialized` ([`20260726190515_section9_po_ap_high_remediation.sql#L165`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20260726190515_section9_po_ap_high_remediation.sql#L165)) and [`src/pages/PurchaseOrderDetail.tsx#L2154`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/PurchaseOrderDetail.tsx#L2154).
- **Smallest fix:** in `receive_po_items`, fill a blank line unit from the stock unit. Refuse with a plain message when the line unit differs from the stock unit and no conversion exists. Default new PO lines to `inventory_unit`.

### 5. MED (data): Two seed-treatment products are stocked and priced "per Lb" at per-jug money
- **What breaks:** both products have `inventory_unit = rate_unit = 'Lb'` and `container_unit = 'Ea'`.
  - Products `0b2e713b` and `17ccc5ba`: cost and Tier 1 price per lb equal a whole jug's money.
  - Their purchases were "EA" at the same money.
  - An order or quote by the pound would bill a jug's price per pound, and any stock received in lb would be valued at a jug's cost per lb. Each has 1 order line; on-hand is 0.
- **Where:** live `products` rows. The unit change is blocked by `guard_product_setup_fields` until the reviewed unit change ships.
- **Note:** these may already be on Mason's private unit-mismatch list (WP-PM unit audit, KI-30). Confirm.
- **Smallest fix:** Mason confirms the real sales unit, then a reviewed unit correction (Ea/Unit).

### 6. LOW: Stored tier margins disagree with the stored prices on 3 products
- **What breaks:**
  - Product `8b9c7b32`: its stored Tier 1 margin is about 6 points above the margin its stored price gives, so admin margin views mislead.
  - Running `_calculate_product_pricing('legacy_margin', ...)` live returns a higher Tier 1, so any legacy-mode write of cost or margin would silently reprice it.
  - Product `a21ff506` stores a rounded margin a cent away from its price (legacy would move the price by one cent).
  - 8 products have a stale `tier1_gross_margin`.
- **Where:** `calculate_prices_from_margin` (default mode `legacy_margin`) and `_calculate_product_pricing`.
- **Smallest fix:** a reviewed data fix that recomputes margins from prices. The default mode for a missing setting could fail closed instead of `legacy_margin`.

### 7. LOW: "Reconcile negative inventory" can overwrite any row, not just negative ones
- **What breaks:** `reconcile_negative_inventory` sets any row to any number of 0 or more, positive rows included, with no count behind it. That is an absolute overwrite outside the count, which goes against "negatives fixed only from the count". It is admin-only and logged.
- **Where:** `_reconcile_negative_inventory_replay_impl_20261015`.
- **Smallest fix:** refuse when on-hand is not below zero, or require a completed count line.

### 8. LOW: Per-acre price silently treats unknown units as "1 oz" and mixes liquid with dry
- **What breaks:** `product_price_per_acre` uses factor 1 for a unit not in `unit_conversions` and never checks liquid vs dry, so a wrong unit gives a confident wrong per-acre price instead of none.
- **Evidence:** today only the 2 KI-114 products mismatch (oz to Dry oz), so the risk is latent.
- **Where:** [`20260702190000_per_acre_unit_fix_recompute.sql#L106`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20260702190000_per_acre_unit_fix_recompute.sql#L106).
- **Smallest fix:** return NULL when either unit is unknown or the types differ.

### 9. LOW: Retiring an inventory row ignores open purchase orders
- **What breaks:** `retire_inventory_item` deletes the row (writing a -on-hand adjustment) without checking `quantity_on_order`. The on-order recompute then recreates a zero row, and the PO still points at stock that "was retired".
- **Where:** `_retire_inventory_item_replay_impl_20261015`.
- **Smallest fix:** refuse while open PO quantity is above 0.

## Decision conflicts
- **D12 count cutoff vs cycle-count code:** see #1. The decision needs a cutoff, and the code silently gets in-count movements wrong.
- **"Revenue" in Profitability / Gross Sales is ordered value, not billed or delivered:**
  - `_get_profitability_report_cost_impl_20261019` and `_get_gross_sales_report_cost_impl_20261019` sum `order_items.total_price` and cost on confirmed and partially fulfilled orders.
  - Live, a large amount of not-yet-delivered order value (confirmed orders plus the undelivered part of partially fulfilled lines) is reported as revenue and profit. Credits and returns are not subtracted.
  - Bottom Line P&L uses posted invoices instead, so the two "gross profit" figures disagree.
  - The order basis is documented (sales-reports build sheet: "roadmap area 2"), but it conflicts with "products are billed only when delivered" (2026-10-14) as a profit measure. At minimum, label these as booked sales.
  - The two reports also differ on drafts: Gross Sales does not exclude `draft` and Profitability does. Moot today, since there are no draft orders.
- **Sale-cost chain:** the costing plan (2026-07-16 §2) describes quote cost, then order `cost_at_time_cents`, then invoice `cost_cents`. In code, a sale invoice line that is added or edited takes today's catalog cost at save (`_cost_step2_invoice_items`, `_save_invoice_lineage_unaware_impl_20260827`). Generated lines keep the cost they were created with. Order margin and invoice margin can therefore differ.

## Gaps between the vision and what's built
- Costing is a price-list valuation only. There is no purchase cost, no average cost and no lots (D12 parks these deliberately). Unit "Gate 0" is not built, which is where #4 and #5 come from.
- The "Pricing-basis value" relabel (D12 item 7) is not done.
- Reorder points: the earlier plan says 0 of 595 active products have one (TO_DO 0.8).
- Shop-filled tote cost at Bulk average (2026-10-29 #13) is parked. Fills are quantity-only. There are 0 tote fills live.
- Transfers and multi-warehouse are not built (KI-85 Part B).
- Count creation is two browser inserts (not one RPC), and expected quantities are captured client-side. That goes against the "invariants in the database" rule.
- Data to review, not bugs:
  - 3 active products have Tier 3 priced below Tier 2 (saved today, around 6:43 to 6:47 AM CT). The warning is acknowledged, which is allowed by decision.
  - 3 active products have no cost and 4 have no Tier 1 price. The below-cost guard refuses selling them, which fails closed.

## Already known or parked (not re-reported)
- KI-29 (19 negative rows), KI-108 (ledger gaps), KI-109/KI-114 (Piksi mg vs dry oz, rate data), KI-16 (job cost rounding), KI-81/KI-82, KI-85, KI-93/94/101/102.
- `manual_inventory_add` lets sales reps create opening stock while adjust is admin-only. This falls under the parked rep-only rules (TO_DO: "Reps write the stock ledger directly"; must be fixed before the first regular rep).

## Live checks that came back clean
- Reserved stock equals open-order remainders exactly (64,626.71 = 64,626.71; 0 of 117 rows off).
- Every costed product has exactly one active cost-basis row and it matches (602/602).
- No sub-cent costs or prices, no tier priced below cost, no negative reservations.
- Product unit changes are blocked on saved products (`guard_product_setup_fields`). Deactivation and inactive-line guards match the 2026-10-28 and 2026-10-30 decisions.
- Return receipt checks cumulative quantities and units.

## Open PRs in this area (none fix #1 to #9)
- #1706: unit spellings, Dry oz to lb.
- #1741: KI-16 rate-unit follow-ups.
- #1731: sale lines always carry a unit.

## Could not verify
- Return-credit COGS sign in the P&L: there are no credit memos live (KI-112 prover pending).
- Delivery-completion unit handling (the nested impl was not traced). Live: 10 of 178 delivered lines have a unit text different from the stock unit, mostly blank or spelling variants, plus the known Piksi case.
- Whether the count screen shows expected quantity to counters (blind count).
- Four July draft invoices (CS-2026-0065/0066/0070) carry $0 price and $0 cost on lines whose order cost is set (their order lines carry cost). They likely can't post at $0 price; not checked.
- Whether #5's products are on Mason's private mismatch list.

---

# SWEEP FILE: customers-purchasing-signin-2026-11-10.md

# Read-only bug sweep: customers & farms, purchasing & vendors, sign-in / settings / imports

- Repo: `croprxsolutions/CRX_Manager_V1.0`, `main` at `a1ba9e63d` (2026-11-10 2:36 PM Central)
- Live database: Supabase `rhyzpcqhnizqbxphqdkr`, plain read-only SELECTs only (counts, IDs, PO numbers; no names, emails, phones or addresses)
- Swept: 2026-11-10, about 5:20–6:30 PM Central
- Out of scope: chemical sales, field application flows, and everything already reported in `product-inventory-cost-2026-11-10.md` (the receiving unit mismatch is there, finding #1, and is not repeated here).
- Open PRs checked (12 open): none of them addresses a finding below. #1674 (fields and who-pays plan, draft) is the closest; it is a plan only.

Link base: `https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/`

---

## Ranked findings (most severe first)

### 1. A partly received purchase order can never be closed, so stock that will never arrive keeps counting as "on order"
- **What breaks:** If a vendor ships short, there is no way to say "the rest isn't coming." The leftover keeps counting as incoming stock. That makes products look covered when they are not, and it hides the "this order would go negative" warning when an order is entered.
- **Severity: HIGH.** It quietly changes the stock number the app uses for order-time warnings and low-stock alerts. It already affects 9 live products.
- **Area:** Purchasing
- **Where:**
  - `cancel_purchase_order` → `_section9_cancel_purchase_order_serialized` refuses any PO with a received quantity ("Use partial receive workflow instead"; no such workflow exists). [supabase/migrations/20260716120104_gauntlet_access_boundaries.sql](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20260716120104_gauntlet_access_boundaries.sql)
  - The status rule allows partly-received → cancelled, but the function never lets it happen. There is no "closed" status. [supabase/migrations/20260333500000_allow_po_reverse_transitions.sql](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20260333500000_allow_po_reverse_transitions.sql)
  - No close-short button anywhere in [src/pages/PurchaseOrderDetail.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/PurchaseOrderDetail.tsx) or [src/pages/PurchaseOrders.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/PurchaseOrders.tsx).
  - Net Position = available − prebooked + on order ([docs/workflows/INVENTORY_RULES.md](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/docs/workflows/INVENTORY_RULES.md) §Net Position). The order-creation warnings use the same formula.
- **Evidence:** code read plus live SELECT.
  - 10 open POs: 7 partly received and 3 submitted. 9 of the 10 were submitted 2026-03-04 to 03-23, and PO-2026-0033 on 05-06. The newest receipt on any of them is 2026-05-06.
  - Open quantity across the 10: 14,715 units. That equals the live `inventory.quantity_on_order` total (14,715) exactly. The biggest are PO-2026-0003 (9,000 open), PO-2026-0001 (2,820) and PO-2026-0024 (1,490).
  - 18 products have open-PO quantity. For 9 of them, available − prebooked is below zero but turns zero-or-positive once on order is added. They also clear their reorder point only because of on order.
- **Smallest fix:** Add a `close_purchase_order_short(po_id, reason)` function, admin or rep, that refuses while active bills exceed the received value. Give it a new `closed` status (partly-received → closed) that drops out of the on-order sums, and an activity-feed row. Then Mason decides which of the 10 POs to close (a data step, not done here).

### 2. Vendor bills are checked against what was ordered, not what arrived, and against the wrong vendor or a cancelled PO
- **What breaks:** On a short shipment, the office can enter and pay a bill for the full ordered amount without any warning. The bill can also be attached to another vendor's PO or to a cancelled PO.
- **Severity: MED.** It can mean overpaying vendors. Today 7 POs are partly received. Every live bill (6) has no PO attached, so nothing has gone wrong yet.
- **Area:** Purchasing / payables
- **Where:**
  - `create_vendor_bill`: the over-billing check compares against `purchase_orders.total_cost_cents` (the ordered value) with 5% slack, and never reads received quantities. It does not check the PO's status (cancelled is fine to it) or that the PO's vendor is the bill's vendor. [supabase/migrations/20261204100000_ki18_batch1_chicago_today.sql](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261204100000_ki18_batch1_chicago_today.sql)
  - [src/pages/NewVendorBill.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/NewVendorBill.tsx) `handlePOSelect` (about lines 154–172) fills in the ordered total. If the PO's vendor text matches no vendor record, it quietly keeps whatever vendor was already picked. The picker hides cancelled POs, but the server does not refuse them.
- **Evidence:** code read. Live: 0 of 6 bills have a PO attached, and 3 of 34 POs have a vendor text that matches no vendor record (see #3).
- **Smallest fix:** In `create_vendor_bill`/`update_vendor_bill`, refuse a cancelled PO and a vendor that doesn't match the PO. Compare the running billed total with the received value (sum of received × unit cost) and ask for the same confirmation and reason when it is exceeded. In the screen, fill in the received value and clear the vendor when no match is found.

### 3. A purchase order's vendor is free text, not a link to the vendor list
- **What breaks:** Renaming a vendor, or typing a vendor name on a bulk import, leaves POs that belong to no vendor. A bill then cannot find the PO's vendor, and per-vendor history misses those POs.
- **Severity: MED-LOW.** 3 live POs are already orphaned. It is also the root cause behind part of #2.
- **Area:** Purchasing / vendors
- **Where:**
  - `purchase_orders.vendor` is `text` with no foreign key (live schema).
  - `sync_product_vendor_on_vendor_rename` updates only `products.vendor`.
  - [src/components/purchase-orders/BulkPOImport.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/components/purchase-orders/BulkPOImport.tsx) suggests names from `products.vendor` (line about 295), not the vendor list, and saves whatever text the OCR or the user gave.
  - `delete_vendor` leaves open POs unchecked on purpose (`v_active_po_count := 0; -- intentionally unchecked`).
- **Evidence:** live SELECT. 11 distinct PO vendor texts. 3 POs match no vendor record, even ignoring case and spacing: PO-2026-0030 (submitted), PO-2026-0018 (partly received), PO-2026-0020 (fully received).
- **Smallest fix:** Add `purchase_orders.vendor_id` (FK to vendors), set it in `save_purchase_order` and keep the text as a snapshot. The bulk import picks from the vendor list. Backfilling the 3 orphans is Mason's call.

### 4. Bulk Customer Import fails for every sales rep, and it misreads some files without saying so
- **What breaks:** A rep sees the Bulk Import button, uploads a list, and every row fails with only "Failed to import N customer(s)." For admins, a quoted acreage like "1,200" saves as 1 acre, and rows with an empty first column disappear without being counted as invalid.
- **Severity: MED.** The button is shown to reps but can never work for them. Acreage that is wrong without warning feeds farm records and call lists.
- **Area:** Customers / imports
- **Where:** [src/components/customers/BulkCustomerImport.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/components/customers/BulkCustomerImport.tsx)
  - The insert (line about 309) writes straight to `customers` and never sets `assigned_sales_rep`. The live `customers_insert` policy lets a rep insert only when `assigned_sales_rep = auth.uid()`, the column has no default, and no BEFORE trigger fills it.
  - `parseFloat(value)` (about line 252) reads "1,200" as 1.
  - `parseCSV` drops any row whose first cell is blank (`cols[0]` check) before validation.
  - It goes around `save_customer`, so there is no activity-feed row, and a double click imports twice (duplicate detection is already in KI-77, not repeated).
  - The button shows for every role: [src/pages/Customers.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/Customers.tsx) about line 460.
- **Evidence:** code read plus the live policy, column default and trigger list. Not clicked through as a rep.
- **Smallest fix:** For non-admins, set `assigned_sales_rep: profile.id` on each row (or route through `save_customer`). Strip thousands separators and reject non-numbers instead of dropping them. Count blank-first-cell rows as invalid. Show the database's reason per failed row.

### 5. Farm groups (parent customer) can be made into a loop, and grandchildren are left out
- **What breaks:** If customer A is made B's parent while B is already A's parent, the farm-group view in Sales Reports runs until the 8-second limit and fails. A three-level group leaves the bottom level out of the group totals.
- **Severity: LOW-MED.** Any rep can set a parent. Live data is clean today.
- **Area:** Customers & farms
- **Where:**
  - `get_customer_farm_group` uses `WITH RECURSIVE ... UNION ALL` with no loop guard, and returns only the top parent's direct children. [supabase/migrations/20261023090000_field_functions_require_field_access.sql](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261023090000_field_functions_require_field_access.sql)
  - The picker excludes only the customer itself: [src/pages/CustomerDetail.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/CustomerDetail.tsx) about line 1479.
  - `save_customer` accepts any `parent_customer_id`. The caller is [src/pages/SalesReports.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/SalesReports.tsx) line 184.
- **Evidence:** code read plus live SELECT: 19 customers have a parent, 0 self-parents, 0 two-level chains, and `authenticated` statement_timeout is 8s.
- **Smallest fix:** In `save_customer`, refuse a parent that is the customer itself, one of its descendants, or itself a child (one level only). Use `UNION` plus a depth cap in the function.

### 6. Customer payment terms are free text, and anything unrecognized silently becomes Net 30
- **What breaks:** Typing "COD", "Cash", "due_on_receipt" or "10th of month" on a customer saves fine, but invoices get a 30-day due date. Aging and finance charges then run late.
- **Severity: LOW.** Every live value parses correctly today: 146 empty, 5 blank, 1 "Net 30", 2 "net_30".
- **Area:** Customers
- **Where:**
  - `parse_payment_terms_days` returns 30 for anything without "net N", a number or the four receipt phrases. Checked live: `due_on_receipt` → 30, `COD` → 30. [supabase/migrations/20260721191914_due_on_receipt_terms_parser.sql](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20260721191914_due_on_receipt_terms_parser.sql)
  - The customer screen's Payment Terms is a free-text input: [src/pages/CustomerDetail.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/CustomerDetail.tsx) line 1417. The invoice screen uses presets ('Net 30', 'Net 15', 'Net 60', 'Due on receipt').
- **Evidence:** code read plus live SELECT calling the parser.
- **Smallest fix:** Make the customer field the same preset list plus "Custom (N days)". Have `save_customer` refuse terms the parser would default.

### 7. The last admin can remove their own admin role
- **What breaks:** If only one admin is left and they change their own role to sales rep, nobody can reach Settings or restore an admin without database access.
- **Severity: LOW.** There are 5 active admins today, and the screen warns "you will lose access."
- **Area:** Sign-in / roles
- **Where:**
  - `_guard_last_active_admin` fires only on `UPDATE OF is_active` and checks only deactivation, not a role change. [supabase/migrations/20260727174805_deactivation_revokes_auth_access.sql](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20260727174805_deactivation_revokes_auth_access.sql)
  - `admin_update_profile` lets the role change through. [src/pages/SettingsPage.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/SettingsPage.tsx) line 824 warns but allows it.
- **Evidence:** code read plus live trigger definitions. Live: 5 active admins.
- **Smallest fix:** Extend the guard to `UPDATE OF is_active, role` and refuse when an active admin stops being one and no other active admin remains.

### 8. Deactivating a customer doesn't check open orders, deliveries, holds or quotes
- **What breaks:** A customer can be switched off while they still have confirmed orders waiting. Those orders drop out of customer-based views and call lists but still hold stock and demand.
- **Severity: LOW.** One live case, which looks old.
- **Area:** Customers
- **Where:**
  - `guard_customer_rep_edit_20261013` blocks deactivation only for posted or overdue invoices, and only for reps; admins skip the whole guard. [supabase/migrations/20261111100000_tiers_credit_limits_admin_only.sql](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261111100000_tiers_credit_limits_admin_only.sql)
  - The bulk Deactivate on [src/pages/Customers.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/Customers.tsx) (about lines 320–335) checks invoices only.
- **Evidence:** live SELECT. Of 3 inactive customers, 1 (deactivated 2026-02-06; id in Mason's private copy) still has 2 confirmed orders. 0 active holds, 0 open quotes and 0 prepay on inactive customers.
- **Smallest fix:** Add open orders, undelivered deliveries, active holds and open quotes to the deactivation check, for every role, inside the guard trigger. What to do with the one live case is Mason's call.

### 9. Crop Programs (and job print defaults) let reps edit, but only admins can save
- **What breaks:** A rep builds or edits a crop program, presses Save, and gets an error. Their work is lost. Separately, two admins editing programs at the same time overwrite each other, because the whole list is one saved setting.
- **Severity: LOW.**
- **Area:** Settings
- **Where:**
  - [src/pages/CropPrograms.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/CropPrograms.tsx): New, Edit and Duplicate are shown to every role (only Delete is admin-only, line 395). `savePrograms` (lines 141–165) updates `app_settings`.
  - Live `settings_update`/`settings_insert` policies are `is_admin()`. The page is open to `['admin','sales_rep']` in [src/appPages.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/appPages.tsx) line 277.
  - Same mismatch for "Save default" in [src/components/jobs/PrintOptionsDialog.tsx](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/components/jobs/PrintOptionsDialog.tsx) line 84.
- **Evidence:** code read plus live policies.
- **Smallest fix:** Decide who owns crop programs. Either hide editing for non-admins, or move programs to their own table with row-level saves and a version check.

### 10. A known-issue note is out of date: PO-2026-0015's receipt gap is still there
- **What breaks:** One PO line shows 227.5 received but has no receiving record. It cannot be undone through Receiving, and lot trace finds nothing for it.
- **Severity: LOW.** KI-29 currently says this "no longer shows."
- **Area:** Purchasing
- **Where:** [docs/manual/KNOWN_ISSUES.md](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/docs/manual/KNOWN_ISSUES.md) KI-29.
- **Evidence:** live SELECT. Item `e6559c38-4ae4-4899-b33c-a23e8900cec8` on PO-2026-0015 (fully received) has `quantity_received` 227.5 and 0 `receiving_records`. The only trace is one `received` inventory transaction of 227.5 at 2026-03-12 12:46 PM Central. It is the only line live where received ≠ the sum of its receiving records.
- **Smallest fix:** Correct the KI-29 line. Mason decides whether to add a matching receiving record (a data step).

### 11. An admin password reset doesn't sign the user out or leave an audit record
- **What breaks:** If an account is compromised and an admin sets a new password, anyone already signed in on that account stays signed in. Nothing in the app records who reset whose password.
- **Severity: LOW.** It comes from reading the code; not tested live.
- **Area:** Sign-in
- **Where:**
  - [supabase/functions/create-user/index.ts](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/functions/create-user/index.ts) (`action: reset_password`) and [supabase/functions/reset-user-password/index.ts](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/functions/reset-user-password/index.ts). Both call only `auth.admin.updateUserById(..., { password })`, with no session revocation and no `activity_feed`/audit insert.
  - Deactivation, by contrast, deletes sessions and refresh tokens (`_sync_auth_access_on_profile_active`).
- **Evidence:** code read.
- **Smallest fix:** After a successful reset, end the target's sessions (`auth.admin.signOut` for that user, or delete their `auth.sessions`/`refresh_tokens` as deactivation does) and write an audit row naming the admin and the target.

### 12. The live project's public (anon) key is hard-coded in 5 test files
- **What breaks:** Nothing directly. This key is meant to be public and ships in every browser bundle anyway. But it is pinned in test code, so rotating it would break those tests without anyone noticing.
- **Severity: LOW / informational.** No secret keys were found.
- **Area:** Secrets
- **Where (path and key type only):** a Supabase legacy JWT with `role=anon` for project `rhyzpcqhnizqbxphqdkr` in:
  - `tests/e2e/golive/utils/supabase-helpers.ts`
  - `tests/e2e/workflow-financial-operations.spec.ts`
  - `tests/e2e/workflow-job-lifecycle.spec.ts`
  - `tests/e2e/workflow-schema-regression.spec.ts` (2 places)
  - `tests/e2e/comprehensive-ui-workflow.spec.ts`
- **Clean results:**
  - No service-role key, `sb_secret_`, private key, Stripe, GitHub, Slack, AWS, Google or Resend key in tracked files.
  - The matches in `scripts/write-codex-push-proof.test.mjs` and `scripts/backup-claude-memory.test.mjs` are made-up test patterns.
  - `.env.example` and `.env.staging.example` list variable names with empty values.
  - No `VITE_*` secret variable is read in `src/`. Only the anon key, URL, Mapbox token and Sentry DSN are, all meant to be public.
  - The service-role key appears only in Edge Functions, through `Deno.env`.
- **Evidence:** pattern scan of the tracked tree at HEAD (shallow clone, so history was not scanned). Key types were decoded from JWT payloads; no values were recorded.
- **Smallest fix:** Read the key from `process.env` (as `.env.example` already names it) in those 5 files.

---

## Decision conflicts / questions for Mason (not bugs)

1. **Reps can change any customer's payment terms and finance-charge settings** (`finance_charge_enabled`, `_rate`, `_grace_days`), plus `parent_customer_id` and the default application service. The 2026-11-01 decision made only tier and credit limit admin-only, and the guard enforces exactly that. The 2026-07-17 entry (now superseded) named finance-charge settings as sensitive, and the 2026-10-13 entry says reps "can see all and edit all." Is the narrower lock still intended, or should terms and finance charges join tier and credit limit?
2. **Who may delete customer addresses?** Two rules in the app disagree about whether reps may delete a customer's addresses. _Detail withheld from this public repo until the fix is live (AGENTS.md › Public security write-ups); full text in Mason's private copy._ One of the two should match the other.
3. **Hiding a page from a user (Settings → Page Access, `denied_pages`) only hides the screen.** It is not enforced below the screen. _Detail withheld from this public repo until the fix is live (AGENTS.md › Public security write-ups); full text in Mason's private copy._ No decision records whether Page Access is meant as a security control or a tidiness setting. If it is meant as security, it is not enforced.
4. **Deactivation guard applies to reps only.** Admins skip the open-invoice check at the database level and rely on the Customers list's own check. Probably intended (admin override), but not recorded.

## Plan vs built gaps

- **No customer merge tool.** The grand plan's duplicate-merge policy (2026-10-30) covers products. For customers there is no merge path and no hard-delete in the app (DELETE is admin-only in RLS and cascades to addresses, fields, field billing defaults and AR reminder tracking). Live: 1 group of 2 customers shares a normalized name. Customer hygiene stays in KI-30.
- **No three-way match** (PO ↔ receipt ↔ bill). Plans mention AP polish, and #2 above is the visible symptom.
- **Credit limit math differs in three places:**
  - `check_customer_credit_limit` (New Order and Quotes convert) leaves out drafts and counts `unposted`.
  - `customer_credit_exposure` (the guard hook) counts drafts.
  - `_check_credit_limit` counts drafts *and soft-deleted invoices* and uses `>=`. It has no caller left and is callable by reps; worth dropping.
  - Already tracked in To-Do 1.8 and 10.6 (server-side enforcement), so not ranked here.
- **PO-to-vendor link** (DATA-11 linked products to vendors; POs were never linked). See #3.

## Couldn't verify

- **Deployed browser bundle:** I didn't fetch the production JS bundle, so "no secrets in the client bundle" is based on the source and env names, not the built files.
- **Git history:** the clone is shallow; only the HEAD tree was scanned for keys.
- **Supabase Auth settings** (public sign-up on or off, password rules, session lifetime, leaked-password protection) are not readable with read-only SQL. A stranger who signs up still gets an inactive, banned "Pending user" profile (`handle_new_user`), so the impact is limited either way.
- **Password reset and sessions (#11):** I didn't test whether this project's Auth version ends sessions on an admin password change.
- **Rep Bulk Customer Import (#4):** inferred from the live policy, column default and triggers; not clicked through as a rep.
- **Out of scope but noticed:** applicators may be able to change a licensing field on their own profile that job completion reads. _Detail withheld from this public repo until the fix is live (AGENTS.md › Public security write-ups); full text in Mason's private copy._ Field application, so not assessed; logged under KI-07.

## Checked and clean (this sweep)

- **Profiles:**
  - A user cannot change their own role, active flag, name or page access (`_guard_profile_role_lock`).
  - Non-admin profile inserts are refused.
  - Deactivation bans the login and deletes sessions and refresh tokens.
  - New sign-ups start inactive and banned.
  - Create-user activates through the calling admin's own `admin_update_profile`.
  - Entity-recipient profiles cannot get a password.
- **Customers:**
  - Tier and credit limit changes are admin-only. A rep's new customer must be self-assigned, starts on the default tier with no limit, has no prepay, and gets no commission split.
  - The one-primary-contact index holds: 0 customers with two primaries, 0 inactive primaries.
  - 0 parent cycles, 0 parents pointing at inactive customers, 0 duplicate account numbers.
  - 0 inactive customers with open invoices. 0 active customers assigned to an inactive or non-rep profile.
- **POs:**
  - Header total = line sum on all 34.
  - PO numbers are assigned by the server under a lock and are unique.
  - New POs must start as draft; received lines are immutable; fully-received and cancelled POs can't be edited.
  - Cancel refuses POs with active bills; delete refuses received POs or POs with any bill.
  - 0 cancelled POs with receipts. Receive status is now computed per line.
  - PO-2026-0008's mixed short and over lines are already in KI-29.
- **Vendor bills and payments:**
  - Total = subtotal + adjustment (check constraint).
  - Bill numbers are unique per vendor while active.
  - Payment references are unique per bill.
  - AP aging and the AP dashboard leave out voided and deleted bills.
  - The one paid bill's payments equal its total.
- **Settings:**
  - Writes are admin-only in RLS.
  - Settings page sends non-admins away.
  - No sales-tax settings exist, and none are needed (recorded: no sales tax).

---

# SWEEP FILE: invoicing-access-reports-2026-11-10.md

# CRX Manager bug sweep 3: invoicing and AR, roles and access, reports and month-end

- **Date:** 2026-11-10 (America/Chicago)
- **Repo:** croprxsolutions/CRX_Manager_V1.0, `main` at `a1ba9e6` (2026-11-10 2:36 PM Central)
- **Live DB:** rhyzpcqhnizqbxphqdkr. I ran plain read-only SELECTs only, against catalog reads and table data.
- **Rules followed:** No writes, DDL, PRs, comments or messages. The report has no customer names or personal data, only counts, invoice numbers and amounts.
- **Out of scope:** The chemical sale and field application flows themselves. The invoice and payment code they feed into is covered.
- **Earlier sweeps:** `product-inventory-cost-2026-11-10.md` (sweep 1) and `customers-purchasing-signin-2026-11-10.md` (sweep 2). This report doesn't repeat their findings; it references them where related.

Link base: `https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/`

---

## Ranked findings (most severe first)

### 1. The P&L and Monthly Summary subtract commissions for every booked order but count revenue only from invoices posted in CRX — HIGH
- **What breaks:** The bottom line shows a large loss that isn't real. Commissions on all booked orders (mostly billed outside CRX) are subtracted from the much smaller CRX-invoiced revenue.
- **Severity:** HIGH. It is the headline profit number, it is wrong by six figures today, and the error keeps growing until all billing moves into CRX.
- **Area:** Reports and month-end.
- **Where:**
  - `_get_bottom_line_pnl_cost_impl_20261019` (`get_bottom_line_pnl`) in [`supabase/migrations/20261106150000_fix_delivery_one_screen.sql`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261106150000_fix_delivery_one_screen.sql) (around L589).
  - `get_monthly_summary` in the same file (around L553), in the `commissions.earned_cents` field.
- **Evidence (live SELECT, mirroring the function's own filters):**
  - Revenue counts invoices with status posted/overdue/paid by `invoice_date`. Commissions count every non-replaced commission by `order_date`, whether or not the order was ever invoiced.
  - 2026 to date: commissions charged are about three times CRX-invoiced revenue, so Net Profit shows a six-figure loss.
  - March 2026 alone: no CRX revenue against a six-figure commission total.
  - Only **1 of the 35** orders that carry commissions has a posted CRX invoice.
- **Related:** Sweep 1 found a separate COGS overcount on application-fee lines in these same two functions.
- **Smallest fix:** Count a commission only when its order has an invoice in the revenue set for the period (join through `invoices.order_id` with the same status and date filter). Until then, label the line "Commissions on booked orders (not matched to revenue)".
- **Open PR:** none.

### 2. Settings → Page Access only hides screens; the database does not enforce it — MED (HIGH if it is meant as security)
- **What breaks:** A user with money pages hidden (one live rep today) keeps the abilities behind those pages.
- **Severity:** MED. The setting looks like a permission but isn't enforced. It is HIGH if Mason uses it to keep someone away from money.
- **Area:** Roles and access. This answers sweep 2's open question with evidence.
- **Where / evidence:** _Detail withheld from this public repo until the fix is live (AGENTS.md › Public security write-ups); full text in Mason's private copy._
- **Smallest fix:** Pick one:
  - (a) Record in the Decision Log that Page Access is navigation tidiness only, and rename it "Hide from menu".
  - (b) Add a helper `page_allowed(page_key)` and call it at the top of the payment and report RPCs.
- **Open PR:** none. #1576 (a rep can unpost only their own invoices) is the related KI-03 work.

### 3. Finance charge rate: the screen says "%" but the system treats it as an annual rate — MED
- **What breaks:** Two active customers are set to 1.5. If that was meant as the usual 1.5% a month, they would be billed one-twelfth of it. On a $10,000 overdue balance that is $12.50 instead of $150.
- **Severity:** MED. It affects money collected and is silent. No finance charges have been run yet, so nothing is mis-billed today.
- **Area:** Invoicing and AR.
- **Where:**
  - [`src/pages/CustomerDetail.tsx`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/src/pages/CustomerDetail.tsx) L1439, labelled "Finance Charge Rate (%)".
  - `_generate_finance_charges_idem_impl_20260721` ([`20260721145936_require_money_lifecycle_idempotency_keys.sql`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20260721145936_require_money_lifecycle_idempotency_keys.sql)) computes `overdue × rate / 100 / 12`.
  - The preview uses the same formula ([`20260712210000_ar_credit_visibility.sql`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20260712210000_ar_credit_visibility.sql) L221).
- **Evidence (live):**
  - Rate spread across active customers: 149 at 0 and 2 at 1.5.
  - The minimum-balance setting is 500 cents.
  - 0 finance_charges rows.
- **Smallest fix:** Label the field "Annual rate (%)" with helper text such as "18 = 1.5% a month", and ask Mason what the two 1.5 values mean.
- **Open PR:** none.

### 4. Any rep can change a customer's payment terms and finance-charge settings — MED
- **What breaks:** A rep can quietly move a customer from Net 30 to Net 90, set the finance-charge rate to 0, turn finance charges off, or add a long grace period. That changes due dates, overdue status, aging and late fees for that customer.
- **Severity:** MED. These are credit terms. Mason made the similar settings (price tier and credit limit) admin-only on 2026-11-01.
- **Area:** Roles and access, plus AR.
- **Where:** `guard_customer_rep_edit_20261013` in [`supabase/migrations/20261111100000_tiers_credit_limits_admin_only.sql`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261111100000_tiers_credit_limits_admin_only.sql) L72.
- **Evidence (live function source):** The guard blocks rep changes to tier, credit limit, commission split, assigned rep and prepay balance. It never mentions `payment_terms`, `finance_charge_rate`, `finance_charge_enabled` or `finance_charge_grace_days`. Reps can edit any customer, per the 2026-10-13 decision.
- **Smallest fix:** Add four `IS DISTINCT FROM OLD` checks (with matching INSERT checks) to the same guard. On the screen, disable those fields for non-admins.
- **Open PR:** none.

### 5. Voiding or cancelling an order ignores its unposted, overdue and paid invoices — MED
- **What breaks:** If an order is voided after its invoice went overdue or was paid, the invoice stays in AR (aging, reminders, finance charges) and no admin is told.
  - An unposted invoice on a voided order stays postable.
  - A cancelled order skips overdue and paid invoices the same way.
- **Severity:** MED. A voided sale could keep collecting from a customer with no alert. Not hit live yet: there are 0 voided orders.
- **Area:** Invoicing. Order void is part of the chemical sale flow, but the invoice handling it triggers is in scope.
- **Where:**
  - `_void_order_impl_20260714` in [`20261021030000_void_order_governed_split_draft_claims.sql`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261021030000_void_order_governed_split_draft_claims.sql) L263: the invoice loop handles only `status IN ('draft','posted')`.
  - `_cancel_order_impl_20260714` in [`20260714222000_return_credit_source_of_truth.sql`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20260714222000_return_credit_source_of_truth.sql): the loop handles `('draft','unposted','posted')`.
- **Evidence:** Code read of the live definitions.
- **Smallest fix:**
  - Add `'unposted'` to void's cancel branch.
  - Add `'overdue'` and `'paid'` to the "needs manual voiding" notice in both functions, or refuse the void while a live invoice exists.
- **Open PR:** none. KI-102 fixed a different side effect of the same function (stock).

### 6. Monthly Summary and the month-close summary show $0 payments, and the close summary undercounts invoices — MED
- **What breaks:** Both screens read an old payments table that is no longer written.
  - July 2026 had one customer payment, but Monthly Summary for July shows 0 payments and $0.
  - Closing a month reports "payments received $0".
  - The close summary also counts only invoices still in "posted" status, so a month whose invoices were later paid or went overdue shows less invoiced than it really did. July 2026 would show $0 invoiced against an invoice actually posted (now paid).
- **Severity:** MED. These are the month-end numbers someone would sign off on.
- **Area:** Reports and month-end.
- **Where:**
  - `get_monthly_summary` (`payments` block) in [`20261106150000_fix_delivery_one_screen.sql`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261106150000_fix_delivery_one_screen.sql).
  - `_close_accounting_period_replay_impl_20261015` (`payments_received_cents`, `invoices_posted`, `total_invoiced_cents`) in [`20261102180000_bind_money_replay_receipts_batch4a.sql`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261102180000_bind_money_replay_receipts_batch4a.sql).
- **Evidence (live):**
  - `payments` has 0 rows.
  - `allocation_sets` (entity_type 'payment') has 1 active set, dated 2026-07.
  - Only 3 functions still read `payments`: these two and the statement function. The statement also reads allocation_sets, so it is correct.
- **Smallest fix:**
  - Sum active `allocation_sets.total_payment_cents` by `payment_date` (keep the legacy table in a UNION, as the statement does).
  - Use `status IN ('posted','overdue','paid')` in the close summary.
- **Open PR:** none.

### 7. Monthly Summary's "AR balance" is always today's AR, whatever month you pick — LOW
- **What breaks:** Looking back at June shows today's receivables, not June's.
- **Severity:** LOW. It is a mislabel; the real as-of AR is on the AR Aging tab.
- **Area:** Reports.
- **Where:** `get_monthly_summary`, `ar_balance_cents` (no date filter).
- **Evidence:** Code read.
- **Smallest fix:** Rename it "Current AR (today)", or reuse `get_ar_aging(p_period_end)` totals.

### 8. Cancelled and voided invoices keep money amounts in the database — LOW
- **What breaks:** Nothing on screen today, because every report I read filters by status. An export, a new report or an ad-hoc query that forgets the status filter would count dead invoices.
- **Severity:** LOW (latent).
- **Area:** Invoicing.
- **Where:**
  - `_void_delivery_replay_impl_20261015` ([`20261107120000_void_delivery_respects_voided_and_cancelled_orders.sql`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261107120000_void_delivery_respects_voided_and_cancelled_orders.sql) L63) cancels the draft invoice without zeroing its total. Order void and order cancel do zero it.
  - Invoice void zeroes the header but leaves the lines.
- **Evidence (live):**
  - CS-2026-0179 is cancelled with its total and balance still set.
  - 4 voided invoices have lines summing to more than their $0 header: CS-2026-0058, CS-2026-0173, INV-2026-1522 and INV-2026-1528.
  - I checked the P&L, Monthly Summary, year-end, statements, aging, balance listing and reminders. All exclude these by status or by posted-as-of.
- **Smallest fix:** Zero `total_amount_cents` in the delivery-void cancel, to match order void.

### 9. Bill-split share rows on unposted invoices are not owner-checked — LOW
- **What breaks:** A rep could attach another payer's share to an unposted invoice that isn't theirs without the split screen. Posting and statements read those rows.
- **Severity:** LOW. Blocked once the invoice is posted; part of the known KI-03 gap (rep invoice scoping).
- **Area:** Roles and access.
- **Where / evidence / fix:** _Detail withheld from this public repo until the fix is live (AGENTS.md › Public security write-ups); full text in Mason's private copy._
- **Open PR:** #1576 covers unposting only.

### 10. Late-payment reminders and finance charges ignore money the customer already has on account — LOW
- **What breaks:** A customer holding an unused prepayment or credit memo can still get a past-due reminder or a finance charge on the full overdue amount.
- **Severity:** LOW. There is 0 overlap live today, and Mason may want it this way.
- **Area:** AR.
- **Where:**
  - `get_ar_reminder_candidates` ([`20261204100000_ki18_batch1_chicago_today.sql`](https://github.com/croprxsolutions/CRX_Manager_V1.0/blob/main/supabase/migrations/20261204100000_ki18_batch1_chicago_today.sql) L2043) returns the credit but doesn't subtract it. It also has no `deleted_at IS NULL` on the main invoice filter.
  - The finance charge generator sums `balance_cents` only.
- **Evidence:** Code read. Live: 0 overdue customers have a prepay balance.
- **Smallest fix:** Decide the policy first (see questions). Add `AND i.deleted_at IS NULL` either way.

### 11. The anon (signed-out) role still holds SELECT grants on about 95 tables — LOW (defence in depth)
- **What breaks:** Nothing today. Row security blocks every signed-out read. If any one policy is later loosened by mistake, customer, invoice, payment and audit data would become readable without logging in.
- **Severity:** LOW.
- **Area:** Roles and access.
- **Where / evidence:** _Detail withheld from this public repo until the fix is live (AGENTS.md › Public security write-ups); full text in Mason's private copy._ All public tables have RLS on and no signed-out read succeeds today.
- **Smallest fix:** One migration to `REVOKE SELECT ... FROM anon` on the tables the login page doesn't need.

---

## Checks that came back clean (live)
- **Invoice integrity:**
  - 0 invoice lines where extended ≠ round(qty × price).
  - 0 invoices whose stored balance ≠ total − paid − prepay − credit − write-off.
  - 0 negative balances, 0 invoices paid beyond their total, 0 posted $0 invoices, 0 "paid" invoices with a balance.
  - The one customer prepay balance (from the one overpayment) equals its prepay credit rows.
- **Payment application:**
  - `allocate_payment` refuses applying more than an invoice's balance, more than the payment, or to an invoice that isn't posted/overdue or belongs to another customer.
  - The rest of an overpayment becomes a prepay credit.
  - Voiding a payment (admin only) reverses invoice paid amounts and any use of that overpayment's credit.
- **Status rules:** The allowed transitions are sensible, including paid → posted on a payment void. Invoices are voided via the admin override.
- **AR aging and Customer Balance:** These rebuild "as of" a date using Chicago dates and the posting audit trail. Customers that can't be rebuilt are flagged (KI-95), not mis-stated. Cancelled invoices never count.
- **Time zones:**
  - Every date default (invoice, order, delivery, payment, reminder, commission payment dates) uses Chicago time.
  - Report date filters use stored business dates.
  - Remaining UTC uses: `mark_overdue_invoices` CURRENT_DATE (accepted under KI-18) and `created_at::date` fallbacks in Profitability and the financial dashboard. Those fallbacks never fire, because 0 orders have a null order date.
- **Month-close:**
  - Close refuses an unfinished month, a month with draft/unposted invoices, and an already-closed month.
  - It creates the period row when missing.
  - Payments, write-offs, finance charges and posting all check the period.
  - The functions that edit invoice money without a period check only touch draft or unposted invoices.
- **Table security:**
  - No table lacks RLS.
  - Invoices and invoice lines have no direct INSERT/UPDATE grant to signed-in users.
  - Prepay tables are SELECT-only for signed-in users.
  - The SECURITY DEFINER functions with no visible role check are wrappers or harmless helpers. `get_batch_year_end_summaries` is covered by its inner admin-or-rep check.

## Decision conflicts and recorded-decision notes
- **Sales Reports vs P&L:** Sales Reports and the dashboard count booked orders. The P&L and Monthly Summary count posted invoices (a small fraction of booked orders in 2026). This is **recorded intent**: the 2026-11-09 build sheet keeps sales on orders until "roadmap area 2". It isn't a bug, but the two will never agree while billing happens in Chem Man. Finding 1 is the part that is wrong.
- **Page Access vs KI-03:** The 2026-10-13 decision says reps see all invoices read-only. Page Access lets an admin hide Invoices from one rep, but the database still follows the global decision (Finding 2). There is no decision on which one wins.
- **Credit terms:** Mason's 2026-11-01 rule made tiers and credit limits admin-only. Payment terms and finance-charge settings aren't covered, which is a gap next to that decision (Finding 4).

## Plan-vs-built gaps
- **Month-close has never been used.** Period rows exist only for 2025-10 through 2026-06, all open. Months with no row count as open, so anyone with the right role can still post, pay or charge into any month back to October 2025.
- Finance charges are built but have never been run (0 rows), and the rate unit is undefined (Finding 3).
- `payments` (the legacy table) is dead, but three functions still read it (Finding 6).
- `_check_credit_limit` is dead code that signed-in users can still execute (noted earlier).

## Couldn't verify
- I couldn't call the report RPCs live, because they need a signed-in admin and I didn't impersonate one. The report numbers above come from SELECTs that copy each function's own filters.
- I didn't open the screens (UI labels and behaviour come from code), and I didn't check the cron schedule for `mark_overdue_invoices`.
- Whether the two 1.5 finance-charge rates are meant monthly or yearly.
- Whether Chem Man invoices are ever meant to flow into CRX revenue, which decides the real fix for Finding 1.

## Questions for Mason
1. Should the P&L subtract commissions only on sales billed in CRX, or should CRX revenue include sales billed in Chem Man?
2. Is Settings → Page Access meant to lock someone out of money and reports, or just tidy their menu?
3. Do the two customers at "1.5" mean 1.5% a month (18% a year) or 1.5% a year?
4. Should reps be able to change payment terms or turn off finance charges?
5. Should a customer's unused prepayment or credit be subtracted before reminders and finance charges?
6. Do you want to start closing months (2026-07 onward), so old months can't be changed?

## Open PRs checked
#1576, 1674, 1706, 1731, 1741, 1742, 1744, 1746, 1747, 1748. None fixes a finding here. #1576 is related to Finding 9 and KI-03.
