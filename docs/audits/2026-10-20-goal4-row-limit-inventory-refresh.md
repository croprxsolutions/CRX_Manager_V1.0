# Goal 4, step 1 refreshed: what still stops at a row limit (2026-10-20)

This refreshes `docs/audits/2026-10-15-goal4-row-limit-inventory.md` after Goal 4 part 1 (PRs #959, #970, #981). It keeps that audit's IDs (H = money or integrity/compliance, M = a missing record, L = low or by design), marks each one fixed or still open on `origin/main` at `875a36fe4`, and adds the places the first audit missed (N1–N13). The original audit is still the reference for each item's description; this page gives the current status and line numbers. Read-only: nothing was changed, and the live database was only read (SELECT).

## Summary for Mason

**Where things stand.** Part 1 fixed the main list pages, Reports and Sales Reports. Every place below still reads at most a set number of records, and at most 1,000 when no number is given, because the server stops every reply there. None of them warns on screen except where noted.

1. **18 of the 40 high-risk items are fixed, 22 are still open.** The open ones are:
   - **Field Invoices (H5–H7).** Its three panels still stop at 1,000, and "Post all" / "Unpost all" act only on the invoices loaded.
   - **AR, AP and prepay (H15, H16, H19, H20, H23, H24, H37, H38, H43, and new N1).** These include the AR aging totals, the finance-charge run (customers past the limit would never be charged), check allocation (only a customer's first 200 open invoices can be paid against), and the aging card on a customer's own page.
   - **Integrity checks (H25–H30) and compliance records (H32, H33, H42),** including the restricted-use register and the application logbooks.
   - **The dashboard action queue (H36),** whose counts top out at 10.
2. **One limit is already being hit today: Notifications.** Four staff accounts each have 1,000 to 1,400 unread notifications. The Notifications page shows only the newest 200, and the bell's unread badge counts only the 20 it loads (L9, L10-1). Nothing is lost, because older notifications are still in the database. But staff can't see them, and the unread counts are wrong. Every other table is still under its limit (largest business tables on 2026-10-20: 604 products, 400 delivery lines, 289 order lines, 154 customers).
3. **Pickers: none has become a search box yet**, apart from the product pickers PR #944 changed. About 60 dropdowns still load a fixed list (500, 1,000, or 200) and filter it on screen. The shared `SearchableSelect` box used on New Order, Quote Builder, Job Detail and Blend Ticket Detail looks like a search, but it only searches the records it already loaded.
4. **No new limits were added since 2026-10-15.** All new code reads every row. The 13 new items (N1–N13) were already there and were missed the first time.
5. **Server-side limits are unchanged.** The live database's functions still cap the call lists at 200, the dispatch board at 500, the dashboard queue at the number asked for (10), cost-basis purchase candidates at 20, and the dashboard top-N lists by design.

**Recommended next step:** build **part 2**, a screen-only fix with no database change that finishes the high-risk items the same way part 1 did (plan below).

## Status of the 2026-10-15 items

### HIGH: fixed (18)

H1, H2, H3, H4, H8, H9, H10, H11, H12, H13, H14, H18, H21, H22, H34, H39, H40, H41. Each now reads through `src/lib/pagedRead.ts`. The three that act on their rows now cover every eligible row: the commission payout picker (H3) and commission quick-pay (H12). Except for H34 and H41, which have no money total, their totals are still added up in the browser, from the complete set. Moving them into the database is item (d).

### HIGH: still open (22)

| ID | Where now (file:line) | Cap | Note |
|---|---|---|---|
| H5 | `components/field-invoices/FieldInvoicesListPanel.tsx:145` | asks 2,000, gets 1,000 (server) | The warning toast at `:155` can't fire |
| H6 | `components/field-invoices/FieldInvoicesPostedPanel.tsx:121` | 1,000 (server) | "Unpost all" (`:434`) acts only on loaded rows |
| H7 | `components/field-invoices/FieldInvoicesUnpostedPanel.tsx:117` | 1,000 (server), newest first | "Post all" (`:395`) skips the oldest drafts |
| H15 | `pages/AccountsReceivable.tsx:46`, `pages/ARaging.tsx:99` (`get_ar_aging`, one call) | 1,000 (server) | Smallest balances drop first |
| H16 | `pages/AccountsReceivable.tsx:52` | 1,000 (server) | Unused Prepay card |
| H19 | `pages/FieldProfitability.tsx:78` (`get_field_profitability`, one call) | 1,000 (server) | |
| H20 | `components/prepay/PrepaymentManagerPanel.tsx:129` | 500 customers | The apply runs in the database; the preview, totals and CSV are capped |
| H23 | `pages/CustomerDetail.tsx:713`, `:721` | 1,000 (server) | One customer's purchase history total |
| H24 | `components/invoices/FinanceChargePreviewModal.tsx:50` (`preview_finance_charges`) | 1,000 (server) | "Generate" charges only the previewed customers (`:110`) |
| H25 | `lib/reconciliation.ts:857` | 1,000 (server) | Integrity check 5; checks 1–4, 7 and 8 already read every row |
| H26 | `lib/reconciliation.ts:885`, `:889` | 1,000 each (server) | Check 6 |
| H27 | `lib/reconciliation.ts:1020` | 1,000 (server) | Check 9 |
| H28 | `lib/reconciliation.ts:1048` | 1,000 (server) | Check 10 |
| H29 | `components/integrity/IntegrityCleanupPanel.tsx:152` | 1,000 (server), newest first | Unbilled deliveries |
| H30 | `components/integrity/IntegrityCleanupPanel.tsx:144`, `:157`, `:165` | 1,000 each (server) | Negative stock, stock made at delivery, open alerts |
| H32 | `pages/Compliance.tsx:172` (`get_rup_sales_register`, one call) | 1,000 (server) | Restricted-use register |
| H33 | `components/reports/LogbookReport.tsx:88`, `:95`, `:102`, `:114` (four logbook functions) | 1,000 each (server) | |
| H36 | `components/dashboard/ActionQueue.tsx:194` (`get_dashboard_action_items`, `p_limit: 10`) | 10 per category | Needs the function to return a true count (a database change) |
| H37 | `pages/AccountsPayable.tsx:43` (`get_ap_aging`, one call) | 1,000 (server) | |
| H38 | `pages/AccountsReceivable.tsx:58` | 1,000 (server) | Open credit memos |
| H42 | `pages/Compliance.tsx:117` | 1,000 (server) | Expired and expiring license counts |
| H43 | `pages/PaymentAllocation.tsx:161` | 200 | A check can only be applied to a customer's first 200 open invoices |

### MED: fixed

M1–M4 (PR #944), M5–M10, M12–M16, M28, M35, M39, M41, M42, M46, M58, M63, M65; also the Application Records and Returns customer lists in M48, and the Sales Reports category list in M49. The Orders pick-list in M62 is fixed too; the Order Detail one (`pages/OrderDetail.tsx:444`) is still open.

### MED: still open, by kind

All silent unless noted. Line numbers are current.

**Main lists and list-like panels**
- M11 Dispatch board jobs: 500 (`pages/DispatchBoard.tsx:221`, and the function `get_dispatch_board_jobs`).
- M18 Receiving hub: 500 (`components/receiving/ReceivingHubPanel.tsx:120`).
- M19 Receiving log: 500, never asks for page 2 (`components/receiving/ReceivingLogPanel.tsx:92`).
- M21 Call lists: 200 each (the five `get_call_list_*` functions).
- M22 Fields list and the shared field map cache: 1,000 (`pages/Fields.tsx:73`, `lib/fieldsGeojsonCache.ts:30`).
- M25 Watchdog exceptions (`pages/WatchdogExceptions.tsx:93`).
- M55 Inventory active holds (`pages/InventoryPage.tsx:333`).
- M56 Label review queue (`pages/LabelReview.tsx:210`).
- M61 Unbilled work backlog: 500 jobs and 500 blend tickets, with a banner (`components/field-invoices/UnbilledApplicationsPanel.tsx:169`, `:177`).
- M66 My Route stops (`pages/FieldRoute.tsx:76`).

**Lookups feeding a page**
- M20 Office Cockpit tiles: 50 each (`pages/OfficeCockpit.tsx:552`, `:562`, `:587`, `:597`, `:611`, `:631`). "Post all clean" acts only on the 50 loaded.
- M26 Field Invoices split locations (`FieldInvoicesPostedPanel.tsx:146`, `FieldInvoicesUnpostedPanel.tsx:144`).
- M36 Order Detail field-split reads (`pages/OrderDetail.tsx:315`, `:316`).
- M52 Jobs billed-customer column (`pages/Jobs.tsx:573`).
- M54 Cockpit lapsed crop-program holds (`pages/OfficeCockpit.tsx:635`).
- M60 Product Detail category, vendor and manufacturer choices (`pages/ProductDetail.tsx:439`).
- M62 Order Detail pick-list stock (`pages/OrderDetail.tsx:444`).

**Pickers (dropdowns that load a list instead of searching)**
- M17 New Delivery open orders (`pages/NewDelivery.tsx:117`).
- M29 Invoice customer picker, which also feeds the PDF address and email: 500 (`pages/InvoiceDetail.tsx:324`; PDF and email lookups `:1352`, `:1443`).
- M30 New Order customers (`pages/NewOrder.tsx:212`).
- M31 Quote Builder customers, products and fields (`pages/QuoteBuilder.tsx:803`, `:804`, `:806`).
- M32 Job Detail customers, fields and products (`pages/JobDetail.tsx:1653`–`:1655`).
- M33, M34 Blend Ticket Detail products, customers and fields (`pages/BlendTicketDetail.tsx:219`–`:232`); linked job, 200 (`:242`).
- M37 Order Detail bill-split customer: 500 (`pages/OrderDetail.tsx:825`).
- M38 Split invoice editor fields, products, and jobs (200) (`pages/FieldAppSplitInvoiceEditor.tsx:286`, `:287`, `:297`).
- M40 Logbook customers 500, applicators 200, fields 500 (`components/reports/LogbookReport.tsx:59`, `:64`, `:68`).
- M43 Field Setup customers: 500 (`pages/FieldSetup.tsx:261`).
- M44 Parent customer: 500 (`pages/CustomerDetail.tsx:408`).
- M45 Bulk field import customer: 500 (`components/fields/BulkFieldImport.tsx:170`).
- M47 Vendor bill link-to-PO: 200 (`pages/NewVendorBill.tsx:123`).
- M48 customer lists still open:
  - `pages/ARaging.tsx:86`
  - `components/field-invoices/CustomerInvoiceSummaryPanel.tsx:73`
  - `pages/Compliance.tsx:151`
  - `pages/Jobs.tsx:331`
  - `pages/InventoryPage.tsx:430`
  - `components/prepay/PrepaymentManagerPanel.tsx:308`
  - `components/field-app/SelectLocationsModal.tsx:69`
  - `pages/ApplicationServiceDetail.tsx:79`
  - `components/quotes/BulkQuoteImport.tsx:442`
- M49 product lists still open:
  - `components/blendtickets/ManualTicketCreate.tsx:292`
  - `components/deliveries/QuickDeliveryModal.tsx:99`
  - `components/orders/BulkOrderImport.tsx:392`
  - `components/purchase-orders/BulkPOImport.tsx:205`
  - `components/quotes/BulkQuoteImport.tsx:443`
  - `components/receiving/QuickReceivePanel.tsx:150`
  - `pages/BlendRecipes.tsx:138`
  - `pages/BrandVsGeneric.tsx:54`
  - `pages/InventoryPage.tsx:415`
  - `pages/NewPurchaseOrder.tsx:87`
  - `pages/LabelDataQuality.tsx:384`, `:390`
- M50 field lists: `components/field-app/SelectLocationsModal.tsx:38`, `pages/Compliance.tsx:187` (total acres), `pages/Fields.tsx:84`.
- M51 Edge Function `process-blend-ticket` matches against products and customers (`supabase/functions/process-blend-ticket/index.ts:1072`, `:1077`).
- M53 Cost-basis purchase candidates: 20 (database function).
- M59 Prepay workspace customer (`components/prepay/PrepayWorkspacePanel.tsx:77`).

**Scoped to one record**
- M23 One product's stock ledger (`components/inventory/TransactionLedgerModal.tsx:131`).
- M24 New cycle count, one warehouse (`pages/CycleCounts.tsx:220`).
- M27 Customer "Recent Transactions": the 50 oldest (`pages/CustomerDetail.tsx:2006`).
- M57 One customer's statement: `pages/ARaging.tsx:147`, `:383`, `pages/CustomerDetail.tsx:652`. The second ARaging call is newly noted.
- M64 Customer interaction history: 50 (`components/customers/CustomerContacts.tsx:197`).

### LOW

Unchanged from 2026-10-15 except:
- **Vendors (L19-1) is fixed.**
- **Notifications (L9, L10-1) is now already over its limit.** It belongs with the list pages, not LOW (see Summary point 2).

The rest are short on purpose, already signalled, or scoped to one small record:
- L1 Customers (1,000, banner) and L2 Jobs (500, banner) are list pages for part 3.
- L3–L7, L11–L15, L18, L21 and L22 need no fix.
- L17 and L20 are per-record reads.

## New items (missed on 2026-10-15)

| ID | Where (file:line) | What | Cap | Money / check? |
|---|---|---|---|---|
| N1 | `pages/CustomerDetail.tsx:645` | The Financials tab reads the whole company's AR aging (`get_ar_aging`) and picks this customer out. A small-balance customer past row 1,000 shows no aging on their own page | 1,000 (server) | **Money** |
| N2 | `pages/NewOrder.tsx:213` | New Order product picker | 1,000 (server); 595 active products today | |
| N3 | `pages/OrderDetail.tsx:356` | Order edit product picker | 1,000 (server) | |
| N4 | `pages/Jobs.tsx:469` | Jobs list applicator filter reads dispatches unpaged; read errors are ignored | 1,000 (server) | |
| N5 | `pages/Jobs.tsx:490` | Jobs list customer filter reads field shares unpaged; read errors are ignored | 1,000 (server) | |
| N6 | `pages/CycleCounts.tsx:189` | New cycle count location choices read from the whole inventory table | 1,000 (server) | |
| N7 | `pages/DispatchBoard.tsx:460` | Field boundaries for the dispatch map (`get_fields_geojson_by_ids`) | 1,000 (server) | |
| N8 | `pages/FieldView.tsx:304` | Same function, one applicator's fields | 1,000 (server) | |
| N9 | `components/prepay/PrepayWorkspacePanel.tsx:96`, `:102` | One customer's prepay buckets and open invoices for the Apply step | 1,000 per customer | **Money** (unlikely to hit) |
| N10 | `pages/Returns.tsx:332` | "Pick an order" for a new return, one customer | 1,000 per customer | |
| N11 | `pages/JobDetail.tsx:1701` | License check reads the whole license table; licenses past the limit would read as missing | 1,000 (server); small table | Compliance |
| N12 | `pages/BrandVsGeneric.tsx:56` | Brand-to-generic mapping list | 1,000 (server) | |
| N13 | Per-record reads on Delivery Detail, Field Stop, Quote Builder, Invoice Detail, Order Detail and the Prepay manager (`PrepaymentManagerPanel.tsx:141`, part of H20) | One record's lines, photos, notes and similar | 1,000 per record | L20 class |

**Not a row limit, noted.** `pages/OrderDetail.tsx:327` sends every customer id from the M36 reads in one `.in()` list, which could make the request too long at volume. Migration `20261015130000` line 608 takes a `customer_application_rates` row with `LIMIT 1` and no `ORDER BY`, so the pick is arbitrary if two rates exist. Both are outside Goal 4.

## Plan for the rest of Goal 4

Plain-English terms: **paging** means asking for records one batch at a time until none are left, which is what part 1 did. **Server-side paging** means the screen asks the database for just one screenful at a time, plus a total count, instead of loading everything.

**Part 2 (next): finish the high-risk reads, screen-only, no database change.** Use the part 1 helper (`fetchAllRows`, with an exact count and a fixed sort order) on:
- Field Invoices H5–H7 and M26, so "Post all" and "Unpost all" reach every invoice;
- AR and prepay H15, H16, H20, H23, H38, H43, N1, N9, plus the report functions H19, H24 and H37 (paged like part 1's report functions);
- integrity checks H25–H30;
- compliance H32, H33 and H42, plus the logbook pickers M40;
- Notifications (L10-1), with the bell badge (L9) counting unread notifications in the database instead of the 20 it loads.

Done when each reads past a 1,000-row fake in tests, and a live check with a 10-row page matches the database count, as in part 1. Size: one PR, similar to #981. H36 (dashboard counts) needs the function to return a true count, so it moves to part 4.

**Part 3, item (b): pickers become search boxes.**
- Add customer and field search pickers beside the existing `ProductSearchPicker`. Each asks the database as you type and loads a saved choice by id.
- Swap them into the open pickers, invoice customer (M29) first, since it feeds the PDF address and email. That covers M17, M29–M34, M37, M38, M43–M45, M47, the M48/M49/M50 lists, M59, N2, N3 and N6.
- Bulk imports (in M48 and M49) should match names in the database.
- The blend-ticket scanner (M51) is an Edge Function. Changing it needs a deploy, which needs Mason's OK at that time.

Done when a search finds a record past the old limit on every picker. Probably two PRs.

**Part 4, item (c): real server-side paging for the big lists.**
- Customers, Jobs, Invoices, Orders, Deliveries, Quotes, Notifications, Dispatch Board, Receiving, Call Lists, Fields and Watchdog get one screenful at a time with a database search and an exact total. The stable order is the record's date plus its id, so rows aren't missed or repeated while records change.
- This replaces part 1's "load everything" approach before history grows, and removes part 1's per-page counting cost (KNOWN_ISSUES "Deferred").
- It likely needs new database search functions, which are non-destructive migrations, and the dashboard queue count (H36).

**Then (d) and (e)** as the plan says: money totals computed in the database, then the workload test.
