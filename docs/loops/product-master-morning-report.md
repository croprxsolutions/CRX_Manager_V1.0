# Product Master: Wave 2 morning report (2026-11-02)

**Status:** 2 drafted (change history; the first half of setup checks), 1 parked, 8 not attempted, of 11. Run: 2026-11-01 21:50 to 04:25 Central. No new package may start after 03:50, so the run ended there, inside the 05:50 wrap (Wave 2, attempt 1).

**Recommended next step:** land **#1266 (change history)** first. It passed every check, and every other database package in this wave stacks on it. Its live apply needs your own `I approve`, for the reason under "Mason-gated migrations". Its Sol proof stays valid until about 11:15 PM Central tonight (2026-11-02).

## Packages

| Package | Status | PR / where |
|---|---|---|
| WP-PM-12a Change history | **DRAFTED** | [#1266](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1266) |
| WP-PM-3 Turning products off safely | **PARKED** (Sol HIGH after 3 rounds) | branch `pm/wp-pm-3-turn-off-safely` at `c13fa0298`, on this computer only |
| WP-PM-8 Setup checks (split: 8a now, 8b later) | **DRAFTED** (8a); 8b not attempted | [#1272](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1272) |
| WP-PM-9 Forms, units, containers | not attempted (time; needs PM-8) | |
| DM-0 Data hygiene | not attempted (time; needs PM-8, PM-9) | |
| WP-PM-5 Use Timing | not attempted (time; needs PM-8) | |
| WP-PM-6a Unit audit | not attempted (time; needs PM-9) | |
| WP-PM-6b New-product flow, Duplicate 💲 | not attempted (needs PM-6a) | |
| WP-PM-7 One cost path, tier order 💲 | not attempted (time) | |
| WP-PM-15a Vendor proposals 💲 | not attempted (needs PM-7) | |
| WP-PM-12b Corrections | not attempted (time) | |

Each package took about two and a half hours, including three independent review rounds, so the wave was always going to be longer than one night.

### WP-PM-12a Change history: DRAFTED, [#1266](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1266)
- **What it does:** each product page shows who changed which setup field, when, and old → new. The database writes it in the same save, so no screen can skip it and nobody can edit it. Cost, margin and price stay out.
- **Proof:** the real-schema database proof passed; 6,964 unit tests passed, none failed; all 20 browser tests on the test app passed, including a saved signal word showing the staff member's name after reload. All 20 CI checks are green.
- **Owed:** a Mason-session click-through on the Vercel preview. After apply: run `list_migrations`, regenerate the schema registry and types, then switch the card off `supabaseUntyped`.
- **Migration:** **Mason-gated** (see below). Sol clean on `2bb7bfdfb`.
- **CodeRabbit:** labelled and reviewed. One comment, about two old test scripts, was refuted on the thread (they never replay this migration); CodeRabbit agreed. No fix commit.
- **Not proven:** multi-row update, product-delete refusal, `use_timing` rewrite, trigger order.

### WP-PM-3 Turning products off safely: PARKED
- **Why:** after the three build rounds the mission allows, Sol found one HIGH. Raising the ordered quantity of a turned-off product on an existing order line is not blocked, and that is a new sale. The guard deliberately left held lines editable, so the one live open order that holds a turned-off product keeps working, and the quantity case slipped through.
- **Everything else passed:** three independent reviews found 1 BLOCKER and 13 HIGH between them, all fixed and confirmed by a re-review. The database proof passed (including two real sessions racing a deactivation in both orders), 6,996 unit tests passed, and all 24 browser tests passed. In the browser, the row button refuses with the order named, a stock warning is confirmed, and an inactive product is reactivated.
- **Exact next step (needs your OK for a fourth round):** refuse an *increase* in ordered quantity on order, quote and PO lines for a turned-off product (decreases and other edits stay allowed), add a proof case, rerun Sol, then open the draft PR. The branch stacks on #1266.
- **Also owed when it resumes:** pin the live bodies of the three inventory functions it re-creates before replacing them (a review MED). After a fourth round, Claude also made small test-and-docs-only fixes.
- **For you to confirm when it lands:**
  1. Voiding a delivery that would put a turned-off product back on an open order is refused until reactivation. Voiding a delivery of other products on the same order still works.
  2. Draw-down from a booking, season rollover and copying a quote refuse a turned-off product.
  3. A PO receipt reversal can reopen a PO holding a turned-off product. This is allowed so stock corrections stay possible.
- **Also in it:** retired stock with a balance stays visible in inventory and in the admin inventory value (💲 display only).

### WP-PM-8a Setup checks: DRAFTED, [#1272](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1272)
- **What it does:** Category is a pick list from a new admin-maintained table: the 11 categories in use plus **Seed**. The database refuses a blank or space-padded name, an empty SKU or EPA string, a badly formatted EPA number, a negative or non-finite rate, and negative REI/PHI, but only when that field changes. The 16 old products that don't meet these rules keep working, so a price change, notes edit or deactivation on them succeeds. An existing product's form and units are locked until the reviewed unit change (WP-PM-6a); a first-time choice is allowed. Bulk import follows the same rules.
- **Proof:** all 20 CI checks are green. The real-schema database proof passed; 7,043 unit tests passed, none failed; all 24 browser tests passed, including a blank name and a bad EPA number refused on the product page and Seed saved with a first form choice.
- **Smaller safe variant (said plainly):** the sheet's "a Form change asks before clearing units" is a lock on saved products for now, as the sheet's dependency rule requires. The incomplete badge and filter, the near-match warnings for vendor and manufacturer, and the rate help text are **WP-PM-8b**, not started.
- **Owed:** a Mason-session click-through on the Vercel preview; the three open CodeRabbit fixes (below), then exact-head Sol. At apply, keep the time between apply and deploy short, because until the new screen deploys the old screen can type an off-list category and would get a database error.
- **Migration:** routine; applies after #1266's. Sol clean on `3feefee69`.
- **Reviews:** three Codex rounds. Compliance found 2 HIGH, and drift and security found 2 HIGH. The worst would have blocked price changes on the 16 old products. All fixed, and a re-review confirmed each fix. Claude fixed a unit name in the proof's test data.

## Suggested merge order
1. **#1266** change history (stacks on nothing).
2. **#1272** setup checks, after #1266. Refresh it after #1266 lands and recheck.
3. WP-PM-3, after its fourth round. It stacks on #1266, so refresh it after #1266 lands and recheck.

Every PR targets `main`. After a prerequisite lands, refresh and recheck the dependent PR's diff before landing it.

## Mason-gated migrations (need your `I approve`)
- **#1266, `20261102100000_product_change_history`.** Nothing in it deletes data. Its append-only history table refuses TRUNCATE, and the owner-approval classifier reads that word as a data-deleting migration. That is a false positive, but the protection stays as it is, so the apply waits for you.

- #1272 (`20261102102000_product_setup_checks`) is routine, with no access change and no classifier category. It still needs exact-head Sol at apply.

## Tests, builds and events
- Baseline at start: typecheck, build and lint passed; 6,917 tests passed. One failure came from my own tree switch, and that file passed 22 of 22 alone.
- All three Wave 1 PRs still open at the start (#1250, #1252, #1255) merged during the night, and main also took #1264, #1265, #1267 and #1271. Each package merged the newest main before Sol.
- **Codex events:** one, at 23:33. WP-PM-3's first round ended on `Selected model is at capacity`. §6 says a Codex API error ends the run early. I judged one capacity message a passing condition, kept the same model and continued. No further errors. This is recorded in the ledger.
- `CURRENT_STATE.md` and `KNOWN_ISSUES.md` were re-stamped 2026-11-02 for a live ledger read only (high-water `20261101181836`, 1,089 rows). A 2026-11-02 migration requires that stamp.

## CodeRabbit
- #1266: requested after Sol; one comment, refuted; no fixes kept.
- #1272: requested after Sol at 04:03 and reviewed, with 5 comments. **Refuted and resolved (2):** the live-function list (trigger functions are not RPCs) and product hard-deletes (no app path deletes products). **Valid, left open for the landing session (3):** trim a category name after collapsing its whitespace (a raw error instead of a clear message for a tab-padded name); bound a browser test's keyboard loop by the vendor option count; a KNOWN_ISSUES note. These go in one reviewed Codex round, then exact-head Sol before apply, because tonight's three build rounds were used.
- WP-PM-3: not requested (parked before a PR).

## Sol proofs (each stays valid for 24 hours)
- #1266: clean on `2bb7bfdfb`, about 23:15 on 2026-11-01. Valid until about **23:15 on 2026-11-02**. Main touched `ProductDetail.tsx` (#1271) after it, so the landing session must check whether the carry-forward still holds.
- #1272: clean on `3feefee69`, about 03:59 on 2026-11-02. Valid until about **03:59 on 2026-11-03**.

## Decision for you
- Land #1266 before the next wave, and approve its apply.
- Say yes or no to a fourth round for WP-PM-3.
- Land #1272 after #1266, or hold it until WP-PM-8b lands, if you'd rather ship setup checks as one change.

## Private review lists
`Products\Product Master review\2026-11-02 PM-8 setup check cleanup list.md` in your private vault: 16 products that don't meet the new setup checks. Only one needs a real decision: an EPA number missing its second part.
