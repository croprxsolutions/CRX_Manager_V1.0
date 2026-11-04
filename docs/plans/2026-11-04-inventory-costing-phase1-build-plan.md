# Inventory Costing Phase 1: Stock Age and Holding Cost Reports (Build Plan)

> **STATUS 2026-11-04: PLAN ONLY, NOT APPROVED TO BUILD.** This is the detailed build plan for Phase 1 of
> `docs/plans/2026-07-16-inventory-costing-plan.md` (section 3). Building it needs Mason's separate go-ahead
> (decision D1, still open). Mason's decisions D2-D11 are in that plan's section 12.
>
> **Revised three times on 2026-11-04 by Sol (gpt-6-sol, high) reviews:** the whole plan (44 findings), the
> plan against the real code (33 findings, one refuted), and a re-check of the revision (28 findings). The
> code check showed the stock ledger cannot be replayed reliably for age, so the rule is now the simplest one
> the code supports: **a starting date per product (Mason's estimate), plus CRX receipts after it, trusted
> only while the product's later history is ordinary receipts and sales that add up.** Anything else asks for
> a new starting date instead of guessing. Mason's direction for every revision: **keep it simple but
> practical; this is not a major feature.**

**Date:** 2026-11-04. **Grounded on:** `main` and read-only live queries the same day.

## 1. What Phase 1 gives Mason (plain English)

Admins only. Nothing here changes stock, prices, quotes, orders, invoices or commissions. Phase 1 adds **two
small tables** (Mason's starting dates: a batch and its lines) and **one admin save action**; everything else
is read-only.

1. **An honest name for today's valuation.** The Reports tab "Inventory Cost", its "Unit Cost" and "Total
   Value" columns and CSV headings, and the Inventory page card "Inventory Value" are relabelled
   **"Pricing-basis …"**. The numbers do not change; only the labels do, because the number is quantity ×
   price-list cost, not what the stock cost.
2. **Stock age report.** How long stock has likely sat, in buckets 0-90, 91-180, 181-270, 271-365 and 366+
   days, plus **"age unknown"**. Rows below zero are listed apart as **"negative stock — not aged"**; rows at
   zero are left out. Every age is an estimate (no lots, D6).
3. **Estimated holding cost.** The yearly rate (10% to start, D4) for the days stock has sat, at **today's**
   price-list cost and rate. A decision aid only; never added to inventory value.
4. **Supplier-price check.** Where a recent, verified per-unit supplier quote exists, the gap between the
   price-list cost and what it would cost to buy again.
5. **Aged-stock list.** Stock past 270 days (D3), with value and holding cost side by side, never summed.
6. **Bulk "starting date" entry (D10).** An admin selects any number of in-stock products and records roughly
   when the stock CRX shows on hand came in (one date, or a few date-and-quantity lines). That is the
   product's **starting point**; CRX receipts after it are added on top. It is an estimate against CRX's
   **recorded** on-hand, not a physical count; Phase 2's opening still needs the physical stock count (D9).

## 2. What the code and live data say (2026-11-04)

- 117 inventory rows, one per product, all `Main Warehouse`: 66 above zero, 19 below zero, 32 at zero.
  "One location" is today's data, not a database rule, so everything here is keyed by product **and**
  location.
- **The stock ledger cannot be replayed reliably for age** (Sol code check): a `received` ledger row carries
  the PO but not the receiving record or PO line; reversing a receipt deletes the receiving record and writes a
  generic negative `adjusted` row; rows written in one transaction can share a timestamp; and signs differ by
  writer (`adjusted` and `returned` are signed; void reversals use `from_location` in one writer and
  `to_location` in another).
- **Ordinary movements are consistent:** `received`, `delivered` and `job_applied` rows are positive
  magnitudes. Summing physical movements matches on-hand for 107 of 117 products.
- **Receiving records are the dated source:** each has `received_at`, quantity, `unit_size` and its PO line;
  a reversed receipt's record is deleted. The last CRX receipt was 2026-06-10; since then product was bought
  by phone and email (D9).
- **Write paths:** every screen changes receipts and the stock ledger through the receiving and stock
  functions. The report must still rely only on records those functions write; PR 1A tightens database write
  permissions to match (details are in private review notes until that change is live).
- **Units:** receiving adds the entered quantity as-is (no conversion). 30 of the 53 in-stock products with
  receipts have a receipt whose unit text differs from the inventory row or product. Gate 0 is not built.
- **Supplier prices:** 10 current observations, all `price_kind = quote`, `package_quantity = 1`, in Qt, Gal
  or Lb. A replacement observation points at the one it replaces (`supersedes_observation_id`).
- **Settings** live in `app_settings` (key/value text); admins write them by a direct upsert from the Settings
  page.
- **Today's valuation:** `get_inventory_cost_report` (admin-only; its implementation function is not callable
  by API roles, checked live) rounds each row to cents and turns a missing `current_cost` into 0; the
  Inventory page card sums unrounded browser numbers. Phase 1 leaves both untouched and does not claim they
  agree to the cent.

## 3. How the age estimate works

For each product and location **with a starting point** (section 4) and stock above zero, the report first
checks that the history since the starting point is **ordinary and adds up**:
- every ledger row after it is a `received`, `delivered` or `job_applied` row (no adjustment, return, return
  cancellation, delivery reversal, cycle-count change or receipt reversal);
- every receiving record after it has a unit matching the inventory row and the product's inventory unit;
- starting quantity + receipts after it − deliveries and jobs after it = today's on-hand (this also catches
  any stock change made outside the ordinary actions).

