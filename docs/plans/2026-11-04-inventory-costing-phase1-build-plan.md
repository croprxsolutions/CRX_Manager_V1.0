# Inventory Costing Phase 1: Stock Age and Holding Cost Reports (Build Plan)

> **STATUS 2026-11-04: PLAN ONLY, NOT APPROVED TO BUILD.** This is the detailed build plan for Phase 1 of
> `docs/plans/2026-07-16-inventory-costing-plan.md` (section 3). Building it needs Mason's separate go-ahead
> (decision D1, still open). Mason's decisions D2-D10 are in that plan's section 12.

**Date:** 2026-11-04. **Grounded on:** `main` at `f44f1931c` and read-only live queries the same day.

## 1. What Phase 1 gives Mason (plain English)

Admins only. Nothing here changes stock, prices, quotes, orders, invoices or commissions.

1. **An honest name for today's valuation.** The Reports tab "Inventory Cost" and the Inventory page card
   "Inventory Value" become **"Pricing-basis valuation"** and **"Pricing-basis value"**. The numbers do not
   change; only the label does, because the number is quantity × price-list cost, not what the stock cost.
2. **Stock age report.** How long stock has likely sat on the shelf, in buckets 0-90, 91-180, 181-270, 271-365
   and 366+ days, plus **"age unknown"** and **"negative stock — not aged"**. It is an estimate (no lots, D6).
3. **Estimated holding cost.** The yearly rate (10% to start, D4) charged for the days stock has sat. A
   decision aid only; never added to inventory value.
4. **Supplier-price check.** Where a current supplier price exists in the same unit, the gap between the
   price-list cost and what it would cost to buy again.
5. **Aged-stock list.** Stock past 270 days (D3), with value and holding cost side by side, never summed.
6. **Bulk "estimated received date" entry (D10, new).** For stock the report cannot date, an admin selects
   any number of products and enters an estimated received date (and optionally how much of the stock that
   date covers, plus a note). Those rows then age from the entered date, marked **"owner estimate"**.

## 2. What the live data says (2026-11-04, read-only)

- 117 inventory rows, all `Main Warehouse`: 66 positive, 19 negative, the rest zero.
- 53 of the 66 in-stock products have at least one CRX receipt; 13 have none.
- **Units:** only 23 of the 66 have every receipt, the inventory row and the product all in the same unit.
  12 in-stock rows carry a unit different from their product's inventory unit. Gate 0 (common unit) is not
  built, and no product is formally "unit-verified". No cycle count has ever been completed.
- **The June gap:** the last CRX receipt was 2026-06-10. Since then product was bought by phone and email
  (D9). 42 of the 66 in-stock products had a delivery or job after their last CRX receipt, and 13 had a
  stock adjustment, so CRX cannot tell which receipt their current stock came from.
- No in-stock product's last receipt is older than 270 days yet, so the aged-stock list starts nearly empty
  unless Mason enters older estimated dates.
- 10 current supplier price observations exist, so the supplier-price check will cover only a handful of
  products at first.
- Settings live in `app_settings` (key/value text). Any signed-in user can read a setting and only admins can
  write one; the Settings page writes them directly.
- Today's valuation: `get_inventory_cost_report` (admin-only via `require_admin()`, latest body
  `20261103100000`) and the Inventory page card, which sums `quantity_available × current_cost` in the browser
  (negative rows subtract). Phase 1 leaves both calculations untouched.

## 3. How the age estimate works

For each inventory row with stock above zero, on-hand quantity is matched to **"layers"**, newest first (the
oldest stock is assumed to have sold first). Each layer has a date, a quantity and a source:

1. **CRX receipts dated on or after 2026-06-11** (after the gap began): always usable.
2. **The product's latest owner estimate** (section 4), for the quantity it covers.
3. **CRX receipts dated on or before 2026-06-10:** usable **only** if the product had no delivery, job or
   adjustment after its **last receipt dated on or before 2026-06-10** (its pre-gap stock is untouched since
   then). Otherwise skipped (D10: gap stock shows "age unknown"). The check is anchored to that last pre-gap
   receipt, never to the newest receipt, so a new CRX receipt cannot erase gap-era movements: if 50 units of
   gap stock sit beside 10 newly received units, the 10 are dated and the 50 stay "age unknown".

