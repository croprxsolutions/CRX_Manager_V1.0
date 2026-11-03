# Product Master: Wave 2 report (2026-11-02, attempt 2)

## Current status (2026-11-03 7:15 AM Central)

**Status:** **1 landed** (Use Timing), **3 PRs open** (Corrections, One cost path, Seed/each forms), **4 waiting** on those PRs or not started. Wave 2 is **not finished**. Wave 3 has not started.

**Recommended next step:** do the WP-PM-12b click-through on its Vercel preview (steps below). It is the only open Wave 2 step that needs you.

| Package | Status | Where |
|---|---|---|
| WP-PM-5 Use Timing | **LANDED.** Migration `20261103210000` applied 11:27 PM Central 11-02 with your approval. Merged as `c69209353` at 11:31 PM. 317/317 timings back-filled with 0 mismatches. Live save test on "2, 4D Ester 6# - 2.5 Gal": two timings saved and survived a reload, then it was reverted. Read back from live: Pre-Emerge Corn only. Registry refresh merged ([#1343](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1343)). | [#1316](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1316) merged |
| WP-PM-12b Corrections | **PR open, no migration.** Sol clean on `48cfcb0bc`, carried to `da04b0823`. `40a066a63` is docs only (your EPA decision). Main was merged in since then, now head `07330f84c`. The PR is marked ready and CI is re-running. **Owed:** your preview click-through. | [#1341](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1341) |
| WP-PM-7 One cost path, tier-order warning 💲 | **Draft PR.** Luna: 1 LOW, deferred. Sol clean on exact head `f1a15f169` (about 12:35 AM Central 11-03). 18 checks pass. **Blocked:** its stamp `20261103230000` is now below live (see Stamp alert). It needs a new stamp, a re-proof and a new Sol. Also owed: a preview click-through. | [#1345](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1345) |
| WP-PM-9 Seed and each forms | **PR open (marked ready).** Sol clean on `6f99da763`. Later fix commits and a main merge make the head `21bff9bea`, which needs exact-head Sol before the apply. 20 checks pass. **Blocked:** its stamp `20261104090000` is now below live. It lands after WP-PM-7. | [#1342](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1342) |
| WP-PM-6a Unit audit | Waits on WP-PM-9 landing. Audit done (vault list). | |
| WP-PM-6b New-product flow 💲 | Waits on WP-PM-6a. | |
| WP-PM-15a Vendor proposals 💲 | Waits on WP-PM-7 landing. | |
| WP-PM-8b Incomplete badge, near-match warnings, rate help | Not started. | |
| DM-0 Data clean-up | Your data step (vault list). | |

**Stamp alert (found 7:15 AM Central).** Every database change is named with a stamp (a date and number), and a new one must sort above everything already live. Live is now at `20261104120000_balance_reports_flag_unrebuildable_customers`, applied 6:53 AM Central 11-03 by another PR. That is above both WP-PM-7's `20261103230000` and WP-PM-9's `20261104090000`. Both owner sessions were told to re-stamp with `npm run next-migration-stamp` (now on main): They agreed WP-PM-7 takes `20261104140000` and WP-PM-9 `20261104150000` (#1347 holds `20261104130000`). Each then re-runs its proof and Sol on the new head.

**Landing order:** WP-PM-12b (no migration) any time after your click-through, then WP-PM-7, then WP-PM-9, then 6a, then 6b and 15a. Each applies its migration before its merge, and the next one merges main and re-checks.

**WP-PM-12b click-through.** Preview: <https://crx-manager-v1-0-git-pm-wp-pm-12b-c-0cf32e-mason-wells-projects.vercel.app>. It saves to the live database, so use a throwaway job.
1. Open a scheduled job that has a chemical line.
2. On the Chemicals tab, type an REI different from the product's label. Save, then reload.
3. An amber notice, "Some lines differ from the product's current label", lists old → new.
4. Click "Update to current label", Save, then reload. The notice is gone and the line shows the product's value.
5. On another line with a different value, click "Keep job values". The notice hides.
6. Open a completed job. No notice appears.

**Follow-ups named this round (not Wave 2 scope):**
- a product-page list of open jobs still on old label values;
- a server-side status check in `save_job`, which does not itself refuse edits to completed jobs;
- WP-PM-7 deferred LOWs: emoji character count, older `toFixed` displays, the raw select in the cost modal.

**Still yours:** the DM-0 list and Piksi Dust Plus tidy-up (name, suggested rate, notes; cost basis still open) in your vault; delete the REAL-DATA-OK note in `C:\CRX_Manager` if it is still there.

## Packages (as of the run's end, 2026-11-02 7:47 PM Central)

**Status then:** of the 9 Wave 2 packages left after attempt 1: 1 drafted (Use Timing), 6 parked, 2 not attempted. The run ended at the closeout deadline. The sections below are that run's record.

| Package | Status | PR / where |
|---|---|---|
| WP-PM-5 Use Timing | **DRAFTED** (see CI note below) | [#1316](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1316), head `9f5b63928`; **Mason-gated** migration `20261103210000` |
| WP-PM-9 Seed and each forms | **PARKED**: failed review after 3 build rounds (Sol found 2 HIGH) | branch `pm/wp-pm-9-forms-seed-each` at `19551a7ba`, backed up to GitHub (no PR) |
| DM-0 Data clean-up lists | **PARKED**: the lists are done; the data step is yours | your vault: `Products\Product Master review\2026-11-02 DM-0 data hygiene review list.md` |
| WP-PM-6a Unit audit | **PARKED**: waits on WP-PM-9; audit half done | your vault: `Products\Product Master review\2026-11-02 PM-6a unit mismatch list.md` |
| WP-PM-6b New-product flow, Duplicate 💲 | **PARKED**: waits on WP-PM-6a | |
| WP-PM-7 One cost path, tier-order warning 💲 | **PARKED**: time; one build round done, review fixes owed | branch `pm/wp-pm-7-cost-path` at `31436cc01`, backed up to GitHub (no PR) |
| WP-PM-15a Vendor proposals 💲 | **PARKED**: waits on WP-PM-7 | |
| WP-PM-12b Corrections | not attempted (no new package after 18:32) | |
| WP-PM-8b Incomplete badge, near-match warnings, rate help | not attempted (no new package after 18:32) | |

### WP-PM-5 Use Timing: DRAFTED, [#1316](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1316)

**What it does:** a product can have several use timings. Post-Emerge Corn, Post-Emerge Soybeans and Pre-Emerge are added; Post-Emergence stays. Only Herbicide and Foliar Fertilizer have timings. The product page uses checkboxes and asks before a category change clears the timings. The old single timing text is kept by the database as the timings joined with "; ", so the price workbook, bulk import and change history keep working, and no money function was touched.

**Proof:**
- the database proof (`PRODUCT_USE_TIMINGS_PROOF_PASS`) shows all 317 existing timings copied exactly;
- a real workbook export, preview and apply keeps both timings with prices unchanged;
- the full test suite passed on the round-2 head (7,069 tests);
- the guard regression suite passed 49 of 49 locally on the final fix;
- Sol is clean on `fcf1260ce`.

**Owed:**
- **CI:** CI on `0b90a1767` failed one guard check: the migration's record carried the Windows line-ending hash of the file instead of the repo's LF hash. Corrected in `62c349481`, then main merged in as `fcf1260ce`, re-checked locally (49 of 49 guard suites) and pushed at 7:24 PM Central. **Every CI check on `fcf1260ce` passed** (read at 9:01 PM Central).
- **New date stamp (after the run):** at 7:57 PM Central another PR's migration, stamped `20261103150000`, was applied live, which put #1316's original `20261103140000` below the live high-water. At 9:40 PM Central it was pushed re-stamped `20261103210000` (`160000` and `170000` were already taken by other sessions), with the latest main merged in. The proof was re-run and passed (`PRODUCT_USE_TIMINGS_PROOF_PASS`; its test database now gets live's active Main Warehouse before replaying KI-85), the docs check passed, and Sol re-ran (below). CI on the new head runs after this report.
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
- a new timestamp above `20261103210000` (its `20261103150000` is now taken by a live migration from PR #1313);
- a stated $0 tier must count as a real price, per your 2026-10-27 decision;
- more proof cases.

## Suggested merge order

1. **#1276** (turning products off; another session is landing it).
2. **#1316** (Use Timing): wait for CI on `9f5b63928`, then apply its migration first, with your `I approve`, then merge.
3. Later, after their next rounds: WP-PM-9 (new timestamp), then WP-PM-6a, WP-PM-7, WP-PM-15a.

Every PR targets `main`, so after one lands, the next must merge `main` in and re-check before landing.

## Mason-gated migrations

- `20261103210000_product_use_timings.sql` (#1316): adds column grants on `products` matching `use_timing`'s grants. Needs your `I approve`.

## Tests, builds and events

- **Baseline on `main` at start:** typecheck, build and lint passed; 7,047 tests passed, none failed.
- **WP-PM-9** on `19551a7ba`: full suite 7,078 passed, none failed.
- **WP-PM-5:** full suite 7,069 passed on `3c8b77f5f`. The local full suite on the fix head was stopped to free the build folder; CI runs it.
- **Codex:**
  - WP-PM-5 round 1 hit the 50-minute limit while re-running its own final check, with the work complete.
  - WP-PM-7's Codex ran one read-only `git fetch` despite the no-network instruction; nothing changed.
- **Schema registry:** refreshed read-only from live at the start and again at 9:08 PM Central (high-water `20261103015728`; only the applied-migration list changed), and left uncommitted in this session's worktree for you.
- **Shared test app:** port 5199 is held by a test-app frontend nobody claims (node PID 45156, started 10:20 today). Neither this run nor the #1276 session stopped it, so **no browser proof ran this run**. If it isn't yours, it is safe to close.

## CodeRabbit

- #1316: requested once after Sol. It found 2 comments (a preflight hole for a timed product with no category, and an unreachable display branch); both were fixed by Codex.
- No other PR was opened.

## Sol proofs

- #1316: clean on `604b763e5` at about 9:35 PM Central (11-02). It was carried to head `9f5b63928` by the collision check, because main's new commits touched only `ship.md`, `package.json` and `scripts/sol-needed.mjs`. **It passes 24 hours at about 9:35 PM Central on 2026-11-03.** The live apply needs Sol on the exact final head, so the landing session re-runs Sol right before the apply.
- Earlier clean proofs on `3c8b77f5f`, `0b90a1767` and `fcf1260ce` no longer match the head.

## Decision for you

1. Land #1316 (your `I approve` for its migration).
2. Approve WP-PM-9's 4th round, so seed and each forms can draft and unblock WP-PM-6a and 6b.
3. Your data steps from the two vault lists (DM-0 and the unit mismatches), starting with Piksi Dust Plus's price.

## Attempt 1 (2026-11-01 night), for reference

Drafted change history (#1266), turning products off (#1276, after your approved rounds 4-6) and the first half of setup checks (#1272). #1266 and #1272 are merged and their migrations are live; #1276 is being landed by another session.
