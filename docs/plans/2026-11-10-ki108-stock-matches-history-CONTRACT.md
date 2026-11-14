# KI-108 — make five products' stored stock match their history (behavior contract)

Read at `462212c7e` (origin/main) and live read-only on 2026-11-10.

## Outcome and authority

- **Business result.** The `/integrity-report` stock-vs-history check passes for all products. Mason decided
  on 2026-11-10, in chat: trust the transaction history. For 2,4D Amine 4# - 2.5 Gal, whose history adds up to
  −70 because the March opening load was never recorded, keep the stored 25 and add the missing +95
  opening-stock row (Mason, 2026-11-10: "Keep 25, add +95").
- **Change.** One data-only migration, `supabase/migrations/20270103150000_ki108_stock_matches_history.sql`,
  plus its changelog record. No function, policy, screen or code change. Files: the migration, its proof
  script, its changelog note, this contract. `docs/manual/KNOWN_ISSUES.md` KI-108 is updated to FIXED after
  the live apply, once docs PR #1760 (which rewrites that entry) has landed, to avoid a conflict.
- **Who acts.** Nobody through the app. The migration runs once as the migration owner. The +95 row is recorded
  as performed by Mason's admin profile (`22c1fc50-…`, verified live: role admin, active), who approved it.

| Inventory row (Main Warehouse) | Product | Stored now | After | How |
|---|---|---|---|---|
| `b9ec0d1b-…` | Black Strap Molasses Sugar - Tote | 2000 | 675 | stored set to history |
| `4f3d6b53-…` | Start Right 2.0 (AgBio) - Tote | 670.19 | 140.19 | stored set to history |
| `ee742c21-…` | 2, 4D Amine 4# - Bulk | 55 | 0 | stored set to history |
| `3d13a723-…` | Start Right 2.0 (AgBio) - 2.5 Gal | 290 | 280 | stored set to history |
| `ac6b4862-…` | 2, 4D Amine 4# - 2.5 Gal | 25 | 25 | +95 `adjusted` ledger row (history −70 → 25) |

Black Strap Molasses Sugar - Bulk stays at −1,325, which already matches its history.

## State and failure

- **Rules that always hold.** After the migration, for these five rows, stored `quantity_available` equals the
  ledger total computed as `checkInventoryLedger` does (`src/lib/reconciliation.ts`, including the
  `PREBOOK_ONLY_ADJUSTMENT_TX_IDS` exclusion, used in both the pre- and post-check). `quantity_prebooked` is
  untouched (0 on all five). The migration checks this after writing and raises if it fails, so the whole
  change rolls back. It promises nothing about other products: after the apply, the all-products check is
  re-run on live read-only and any new mismatch is reported as its own issue.
- **Existing rows.** The migration binds a signature of the approved state per product: inventory row id,
  stored and pre-booked quantity, ledger total, ledger row count and newest movement time; plus exactly one
  inventory row per product and no `in_progress` cycle count on it (a count snapshots expected stock when it
  starts, so one opened before the correction would carry a stale difference; completing a count adds that
  difference with a matching ledger row, live `_complete_cycle_count_impl`; none is open today, all 17 counts
  are cancelled). The migration also locks `cycle_counts` and `cycle_count_items`, so a count whose rows are
  written while it runs waits until it commits (Luna round 1). The lock cannot cover a count screen that read
  stock in the browser before the apply and saves after it (`CycleCounts.tsx` ~L286): that is the existing
  KI-134 (any stock movement during an open count), not new here (Luna round 2, refuted as pre-existing). The
  post-apply check (case 5) therefore also lists any `in_progress` count holding one of the five products with an
  `expected_qty` other than the new stored value; if one exists, it is cancelled and restarted before it is
  completed.
  Any difference raises `KI108_PREIMAGE_DRIFTED` and changes nothing. The no-op path is taken only when none of
  the five **products** exist (schema-only rebuild); products present with other inventory rows raise. The
  signature is not a row-by-row copy of the history; on production, where the ledger is append-only, any new
  movement changes the count.
- **If it is refused.** Re-run the read-only check. If each product's gap is unchanged, refresh the bound
  values in a new reviewed migration (target = stored minus the same gap). If a gap changed, ask Mason again.
- **Timing.** The migration takes write locks on `inventory`, `inventory_transactions`, `cycle_counts` and `cycle_count_items` with a 5-second
  lock timeout and a 60-second statement timeout, so it fails rather than queue behind a long transaction. A
  lock-order deadlock with a writer makes one side fail and roll back; the migration can simply run again.
  App writers cannot later overwrite the result with a stale absolute number: the inventory screen's bulk edit
  may change only `reorder_point` and `min_stock_level` (`src/pages/InventoryPage.tsx:1244`), and
  `adjust_inventory` takes a delta (live body). The live apply runs as one transaction; `LOCK TABLE` outside a
  transaction errors, so a wrong runner fails before writing.