**If the check passes**, on-hand is dated newest first: the receipts after the starting point (by
`received_at`), then the starting point's lines (newest date first, each capped at its quantity). Anything
left is "age unknown" (only possible if the starting point covered less than all the stock).

**If the check fails**, the whole row shows **"age unknown — re-enter starting date"**, with the reason (for
example "count correction on 3 Dec"). A fresh starting date resets it. This keeps the rule simple and never
gives a confident date to stock whose origin is unclear.

**Without a starting point**, the row shows "age unknown — needs a starting date". Receipts before 2026-06-11
are never used: CRX cannot tell whether that stock is still on the shelf or was replaced by a phone or email
purchase.

Why newest first: the oldest stock is assumed to have sold first, so what remains came in most recently.

**Known limits, stated on the report:** starting dates are estimates; unit labels are matched as text until
Gate 0 verifies them; stock bought outside CRX stays invisible.

Age = days from the layer date to today in Central time. Each layer shows its source (CRX receipt or starting
date). The report is always "as of today": the Reports page's shared date bar is hidden on this tab.

## 4. Bulk starting-date entry (D10)

**Where:** on the new report, a filter "Needs a starting date" with a checkbox on each row.
- **Set starting date** (rows above zero only): pick one date for the whole on-hand quantity or, per row, split
  it into a few date-and-quantity lines; optional note.
- **Remove starting date** (any row): saves an empty replacement, so the row goes back to "needs a starting
  date".
- A preview lists every product, its lines and the recorded on-hand they describe, then a `ConfirmModal`. One
  save covers all rows, or none if any row fails.
- **A new starting point replaces the old one** for that product and location; history is kept.

**Validation (in the database):** at most one entry per product and location per request; each date is a
real date no later than the save (older dates are allowed and land in 366+); each quantity is finite and
above zero; the lines' total is finite and no more than the row's on-hand at the moment of saving; the
inventory row exists.

**Storage (two small append-only tables):**
- `inventory_age_baseline_batches`: one row per product-location replacement, with a database sequence
  number (the highest sequence is the one in use), product, location, as-of time, note, entered by, the
  request's idempotency key and its fingerprint.
- `inventory_age_baseline_lines`: zero or more lines per batch (estimated received date, quantity). Zero lines
  means "removed".

**What it is not:** no cost entry and no change to stock quantities or receipts.

## 5. Holding cost and supplier-price check

- **Cost basis:** the price-list cost (`products.current_cost`) read directly (not through the existing
  report, which turns a missing cost into 0). A missing cost is "value unknown" and excluded from valued
  totals. Labelled "price-list cost basis", never "what we paid".
- **Holding cost so far** for each dated layer: quantity × unit cost × rate × days ÷ 365, all in exact
  PostgreSQL `numeric` (the unit cost is **not** rounded first), then rounded **once** per layer, half away
  from zero, to whole cents. Labelled **"estimate at today's cost and rate"**. Starting-date layers are shown
  in their own column. Unknown stock gets no charge.
- **Holding cost per month from now:** 30 days at today's quantity, cost and rate, assuming the stock stays.
- **Rate:** setting `inventory_carrying_rate_bps`, a whole number of basis points (1000 = 10%), 0 to 10000.
- **Aged threshold:** setting `inventory_aged_days`, a whole number of days, 30 to 1095, starting at 270.
- **Both settings are checked by the database:** a trigger on `app_settings` rejects a non-integer or
  out-of-range value for these keys and refuses renaming or deleting either key. The report raises a clear
  error if either row is missing or bad.
