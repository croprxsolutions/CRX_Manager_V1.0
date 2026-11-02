# Product Master Wave 1: morning report

**Status: 7 of 8 packages are drafted with their proof, and the optional eighth was not started. Nothing was merged, deployed or changed on live.**

**Recommended next step:** land [#1245](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1245) and [#1246](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1246) first. They need no Sol review and no money decision. Then work down the order below.

Run: 2026-11-01, 13:20 to about 20:05 Central, on `C:\CRX_PMBuild`. Base `2538335c5`; `main` moved during the run.

## The decision for Mason

**Which of these should land before Wave 2?** The wave plan says Wave 2 starts after the work you choose has landed. Sol reviews expire 24 hours after they run, so landing by tomorrow afternoon avoids re-running them. Wave 2's first package, WP-PM-12a, stands alone, but WP-PM-3 and the others touch the same product files, so landing all seven first is cleanest.

Three smaller questions came out of the work:

1. **Should the customer sales sheet print all three tier prices?** It does today. The Products page calls tiers customer-specific pricing, so a customer sees other tiers' prices.
2. **Should the customer CSV show Vendor?** That is your supplier. The PDF leaves it out. This also was already true.
3. **Is this right for phones?** The Products phone view has search, filters, opening a product and sales sheet downloads. It has no editing, no selection and no pricing workbook buttons.

## Each package

| Package | PR | One-line proof | Still owed | Migration | Sol |
|---|---|---|---|---|---|
| WP-PM-1 Dropdowns | [#1245](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1245) | 8 of 8 in the test app: full list, saved choice marked, keyboard, wheel scroll, Escape in a pop-up, save and reload | Touch scrolling, a screen reader, a long real list | none | not required |
| WP-PM-14 RUP notice | [#1246](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1246) | 5 of 5: the notice shows on both RUP tabs | The notice beside real register rows | none | not required |
| WP-PM-16 EPA label link | [#1247](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1247) | 5 of 5, and EPA's page returned the right title for 524-475, 100-1070 and 7969-405 | Clicking a real product and a real brand row through to EPA | none | clean, expires 2026-11-02 15:07 Central |
| WP-PM-2 Pricing page 💲 | [#1248](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1248) | 6 of 6: margins typed as 20, 22.5 and 25 saved exactly, prices $100.00, $103.23 and $106.67 matched a hand check, and a save with no edits changed nothing | A real product last priced by margin | none | clean, expires 2026-11-02 16:31 Central |
| WP-PM-4 Sales sheet and list 💲 | [#1250](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1250) | 8 of 8, reading the real files: the sales sheet CSV and PDF held the active product only, with no cost, margin or EPA wording | A long multi-page sheet with real products | none | **owed at landing.** A later fix changed `Products.tsx`, and Sol refuses a draft |
| WP-PM-13 Reorder display | [#1252](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1252) | 6 of 6: the card and Inventory both show 12.5 and 0.25, total 12.75, and the link opens that product | The unit in a browser, a phone, real products | none | clean, expires 2026-11-02 18:05 Central |
| WP-PM-11b List editing and phone 💲 through the stack | [#1255](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1255) | 14 of 14 on the integrated branch: 50 rows a page, edits kept across pages, Stay and Leave, phone cards, no sideways scroll | A real phone | none | clean, expires 2026-11-02 19:23 Central |
| WP-PM-12a Change history | not started | NOT ATTEMPTED: under 3 hours remained when WP-PM-11b finished, so the optional rule was not met | Moves to Wave 2, as the wave table already says | | |

**Every package is proven on invented data in the test app. The real-product checks above are owed on each PR's Vercel preview, and each PR body lists the exact clicks.**

No package was PARKED or REFUTED.

## Worth knowing

- **WP-PM-2 fixed an older fault.** Moving from one product to another reused the same page, so during a load a save could write one product's details onto the next. Each product now gets its own page instance, the way Jobs and Deliveries work.
- **WP-PM-4 fixed a false price.** The customer CSV printed $0.00 for a product with no price. It now prints blank.
- **Pricing default.** A product with all three prices opens price-driven, so Update Cost now starts on "Keep entered prices" and margins move unless someone switches. The preview still shows every result. It is recorded in the Decision Log.
- **Inactive products.** The list now hides them by default. Choose Inactive or All to see them, including to turn one back on.
- **An existing false prompt is gone.** The false Unsaved Changes prompt after creating a product was fixed separately in #1243.

## Suggested merge order

Every PR targets `main`. After a prerequisite lands, refresh the PR that stacks on it, re-run its proof, and read its actual diff.

1. #1245 Dropdowns
2. #1246 RUP notice
3. #1247 EPA link
4. #1248 Pricing page
5. #1250 Sales sheet, which stacks on #1248. Sol runs here after it is marked ready.
6. #1252 Reorder display. Expect a small text conflict with #1255 in `src/pages/InventoryPage.productIdentity.test.tsx`.
7. #1255 List editing, which stacks on #1245, #1248 and #1250. Its diff is cumulative until they land. Handle its 4 CodeRabbit comments first; a fix to `Products.tsx` or the table means Sol runs again.

**Mason-gated migrations:** none. No package in this wave has a migration.

## Test and build status

- **Baseline:** typecheck, build, lint and all tests passed before any work: 6,839 passed.
- **Every package:** typecheck, build, lint and code-health passed. Every PR's CI is green on its final head.
- **Flaky tests, not from this work:**
  - `BlendTicketDetail.test.tsx`, "blocks application-record creation while a local product edit is unsaved", failed in several local full runs on unrelated branches and passed in others and in CI.
  - `InventoryPage.uncertainRetry.test.tsx` failed once in CI and passed on a rerun. It has a fix branch, `claude/fix-inventory-retry-flake`.
  - `ProductMarginFloorCard.test.tsx` failed once in a full run and passed 4 of 4 alone.
- **Codex events:** no usage limits. Luna ran out of output space twice on the full WP-PM-2 diff, so its last round covered the final code commit, and Sol reviewed the whole diff clean.
- **Sol:** one BLOCKERS verdict on WP-PM-13, for a person denied Inventory seeing stock on the card. Fixed, then clean.

## CodeRabbit

| PR | Requested | Found | Kept |
|---|---|---|---|
| #1245 | yes, over 400 lines | 3 comments, including a real scroll bug | All fixed by its one free fix. Read in full, proven, Luna clean |
| #1246, #1247 | no, not 💲 and under 400 lines | | |
| #1248 | yes, 💲 | 2 comments | One Decision Log wording fix kept. One refuted: the server already refuses a negative margin |
| #1250 | yes, 💲 | 3 comments | Status column added to the internal PDF by a Codex round. The Decision Log label came from #1248. One test note declined with a reason |
| #1252 | yes, over 400 lines | no comments | |
| #1255 | yes, over 400 lines | 4 comments, none serious | **Owed before landing.** The package is at its limit of 3 build rounds, so none are fixed yet: the phone list ignores a vendor filter set at desktop width; the table should report leaving edit mode when it disappears; a plainer Decision Log line; one render-count test line |

No paid option or agent minutes were used.

## Deferred on purpose

All of these are listed in the PR bodies. Most were already true before this work.

- Exports follow the filters, not the search box, on desktop and phone.
- The Inventory Forecast tab and a Retry after a failed load can drop unsaved table edits.
- A sales sheet is built from the list loaded in the browser, so an open tab can miss a product turned off since.
- The `price_list` CSV in Reports has the same false $0.00.
- The Active switch in the list skips the open purchase order check. WP-PM-3 in Wave 2 fixes that in the database.
- The Inventory phone view rounds to one decimal place, so 0.25 reads 0.3 there and 0.25 on the product card.
- Each product page open runs the whole-catalog inventory read.
- Every package's proof leaves invented rows in the throwaway test database until its next rebuild.

## Test copy of the app

It worked well and caught real problems. Two gaps for later: it has no unit list, so products with units can't be made, and stock has no browser write, so `seed.sql` gained one invented stocked product on #1252. Its proofs now need to aim at the visible layout, because Products holds both phone and desktop layouts at once.

## Not verified

Nothing here ran against real data or a real phone. No live data was read for this wave. The Vercel preview checks above are still owed.
