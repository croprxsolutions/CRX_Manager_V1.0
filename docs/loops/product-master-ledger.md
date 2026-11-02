# Product Master loop ledger

**Run:** Wave 1, attempt 1. **Started:** 2026-11-01 13:20 America/Chicago. **Hard wrap:** 21:20; no new package after 19:20; closeout by 20:35.
**Coordinator branch:** `loop/product-master-w1-r1-2026-11-01`. **Build worktree:** `C:\CRX_PMBuild`. **Base:** `origin/main` at `2538335c5`.

## Step 0

- **Plan on main:** section 4a and the wave table are present on `origin/main`.
- **Context size:** `autoCompactWindow` is 800000, no `modelSettings` override.
- **Validator:** MISSION DOC OK; one expected warning (build worktree did not exist yet).
- **Collision check:** no other worktree on `C:\CRX_PMBuild` or a `pm/*` branch. No existing `pm/*` branches or PRs.
- **Docker:** 29.5.3 answers; `postgres:17` pulled.
- **Codex:** codex-cli 0.165.0; wrapper self-test wrote the token file, then it was deleted.
- **Keep awake:** granted until the session goes idle.
- **Staleness check:** one commit since 2026-10-29 touched the watched screens: `9b6577804` (#1208) changed a React key in `ProductDetail.tsx`. No package is affected. No migration since 2026-10-29 writes to `products`. No package is REFUTED by the staleness check.
- **Test app:** at start it was running from the pre-merge `C:\CRX_wp_pm_0` build (`ba19220e1`, 172 migrations) and in use by the false Unsaved Changes session in `C:\CRX_false_unsaved_combo`. That session's product-page edit is about 5 lines in `ProductDetail.tsx`; it is not this work.

## Packages

| Package | Status | Branch | PR | Builder, rounds | Luna | Reviewers | Migration | Sol |
|---|---|---|---|---|---|---|---|---|
| WP-PM-1 Dropdowns | DRAFTED | `pm/wp-pm-1-dropdowns` | [#1245](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1245) | Luna, 3 rounds, plus CodeRabbit's one free fix | 4 rounds, last two clean; 1 LOW accepted | compliance clean; CodeRabbit 3 comments, all fixed | none | not required |
| WP-PM-14 RUP notice | DRAFTED | `pm/wp-pm-14-rup-notice` | [#1246](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1246) | Luna, 1 round | clean | compliance clean | none | not required |
| WP-PM-16 EPA label link | DRAFTED | `pm/wp-pm-16-epa-label-link` | [#1247](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1247) | Luna, 1 round | 2 rounds; 1 LOW accepted | compliance clean | none | clean on `22021aa02`, 2026-11-01 15:07 Central |
| WP-PM-2 Pricing page 💲 | DRAFTED | `pm/wp-pm-2-pricing` | [#1248](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1248) | Sol, 3 rounds | first clean, 1 LOW, then 2 void runs of the whole diff, last commit 1 MED and 2 LOW deferred, all matching `main` | compliance on Opus 3 rounds, HIGHs fixed | none | clean on `b5ae91dd4`, 2026-11-01 16:31 Central |
| WP-PM-4 Sales sheet and list 💲 | DRAFTED | `pm/wp-pm-4-sales-sheet`, stacks on #1248 | [#1250](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1250) | Sol, 2 rounds | package 2 findings, fixed or accepted; fix commit 1 MED refuted | compliance on Opus, HIGH fixed | none | Sol owed at landing: clean on `8af7e1fec`, 2026-11-01 17:07 Central, then CodeRabbit's fix changed `Products.tsx` |
| WP-PM-13 Reorder display | DRAFTED | `pm/wp-pm-13-reorder-display` | [#1252](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1252) | Luna, 3 rounds | 3 rounds; last MED refuted, 2 LOW deferred | compliance on Opus, HIGHs fixed | none | clean on `ec1d28a44`, 2026-11-01 18:05 Central, after one BLOCKERS verdict fixed |
| WP-PM-11b List editing and phone layout | DRAFTED | `pm/wp-pm-11b-list-editing`, stacks on #1245, #1248, #1250 | [#1255](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1255) | Luna, 3 rounds, at the cap | 2 rounds; 2 MED and 1 LOW, one intended, the rest deferred | compliance on Opus, HIGHs fixed or named | none | clean on `da059bb0c`, 2026-11-01 19:23 Central; later commit is a proof file, off the list. CodeRabbit owed: 4 comments open, to fix or refute before landing |
| WP-PM-12a Change history (optional, needs 3 hours left) | NOT ATTEMPTED | | | | | | | Reason: under 3 hours remained when WP-PM-11b finished |

## Proof

**WP-PM-1.** PROOF — Ran: rebuilt the test app from `e9ed2bd3f` (172 migrations, 1,089 ledger rows) and `node scripts/local-app/app.mjs test` · Saw: 8 of 8 passed, including the full list with the saved choice marked on Category, Vendor, Manufacturer and Use Timing, all 5 Use Timing options clicked, wheel scroll, keyboard to the last option, Escape inside a pop-up closing only the list, a pick surviving save and reload; browser hosts 127.0.0.1 only · Not verified: touch scroll, a screen reader, Brand vs Generic with a long real list. Owed on the Vercel preview. CI green on the head.

**WP-PM-14.** PROOF — Ran: rebuilt the test app from `83fa16ba6` (172 migrations) and `node scripts/local-app/app.mjs test` · Saw: 5 of 5 passed, notice on both RUP tabs, screenshot shows it above the filters; browser hosts 127.0.0.1 only · Not verified: the notice beside real register rows. Owed on the Vercel preview. CI green on the head.

**WP-PM-16.** PROOF — Ran: rebuilt the test app from `22021aa02` (172 migrations) and `node scripts/local-app/app.mjs test`; requested EPA's page for `524-475`, `100-1070` and `7969-405` · Saw: 5 of 5 passed, the link followed the typed number and a three-part number linked to its base; EPA returned the right product title for all three; browser hosts 127.0.0.1 only · Not verified: clicking through to EPA from the app (the test browser cannot leave the computer), and the brand-row link in a browser (component test only). Owed on the Vercel preview. CI green on the head.

**WP-PM-2.** PROOF — Ran: rebuilt the test app from `b5ae91dd4` (172 migrations) and `node scripts/local-app/app.mjs test` · Saw: 6 of 6 passed; margins typed as 20, 22.5 and 25 stayed as typed and saved exactly, giving $100.00, $103.23 and $106.67 on an $80 cost; markup 25.0%, 29.0% and 33.3% matched the hand check; the product reopened price-driven with price boxes usable; a save with no edits left every price, margin and the pricing version identical; the list opened the row price-driven; Stay and Leave worked between two products through the real search box; browser hosts 127.0.0.1 only · Not verified: real products with odd saved values. Owed on the Vercel preview. Found and fixed an older fault: moving between products could carry one product's details onto the next.

**WP-PM-11b.** PROOF — Ran: rebuilt the test app from `bfcb38d7c` (172 migrations) and `node scripts/local-app/app.mjs test` · Saw: 14 of 14 passed on the branch integrating #1245, #1248 and #1250; 60 invented products showed 50 rows then 10; an edit survived moving between pages; leaving warned, Stay kept the edit, Leave left; at phone width cards showed, search worked, no sideways scroll, a tap opened the product, Download stayed; browser hosts 127.0.0.1 only · Not verified: a real phone, real products. Owed on the Vercel preview. CI green on the head.

**WP-PM-13.** PROOF — Ran: rebuilt the test app from `ec1d28a44` (172 migrations) and `node scripts/local-app/app.mjs test` · Saw: 6 of 6 passed; the invented product showed North Barn 12.5 and South Barn 0.25 on the card and the same in the Inventory rows, total 12.75, reorder point Not set for 0, an "As of" time; the link opened Inventory on that product and Show all returned; a product with no stock said so; browser hosts 127.0.0.1 only · Not verified: the unit in a browser (the test copy has no unit list, so component test only), a phone, real products. Owed on the Vercel preview.

**WP-PM-4.** PROOF — Ran: rebuilt the test app from `d01f8639d` (172 migrations) and `node scripts/local-app/app.mjs test` · Saw: 8 of 8 passed; with the filter on All, the downloaded sales sheet CSV and PDF held the active product only, the PDF said "1 active product(s)", its text had no cost, margin or EPA wording; the internal CSV held both products and every new column; a `=`-led name stayed safe in one cell; EPA and manufacturer search found the product; browser hosts 127.0.0.1 only · Not verified: a long multi-page sheet with real products. Owed on the Vercel preview.

**Flaky tests, not from this work.** `BlendTicketDetail.test.tsx` "blocks application-record creation while a local product edit is unsaved" failed in the local full run on three unrelated branches and 1 of 3 solo repeats on one of them, and passed in the baseline, in another full run and in CI. That page does not use any changed component. `InventoryPage.uncertainRetry.test.tsx` failed once in CI on #1245 and has its own fix branch, `claude/fix-inventory-retry-flake`.

---

# Wave 2

**Run:** Wave 2, attempt 1. **Started:** 2026-11-01 21:50 America/Chicago. **Hard wrap:** 2026-11-02 05:50; no new package after 03:50; closeout by 05:05.
**Coordinator branch:** `loop/product-master-w2-r1-2026-11-01`. **Build worktree:** `C:\CRX_PMBuild`. **Base:** `origin/main` at `d246acfa7`.

## Wave 2 Step 0

- **Start condition:** Mason, 2026-11-01: the Wave 1 PRs already merged are enough to begin. Merged: #1245, #1246, #1247, #1248. Still open at start: #1250 (`3099829c9`), #1252 (`ec1d28a44`), #1255 (`bfcb38d7c`, draft, conflicting). A separate session is landing them; re-checked before each package.
- **Plan on main:** section 4a and the wave table are present on `origin/main`.
- **Context size:** `autoCompactWindow` is 800000, no `modelSettings` override.
- **Validator:** MISSION DOC OK, no warnings.
- **Collision check:** no worktree owner on `C:\CRX_PMBuild`: clean, no process using it, Wave 1's loop finished at `4a984c297`. Reused it, detached at `d246acfa7`. Wave 1 landing uses `C:\CRX_pm_land`.
- **Docker:** 29.5.3 answers; `postgres:17` pulled.
- **Codex:** codex-cli 0.165.0; wrapper self-test wrote the token file, then it was deleted.
- **Keep awake:** granted until the session goes idle.
- **Test app:** stopped frontend, database built from `bfcb38d7c` (Wave 1's #1255) with 172 migrations. Shared with the landing session; take turns, never rebuild over its work.
- **Staleness check:** commits since 2026-10-29 on the watched screens: `fa0fafaef` (#1248), `b0142dfa7` (#1247), `c57abe6d6` (#1245), `2ff06c483` (#1243). None does a Wave 2 package. No package is REFUTED by the staleness check.

## Wave 2 packages

| Package | Status | Branch | PR | Builder, rounds | Luna | Reviewers | Migration | Sol |
|---|---|---|---|---|---|---|---|---|
| WP-PM-12a Change history | ⬜ | | | | | | | |
| WP-PM-3 Turning products off | ⬜ | | | | | | | |
| WP-PM-8 Setup checks | ⬜ | | | | | | | |
| WP-PM-9 Forms, units, containers | ⬜ | | | | | | | |
| DM-0 Data hygiene | ⬜ | | | | | | | |
| WP-PM-5 Use Timing | ⬜ | | | | | | | |
| WP-PM-6a Unit audit | ⬜ | | | | | | | |
| WP-PM-6b New-product flow, Duplicate 💲 | ⬜ | | | | | | | |
| WP-PM-7 One cost path, tier order 💲 | ⬜ | | | | | | | |
| WP-PM-15a Vendor proposals 💲 | ⬜ | | | | | | | |
| WP-PM-12b Corrections | ⬜ | | | | | | | |

## Wave 2 proof
