# Foundation roadmap: which base areas to finish next

**Status: ROADMAP, 2026-11-08. Read-only analysis; nothing here authorizes building.** Mason asked for the base parts of the app to be finished fully and up to standard, the way the Product Master work did it, so later work stands on them. He asked for this ranking to be saved for the future road map (in chat, 2026-11-08). Each area still gets its own backlog, build sheet and Sol review before it is built. The to-do list carries it as section 18 ([`docs/manual/TO_DO_LIST.md`](../manual/TO_DO_LIST.md)).

**Evidence:** `main` at `cfcfca4ca` (0 behind on 2026-11-08), migrations, source and docs. The live database was not queried; findings come from the newest migration files, and some files newer than the live high-water `20261108043505` may not be applied yet. Re-check every fact below at build time.

## What "finished and up to standard" means (the Product Master model)

- **One source of truth:** each fact is stored once; everything else reads it.
- **Rules in the database:** every save goes through one RPC that takes and enforces `p_idempotency_key`; screens never write tables directly.
- **Money in whole cents;** access rules (RLS) enforced in the database, not only by hiding buttons.
- **Built the Product Master way:** a backlog, a build sheet with a "Done when" per package, one PR per package, Sol on database, money and permission work, and a ledger.

## The ranking

| # | Area | Size | Risk | Overlaps |
|---|---|---|---|---|
| 1 | Fields and who pays | 2 waves, about 5–6 PRs | Money, customer data | Applicator access part C on PR #1650 |
| 2 | Sales read model, per payer | 1 wave, 2–3 PRs | Money (read-only) | Needs Taha's PR #1524 live; stay clear of his M15 report |
| 3 | Customer master | 1–2 waves, 3–4 PRs | Customer data | Duplicate warning PR #1660 (screen only); Taha's billing reads customer terms |
| 4 | Seasons and price rules | 1 wave, 2–3 PRs | Money | Taha owns quoting and bookings to 2026-12-15 |
| 5 | Permissions, one model | 1–2 waves, 3–4 PRs | Security | PR #1650; Taha's PR #1576 (unpost scope) |
| 6 | Money units and retry keys | 2–3 waves, 6+ PRs | Money (high) | Mostly Taha's billing tables until 2026-12-15 |

**Start next: area 1.** It is the base for field-application invoicing (wanted ready before February, per the 2026-11-04 billing decision, which moves it up from the 2026-10-22 "built last" call), landlord split billing, applicator access and spray reconciliation, and it is outside Taha's chemical-sale billing. Run area 2 alongside it once PR #1524 is live.