A receipt layer is usable only when the receipt's unit, the inventory row's unit and the product's inventory
unit all match. If any differ, that receipt is skipped. Phase 1 never converts units; that waits for Gate 0. An
owner estimate is entered in the inventory row's own unit, so this check does not apply to it.

Whatever quantity is still unmatched is **"age unknown"**. A row at zero or below is never matched to anything:
it is listed as "negative stock — not aged", with no bucket and no holding cost.

Age = days from the layer date to today in Central time. Each layer shows its source (CRX receipt or owner
estimate), so Mason can see what the estimate rests on.

Known limit, stated on the report: if purchases are made outside CRX again, the report cannot see them. It will
then show matched stock as older than it really is.

## 4. Bulk estimated-date entry (D10)

**Where:** on the new report, a filter "Age unknown only" with a checkbox on each row.
- Select rows, choose **"Set estimated received date"**, pick one date, and optionally add a note. By default
  the date covers all stock currently on hand; it can be lowered per row.
- A preview lists every product, the quantity covered and the date, then a `ConfirmModal`. One save covers
  all rows, or none if any row fails.
- Single-row edit uses the same flow. **"Clear estimate"** removes a row's estimate, so that row goes back to
  "age unknown".
- Validation: the date cannot be in the future or before 2020-01-01. The covered quantity must be above zero
  and no more than the row's on-hand quantity at the moment of saving. The product must still have that
  inventory row.