- **Side effects.** `trg_inventory_significant_change` writes an activity-feed line only when `auth.uid()` is
  set; with no request identity in the migration session none appears (harmless if one does). The audit trail
  is the +95 row's note, this migration, and the changelog record, which lists all four before/after values.
  The note records an approved reconciliation and calls unrecorded opening stock the likely cause, without
  asserting it. The +95 row is dated at apply time, not back-dated to March. The only database function reading
  `inventory_transactions` (`_get_inventory_position_cost_impl_20261019`) reads delivery types only. Screens
  that read the ledger: the transaction ledger modal and the integrity report. `performed_by` records the
  approving person (the profile must exist), not a current-permission check.
- **Undo.** Ledger rows cannot be deleted (immutability trigger). Undo is a new reviewed migration that binds
  the post-apply state the same way (refusing if anything moved since), restores the four stored values and adds
  one −95 row. It is not pre-written.

## Delivery

One PR: the migration, its proof script and docs. No screen depends on it. Sol is required (database path);
apply live before merge through the apply gate, after the Taha hold, with Mason's explicit yes immediately
beforehand. If the PR then changes or fails to merge, the follow-up is a new migration, never an edit.

## Proof cases

`node scripts/smoke/prove-ki108-stock-matches-history.mjs`: an offline, disposable PostgreSQL 17 container
from the checked-in baseline, seeded with the bound inventory rows and synthetic ledger rows matching the bound totals, counts and newest times (public repo: no live movement history; Sol round 1 MED), with `inventory` and `inventory_transactions`
columns, types, nullability and unique key asserted equal to live. Run 2026-11-10: PASS.

1. When the migration runs on today's five rows and histories, then the four stored values change as in the
   table, 2,4D 2.5 Gal stays 25 with one new +95 `adjusted` row, and the ledger check passes for every row.
2. When the state differs (one more delivery, a changed stored value, pre-booked stock, a missing row, the same
   products with regenerated row ids, a second location, an in-progress cycle count), then it raises
   `KI108_PREIMAGE_DRIFTED` and nothing changes. When it fails after writing the +95 row, nothing is kept.
3. When none of the five products exists, then it does nothing and raises nothing.
4. When it has run, Black Strap Bulk and an unrelated product are unchanged, and a second run is refused.
5. After the live apply: the read-only all-products check, and the `/integrity-report` page's Inventory Ledger
   check passes or lists only products other than these five; and no `in_progress` cycle count holds one of
   the five products with a stale `expected_qty` (KI-134).

## Cold challenge (gpt-6-astra, high, 2026-11-10): 30 findings, all settled

- Fixed in the migration: lock and statement timeouts (7); one inventory row per product (4); no-op only when
  the products are absent (3); one exclusion rule in the pre- and post-check (5, 30); open cycle count
  refused (from 9); note no longer asserts the cause (23); actor check is existence only (22).
- Fixed in the proof script: a failure after writing rolls back (16); regenerated ids, second location and
  cycle-count cases (3, 4); the SQL oracle filters exclusions as the app does (17); fidelity covers types and
  nullability (14); the passing run is recorded above (15).
- Fixed in this contract: "signature", not "exact" (6); what to do when refused (25); scope is these five rows,
  with an all-products check after apply (13); undo is a guarded new migration (1, 2); a disposable container
  instead of an explicit ROLLBACK run (18); runner, migration-ledger and merge-after-apply handling (10, 11,
  12); dated at apply time (24, a technical audit choice, not a business one).
- Disproved: stale absolute writes from the app (9: bulk edit is limited to two non-stock fields,
  `adjust_inventory` takes a delta); a deadlock leaves nothing partial (8: one side fails and rolls back).
- Left to the delivery gates: Sol, Taha hold, apply gate (26); migration order (27: newest on disk is
  `20270101000000`).
- Declined: per-role reads (19), because the new row has the same shape and owner as existing `adjusted` rows,
  so every role sees it as it sees those; screen caching (20), covered by loading the page after apply (case
  5); a separate admin correction record (28), because the changelog lists every before/after value;
  green-result limits (29), stated in KI-108.
- No new business decision was raised.

## Open business decisions

None. Mason settled both on 2026-11-10 (history wins; keep 25 and add +95 for 2,4D 2.5 Gal).
