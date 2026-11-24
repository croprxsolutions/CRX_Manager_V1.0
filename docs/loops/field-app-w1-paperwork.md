# MISSION: field application, slice 1 paperwork lane

You fix the printed applicator and loader sheets to match the field application design. No database changes: every value printed already exists. Read `docs/plans/field-application/BUILD-PLAN.md` first.

## Driver

Claude, autonomous, in this session, after Mason's go (M7). Each group: build → render the real PDF and look at it → the `ship.md` Step 6 review route (ordinary code off the Sol list gets one Terra final review; Luna and Sol only if a file is on `docs/reference/sol-required-paths.md`) → PR into `staging`.

## Existing data to print (do not add columns)

Spray order: `job_fields.sort_order` (already printed as "Stop N" by `src/lib/applicatorSheetData.ts`). Tank-sized loads: `job_loader_worksheets.load_balance_mode` ('proportional' | 'full_loads_remainder'), `capacity_gal`, `per_load_acres`. Carrier rate: `jobs.carrier_rate_gpa` (finished gallons per acre: water plus product). Drag-and-drop ordering is slice 2 (office screens lane).

## Groups, in order (one PR each)

1. Safety (REI, PHI, signal word) always printed on every page of the applicator sheet, including map-only prints; the option to leave it off removed (SPEC stage 3).
2. "Hide tank contents" (hides amounts and rates; product names and safety still print) and "map pages only" print options.
3. Spray-order numbers 1, 2, 3 on printed maps from `sort_order`; numbers restart per job (Sol 86).
4. Directions link per field on the sheet.
5. Loader sheet shows water to add (finished gallons − liquid product gallons) and finished gallons, in the loader's units (Sol 62); dry products add no volume.
6. EPA number: a dash for a product with no EPA registration, "Unknown" for a registered product whose number is missing (KI-206); loader views (one big batch or loads sized to the tank) using the existing modes.

## Worktree

`C:\CRX_wt\field-paperwork`, branch per group `feat/field-paper-<n>` from current `origin/staging`. Owns: `src/lib/applicatorPrintOptions.ts`, `src/lib/applicatorSheet*.ts`, `src/lib/jobMapImages.ts`, `src/lib/loaderWorksheet*.ts`, `src/lib/newJobLoaderPrint.ts`, `src/components/jobs/LoaderWorksheetsPanel.tsx`, their tests, and the "Slice 1 · paperwork" section of `PROGRESS.md`. May add one entry to the existing print menu in `src/pages/JobDetail.tsx` (ask for the lease in `PROGRESS.md`) and nothing else there; must not edit `src/types/index.ts` or any migration. Test logins: `docs/reference/qa-testing.md`.

## Definition of done

All six groups merged into `staging` and checked there, each PR showing rendered pages for a one-field and a multi-field job (first and later pages, map-only and full prints, with and without hidden tank contents), directions links opened, the printed safety values matched against the product records, a registered product with no number ("Unknown") and an unregistered one (dash), a saved print preference that used to hide safety, and a two-job bulk print with spray numbers restarting per job. Anything parked is in `PROGRESS.md` with the reason, and the lane reports PARTIAL.

## Delivery gate

`BUILD-PLAN.md` › Delivery gate applies in full.