**What it is not:** it does not enter a cost (starting costs come with Phase 2's stock count, D9). It never
changes stock quantities or any receipt. The entries can later be offered to Phase 2's opening workbook as
suggested dates.

**History:** every save adds new rows; nothing is overwritten. The newest entry per product and location is
the one in use, and older ones stay as history showing who entered what and when.

## 5. Holding cost and supplier-price check

- **Cost basis:** the price-list cost (`products.current_cost`), turned into whole cents before any arithmetic.
  It is the only per-unit cost CRX holds in the inventory unit. Labelled "price-list cost basis" everywhere,
  never "what we paid". It assumes the same unit as today's valuation does.
- **Holding cost so far for a layer:** layer quantity × cost in cents × rate × days ÷ 365. Computed in exact
  PostgreSQL `numeric` and rounded once per layer, half away from zero, to whole cents. Also shown: the
  holding cost per month going forward.
- **Rate:** setting `inventory_carrying_rate_bps`, an integer in basis points (1000 = 10%, so there are no
  fractions). It is edited on the Settings page, accepts whole numbers from 0 to 10000, and starts at 1000.
- **Aged threshold:** setting `inventory_aged_days`, 270 to start (D3), edited on the Settings page.
- **Supplier-price check:** uses a current observation (no end date, or one in the future, and not superseded)
  in the product's inventory unit. If the unit differs, the price is left out and that row is counted as "not
  covered". Price exposure = units on hand × (price-list cost − supplier cost). It is a review signal only.

## 6. Coverage and totals (rule from the main plan, section 3.2)

- Each column shows its coverage: the share of in-stock rows it can measure, and the share of on-hand quantity
  it covers.
- Any total over incomplete coverage is labelled **"partial"**, with the count of excluded rows beside it.
- Every product's buckets + age unknown always add back to its on-hand quantity. The report checks this itself
  and flags any row where it fails.
- Footer on every view: "These are management views. The books use the cost basis the accountant approves,
  reconciled to QuickBooks, after any write-downs."

## 7. Build steps (two PRs, database first)

A new database function and the screens that call it are never shipped in one PR. That deadlocks the apply
and merge gates, so the database PR lands first.

### PR 1A: database (one migration plus its ledger note)

- **Setting rows** `inventory_carrying_rate_bps` = `1000` and `inventory_aged_days` = `270`, inserted only if
  they are missing (non-destructive).
- **New table `inventory_age_estimates`:** product, location, estimated received date, covered quantity (or
  empty for "all on hand"), cleared flag, note, entered by and entered at, and the idempotency key. Row Level
  Security is on, with no client read or write policies, in the same migration. A trigger rejects UPDATE and
  DELETE. Reads and writes go only through the functions below.
- **`get_inventory_aging_report()`**: read-only. Returns one row per layer plus per-row totals and coverage, as
  in sections 3, 5 and 6.
- **`set_inventory_age_estimates(p_rows jsonb, p_idempotency_key text)`**: bulk save or clear. It **refuses a
  null key**, records the key in the existing `idempotency_keys` table scoped to this operation and caller,
  locks the affected inventory rows, validates every row and inserts all of them or none.
- Both functions are `SECURITY DEFINER` with `SET search_path = public, pg_temp`. Each calls
  `require_admin()` first, before reading any cached idempotent result. Execute is revoked from `PUBLIC` and
  `anon` and granted to `authenticated` only.
- Refresh `.claude/schema-registry.json` after the live apply.

### PR 1B: screens

- `src/pages/Reports.tsx`: rename the tab; add a **"Stock age & holding cost"** tab (admins only, like the
  existing cost tabs) with the buckets, an aged-stock filter, the supplier-price columns, coverage badges, a CSV
  export and the bulk-date flow from section 4.
- `src/pages/InventoryPage.tsx`: rename the card only.
- `src/pages/SettingsPage.tsx`: two admin fields (holding rate as a percent, converted to whole basis points;
  aged days).
- Uses `src/lib/db.ts`, `assertRpcResult()`, `ConfirmModal`, toasts and the house table component; no new
  dependency.

### Gates (from `.claude/commands/ship.md`)

Both PRs are on the Sol list (`supabase/`; `Reports.tsx`, `SettingsPage.tsx`, and `InventoryPage.tsx` through
the money word `inventor`). Each gets Luna rounds, then one clean Sol high review, plus `/security-review`
because they add an admin-only permission boundary. PR 1A's migration is non-destructive. It goes through the
migration-apply proof gate before merge, and 1B waits until 1A is live.

## 8. Proof before calling it done

1. Run the report against live data (read-only) and record the coverage numbers. For every row, check that the
   buckets + unknown add back to on-hand.
2. Spot-check three products by hand: one dated by a post-gap receipt (once one exists), one untouched pre-gap
   product, and one gap product after an owner estimate.
3. A sales rep and a signed-out caller each get "admin required" from both functions, and the new tab does not
   appear for a rep.
4. Bulk save the same request twice with one key: only one set of rows is written. Reusing that key for a
   different request is refused. A row covering more than on-hand rejects the whole save.
5. The renamed report and card show the same totals as before, to the cent (screenshots before and after).
6. Change the holding rate in Settings and watch the holding cost change, then set it back.
7. Screenshots of the new tab on desktop and phone width.

## 9. Not in Phase 1

Unit conversion (Gate 0); any cost entry or average cost (Phase 2); lots (D6); freight and rebates (D7); quote
warnings (Phase 5); changes to the existing valuation's math; a "fresh start date" setting (the fixed gap date
2026-06-10 covers today's case).

## 10. Risks Mason should know

- **The report starts mostly "age unknown"** (about 42 of 66 in-stock products) until Mason enters estimated
  dates or new CRX receipts come in. That is deliberate: it shows nothing it cannot back up.
- **Units:** 30 of the 53 in-stock products with receipts fail the unit match, so their receipt layers are skipped until the unit
  clean-up and Gate 0 land. Owner estimates still work for them.
- **Price-list cost is not purchase cost.** Holding cost is only as good as the price list until Phase 2.
- **Purchases outside CRX make ages look older than they are.** Entering POs and receiving in CRX (D9) is what
  keeps the report true.
