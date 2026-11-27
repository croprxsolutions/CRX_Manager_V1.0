# CRX map engine swap — round 3 phone proof

**Checkout:** `C:\CRX_wt\map-swap`  
**Branch:** `feat/maps-step1-engine-swap`  
**Tested tree:** `1ff7bc7e2ce7f3797b29a11956f8e8937aa338df` plus the uncommitted working tree that became this PR's commit (later rebased onto newer `origin/staging`; it merged cleanly, and the code checks were re-run after it).

## Proof locations

- **Final run (after rebase and review fixes), both lanes passed:** `C:\Claude\map-swap-proofinal-rebased\` (43 screenshots plus both PDFs). The spec's single walkthrough test now has a 180 s limit; 90 s ran out on a cold dev server.

- Compact review set: `C:\Claude\map-swap-proof\compact\` on the build PC (12 PNGs, each under 250 KB). Screenshots are kept out of the repo, as for step 0, because the code-review gate cannot read pictures; the walkthrough spec `scripts/local-app/e2e/maps-step1.spec.ts` re-creates them.
- Full-size originals and PDFs: `C:\Claude\map-swap-proof\` (54 files, including both downloaded PDFs and the full-size screenshots).

## Retained screenshots

- Draft before and after changing the picture: `mapbox-fixture-field-setup-draft-before-switch.png`, `mapbox-fixture-field-setup-draft-after-switch.png`.
- Saved boundary appears after reload while USDA tile requests are delayed: `usda-keyless-field-setup-saved-reloaded.png`.
- Corner drag while USDA is displayed: `mapbox-fixture-field-setup-corner-drag-usda.png`.
- Phone My Day Field View and Crew map captures at asserted 390 × 844 (Map view selected, map in frame, saved entrance pin visible in the Crew shot), plus Field Setup with drawing controls shown and hidden: `mapbox-fixture-phone-crew-map-marker.png`, `mapbox-fixture-phone-field-view-map.png`, `mapbox-fixture-phone-field-setup-drawing.png`, `mapbox-fixture-phone-field-setup.png`.
- Customer Detail pin: `usda-keyless-customer-detail-map.png`.
- Desktop Field Setup controls: `mapbox-fixture-desktop-field-setup-controls.png`.
- PDF map overview and Stop 1 page: `mapbox-fixture-map-pages-only-page-1.png`, `mapbox-fixture-map-pages-only-page-2.png`.

## Round 2 findings

- **DrawControl initial geometry — PASS.** `DrawControl.test.tsx`: “adds saved geometry that arrives after load fired while source tiles are still loading.” `maps-step1.spec.ts` delayed USDA tile responses by about three seconds; saved multipart geometry appeared and remained editable.
- **Picture switching during tile load — PASS.** `mapPicture.test.ts`: “applies visibility while source tiles are still loading when picture layers exist.” The fake-token browser run held Mapbox tiles, switched to USDA, and observed the toggle, attribution, and layer visibility update before releasing the requests.
- **Phone offsets — PASS.** `maplibreSetup.test.ts`: “scopes attribution and top-right offsets to Field Setup while drawing.” The 390 × 844 Crew map, Field View, and Field Setup screenshots show the four requested phone states without control overlap.
- **Desktop controls — PASS.** The before-fix browser geometry check caught the Draw / Locate Me overlap. The old staging positions (`top-4 left-4` for Locate Me and `top-4 left-14` for search) also put Locate Me over the top-left Draw control, so this predated the engine swap. Locate Me now sits lower on desktop; all controls fit and can be clicked.
- **Customer Detail marker — PASS.** Runtime RPC evidence returned `centroid_geojson` as a string containing a Point near the map’s default center; the value was valid and in view. On the new fallback map, the React MapLibre Marker child produced no marker DOM. The fix creates and cleans up a native marker on the loaded MapLibre map; the browser now observes one visible pin. The old staging no-token path rendered “Map not available,” so this missing pin was in the new fallback path, not a previously visible staging map. The page component and field-app directory were not edited.

## Verification

- `npx tsc --noEmit -p tsconfig.app.json` — PASS.
- `npm run lint` (`eslint . --max-warnings=0`) — PASS.
- `npm run test` — PASS: 713 files, 10,048 passed, 123 skipped (10,171 total).
- `npm run build` — PASS. Vite reported its existing large-chunk advisory for the MapLibre bundle; build completed.
- `node scripts/check-code-health.mjs` — PASS.
- `npm run generate-map` — PASS.
- `node scripts/verify-deps.mjs` — PASS.
- Step 0 Playwright proof — PASS, 4 cases.
- Full `maps-step1.spec.ts` walkthrough — PASS in both the no-token USDA lane and fake-token lane on local Docker.
- The local Docker lane was stopped after both runs. No commit or push was made.

**For Claude to double-check:** review the compact phone and desktop screenshots for the control spacing, and confirm the PDF overview/Stop 1 pages match the originals in `C:\Claude\map-swap-proof\`.
