# Product Master: Wave 2 report (2026-11-02, attempt 2)

**Status:** of the 9 Wave 2 packages left after attempt 1: **1 drafted** (Use Timing, [#1316](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1316)), **6 parked**, **2 not attempted**. Run: 2026-11-02 12:32 to 19:47 Central (Wave 2, attempt 2). It ended at the closeout deadline.

**Recommended next step:** land **#1316 (Use Timing)** in a normal session. Its migration changes column grants on the products table, so the landing session will show you a summary and ask for your `I approve`. The migration must be applied **before** the merge. Otherwise every product list and picker fails to load, because the screens select the new column.

## Packages

| Package | Status | PR / where |
|---|---|---|
| WP-PM-5 Use Timing | **DRAFTED** (see CI note below) | [#1316](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1316), head `0b90a1767`; **Mason-gated** migration `20261103140000` |
| WP-PM-9 Seed and each forms | **PARKED**: failed review after 3 build rounds (Sol found 2 HIGH) | branch `pm/wp-pm-9-forms-seed-each` at `19551a7ba`, on this PC only |
| DM-0 Data clean-up lists | **PARKED**: the lists are done; the data step is yours | your vault: `Products\Product Master review\2026-11-02 DM-0 data hygiene review list.md` |
| WP-PM-6a Unit audit | **PARKED**: waits on WP-PM-9; audit half done | your vault: `Products\Product Master review\2026-11-02 PM-6a unit mismatch list.md` |
| WP-PM-6b New-product flow, Duplicate 💲 | **PARKED**: waits on WP-PM-6a | |
| WP-PM-7 One cost path, tier-order warning 💲 | **PARKED**: time; one build round done, review fixes owed | branch `pm/wp-pm-7-cost-path` at `31436cc01`, on this PC only |
| WP-PM-15a Vendor proposals 💲 | **PARKED**: waits on WP-PM-7 | |
| WP-PM-12b Corrections | not attempted (no new package after 18:32) | |
| WP-PM-8b Incomplete badge, near-match warnings, rate help | not attempted (no new package after 18:32) | |

### WP-PM-5 Use Timing: DRAFTED, [#1316](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1316)

**What it does:** a product can have several use timings. Post-Emerge Corn, Post-Emerge Soybeans and Pre-Emerge are added; Post-Emergence stays. Only Herbicide and Foliar Fertilizer have timings. The product page uses checkboxes and asks before a category change clears the timings. The old single timing text is kept by the database as the timings joined with "; ", so the price workbook, bulk import and change history keep working, and no money function was touched.

**Proof:**
- the database proof (`PRODUCT_USE_TIMINGS_PROOF_PASS`) shows all 317 existing timings copied exactly;
- a real workbook export, preview and apply keeps both timings with prices unchanged;
- the full test suite passed on the round-2 head (7,069 tests);
- Sol is clean on `0b90a1767`.

**Owed:**
- **CI:** at 19:10 Central, CI on `0b90a1767` was still running (10 passed, 6 pending); the earlier head `3c8b77f5f` passed all 20.
- **Clicks:** a browser click-through on the Vercel preview after the live apply. The exact clicks are in the PR.

**CodeRabbit:** 2 comments, both fixed by Codex and their threads resolved.

### WP-PM-9 Seed and each forms: PARKED

**What it does:** adds Seed (stocked in Lb or Unit) and Each / unit (Ea or Unit). Seed and each products never convert between units. Their rate unit, and every quote line's units, must be the stock unit.

**Why this matters (found while grounding):** the per-acre price and the quote save read a blank unit as one ounce. Without these rules, a seed product stocked in pounds could price at 1/16.

**Why it parked:** after 3 build rounds, Sol found 2 HIGH issues. A seed job line can still be saved in a different unit, which lets job completion take the wrong amount from stock. And a blank quote unit does not stop a product with no form from becoming seed. Both are small fixes. Neither can happen today, because no seed or each products exist.

**Next step:** approve a 4th round. It adds a guard on job lines and blocks blank quote units, then reruns Sol. The migration's timestamp `20261102210000` is now below live and needs a new one in that round.

### DM-0 Data clean-up: PARKED for your data step

The list in your vault covers:
- 11 products with no form, each with a proposed form (8 "each", 3 "liquid");
- 13 products with no SKU (you type them);
- the duplicate SKU `9768NR` (the row with the orders keeps it);
- 3 groups of products sharing a name, including two "MicroNourish - Tote" rows that are exact duplicates with orders on both (a complicated merge), and a "Vixen D - 12#" set up once as liquid and once as dry;
- 4 test rows (two hold old stock that needs an approved adjustment).

Nothing was changed.

### WP-PM-6a Unit audit: PARKED (audit done; the build waits on WP-PM-9)

- **The audit:** 594 of 604 products have matching units. 8 have a blank Unit (products made on the product page, which has no Unit box), and one differs only in capital letters.
- **One real pricing risk:** "Piksi Dust Plus - 1800G Jar" is stocked in milligrams but billed by dry ounces on jobs. **Check its price before it goes on a job.**
- **Proposed design:** the stock unit becomes the one priced unit, and the database keeps Unit in step on new and changed products. Existing rows wait for your approval, row by row; there is no back-fill.

### WP-PM-7 One cost path and tier-order warning: PARKED (time)

**What round 1 built:**
- Current Cost becomes read-only, and the reason is asked once;
- a pick list for the price source;
- a new warning when Tier 2 is priced below Tier 1, or Tier 3 below Tier 2. It sits in the database, so the workbook, the list and the product page all must acknowledge it.

Its proof shows the five existing warnings are unchanged. Only 3 active products are already out of order.

**Fixes owed (round 2 is written, not run):**
- a test file whose special characters were garbled;
- a timestamp that collides with PR #1313;
- a stated $0 tier must count as a real price, per your 2026-10-27 decision;
- more proof cases.

## Suggested merge order

1. **#1276** (turning products off; another session is landing it).
2. **#1316** (Use Timing): apply its migration first, with your `I approve`, then merge.
3. Later, after their next rounds: WP-PM-9 (new timestamp), then WP-PM-6a, WP-PM-7, WP-PM-15a.

Every PR targets `main`, so after one lands, the next must merge `main` in and re-check before landing.

## Mason-gated migrations

- `20261103140000_product_use_timings.sql` (#1316): adds column grants on `products` matching `use_timing`'s grants. Needs your `I approve`.

## Tests, builds and events

- **Baseline on `main` at start:** typecheck, build and lint passed; 7,047 tests passed, none failed.
- **WP-PM-9** on `19551a7ba`: full suite 7,078 passed, none failed.
- **WP-PM-5:** full suite 7,069 passed on `3c8b77f5f`. The local full suite on the fix head was stopped to free the build folder; CI runs it.
- **Codex:**
  - WP-PM-5 round 1 hit the 50-minute limit while re-running its own final check, with the work complete.
  - WP-PM-7's Codex ran one read-only `git fetch` despite the no-network instruction; nothing changed.
- **Schema registry:** refreshed read-only from live at the start, and left uncommitted in this session's worktree for you.
- **Shared test app:** port 5199 is held by a test-app frontend nobody claims (node PID 45156, started 10:20 today). Neither this run nor the #1276 session stopped it, so **no browser proof ran this run**. If it isn't yours, it is safe to close.

## CodeRabbit

- #1316: requested once after Sol. It found 2 comments (a preflight hole for a timed product with no category, and an unreachable display branch); both were fixed by Codex.
- No other PR was opened.

## Sol proofs

- #1316: clean on `0b90a1767` at 2026-11-03 00:06 UTC (7:06 PM Central, 11-02); **it passes 24 hours at 7:06 PM Central on 2026-11-03.**
- The earlier clean proof on `3c8b77f5f` (5:04 PM Central) no longer matches the head.

## Decision for you

1. Land #1316 (your `I approve` for its migration).
2. Approve WP-PM-9's 4th round, so seed and each forms can draft and unblock WP-PM-6a and 6b.
3. Your data steps from the two vault lists (DM-0 and the unit mismatches), starting with Piksi Dust Plus's price.

## Attempt 1 (2026-11-01 night), for reference

Drafted change history (#1266), turning products off (#1276, after your approved rounds 4-6) and the first half of setup checks (#1272). #1266 and #1272 are merged and their migrations are live; #1276 is being landed by another session.
