# Inventory Costing Phase 1: Stock Age and Holding Cost Reports (Build Plan)

> **STATUS 2026-11-04: PLAN ONLY, NOT APPROVED TO BUILD.** This is the detailed build plan for Phase 1 of
> `docs/plans/2026-07-16-inventory-costing-plan.md` (section 3). Building it needs Mason's separate go-ahead
> (decision D1, still open). Mason's decisions D2-D11 are in that plan's section 12.
>
> **Revised 2026-11-04 after a Sol (gpt-6-sol, high) review of the whole plan** (44 findings). The stock-age
> rule is now a replay of each product's stock history instead of a fixed June cut-off and a receipt-first
> order. Mason's direction for every revision: **keep it simple but practical; this is not a major feature.**

**Date:** 2026-11-04. **Grounded on:** `main` and read-only live queries the same day.

## 1. What Phase 1 gives Mason (plain English)

Admins only. Nothing here changes stock, prices, quotes, orders, invoices or commissions. Phase 1 adds **one
small table** (Mason's estimated dates) and **one admin save action**; everything else is read-only.

1. **An honest name for today's valuation.** The Reports tab "Inventory Cost" and the Inventory page card
   "Inventory Value" become **"Pricing-basis valuation"** and **"Pricing-basis value"**. The numbers do not
   change; only the label does, because the number is quantity × price-list cost, not what the stock cost.
2. **Stock age report.** How long stock has likely sat, in buckets 0-90, 91-180, 181-270, 271-365 and 366+
   days, plus **"age unknown"**. Rows below zero are listed apart as **"negative stock — not aged"**; rows at
   zero are left out. Every age is an estimate (no lots, D6).
3. **Estimated holding cost.** The yearly rate (10% to start, D4) for the days stock has sat, at **today's**
   price-list cost and rate. A decision aid only; never added to inventory value.
4. **Supplier-price check.** Where a recent supplier price exists in the same unit, the gap between the
   price-list cost and what it would cost to buy again.
5. **Aged-stock list.** Stock past 270 days (D3), with value and holding cost side by side, never summed.
6. **Bulk "estimated received date" entry (D10).** For stock the report cannot date, an admin selects any
   number of products and enters an estimated received date (optionally how much it covers, and a note). That
   stock then ages from the entered date, marked **"owner estimate"**.

## 2. What the live data says (2026-11-04, read-only)

- 117 inventory rows, one per product, all `Main Warehouse`: 66 above zero, 19 below zero, 32 at zero.
- **The stock history adds up for most products.** Replaying each product's physical movements (received,
  delivered, job applied, delivery reversals, returns, adjustments) gives exactly today's on-hand for 107 of
  117 products, and for 57 of the 66 in stock. The other 9 in-stock products cannot be aged from history.
- `inventory_transactions.adjusted` quantities are **signed** (26 positive, 11 negative); the other physical
  types are stored as positive magnitudes with direction set by the type. Reservations (`booked`,
  `prebooked`, `released`, `prebook_reconciliation`) do not move physical stock and are ignored.
- 53 of the 66 in-stock products have a CRX receipt; the last one was 2026-06-10. Since then product was bought
  by phone and email (D9). Those purchases show up in the history only as adjustments, or not at all.
- **Units:** 30 of the 53 in-stock products with receipts have a receipt in a different unit from the
  inventory row or the product's inventory unit. Gate 0 (a verified common unit) is not built.
- 10 current supplier price observations exist, so the supplier-price check covers only a handful at first.
- Settings live in `app_settings` (key/value text). Any signed-in user can read a setting; only admins can
  write one, directly from the Settings page.
- Today's valuation: `get_inventory_cost_report` (admin-only via `require_admin()`) and the Inventory page
  card, which sums `quantity_available × current_cost` in the browser (rows below zero subtract). Phase 1
  leaves both calculations untouched.

## 3. How the age estimate works: replay the history

For each product, walk its physical stock movements in the order they happened, keeping a simple list of
**layers** (a quantity with a date or "unknown"):

- **A CRX receipt** adds a layer dated on the day it was received, but only when the receipt's unit, the
  inventory row's unit and the product's inventory unit all match. Otherwise it adds an **unknown** layer.
  Phase 1 never converts units; that waits for Gate 0.
- **Anything else that adds stock** (a positive adjustment or count correction, a return, a delivery
  reversal) adds an **unknown** layer. CRX cannot tell where that stock came from.
