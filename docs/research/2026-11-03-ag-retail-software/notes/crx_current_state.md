# CRX Manager: current state map (for comparison with AgWorks / Agvance)

Date of read: 2026-11-03. Repo: `C:/CRX_Manager/.claude/worktrees/adoring-feynman-d9d31d` (branch based on `main` at `ed3876a03`). Read-only research; no live database access. No customer names, live dollar figures, phone numbers or emails are included.

Evidence key: [code] = confirmed in source/migration/schema registry; [doc] = stated in docs only (not independently confirmed in code). Whether a given migration is applied on the live database was NOT checked; where docs say "live" treat it as a doc claim.

Big picture [doc+code]: React 19 + TypeScript PWA (no native apps) on Vercel; Supabase (Postgres + RLS + RPCs + 8 Edge Functions: send-email, create-user, reset-user-password, customer-document-files, epa-lookup, process-document, process-blend-ticket, setup-blend-tickets-storage). Money and inventory rules live in database functions. About 1,029 migration files in `supabase/migrations/`. Roles: admin, sales_rep, driver, applicator (`src/appPages.tsx`). There is NO customer/grower login role. Sources: `docs/manual/start-here/Codebase-Map.md`, `docs/manual/ARCHITECTURE.md`, `src/appPages.tsx`.

Business context [doc]: in-house app for one ag-chem retailer/applicator; target is to replace the legacy system "Chem Man" for all billing from 2027-01-01; books stay in QuickBooks Desktop (`docs/plans/2026-10-13-direction-and-goals.md`, `docs/manual/DECISION_LOG.md` 2026-10-13/14). Season runs Oct 1 to Sep 30 (`docs/workflows/INVENTORY_RULES.md`). No sales tax is charged on anything (owner decision 2026-10-15, `DECISION_LOG.md`).

---

## 1. Quote -> order -> delivery -> invoice -> payment flow (plus blend ticket / job paths)

### What CRX does today
Primary chain (`docs/workflows/QUOTE_TO_DELIVERY.md`; pages `src/pages/Quotes.tsx`, `QuoteBuilder.tsx`, `Orders.tsx`, `OrderDetail.tsx`, `NewOrder.tsx`, `Deliveries.tsx`, `NewDelivery.tsx`, `DeliveryDetail.tsx`, `Invoices.tsx`, `InvoiceDetail.tsx`, `PaymentAllocation.tsx`):