**Not ranked (close to standard):** inventory (one leftover: starting a cycle count is two separate inserts from the screen, `src/pages/CycleCounts.tsx:268-291`; transfers and lots wait for a second warehouse; costing is parked) and products (Stage 1 landed, including WP-PM-5 #1316, WP-PM-9 #1342 and WP-PM-7 #1345; Stage 2 is in progress).

---

## 1. Fields and who pays

Fields, acres, and each field's paying parties and shares (landlord and partner splits).

**Depends on it:** field-application invoices (direct, job, blend ticket); landlord and partner split billing; jobs, dispatch and applicator field access (KI-01, KI-73); spray planned-vs-actual reconciliation; per-acre billing; per-payer sales and commissions on split sales.

**Done when:**
- each field has one billing split group: payers and percentages that sum to exactly 100%, with history;
- every split path (job, field app, order, delivery) reads that group;
- fields are archived through an RPC, never hard-deleted from a screen;
- job access ends when the job ends;
- billing uses one acres value.

**Today:**
- "Who pays for this field" is stored in about 8 places: `fields.customer_id`, `field_billing_defaults`, `job_field_shares`, `field_app_location_shares`, `order_shares`, `order_line_allocations`, `invoice_line_allocations`, `invoice_shares` / `invoice_line_shares`.
- About 5 split-billing mechanisms run side by side: order level, order line, invoice level, field defaults, and per-line field app (PR #164). PR #1524 adds one for chemical sales.
- `src/pages/Fields.tsx:254` hard-deletes fields directly.
- `src/pages/OrderDetail.tsx:960,985` inserts and deletes `order_shares` directly and computes the share in the browser, with no RPC or retry key.
- Owners and landlords are not separate from paying customers; which customers a split may bill is open (KI-76).
- KI-01 part C and KI-73 (access after the job ends): fix written on PR #1650, not applied.

**Already good:** `save_field`, `set_field_boundary` and `set_field_override_acres` take retry keys; the two-acre model has a generated `acres_source`.

**Needs Mason first:** which customers a split may bill (KI-76).

## 2. Sales read model, per payer

One database source for "what was sold, to which payer, for how much, in which season", built from invoice lines in cents.

**Depends on it:** Sales Detail and Sales Summary, dashboard top customers, gross sales, commissions (invoiced sales at gross profit), QuickBooks month-end summary, the chemical history report.

**Done when:** every sales report reads one server source; split sales show per payer and sum to the invoice; field-application invoices are included; cents only; cost stays admin-only.

**Today:**
- The sales report functions (`20260812115235_snapshot_cost_reporting.sql:159,201,254`, wrapped in `20261019010000`) credit sales to `orders.customer_id` and read `order_items.total_price` in dollars, so a split sale shows entirely under the main customer.
- Invoices with no order (field application) are probably missing (not confirmed).
- `src/pages/SalesReports.tsx:297-306` sums dollar totals in the browser.

## 3. Customer master

Customers, contacts, addresses, terms, tier and farm-group parent.

**Done when:** every write goes through `save_customer` or a sibling RPC with a retry key (bulk import, deactivate, crops, contacts included); one home for addresses and contacts; payment terms as a fixed list; duplicates caught in the database; address reads limited by role.

**Today:**
- Direct writes: `src/components/customers/BulkCustomerImport.tsx:309`, `src/pages/Customers.tsx:332` (deactivate, open-invoice check in the browser), `src/pages/CustomerDetail.tsx:1172`, `src/components/customers/CustomerContacts.tsx:113,118,155`.
- Address and contact text on `customers` duplicates `customer_addresses` and `customer_contacts`; `payment_terms` is free text.
- KI-73: customer addresses are readable more widely than intended.
- KI-77: PR #1660 adds a screen-only duplicate warning; bulk import skips it.

## 4. Seasons and price rules

**Done when:** the server alone sets the season on every money record, never the screen. It derives it under the settled rules, not from today's date: a new generic invoice takes its season from its own date (read in Chicago time), dedicated job and blend creators keep their documented exception, and an existing field-application invoice keeps its filed season, so its date may not move across October 1 (DECISION_LOG 2026-09-08; `guard_field_app_invoice_season_date()`). Invoices bill the price that was sent (KI-81). The quote-tier check stays screen-only, as settled (Mason, 2026-11-05, KI-105; built in PR #1605): anyone may quote at another tier, and there is no database refusal.

**Today:**
- No seasons table; season is a bare integer on about 18 tables.
- The invoice save still accepts a season sent by the screen (`20261106140000_invoice_resave_keeps_cost.sql:136,201`); `src/pages/InvoiceDetail.tsx:1161` sends it.
- Tier prices are three plain columns on `products`.

## 5. Permissions, one model

**Done when:** one set of database helpers is used everywhere; there is one test per role and rule (Goal 1); nothing the screen hides is still allowed by the database.

**Today:**
- Roles are stored once (`profiles.role`), but checked three ways: the `is_admin()` family, inline `role = 'admin'` (some without the active-account check), and `role IN (...)` inside functions.
- KI-03: the decided rep scoping for invoices and commission splits is enforced on screen only. PR #1576 covers unposting.
- KI-01 part C and KI-73: PR #1650.

## 6. Money units and retry keys

**Done when:** all stored money is whole cents; invoice running totals can't drift from their detail rows; every money RPC refuses a call with no retry key.

**Today:**
- Still in dollars: `orders.total_price` and `total_cost`; `order_items.price_per_unit` (beside `cost_at_time_cents`); `commissions.commission_amount`; `commission_payments.total_amount`; the retired `payments.amount`, still read by `src/pages/GettingStarted.tsx:163`.
- Invoices keep running totals (`paid_amount_cents` and others) beside the detail rows, so every writer must update both.
- The retry key is optional on most money RPCs (`allocate_payment` skips it when absent); `mark_overdue_invoices` and `update_allocation_set` have none.
- Six August hardening drafts are still parked in `scripts/.staging-migrations/` (for example rejecting non-finite money, and requiring a completed delivery before an invoice posts).

Ranked last only because these are Taha's billing tables during his work to 2026-12-15.

## Not confirmed

Live RLS policies and column types; whether the server re-checks invoice line totals; which invoice types the sales reports leave out; whether every writer keeps invoice running totals in step. An advisory Astra challenge of this ranking was not run.
