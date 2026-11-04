# Inventory Costing Phase 1: Stock Age and Holding Cost Reports (Build Plan)

> **STATUS 2026-11-04: PLAN ONLY, NOT APPROVED TO BUILD.** This is the detailed build plan for Phase 1 of
> `docs/plans/2026-07-16-inventory-costing-plan.md` (section 3). Building it needs Mason's separate go-ahead
> (decision D1, still open). Mason's decisions D2-D11 are in that plan's section 12.
>
> **Revised twice on 2026-11-04.** First after Sol (gpt-6-sol, high) reviewed the whole plan (44 findings);
> then after Sol checked the plan against the real code (33 findings, one refuted). The code check showed the
> stock ledger cannot be replayed reliably: a `received` row has no link to its receiving record, receipt
> reversals write a generic adjustment, rows written together share a timestamp, and the database lets reps
> insert ledger rows and receipts directly. So the age rule is now the simplest one the code supports: **a
> starting date per product (Mason's estimate), plus CRX receipts after it, newest first.** Mason's direction
> for every revision: **keep it simple but practical; this is not a major feature.**

**Date:** 2026-11-04. **Grounded on:** `main` and read-only live queries the same day.

## 1. What Phase 1 gives Mason (plain English)

Admins only. Nothing here changes stock, prices, quotes, orders, invoices or commissions. Phase 1 adds **one
small table** (Mason's starting dates) and **one admin save action**; everything else is read-only.

1. **An honest name for today's valuation.** The Reports tab "Inventory Cost", its "Unit Cost" and "Total
   Value" columns and CSV headings, and the Inventory page card "Inventory Value" are relabelled
   **"Pricing-basis …"**. The numbers do not change; only the labels do, because the number is quantity ×
   price-list cost, not what the stock cost.
2. **Stock age report.** How long stock has likely sat, in buckets 0-90, 91-180, 181-270, 271-365 and 366+
   days, plus **"age unknown"**. Rows below zero are listed apart as **"negative stock — not aged"**; rows at
   zero are left out. Every age is an estimate (no lots, D6).
3. **Estimated holding cost.** The yearly rate (10% to start, D4) for the days stock has sat, at **today's**
   price-list cost and rate. A decision aid only; never added to inventory value.
4. **Supplier-price check.** Where a current per-unit supplier price exists in the same unit, the gap between
   the price-list cost and what it would cost to buy again.
5. **Aged-stock list.** Stock past 270 days (D3), with value and holding cost side by side, never summed.
6. **Bulk "starting date" entry (D10).** An admin selects any number of products and records what is on the
   shelf now and roughly when it came in (one date, or a few date-and-quantity lines). That is the product's
   **starting point**; CRX receipts after it are added on top. This is the same information Phase 2's fresh
   stock count needs (D9), so it can be reused there.

## 2. What the code and live data say (2026-11-04)

- 117 inventory rows, one per product, all `Main Warehouse`: 66 above zero, 19 below zero, 32 at zero.
  "One location" is today's data, not a rule the database enforces, so everything here is keyed by product
  **and** location.
- **The stock ledger cannot be replayed reliably for age** (Sol code check): a `received` ledger row carries
  the PO but not the receiving record or PO line; reversing a receipt deletes the receiving record and writes a
  generic negative `adjusted` row; rows written in one transaction can share a timestamp; and signs differ by
  writer (`adjusted` and `returned` are signed, a cancelled return writes a negative `returned` row; void
  reversals use `from_location` in one writer and `to_location` in another). Phase 1 therefore does **not**
  replay the ledger.
- **Receiving records are the reliable dated source:** each has `received_at`, quantity, `unit_size` and its
  PO line, and a reversed receipt's record is deleted. 53 of the 66 in-stock products have one; the last one
  was 2026-06-10. Since then product was bought by phone and email (D9), so receipts before 2026-06-11 cannot
  date today's stock without Mason's starting date.
- **Direct writes:** the database lets admins and sales reps insert `inventory_transactions` and
  `receiving_records` rows directly (Row Level Security insert policies), and admins can edit `inventory`
  directly. No screen in `src/` uses those direct writes; every real path goes through the receiving and
  stock functions. PR 1A closes the two unused insert paths (section 7) so a receipt always comes from a real
  receiving.
- **Units:** 30 of the 53 in-stock products with receipts have a receipt in a different unit from the
  inventory row or the product's inventory unit. Gate 0 (a verified common unit) is not built.
- **Supplier prices:** 10 current observations, all `price_kind = quote` with `package_quantity = 1`, in Qt,
  Gal or Lb.
- **Settings** live in `app_settings` (key/value text). Any signed-in user can read a setting; only admins can
  write one, by a direct upsert from the Settings page.
- **Today's valuation:** `get_inventory_cost_report` (admin-only via `require_admin()`; its implementation
  function is not callable by API roles, checked live) rounds each row to cents and turns a missing
  `current_cost` into 0; the Inventory page card sums unrounded browser numbers. Phase 1 leaves both
  calculations untouched and does not claim they agree to the cent.

## 3. How the age estimate works

For each product and location with stock above zero:

1. **Dated stock from CRX receipts after the starting point.** Take the receiving records received **after**
   the product's starting point (section 4), newest first, until they add up to today's on-hand. Each one dates
   its quantity by its `received_at`. A receipt is used only when its unit, the inventory row's unit and the
   product's inventory unit all match; otherwise its quantity is **unknown** (Phase 1 never converts units).
2. **Then the starting point's lines**, newest date first, each capped at its recorded quantity.
3. **Whatever is left is "age unknown".**

Without a starting point, only receipts dated on or after **2026-06-11** are used (none exist yet), so the
product shows "age unknown — needs a starting date". Older receipts are never used without one: CRX cannot
tell whether that stock is still on the shelf or was replaced by a phone or email purchase.

Why newest first: the oldest stock is assumed to have sold first, so what remains came in most recently. This
needs only today's on-hand quantity and the receiving records, so it does not depend on the ledger's signs,
timestamps or links.

**Known limits, stated on the report:**
- Stock added after the starting point without a CRX receipt (a count correction, a customer return, a
  purchase made outside CRX) is treated as older stock and may take the starting point's dates. The report
  shows a warning on any product whose ledger has a positive adjustment or return after its starting point.
- Ages are estimates. Re-entering a starting date after a stock count resets the product.

Age = days from the layer date to today in Central time. Each layer shows its source (CRX receipt or starting
date).

## 4. Bulk starting-date entry (D10)

**Where:** on the new report, a filter "Needs a starting date" with a checkbox on each row.
- Select rows, choose **"Set starting date"**, pick one date (applies to the whole on-hand quantity) or, per
  row, split it into a few date-and-quantity lines. Optional note.
- A preview lists every product, its lines and the on-hand they describe, then a `ConfirmModal`. One save
  covers all rows, or none if any row fails.
- **A new starting point for a product replaces the old one** (history is kept). "Remove starting date" saves
  a replacement with no lines, so the product goes back to "needs a starting date".
- Validation (in the database): each date is no later than the save and not before 2020-01-01; each quantity
  is above zero; the lines' total is no more than the row's on-hand at the moment of saving (anything not
  covered stays unknown); the product's inventory row exists.

**What it is not:** no cost entry (starting costs come with Phase 2's stock count, D9); no change to stock
quantities or receipts.

**Storage:** one table `inventory_age_baselines`: an append-only row per line, with batch id, product,
location, the as-of time (the save), estimated received date (null for "remove"), quantity, note, entered by,
and the request's idempotency key. The newest batch per product and location is the one in use.

## 5. Holding cost and supplier-price check

- **Cost basis:** the price-list cost (`products.current_cost`) read directly (not through the existing
  report, which turns a missing cost into 0), turned into whole cents before arithmetic. A missing cost is
  "value unknown" and excluded from valued totals. Labelled "price-list cost basis", never "what we paid".
- **Holding cost so far** for each dated layer: quantity × cost in cents × rate × days ÷ 365, in exact
  PostgreSQL `numeric`, rounded once per layer half away from zero to whole cents. Labelled **"estimate at
  today's cost and rate"**. Starting-date layers are shown in their own column, so the lower-confidence share
  is visible. Unknown stock gets no charge.
- **Holding cost per month from now:** 30 days at today's quantity, cost and rate, assuming the stock stays.
- **Rate:** setting `inventory_carrying_rate_bps`, a whole number of basis points (1000 = 10%), 0 to 10000.
- **Aged threshold:** setting `inventory_aged_days`, a whole number of days, 30 to 1095, starting at 270.
- **Both settings are checked by the database:** a trigger on `app_settings` rejects a non-integer or
  out-of-range value for these keys, and refuses renaming or deleting either key. The report raises a clear
  error if either row is missing or bad.
- **Supplier-price check:** only an observation with `price_kind = quote`, `package_quantity = 1`,
  `price_unit` equal to the product's inventory unit, `effective_from` on or before today, `effective_to`
  empty or not yet passed, and not superseded. The newest such one is used, with vendor and date shown, and
  anything older than 90 days marked "stale". Otherwise "not covered". Price exposure = units on hand ×
  (price-list cost − supplier cost). A review signal only.

## 6. Coverage and totals

- **Coverage** is the number of in-stock rows a column can measure, and their share of pricing-basis value
  (rows with a cost only). Quantities in different units are never added together.
- **Positive stock, negative stock and the net** are shown separately.
- Any total over incomplete coverage is labelled **"partial"**, with the excluded rows' count and their
  pricing-basis value beside it ("value unknown" where a row has no cost).
- Each product's buckets + unknown always add back to its on-hand; the report flags any row where they don't.
- Footer on every view: "These are management views. The books use the cost basis the accountant approves,
  reconciled to QuickBooks, after any write-downs."

## 7. Build steps (two PRs, database first)

A new database function and the screens that call it are never shipped in one PR (it deadlocks the apply and
merge gates), so the database PR lands first.

### PR 1A: database (one migration plus its ledger note)

- **Close two unused direct-insert paths:** drop the client INSERT policies on `inventory_transactions` and
  `receiving_records` (no screen uses them; the receiving and stock functions are `SECURITY DEFINER` and do
  not need them). This changes permissions, so it needs **Mason's explicit OK at build time**, plus
  `/security-review`. Admin UPDATE on `receiving_records` stays for now and is listed as a known limit.
- **Setting rows** `inventory_carrying_rate_bps` = `1000` and `inventory_aged_days` = `270`, inserted only if
  missing, plus the validation trigger from section 5.
- **New table `inventory_age_baselines`** (section 4): Row Level Security on, no client read or write
  policies, in the same migration; a trigger rejects UPDATE and DELETE; a unique index on the idempotency key
  per batch, so an expired cache entry can never let the same request save twice.
- **`get_inventory_aging_report()`**: read-only; sections 3, 5 and 6.
- **`set_inventory_age_baselines(p_rows jsonb, p_idempotency_key text)`**: bulk save. It refuses a null key;
  calls `require_admin()`; follows the existing `check_idempotency_intent` contract (keys are globally unique;
  an actor-bound fingerprint of the full request is stored, so the same key with different rows is refused);
  locks the distinct inventory rows in product-id order; re-reads on-hand under the lock; validates every row;
  and inserts all or none.
- Both functions are `SECURITY DEFINER` with `SET search_path = public, pg_temp`, and are revoked from
  `PUBLIC` and `anon` and granted to `authenticated` only. No new cost value is added to any shared product or
  inventory query.
- Refresh `.claude/schema-registry.json` after the live apply.

### PR 1B: screens

- `src/pages/Reports.tsx`: relabel the existing tab, columns and CSV headings; add a **"Stock age & holding
  cost"** tab through every existing integration point: the `OperationalTab` type, the admin-only tab set, the
  role-change reset, the load routing and state, the table rendering and the CSV dispatch. The tab has the
  buckets, an aged-stock filter, the supplier-price columns, coverage and the starting-date flow.
- `src/pages/InventoryPage.tsx`: relabel the card and the per-row value column only.
- `src/pages/SettingsPage.tsx`: two admin fields through the page's whole settings path (`SettingsForm`,
  `toSettingValues`, `GROUP_KEYS`, saved-value tracking and the upsert); the rate is entered as a percent and
  saved as whole basis points.
- Uses `src/lib/db.ts`, `assertRpcResult()`, `ConfirmModal`, toasts and the house table component; no new
  dependency.

### Gates (from `.claude/commands/ship.md`)

Both PRs are on the Sol list (`supabase/`; `Reports.tsx`, `SettingsPage.tsx`, and `InventoryPage.tsx` through
the money word `inventor`). Each gets Luna rounds, one clean Sol high review and `/security-review`. PR 1A's
migration is non-destructive and goes through the migration-apply proof gate before merge; 1B waits until 1A
is live.

## 8. Proof before calling it done

1. Run the report against live data (read-only) and record coverage; every row's buckets + unknown equal
   on-hand.
2. **Cases on a throwaway copy** (a local database or a rolled-back transaction, never live): no starting date
   (all unknown); a starting date only; a starting date plus a later receipt, then a sale; a receipt in a
   different unit (unknown); a reversed receipt (its record is gone, so it no longer dates stock); a split
   starting point; a replaced and a removed starting point.
3. Spot-check three live products by hand against their receipts and starting dates.
4. A sales rep and a signed-out caller each get "admin required" from both functions; the tab does not appear
   for a rep; a rep's existing product and inventory API responses are unchanged; after PR 1A a rep's direct
   insert into `inventory_transactions` or `receiving_records` is refused, and receiving through the app still
   works.
5. Bulk save the same request twice with one key: one batch. The same key with different rows is refused.
   Lines adding up to more than on-hand reject the whole save.
6. Bad setting values, a renamed key and a deleted key are rejected by the database.
7. Each renamed total shows the same number as before (screenshots before and after).
8. Screenshots of the new tab on desktop and phone width.

## 9. Not in Phase 1

Ledger replay; unit conversion (Gate 0); any cost entry or average cost (Phase 2); lots (D6); freight and
rebates (D7); vendor bills (Phase 4, D11); quote warnings (Phase 5); changes to the existing valuation's math;
past holding cost at past rates.

## 10. Risks Mason should know

- **The report starts almost entirely "needs a starting date".** It fills in as starting dates are entered
  (one bulk session, ideally at the stock count before busy season, D9) and as new CRX receipts arrive.
- **Starting dates are your estimates**, shown as such. Count corrections and returns after the starting date
  can blur them; the report flags those products.
- **Units:** receipts in a different unit count as unknown until the unit clean-up and Gate 0 land.
- **Price-list cost is not purchase cost.** Holding cost is only as good as the price list until Phase 2.
- **Purchases outside CRX stay invisible.** Entering POs and receiving in CRX (D9) is what keeps it true.
