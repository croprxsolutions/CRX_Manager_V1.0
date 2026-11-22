# Behavior contract: one short-stock warning per short product on delivery completion (#2135)

Read on `origin/staging` `84e8df019` (2026-11-22). Lane C of the 2026-11-22 high-bug sprint. Split out of the joint
C1+C2 contract after the cold challenge (Astra, gpt-6.2-astra high, 2026-11-22) suggested shipping it alone (its
finding 52); the follow-up-remainder half (KI-188) has its own contract and PR.

## Facts (with source, confirmed on a fully migrated database)

- Call chain: `complete_delivery` → replay/evidence wrappers (`20261019200000`, `20261022075000`) →
  `_complete_delivery_period_preflight_impl` (body created by `20260716191000` as `complete_delivery`, renamed by
  `20260716202000`, never redefined; md5 `a9f80dc25207eba595e9998409e9ceb9` on the migrated build) →
  `_complete_delivery_aggregate_impl` (`20270106110000`, brand settings only) → `_complete_delivery_authorized_impl`
  → `_complete_delivery_authorized_impl_20270122` (body `20270203120000`).
- The inner body (#1942, `20270203120000` ~L456-495) sums each product's effective quantity across the delivery's
  lines (`p_quantities` honoured, 0-quantity lines skipped) and marks a product short once when the warehouse row is
  missing or on-hand is below that total. It writes the ledger row's `[SHORT STOCK — review required]` note and
  `requires_review` itself (~L528-543), one `delivery_short_stock` activity and one `stock_warning` notification per
  active admin (~L853-879), and returns `short_stock_count`, `stock_warning`, `warnings[]` (~L892-907).
- The outer wrapper flags a product when every line fits but the total does not, a subset of the inner rule, then
  writes a second activity, a second notification set and rewrites the saved receipt with the added count. It is the
  only setter of `app.delivery_aggregate_short_*`, which the ledger trigger `_mark_delivery_aggregate_short_stock`
  reads (grep of migrations, src, scripts).
- The screens read `stock_warning` / `short_stock_count` from the result for a toast (`DeliveryDetail.tsx` ~L1352,
  `QuickDeliveryModal.tsx` ~L466); they need no change.

## 1. Outcome and authority

- **Outcome.** Completing a delivery warns once per short product: `short_stock_count` = number of distinct short
  products, one warning text each, one `delivery_short_stock` activity row for the delivery and one `stock_warning`
  notification per active admin, whatever the number of short products. No warning when stock covers the delivery.
- **Unchanged.** Stock movements, ledger rows, their notes and review flags, who may complete (admin, sales rep,
  assigned driver), the replay lookup (before any write), the existing-stock-row lock pass (C3/#2190's area), the
  trigger (stays, now inert).
- **Change.** One migration re-emits the outer body without its duplicate check and its writes. Private function,
  EXECUTE stays revoked from API roles.

## 2. State, timing, history

- Same transaction and lock order as today (the outer lock pass is kept byte for byte). Replay with the same key
  returns the saved receipt and writes nothing.
- Receipts, activity rows and notifications written before the change stay as they are (no data change). A replay of
  an old key can still return an old doubled receipt; that is the saved answer to that request.
- Baseline check: the migration refuses unless the wrapper body is exactly the md5 above (a later redefinition or a
  second apply stops it before any change); refuses autocommit; postflight pins the new md5, SECURITY DEFINER,
  `search_path = public, pg_temp` and no API-role EXECUTE.

## 3. Proof cases (real migrated DB, `scripts/smoke/prove-single-short-stock-warning-real-schema.mjs`)

Each case completes the delivery through `complete_delivery` signed in as the admin, on the old body and on the new
one, and compares.

1. Two lines of one product, each fitting on-hand 10, together 12: old count 2 (bug), new count 1, one warning, one
   activity, one notice.
2. Two short products (one repeated-line, one individually short) plus a covered product: count 2, two warnings, one
   activity, one notice per admin.
3. Covered delivery: count 0, no warning, no activity, no notice.
4. Repeated lines delivered partially (4 + 4 of on-hand 10): count 0.
5. Product with no warehouse row: count 1.
6. In every case the ledger rows (product, quantity, note, review flag) and on-hand are identical to the old body's,
   and a replay with the same key returns the same receipt and adds nothing.
7. Apply refuses autocommit and a second apply; reverse script restores the old body byte for byte, keeps API roles
   out, and the candidate re-applies.

## Challenge settlement (C2 findings of the 2026-11-22 Astra challenge)

- 37 (count per product) and 38 (filter by event type): adopted; cases 1-3 count per distinct product and filter by
  delivery, `delivery_short_stock` and `stock_warning`.
- 39 (chain): confirmed above from the migrations and the migrated build's md5.
- 40 (more fixtures): cases 2-5 added; ledger/stock compared old vs new.
- 41 (missing-row concurrency): unchanged by this file (lock pass kept); owned by C3 (#2190).
- 42 (trigger still reads settings): only setter removed (grep); the trigger stays because the smoke spec lists it and
  dropping it is not needed to fix the bug.
- 43 (what the driver sees): the toast reads the returned count; with one count it shows one.
- 44 (history): routine; history kept as written (section 2).
- 49/50 (baseline drift, rollback): md5 preflight; reverse proven byte for byte with re-apply.

## Open business decisions

None.