- **Supplier-price check:** a quote counts only if `price_kind = quote`, `package_quantity = 1`, its
  supplier link's `inventory_units_per_supplier_unit` is exactly 1 (one supplier unit is one inventory unit),
  `price_unit` equals the product's inventory unit, `effective_from` is on or before today, `effective_to` is
  empty or not yet passed, no other observation supersedes it (checked against other rows'
  `supersedes_observation_id`), and it is no more than 90 days old. The newest qualifying quote is used, with
  vendor and date shown. Older quotes are listed for reference but never used for the exposure. Otherwise
  "not covered". Price exposure = units on hand × (price-list cost − quote). A review signal only.

## 6. Coverage and totals

- **Coverage** is shown two ways: the number of in-stock rows a column can measure, and their share of
  pricing-basis value (rows with a cost only). Quantities in different units are never added together; a
  unit-normalized quantity coverage waits for Gate 0.
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

- **Tighten write permissions** so receipts and stock-ledger rows change only through the receiving and stock
  functions (specifics in private review notes until live). This changes permissions, so it needs **Mason's
  explicit OK at build time**, plus `/security-review`, and the build first re-checks that no screen depends
  on what is removed.
- **Setting rows** `inventory_carrying_rate_bps` = `1000` and `inventory_aged_days` = `270`, inserted only if
  missing, plus the validation trigger from section 5.
- **The two tables in section 4:** Row Level Security on, no client read or write policies, in the same
  migration; triggers reject UPDATE and DELETE.
- **`get_inventory_aging_report()`**: read-only; sections 3, 5 and 6.
- **`set_inventory_age_baselines(p_rows jsonb, p_idempotency_key text)`**: bulk save. It refuses a null key;
  calls `require_admin()`; follows the existing `check_idempotency_intent` contract (a globally unique key,
  bound to the actor and a fingerprint of the full request, so the same key with different rows is refused);
  because cached keys expire, also refuses a key already stored on a batch; rejects duplicate product-location
  entries; locks the distinct inventory rows in inventory-id order; re-reads on-hand under the lock; validates
  every entry; and inserts all or none.
- Both functions are `SECURITY DEFINER` with `SET search_path = public, pg_temp`, and are revoked from
  `PUBLIC` and `anon` and granted to `authenticated` only. No new cost value is added to any shared product or
  inventory query.
- Refresh `.claude/schema-registry.json` after the live apply.

### PR 1B: screens

- `src/pages/Reports.tsx`: relabel the existing tab, columns and CSV headings; add a **"Stock age & holding
  cost"** tab through every existing integration point: the `OperationalTab` type, the admin-only tab set, the
  role-change reset, the load routing and state, the table rendering and the CSV dispatch; hide the shared date
  bar on this tab. The tab has the buckets, the reasons for unknown rows, an aged-stock filter, the
  supplier-price columns, coverage and the starting-date flow.
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
2. **Cases on a throwaway copy** (a local database or a rolled-back transaction, never live): no starting date;
   a starting date only; a starting date plus a later receipt, then a sale; a receipt in a different unit
   (row must ask for a new starting date); a count correction, a return and its cancellation, a delivery
   reversal and a receipt reversal after the starting date (each must ask for a new starting date); a stock
   change outside the ordinary actions (must fail "adds up"); a split starting point; a replaced and a removed starting
   point.
3. Spot-check three live products by hand against their receipts and starting dates.
4. A sales rep gets "admin required" from both functions and the tab does not appear for them; a signed-out
   caller is refused by database permissions and gets no data; a rep's existing product and inventory API
   responses are unchanged; after PR 1A the permission tightening is proven by the private test list, and
   receiving through the app still works.
5. Bulk save the same request twice with one key: one set of batches. The same key with different rows is
   refused. Two entries for one product, a non-finite quantity, or lines adding up to more than on-hand reject
   the whole save.
6. Bad setting values, a renamed key and a deleted key are rejected by the database.
7. Each renamed total shows the same number as before (screenshots before and after).
8. Screenshots of the new tab on desktop and phone width.

## 9. Not in Phase 1

Ledger replay; unit conversion (Gate 0); any cost entry or average cost (Phase 2); lots (D6); freight and
rebates (D7); vendor bills (Phase 4, D11); quote warnings (Phase 5); changes to the existing valuation's math;
past holding cost at past rates; ageing for products without a starting date.

## 10. Risks Mason should know

- **The report starts almost entirely "needs a starting date".** It fills in once starting dates are entered
  (one bulk session, ideally right after the stock count before busy season, D9) and as new CRX receipts
  arrive.
- **Any unusual movement asks for a new starting date** (a count correction, a return, a reversal). That is
  deliberate: simple and never wrong in a confident way, at the cost of some re-entry.
- **Starting dates are your estimates**, shown as such, against CRX's recorded on-hand.
- **Price-list cost is not purchase cost.** Holding cost is only as good as the price list until Phase 2.
- **Purchases outside CRX stay invisible.** Entering POs and receiving in CRX (D9) is what keeps it true.