- **Anything that removes stock** (a delivery, a job, a negative adjustment) takes from the **oldest-dated
  layer first**, with unknown layers taken after the dated ones of the same entry time. If it removes more
  than the layers hold, the shortfall is a **deficit**; later additions fill the deficit first and only the
  remainder becomes a layer.
- **An owner estimate** (section 4), at the moment it was saved, turns up to its quantity of **unknown** stock
  into a layer with the estimated date. From then on it is used up by later sales like any other layer.

At the end, the layers left are today's stock. **Check:** the replayed total must equal the inventory row's
on-hand quantity. If it does not (9 in-stock products today), the history is incomplete, and the whole row
shows **"age unknown — history does not match on-hand"**. An owner estimate that covers the row's whole
on-hand quantity **restarts the replay** from the moment it was saved: the stock is that one dated layer, and
later movements apply to it. (A later stock count recorded as an adjustment does not fix the history by
itself; it adds unknown stock, which an estimate can then date.)

Why this replaces the June cut-off: stock bought outside CRX either never entered the history (the check
fails) or entered as an adjustment (an unknown layer). Neither can borrow an old receipt's date. A new CRX
receipt dates only its own units.

Age = days from the layer date to today in Central time. Each layer shows its source (CRX receipt or owner
estimate). Stated on the report: "Ages are estimates. Stock bought outside CRX cannot be dated."

## 4. Bulk estimated-date entry (D10)

**Where:** on the new report, a filter "Has unknown age" with a checkbox on each row.
- Select rows, choose **"Set estimated received date"**, pick one date, and optionally add a note. By default
  the date covers **the row's unknown quantity right now**; it can be lowered per row, never raised above it.
- A preview lists every product, the quantity covered and the date, then a `ConfirmModal`. One save covers all
  rows, or none if any row fails.
- Several estimates can apply to one product (for example 40 units from March and, later, 10 from August);
  each covers the stock that was unknown when it was saved.
- **"Clear estimate"** cancels one estimate; that stock goes back to unknown.
- Validation (in the database): the date cannot be in the future or before 2020-01-01; the quantity must be
  above zero and no more than the row's unknown quantity at the moment of saving; the row must reconcile
  (section 3) or the estimate must cover its whole on-hand quantity.