- **Quote** (`quotes`, `quote_sections`, `quote_items`, `quote_versions`). Statuses [code: `.claude/schema-registry.json` status_enums]: draft, sent, revised, accepted, declined, expired, cancelled, closed_by_application, closed_short. A DB trigger `_enforce_quote_status_transition()` is authoritative. Sending writes a frozen `quote_versions` snapshot. `save_quote()` is an atomic save of header+sections+items with a row-version (optimistic concurrency) check. Customer pricing tiers 1-3 (`customers.assigned_tier`, `products.tier1/2/3_price`) with per-line override; per-line cost snapshot at quote time (admin-only cost/margin); below-cost lines need admin approval with a reason (`below_cost_approvals`); per-product margin floors (`product_margin_floors`). A "Last Charged" card shows the customer's previous price per product (`src/components/quotes/LastChargedPrices.tsx`). Quote templates and "Crop Programs" (stored as JSON in `app_settings`, `src/pages/CropPrograms.tsx`) pre-fill sections and rates. CSV import of quotes/orders (`src/lib/quoteOrderCsv.ts`, `orderImportCsvGroups.ts`, `components/quotes/BulkQuoteImport.tsx`). Quote PDF (`src/lib/quotePdf.ts`).
- **Sent-quote price lock** [code: migrations `20261027040000`, `20261029120000`, `20261101100000`; doc: QUOTE_TO_DELIVERY.md]: once sent, line prices stop following the catalog until a rep changes them; raising a sent price needs a "Grower agreed" tick; every change is logged in `quote_price_changes`. Convert / Partial Order / Schedule Job refuse (`QUOTE_RESEND_REQUIRED`) if a line is not at its sent price. See section 2 for bookings.
- **Order** (`orders`, `order_items`, `commissions`). Statuses: confirmed, partially_fulfilled, fulfilled, cancelled, voided. Created by `convert_quote_to_order()` (quote must be sent/revised/accepted; any rep can convert any booking; commission stays with the booking's rep), `draw_down_quote()` (partial order), `create_direct_order()`, rush order, bulk import, or `create_quick_delivery()`. Order lines track `quantity_delivered` / `quantity_remaining`. Order creation pre-books stock (`inventory.quantity_prebooked`, ledger type `booked`). Orders can be priced later ("ship now, price later": `orders.pricing_status` priced|needs_pricing, `order_items.pricing_pending`). Orders can be cancelled (`cancel_order`, releases pre-booked stock) or voided (`void_order`).
- **Delivery** (`deliveries`, `delivery_items`, `delivery_photos`, `delivery_remainders`). Statuses: scheduled, in_progress, completed, cancelled, voided. Two mandatory steps: `confirm_delivery()` (scheduled->in_progress, no stock check) then `complete_delivery()` (deducts inventory as `delivered`, updates order lines/status, creates remainders for partials). Items are editable only while scheduled; afterwards only logistics. Driver can attach up to 10 photos, report issues, capture a signature, or use a paper-ticket fallback with photo; with no signal the app refuses and changes nothing (offline queue for new completions was dropped, DECISION_LOG 2026-10-15; `src/lib/offlineQueue.ts` still exists for other uses). Follow-up deliveries from remainders (`DeliveryRemainders.tsx`, `create_followup_delivery`). Delivery receipt email/PDF (`src/lib/deliveryReceiptEmail.ts`, `deliveryPdf.ts`). A delivery cannot be voided/cancelled while its invoice is active: void the invoice first (DECISION_LOG 2026-10-29).
- **Invoice** (`invoices`, `invoice_items`; `invoice_type` chemical_sale | field_application | misc_charge | credit_memo; statuses draft, unposted, posted, paid, overdue, voided, cancelled). Posted invoices are locked; unpost is reversible for unpaid; `post_invoice`, `post_invoice_group` (atomic group), batch posting (`src/lib/invoiceBatchPosting.ts`). Product lines are billed only for delivered quantity (capped across all of an order's invoices; DECISION_LOG 2026-10-14). Standalone invoices (no order/delivery) carry charge lines only (freight, application fee, service, other), DB-enforced (`20261021050000`). Invoice PDFs, 3 layouts (`src/lib/invoicePdf.ts`); email via `send-email`. Money is integer cents; `balance_cents` is a generated column (registry `generated_columns`). Invoice items carry `cost_cents`, `epa_registration`, `product_form`, `warehouse`, `vendor`, `tote_number`.
- **Payment** (`payments`, `allocation_sets`, `invoice_line_allocations`): `/payments` (`PaymentAllocation.tsx`) -> `allocate_payment` RPC. Methods allowed: check, ach, cash, credit_card, wire, other (labels for money collected outside the app). Auto or manual allocation across invoices; any remainder becomes prepay credit (with a confirmation prompt). Idempotency keys on money RPCs.
- **Quick Delivery / counter sale**: `create_quick_delivery()` makes order + delivery + draft invoice atomically.
- **Parallel field-application branch** (no order): (a) `FieldApplicationInvoice.tsx` -> `save_field_app_invoice()`; (b) approved **blend ticket** -> `create_invoice_from_blend_ticket()`; (c) completed **job** -> `transfer_job_to_invoice()` (optional "auto-draft invoice on job completion" setting, default OFF: `src/lib/autoDraftSetting.ts`). DB check `invoices_field_application_has_no_order`.
- **Blend tickets in CRX** are scanned/entered applicator paper tickets read by OCR (`supabase/functions/process-blend-ticket`, `process-document`; `src/pages/BlendTickets.tsx`, `BlendTicketDetail.tsx`, `src/lib/blendTicketPricing.ts`). Statuses: pending/processing/completed/failed/needs_review; review_status unreviewed/approved/rejected; payment_status unbilled/billed/prepaid/no_charge; they link to orders and become invoices. They are a captured work record, not a pre-planned ticket that reserves product and flows to delivery.
- **Commissions** (`commissions`, `commission_payments`; `CommissionPayments.tsx`): created at order creation with percentage splits between recipients; paid in batches; job-level commissions exist.
- Navigation: sidebar group "Sell & Deliver" (`src/components/layout/Sidebar.tsx`).

### What's missing / gaps
- No single work-order / blend-ticket document created from a quote or order that reserves product, prints, then carries through delivery to invoice as one object. The chain is separate records; field work uses its own job -> invoice branch.
- Invoicing ahead of delivery is deliberately not allowed (advance money is prepay).
- The Order page "Bill Split" card saves percentages that no bill reads; split freeze at first delivery and splitting a partly delivered order are not built (TO_DO_LIST 4.2, 4.3 [doc]).
- No automatic credit when a delivery is voided; staff must void the invoice first (DECISION_LOG 2026-10-29).
- Counter-sale quick delivery is slow (many taps) and weak on sub-1-unit quantities (TO_DO_LIST 2.5 [doc]).
- New delivery completions need a signal (or paper-ticket workaround).
- No payment processor (see section 4). Sales tax not supported by design.

### Notes
- `QUOTE_TO_DELIVERY.md` is dense and current (cites migrations to 2026-11). The quote trigger is the authority for transitions.
- The pipeline is heavily guarded against double-submit (idempotency keys) and stale saves (row versions).

---

## 2. Prepays, deposits, customer credits; booked / price-locked product; early-order programs

### What CRX does today
- **Prepay credits** (`prepay_credits`: customer, season, original/balance cents, payment method, reference, `bucket_label`, `source_type`, optional `quote_id` and `allocation_set_id`; `prepay_applications`: credit -> invoice; `customers.prepay_balance_cents`). Created when a payment has no/partial invoice allocation, or entered directly. Page `src/pages/Prepay.tsx` with `components/prepay/PrepayWorkspacePanel.tsx` (buckets by check on the left, unpaid invoices on the right, fully manual allocation) and `PrepaymentManagerPanel.tsx`. Applied one invoice at a time with `apply_prepay_to_invoice`. Bulk auto-apply (`apply_remaining_prepayments`, `batch_apply_all_prepayments`) is disabled and raises `PREPAY_BULK_APPLY_DISABLED` (QUOTE_TO_DELIVERY.md; migration `20260620200000`).
- Policy: money paid before delivery is prepay, not an invoice for undelivered goods (DECISION_LOG 2026-10-14).
- **Booked / price-locked product ("bookings")** [code+doc]: a quote with `is_planned` = true reserves stock through `inventory_holds` (hold_type crop_program) while draft/sent/revised; released on accept/convert/decline/expire/cancel/close. A sent quote's prices are locked (Mason 2026-10-13). A booking is a sent quote drawn down in pieces: `draw_down_quote()` (Partial Order) creates orders at the booked price while tracking `quote_product_draws`; over-draw beyond the booked quantity is allowed only with `extra_price` today|booked (written as a separate ordinary order); `closed_short` closes an under-drawn booking; `closed_by_application` closes a planned quote fulfilled by spray jobs. Season-end rollover view `get_open_booking_rollover` (`Quotes.tsx`); expiry defaults to Sept 30 of the season, and a part-drawn booking past its date alerts its rep (`20261029100000`). Any rep may draw down, convert, and (since `20261104130000`) change prices on another rep's booking.
- **Program Tracker** (`src/pages/ProgramTracker.tsx`, `get_program_completion`): per-season view of how much of each customer's quoted program has been invoiced.
- **Crop Programs** (`CropPrograms.tsx`): reusable product + rate templates for quoting; not a pricing or rebate program.
- **Customer credits**: credit memos are `invoices` of type `credit_memo`, applied to invoice balances through `credit_memo_applications` (ledgered, reversible). Write-offs in `write_offs`.
- **Early-pay discount**: a recorded/printed figure only. `invoices.discount_earned_cents` + `discount_date` are owner-entered and shown on the Customer Invoice Summary PDF; the migration comment says it does not reduce the balance (`supabase/migrations/20260625150000_invoice_header_footer_discount.sql`; `src/components/field-invoices/CustomerInvoiceSummaryPanel.tsx`).

### What's missing
- **Prepay is not tied to specific product, quantity or price.** The "earmark engine" (prepay reserved against booked product) was built then SHELVED on 2026-06-14 over a double-spend risk; a reserved-pool redesign has not been done (DECISION_LOG 2026-06-14; CURRENT_STATE.md section 4; `docs/roadmap/shelved-earmark-engine/`). `quote_id` and `bucket_label` columns exist but no live reserved-pool billing.
- **No early-order / seasonal price lists.** "Early Bird" named/seasonal price lists were parked by the owner on 2026-10-14 (TO_DO_LIST 0.11). Price is tier (1-3) plus per-line override only.
- No volume/loyalty discount engine; no automatic early-pay discount calculation or application to invoices; no deposit-for-locked-price object beyond the quote price lock itself.
- Prepay balance integrity check (customer balance equals the sum of credits) is not built (TO_DO_LIST 6.8 [doc]).
- Refunds paid outside CRX cannot yet be recorded so credit cannot be double-spent (TO_DO_LIST 6.4 [doc]).

### Notes
- CRX "bookings" are priced, stock-reserving, partially drawable quotes: the nearest analogue to an Agvance/AgWorks contract or booked order. There is no commodity-style contract object and no deposit attached to it.

---

## 3. Split billing (landlord/tenant, percentage splits)

### What CRX does today
Three mechanisms exist [code+doc]:
1. **Order/delivery splits by field/acre**: on the Order page, per-line field/acre allocations (`order_item_field_allocations`, `order_shares`); fields have owner splits in `field_billing_defaults` (split_pct, optional `price_override_cents` per owner); `create_split_invoices_from_order` / `create_split_invoices_by_acre` create one invoice per payer. Billing a landlord (a customer who is not the order's customer) is supported from migration `20261021150000`, with a split-aware return/credit path in `20261021155000` (PR #1010; DECISION_LOG 2026-10-13 and 2026-10-21; TO_DO_LIST 4.1, 4.4). Per-delivery split billing exists (`src/lib/deliverySplitBilling.ts`, migration `20260707070000`).
2. **Field-application split invoices**: `save_field_app_invoice()` produces one invoice per customer sharing the selected fields, linked by `invoice_group_id`; `field_app_location_shares` hold the true per-customer split; Mode A (grower-share $/ac override, all-inclusive) vs Mode B (line-item pricing plus application fee). Atomic `post_invoice_group` and `void_invoice_group`; preview RPC `preview_field_app_invoice_split`. Each child invoice has its own AR, statement and finance charges.
3. **Per-line split editor** (`/split-billing/new`, `FieldAppSplitInvoiceEditor.tsx`; tables `field_app_billing_sets`, `field_app_billing_lines`, `invoice_line_shares`): per-line who-pays-what custom splits on field-app invoices. FLAG-GATED and shipped OFF (`app_settings.per_line_split_billing_enabled`, `src/lib/splitBillingSetting.ts`); the nav link is hidden while off.
- Commission splits across salespeople are a separate feature (percentage splits on quote/order/job; only admins change them).

### What's missing
- The Order-page "Bill Split" card saves percentages that no bill reads (TO_DO_LIST 4.2 [doc]); freezing the money at first delivery (last delivery bills the remainder) and splitting an already partly delivered order are not built (4.1, 4.3).
- Splitting a field-application invoice via the per-line editor is parked/flagged off (4.5, parked 2026-10-15).
- No office notification when a delivery auto-creates split drafts (4.6).
- Open owner question: a split can bill any customer named in editable allocations (KNOWN_ISSUES, scope undecided).
- No crop-share / landlord-percentage-of-inputs accounting beyond splitting invoices.

### Notes
- Landlord/tenant is modelled through field ownership (`field_billing_defaults`) and customer-to-field links, not a generic "bill-to party" object.

---

## 4. Invoicing, credit memos, returns, voids; AR, statements, aging, finance charges; payments

### What CRX does today
- **Invoices/voids**: see section 1. `void_invoice` (UI `InvoiceDetail.tsx`, batch `components/invoices/BatchVoidModal.tsx`) records `void_reason`; voiding reverses AR; posted/paid invoices are credited rather than cancelled (owner decision 2026-10-15 [doc]). Immutable `financial_audit_log`. Write-offs: `components/invoices/WriteOffModal.tsx`, table `write_offs` (reversible). Period locking: `accounting_periods` (open|closed), `close_accounting_period` / `reopen_accounting_period`; Month-End Close page (`MonthEndClose.tsx`) has a checklist, batch statement generation, an optional finance-charge step, and an unbilled rush-order check.
- **Returns** (`src/pages/Returns.tsx`; tables `returns`, `return_items`): statuses requested -> approved -> received -> credited (plus rejected/cancelled); reasons defective, damaged, wrong_product, overstock, expired, other; per-line restock flag, condition and `restocked_quantity`; restocked stock returns to Main Warehouse at the "received" step (ledger type `returned`); the credit is a `credit_memo` invoice via `issue_return_credit` (split-aware since `20261021155000`). Return credits carry COGS (`invoice_items.return_credit_cogs_cents`, `return_credit_source_item_id`). Products carry `return_policy` (returnable | no_return | not_applicable | unknown); receiving records carry `is_non_returnable`.
- **AR**: derived only from `invoices.balance_cents` (orders have no balance). Pages: `AccountsReceivable.tsx` (A/R Workspace), `ARaging.tsx` (aging buckets, statements, reminders via `ar_reminder_tracking`), `PaymentHistory.tsx`, `CustomerTransactionReview.tsx`, `FinancialDashboard.tsx`. Aging uses the Chicago business date (PRs #991/#996/#998 [doc]).
- **Statements**: `src/lib/customerStatement.ts`, `statementPdf.ts`, `statementEmail.ts`, `components/statements/StatementPrintDialog.tsx`; summary or detailed; batch generation at month end; email via `send-email`. Year-end summary (`yearEndSummaryPdf.ts`); Customer Invoice Summary PDF (`invoiceSummaryPdf.ts`).
- **Finance charges** [code: body of `generate_finance_charges` in migration `20260721145936_require_money_lifecycle_idempotency_keys.sql`]: per-customer opt-in rate (`customers.finance_charge_rate`, `finance_charge_enabled`, `finance_charge_grace_days`); charge = overdue balance x (annual rate % / 12), one per customer per month, minimum balance from setting `finance_charge_min_balance_cents` (default 500 cents); preview-then-select modal (`components/invoices/FinanceChargePreviewModal.tsx`, `preview_finance_charges`) launched from AR Aging; creates a charge invoice and `finance_charges` rows; admin only. Flat monthly rate, no compounding, no tiers.
- **Credit limit**: `customers.credit_limit_cents`; `check_customer_credit_limit` gives a warning toast only on order/job/invoice flows (`src/lib/creditLimit.ts`: "Non-blocking").
- **Payments**: see sections 1-2; payment date follows the Chicago date. Customer payment terms are free text (`customers.payment_terms`) plus the invoice due date; field-invoice transfer defaults to Net 30 (KNOWN_ISSUES KI-14).
- **AP side**: `AccountsPayable.tsx`, `VendorBills.tsx`, `NewVendorBill.tsx`, `VendorBillDetail.tsx`; tables `vendor_bills`, `vendor_payments`. Bills can link to a PO (with an overage check); statuses unpaid, partially_paid, paid, voided. Admin only.

### What's missing
- **No online/card/ACH payment processing**: Stripe not started and may not accept restricted-use pesticide sales (`docs/plans/2026-10-21-goal7-quickbooks-stripe-groundwork.md`; TO_DO_LIST 14.4). Payment "methods" are labels for money collected outside the app. No bank import; bank reconciliation is explicitly "not doing" (TO_DO_LIST).
- No compounding/daily-balance/tiered finance-charge methods; TO_DO_LIST 3.10 lists grace-day and Chicago-time handling as open (verify before relying).
- No scheduled statement runs, autopay, or ACH-return/chargeback handling.
- Refund paid outside CRX not recordable (6.4); commission carry-forward deduction on returns not built (8.3); "returns sitting at farm" pickup tracking not built (7.2); returns on legacy-billed deliveries are not blocked (7.3).
- No sales tax, tax-exempt certificates, or tax reporting (no sales tax by decision).
- Credit limit is advisory; no credit hold/block.
- Vendor AP is basic; 1099s, bank reconciliation and automatic bill reading are explicitly "not doing".

### Notes
- Cost and margin are admin-only across the app (RLS + column grants; DECISION_LOG 2026-10-15, 2026-10-28).
- The `credit_memo` invoice type lets returns and credits flow through ordinary AR; applying credit to invoices is a manual per-invoice step.

---

## 5. Revenue / COGS / inventory posting; GL or accounting export (QuickBooks etc.)

### What CRX does today
- Revenue = posted invoices. COGS: cost is snapshotted onto lines at sale time (`order_items.cost_at_time_cents`, `invoice_items.cost_cents`; return credits carry their own COGS). Profitability reports use cost at sale (`get_profitability_report`; TO_DO_LIST 0.6; `SalesReports.tsx`, `Reports.tsx` Gross Sales with Revenue / COGS / Gross Profit; Profitability by customer and by product). Product cost is a manually selected "pricing basis" (`products.current_cost`, `product_cost_basis` history, `cost_history`, supplier price observations/imports, PO line cost with provenance, `costFreshness.ts` stale-cost report). Month-end close locks periods.
- Reports and exports: Reports Library (`Reports.tsx`) with CSV/PDF export (`csvExport.ts`, `reportPdf.ts`) covering sales, profitability, commissions, customer balances, stale costs and others; `FinancialDashboard.tsx` (admin).
- A one-way QuickBooks Desktop sync (invoices, payments, credits) is only a plan: `docs/plans/2026-10-21-goal7-quickbooks-stripe-groundwork.md` (suggests a paid connector; notes QBD's 11-character invoice-number limit) and Goal 7 in `docs/plans/2026-10-13-direction-and-goals.md`; checkpoints 2026-11-15 and 2026-12-15 [doc].

### What's missing (confirmed absent)
- **No general ledger, chart of accounts, journal entries, or accounting export/sync.** A search of `src/`, `supabase/functions/` and `supabase/migrations/` for quickbooks/stripe returns nothing [code, 2026-11-03]. Books stay in QuickBooks Desktop (decision 2026-10-13). Contingency (a transaction-level report and hand entry) is also not built (TO_DO_LIST 14.3).
- **No inventory valuation or average cost**: `inventory`, `inventory_transactions` and `receiving_records` have no cost columns (registry). `docs/plans/2026-07-16-inventory-costing-plan.md` is PARKED, never built. So no FIFO/average-cost COGS, no inventory-value-on-hand report, no automatic inventory-asset/COGS postings. COGS uses the selected product cost at time of sale, not a lot cost.
- No GL account mapping for prepay, write-offs, discounts, rebates, freight, vendor bills or commissions (accountant decisions pending, TO_DO_LIST 14.1).
- No sales tax accounting.

### Notes
- This is the largest structural difference from AgWorks/Agvance, which are integrated accounting suites (GL/AR/AP/inventory costing). CRX is an operations + AR layer and is explicitly not the general-ledger system of record.

---

## 6. Inventory: locations, lots, units, blends/recipes, transfers, POs/receiving, vendor returns, negatives, counts

### What CRX does today
(`docs/workflows/INVENTORY_RULES.md`; `src/pages/InventoryPage.tsx`, `PurchaseOrders.tsx`, `PurchaseOrderDetail.tsx`, `NewPurchaseOrder.tsx`, `Receiving.tsx`, `CycleCounts.tsx`, `BlendRecipes.tsx`, `LotTrace.tsx`, `ToShip.tsx`)
- **Stock model**: one `inventory` row per product per `location` text (quantity_available, quantity_prebooked, quantity_on_order, reorder_point, min_stock_level). `inventory_transactions` ledger with 12 types: received, booked, delivered, returned, adjusted, transferred, job_applied, prebooked, released, prebook_reconciliation, cancelled_delivery_reversal, void_delivery_reversal [code: registry check constraint]. Net Position = available - prebooked + on_order, from one RPC `get_inventory_position()`; low-stock alert; forecast tab (`get_inventory_forecast`); To-Ship board shows product owed to customers vs supply; reorder list grouped by vendor.
- **Locations**: a `warehouses` table exists but the system is effectively single-location. Receiving and manual add refuse any location but Main Warehouse (`UNKNOWN_STORAGE_LOCATION`); all inventory rows were at that one warehouse on 2026-11-02 [doc: KNOWN_ISSUES KI-85]. Add-warehouse admin, transfers and per-location alerts are deferred until a second warehouse opens.
- **Transfers**: ledger type `transferred` is allowed but NO code writes it; there is no transfer function (INVENTORY_RULES.md).
- **Lots**: lot number captured at receiving (`receiving_records.lot_number`, `storage_location`, condition good/damaged/short/wrong_product/mixed, photos) and linked to application records (`application_record_lots`, `source_receiving_record_id`). Lot Trace page (`/lot-trace`, `get_lot_application_trace`) lists every application that used a lot (recall lookup). Stock itself is NOT tracked per lot.
- **Units**: `unit_conversions` (unit, factor_oz, liquid|dry|both) is a frozen-key table; `product_form` liquid|dry|seed|each, `product_form_units`, `container_type` (Jug, Drum, Pallet, Mini-Bulk, Shuttle, Bag, Tote, Ea, Jar), `inventory_unit`/`container_unit`, per-acre rate units; `src/lib/units.ts`, `chemCalculator.ts`, `blendMathValidator.ts`. Weight-per-gallon and active-ingredient parent records are planned, not built (TO_DO_LIST 2.9).
- **Blends/mixes as recipes**: `blend_recipes` + `blend_recipe_items` (product, quantity or rate per acre, price per unit) are reusable spray-mix recipes (`/recipes`); jobs reference `recipe_id`; job loader worksheets (`job_loader_worksheets`, `LoaderWorksheetsPanel`, `loaderWorksheetPdf.ts`), master mix summary PDF (`masterMixSummaryPdf.ts`), carrier rate (gal/ac) and tank capacity on jobs; a `max_label_rate` guardrail. Inventory is deducted per component product at application (`job_applied`). There is no manufactured/blended finished-good SKU and no production-run BOM.
- **Holds/reservations**: manual holds (`create_inventory_hold`, admin override with reason), quote (planned) holds, job holds; a daily integrity sweep flags stale holds.
- **Purchase orders and receiving**: PO statuses draft, submitted, partially_received, fully_received, cancelled; line cost with provenance; PO PDF (`purchaseOrderPdf.ts`); bulk PO import (`BulkPOImport.tsx`); preferred-vendor suggestion per product; `receive_po_items`; Quick Receive; receiving log; `reverse_receiving_record`; receiving PDF. Email of POs to vendors is incomplete (copy only goes to the owner, who orders through supplier portals) [doc: TO_DO_LIST 0.15].
- **Negative inventory**: warn-not-block everywhere (owner decision 2026-07-06, reaffirmed 2026-10-15 6b): `complete_delivery` and `create_quick_delivery` proceed on insufficient stock, allow negatives, flag the ledger row (`requires_review`), and notify admins; receipt reversals may drive stock negative on purpose; auto-created zero rows are flagged `manufactured_at_delivery`.
- **Counts**: `CycleCounts.tsx` (admin): sessions (in_progress|completed|cancelled), expected vs counted, variance posts an `adjusted` ledger row; `components/inventory/BatchAdjustModal.tsx` and `manual_inventory_add` for adjustments; `TransactionLedgerModal` shows the ledger.
- **Integrity**: `Integrity.tsx` and daily `run_data_integrity_sweep()` check stale holds, prebooked vs open orders, and ledger vs stock.

### What's missing
- True multi-location inventory and inter-location transfers; per-lot / per-tote on-hand and per-lot costing; expiry / shelf-life tracking.
- **Vendor returns (returns to vendor, vendor credit memos): no table, screen or RPC.** The `returns` feature is customer returns only (registry table list [code]). Return-batch handling and a return-policy screen are in the "grand plan" only.
- Inventory valuation / average cost (parked); landed cost and freight allocation.
- Manufactured/blended finished goods with BOM consumption, bulk tank/bin inventory, scale/ticket integration, dry-blend production.
- Returnable container / tote deposit tracking (only a `tote_number` text field on invoice lines).
- Automatic reorder / min-max PO generation (a "Need Reordering" list by vendor exists; POs are created manually).

### Notes
- Stock numbers are only as good as the counts; inventory readiness is an owner business task (TO_DO_LIST 15.2 [doc]).

---

## 7. Vendor rebates / programs; vendors

### What CRX does today
- **Vendors**: `vendors` table (name, contact, default payment terms/days, soft-delete); admin `Vendors.tsx` with `save_vendor`, `delete_vendor`, `reactivate_vendor`; vendor alias and legacy-vendor resolution review tables; preferred vendor per product with vendor text following it (commit 7e68ba9d5); `product_supplier_links`. Supplier pricing: `SupplierPricing.tsx` + `supplier_price_imports` / `supplier_price_observations` (upload supplier price sheets, compare, approve cost changes; admin). AP: vendor bills and payments (section 4).
- **Rebates** (`src/pages/Rebates.tsx`, admin): manufacturer `rebate_programs` (type per_unit | percentage | volume_tier | flat; min/max volume; dates; status active/expired/closed; product link) and `rebate_claims` (against orders/customers/products; statuses pending, submitted, approved, paid, rejected; claim amount, paid amount, manufacturer reference). `create_rebate_claim`. Rebate programs are office-only (DECISION_LOG 2026-10-28).

### What's missing
- No automatic rebate accrual from sales or purchases, tier tracking or true-up; claims are created manually per order. No grower-facing rebates or loyalty programs. Rebates and freight are not included in product cost or margin.
- No vendor scorecards, vendor price contracts, EDI / electronic PO or catalog feeds, or vendor portal.

### Notes
- Manufacturer programs (e.g. early-order or growth rebates) are tracked only as claim records, not computed.

---

## 8. Custom application / applicator work orders, field records, acres

### What CRX does today
- **Jobs (applicator work orders)**: `Jobs.tsx`, `JobDetail.tsx` (`/jobs`, `/jobs/:id`); table `jobs` (job_number, customer, status scheduled | in_progress | completed | cancelled | invoiced, priority, applicator, vehicle, recipe, total / applied / remaining acres, season, quote link, application service, ground crew, tags, batch), `job_chemicals`, `job_fields` / `job_field_shares`, attachments, notifications, tags/batches, mass edit, print options (applicator sheet PDF, WPS notice PDF, loader worksheets). Jobs can be created from a quote section (`create_job_from_quote_section`), which reserves stock (job holds). Completing a job deducts chemicals (`job_applied`). Two applicators per job and ground crews are supported (`ground_crews`, DECISION_LOG 2026-10-22).
- **Dispatch and scheduling**: `DispatchBoard.tsx` (dark tablet UI, map and list, dispatch jobs per field location via `job_location_dispatches`, assign to applicator, reschedule notifications); "Job Schedule" list; `TeamBoard.tsx` notes board.
- **Applicator mobile**: `FieldView.tsx` ("My Day": only their dispatched jobs, Start/Complete), `FieldRoute.tsx` / `FieldStop.tsx` (`/my-route`, driver/applicator route workspace). Weather capture on records (`fieldAppWeather.ts`: wind, temperature, humidity at start and end).
- **Fields and acres**: `Fields.tsx` (Mapbox maps), `FieldSetup.tsx`, `FieldDashboard.tsx`, `FieldProfitability.tsx` (admin). `fields` has measured acres, override acres (two-acre model), legal description, FSA farm/tract/field numbers, crop, soil, irrigation, boundary polygon, obstacles (`field_obstacles`), crop history (`field_crop_history`), parent/child fields; shapefile import; USDA CSB click-to-adopt (`csbLookup.ts`, `csbAdopt.ts`); field import with customer matching (`fieldImportParser.ts`, `fieldImportCustomers.ts`).
- **Application records ("Record Book")**: `ApplicationRecords.tsx`; tables `application_records`, `application_record_fields`, `job_applied_records`, `job_applied_record_fields`, `job_applied_record_crew`; capture applicator name and license number, product data, EPA numbers, lot numbers, acres, volume, weather, tach (net tach generated), vehicle. Reports: `chemicalApplicationReportPdf.ts`, `chemicalSummaryReportPdf.ts`, `components/reports/LogbookReport.tsx`.
- **Application services and pricing**: `ApplicationServices.tsx` (default per-acre fees), per-customer application rates (`customer_application_rates`), fuel surcharge setting; `Vehicles.tsx` / `VehicleDetail.tsx` fleet records.
- Field-application invoices from direct entry, blend ticket, or job (section 1); Field Invoices page tabs (drafts, posted, unbilled, customer summary).

### What's missing
- No GPS-track / as-applied machine data import, rate-controller integration, prescription (variable-rate) maps, scouting, soil/grid sampling, agronomic recommendations, or yield data.
- REI/PHI values exist on products and job chemicals (`rei_hours`, `phi_days` [code]) but enforcement/tracking and the dicamba 72-hour rule are not built and flagged "MUST before spring application season" (TO_DO_LIST "folded in" list [doc]).
- No route optimization; dispatch lanes, job templates and a weather strip are listed as later.
- Discrepancy: the "not doing" list says profit per field is removed, yet `FieldProfitability.tsx` is routed in `src/appPages.tsx`; verify before relying.
- Auto-draft invoice on job completion exists but is OFF; policy is the owner's decision (KNOWN_ISSUES).

### Notes
- Applicator work is a first-class module with its own invoice path; quoting, jobs and invoicing link via `quote_id` / `quote_section_id` and the `closed_by_application` quote status.

---

## 9. Compliance: RUP records, applicator licenses, EPA lookups

### What CRX does today
- **Licenses and RUP Register** (`Compliance.tsx`; tabs licenses, RUP products, RUP sales, field listing; page roles admin + sales rep, RUP register admin-only since migration `20261014220000`): `applicator_licenses` per customer/profile (number, type private|commercial|public, state, issue and expiry dates, certification categories); `getLicenseStatus` expiry logic (`src/lib/licenseStatus.ts`); expiring-licenses card (`components/compliance/ExpiringLicensesCard.tsx`); `rup_sales_records` (invoice, product, EPA registration, quantity, buyer name / certification number / type / expiry, signal word, compliance_status compliant|warning|non_compliant, voidable) generated at invoice posting by `generate_rup_sales_records`.
- **RUP checks at sale**: `checkRUPCompliance` (`src/lib/rupCompliance.ts`) warns on New Order, Quote Builder and delivery screens when a customer without a valid license buys RUP products; the invoice post path refuses to proceed if the check itself failed to run; otherwise it WARNS and does not block.
- **EPA label lookup**: Edge Function `epa-lookup` (calls EPA's public pesticide label service with an allow-listed host, rate limiting and a 15-minute cache) used from the Product page "Look up EPA" (`src/lib/epaLookupClient.ts`); `LabelDataQuality.tsx` bulk check/fix of EPA registration numbers; `LabelReview.tsx`; product label drafts from scanned labels (`product_label_drafts`, `product_info_change_set_rows`); products store EPA registration, signal word, `is_rup`, REI hours, PHI days, max label rate; a label-rate guardrail setting warns when a job rate exceeds the label max.
- **Traceability / recall**: Lot Trace (section 6); application records keep lot, EPA and license number; WPS notice PDF; Watchdog flags (`WatchdogExceptions.tsx`) for anomalies; Offline Work Review for queued field actions.

### What's missing
- No state e-reporting export for RUP sales or regulator formats; the register is view/print only [code: no export function found on the compliance page].
- No REI/PHI enforcement or timers, no dicamba / endangered-species lookup, no buffer-zone compliance beyond the field-obstacle layer; OCR of REI/PHI from label images is deferred as a safety trap (CURRENT_STATE.md section 4).
- No SDS library / printing, transport (DOT) documents, or state-specific fertilizer/commodity regulatory reporting found.
- The RUP warning does not block a sale.

### Notes
- Compliance data lives in application records plus the RUP register; the owner has assigned himself compliance readiness (business tasks L1-L3, DECISION_LOG 2026-10-14).

---

## 10. Grower-facing portal; mobile/field use; dispatch/scheduling

### What CRX does today
- **Grower portal: none.** CURRENT_STATE.md section 4 lists it as deferred; DECISION_LOG "~2026-06-28 Internal-only product direction: no grower portal yet"; a brainstorm exists at `docs/plans/2026-06-10-grower-portal-brainstorm.md`. There is no customer role in `UserRole`; every route is staff-only.
- Customer-facing outputs are emails and PDFs only: quotes, invoices, statements, delivery receipts, PO copies (`send-email` Edge Function; `src/lib/emailService.ts`, `deliveryReceiptEmail.ts`, `statementEmail.ts`); staff-side customer documents upload/download (`customer-document-files`); customer notice/reminder settings.
- **Mobile**: installable PWA (service worker; phone bottom nav `components/layout/MobileBottomNav.tsx`; phone card layouts; full-screen modals); role-specific navigation (applicator: My Day, My Jobs, Record Book; driver: My Route, Deliveries; `Sidebar.tsx`). Offline: IndexedDB queue for pending field actions (`offlineQueue.ts`, `offlineReceipts.ts`, `offlineSync.ts`, table `offline_action_receipts`) with an Offline Work Review screen; new delivery completions still require signal (section 1).
- **Dispatch/scheduling**: section 8.

### What's missing
- Grower portal (view quotes/orders/invoices/statements/balance, approve quotes, pay online, upload documents, see application records); e-signature on quotes; SMS notifications (no SMS code found in files read; email only).
- Native apps (explicitly not building); full offline proof of delivery (dropped).
- Live driver GPS tracking, customer ETA notices, automated route optimization.

### Notes
- Everything customer-facing runs through staff. The "Today" cockpit and To-Ship board are office tools.

---

## 11. Main screens and navigation

Source of truth: `src/appPages.tsx` (route list, role gates, Settings permission categories) and `src/components/layout/Sidebar.tsx` (sidebar by role). Roles: A admin, R sales rep, D driver, P applicator.

**Top level**: Today (`/office-cockpit`, morning queues, KPIs, inventory, delivered-not-invoiced; A,R). To-Ship Load-Out Board (`/to-ship`, product owed vs supply; A,R).

**Sell & Deliver**
- Quotes & Bookings (`/quotes`, `/quotes/new`, `/quotes/:id`; A,R): quote list, builder, bookings, rollover.
- Orders (`/orders`, `/orders/new`, `/orders/:id`; A,R): list/detail, pick list, split-by-field editor, invoice creation.
- Deliveries (`/deliveries`, `/new`, `/:id`; A,R,D): list with shortage badge, driver view, quick delivery, completion.
- My Route (`/my-route`, `/my-route/:id`; A,R,D): driver stop list and stop workflow.
- Remainders (`/delivery-remainders`; A,R): pending partial-delivery leftovers, follow-up deliveries.
- Invoices - Chemical (`/invoices`, `/invoices/:id`; A,R): list, batch print/void, post/unpost.
- Returns (`/returns`; A,R).

**Spray Fields**
- Job Schedule (`/jobs`, `/jobs/:id`; A,R,P); Dispatch Board (`/dispatch`; A,R,P); Field Invoices (`/field-invoices`, tabs drafts/posted/unbilled/customer summary; also `/invoices/field-app/new|:id`; A,R); Split Billing per line (`/split-billing/*`; flag-gated, off); Record Book (`/application-records`; A,R,P); Program Tracker (`/program-tracker`; A,R); Blend Recipes (`/recipes`; A,R); Field View phone (`/field`; A,R,P).

**Customers & Fields**: Customers (`/customers`, detail with contacts, addresses, documents, interactions, aging, finance-charge settings; A,R); Call Lists (A,R); Fields & Maps (`/fields`, field setup, field dashboard; A,R); Crop Programs (A,R).

**Inventory & Buying**: Inventory (positions, holds, forecast; A,R); Products & Pricing (`/products`, product detail, EPA/label data, price workbook; A,R; cost is admin-only); Supplier Pricing (A); Brand vs Generic (A,R); Purchase Orders (list/new/detail; A,R); Receiving (hub / quick / log tabs; A,R); Cycle Counts (A).

**Money (mostly admin)**: Record Payments (`/payments`; A,R); A/R Workspace; A/R Aging; Prepay; Customer Transactions; A/P & Vendor Bills; Commissions; Rebates; Month-End Close; Data Integrity; Payment History (all A).

**Compliance & Records**: Licenses & RUP Register (A,R; RUP tab admin-only); Lot Trace (A,R); Watchdog Flags (A,R); Offline Work Review (A,R); Label Review and Label Data Quality (A); Blend Tickets OCR (A,R).

**Insights**: Overview KPI dashboard (A,R); Reports Library (A,R); Sales Reports (A,R); Financial Dashboard (A); Field Profitability (A).

**Setup & Admin (admin)**: Vehicles; Application Services (fees); Vendors; Getting Started (help; all roles); Settings (users and roles, billing options such as fuel surcharge and auto invoice drafts, reminders and quote defaults, field-job guardrails, applicator sheet, customer notices, company details printed on PDFs). Team Board and Notifications are open to all roles.

The command palette and the Settings page-permission screen are derived from the same page list (`lib/pagePermissions.ts`), so an admin can deny individual pages per user.

---

## Cross-cutting findings for the comparison report

1. Strengths: tight quote -> order -> delivery -> invoice -> payment chain with database-enforced rules; price-locked bookings with draw-downs; landlord split invoicing (order and field-app); full applicator job / record / dispatch / map module with lot traceability; strict money safety (integer cents, idempotency keys, audit log); admin-only cost visibility.
2. Biggest gaps vs full ag-retail suites (AgWorks / Agvance style): no GL / accounting; no inventory costing or valuation; single warehouse and no transfers; no vendor returns; no lot-level inventory; no sales tax; no grower portal; no card/ACH payments; no prepay-to-product reservation (earmark shelved); no early-order price lists (parked); no automatic rebate accrual; no REI/PHI enforcement or state e-reporting; no precision-ag / agronomy integrations; no bulk fertilizer blend production.
3. Direction [doc]: CRX is internal-only and designed to replace the legacy billing system by 2027-01-01, with books remaining in QuickBooks Desktop; QuickBooks sync and Stripe are planned (Goal 7) but nothing exists in code.
4. Doc/code discrepancies noticed: (a) the "not doing" list drops profit-per-field but `FieldProfitability.tsx` is routed; (b) `per_line_split_billing_enabled` is OFF so the per-line split editor is hidden by default; (c) "live" statuses rely on docs; migrations were not checked against the live ledger.
5. Not verified here: live migration status for any specific migration; real-world feature usage; whether SMS exists (not found); the complete list of Reports Library reports (only CSV column definitions skimmed).

## Key sources read
`docs/manual/start-here/Home.md`, `Codebase-Map.md`; `docs/manual/ARCHITECTURE.md` (head); `docs/workflows/QUOTE_TO_DELIVERY.md`, `INVENTORY_RULES.md`; `docs/manual/CURRENT_STATE.md` (sections 3-5); `docs/manual/TO_DO_LIST.md` (sections 0, 2-4, 6-8, 14, 17); `docs/manual/KNOWN_ISSUES.md` and `DECISION_LOG.md` (targeted searches); `docs/plans/2026-10-21-goal7-quickbooks-stripe-groundwork.md`, `2026-10-13-direction-and-goals.md`, `2026-07-16-inventory-costing-plan.md`; `.claude/schema-registry.json`; `src/appPages.tsx`; `src/components/layout/Sidebar.tsx`; page headers under `src/pages/`; `src/lib/{creditLimit,rupCompliance,splitBillingSetting,autoDraftSetting,units,offlineQueue}.ts`; migrations `20260721145936_require_money_lifecycle_idempotency_keys.sql` and `20260625150000_invoice_header_footer_discount.sql`.