**What it is not:** no cost entry (starting costs come with Phase 2's stock count, D9); no change to stock
quantities or receipts. Estimates can later be offered to Phase 2's opening workbook as suggested dates.

**History:** every save adds rows and nothing is overwritten. A clear is a new row that points at the estimate
it cancels.

## 5. Holding cost and supplier-price check

- **Cost basis:** the price-list cost (`products.current_cost`), turned into whole cents before arithmetic.
  It is the only per-unit cost CRX holds in the inventory unit. Labelled "price-list cost basis", never "what
  we paid".
- **Holding cost so far** for each dated layer (receipt or owner estimate): quantity × cost in cents × rate ×
  days ÷ 365, in exact PostgreSQL `numeric`, rounded once per layer half away from zero to whole cents.
  Labelled **"estimate at today's cost and rate"**: changing the rate or cost changes it. Owner-estimate
  layers are shown in their own column so the lower-confidence share is visible. Unknown layers get no charge.
- **Holding cost per month from now:** 30 days at today's quantity, cost and rate, assuming the stock stays.
- **Rate:** setting `inventory_carrying_rate_bps`, a whole number of basis points (1000 = 10%), 0 to 10000.
- **Aged threshold:** setting `inventory_aged_days`, a whole number of days, 30 to 1095, starting at 270.
- **Both settings are checked by the database**, not just the screen: a trigger on `app_settings` rejects a
  missing, non-numeric or out-of-range value for these two keys, and the report refuses to run with a clear
  message if a value is somehow bad.
- **Supplier-price check:** the most recent observation for the product in its inventory unit (no end date
  or one not yet passed, not superseded). The vendor and date are shown, and anything older than 90 days is
  marked "stale". A different unit means "not covered". Price exposure = units on hand × (price-list cost −
  supplier cost). A review signal only.

## 6. Coverage and totals

- **Coverage** is shown as the number of in-stock rows a column can measure, and their share of pricing-basis
  value. Quantities in different units are never added together.
- **Positive stock, negative stock and the net** are shown separately, so the net ties to the pricing-basis
  valuation.
- Any total over incomplete coverage is labelled **"partial"**, with the excluded rows' count and their
  pricing-basis value beside it ("value unknown" where a row has no cost).
- Each product's buckets + unknown always add back to its on-hand; the report flags any row where they don't.
- Footer on every view: "These are management views. The books use the cost basis the accountant approves,
  reconciled to QuickBooks, after any write-downs."

## 7. Build steps (two PRs, database first)

A new database function and the screens that call it are never shipped in one PR (it deadlocks the apply and
merge gates), so the database PR lands first.

### PR 1A: database (one migration plus its ledger note)

- **Setting rows** `inventory_carrying_rate_bps` = `1000` and `inventory_aged_days` = `270`, inserted only if
  missing, plus the validation trigger from section 5.
- **New table `inventory_age_estimates`:** product, location, estimated received date, quantity covered,
  note, `clears_estimate_id` (for a clear), entered by, entered at, idempotency key. Row Level Security on,
  with no client read or write policies, in the same migration. A trigger rejects UPDATE and DELETE.
- **`get_inventory_aging_report()`**: read-only; the replay, coverage and holding-cost rules above.
- **`set_inventory_age_estimates(p_rows jsonb, p_idempotency_key text)`**: bulk save or clear. It **refuses a
  null key**, records the key in the existing `idempotency_keys` table scoped to this operation and caller,
  locks the affected inventory rows, recomputes each row's unknown quantity under that lock, validates every
  row and inserts all or none.
- Both functions are `SECURITY DEFINER` with `SET search_path = public, pg_temp`, call `require_admin()`
  first (before any cached idempotent result is read), and are revoked from `PUBLIC` and `anon` and granted to
  `authenticated` only.
- **No new cost value is added to any shared product or inventory query.** Reps' existing API responses must
  not change.
- Refresh `.claude/schema-registry.json` after the live apply.

### PR 1B: screens

- `src/pages/Reports.tsx`: rename the tab; add a **"Stock age & holding cost"** tab (admins only, like the
  existing cost tabs) with the buckets, an aged-stock filter, the supplier-price columns, coverage, a CSV
  export and the bulk-date flow.
- `src/pages/InventoryPage.tsx`: rename the card only.
- `src/pages/SettingsPage.tsx`: two admin fields (holding rate as a percent, saved as whole basis points;
  aged days).
- Uses `src/lib/db.ts`, `assertRpcResult()`, `ConfirmModal`, toasts and the house table component; no new
  dependency.

### Gates (from `.claude/commands/ship.md`)

Both PRs are on the Sol list (`supabase/`; `Reports.tsx`, `SettingsPage.tsx`, and `InventoryPage.tsx` through
the money word `inventor`). Each gets Luna rounds, one clean Sol high review and `/security-review` (a new
admin-only boundary). PR 1A's migration is non-destructive and goes through the migration-apply proof gate
before merge; 1B waits until 1A is live.

## 8. Proof before calling it done

1. Run the report against live data (read-only); record coverage, and confirm every row's buckets + unknown
   equal on-hand and that exactly the non-reconciling rows show "history does not match".
2. **Replay cases on a throwaway copy** (a local database or a rolled-back transaction, never live): a new
   receipt then a sale; stock sold then replaced by a count correction (must become unknown, not keep the
   receipt's date); a deficit filled by a later receipt; two owner estimates on one product; a clear.
3. Spot-check three live products by hand against their history.
4. A sales rep and a signed-out caller each get "admin required" from both functions; the tab does not appear
   for a rep; a rep's existing product and inventory API responses are unchanged.
5. Bulk save the same request twice with one key: one set of rows. The same key for a different request is
   refused. A row covering more than its unknown quantity rejects the whole save.
6. Bad setting values (text, out of range) are rejected by the database.
7. The renamed report and card show the same totals as before, to the cent (screenshots before and after).
8. Screenshots of the new tab on desktop and phone width.

## 9. Not in Phase 1

Unit conversion (Gate 0); any cost entry or average cost (Phase 2); lots (D6); freight and rebates (D7); vendor
bills (Phase 4, D11); quote warnings (Phase 5); changes to the existing valuation's math; past holding cost
at past rates (it is always today's estimate).

## 10. Risks Mason should know

- **Much of the stock starts as "age unknown"** until estimated dates are entered or new CRX receipts arrive.
  That is deliberate: the report shows nothing it cannot back up.
- **Units:** receipts in a different unit count as unknown until the unit clean-up and Gate 0 land. Owner
  estimates still work for them.
- **Price-list cost is not purchase cost.** Holding cost is only as good as the price list until Phase 2.
- **Purchases outside CRX stay invisible.** Entering POs and receiving in CRX (D9) is what keeps it true.
