# MISSION: field application, wave 1, paperwork lane

You fix the printed applicator and loader sheets to match the field application design. No database changes. Read `docs/plans/field-application/GOALS.md` first.

## Driver

Claude, autonomous, in this session. Each item: build → render the real PDF and look at it → Luna until clean → PR into `staging`. These items do not touch money, stock or the database, so Sol is needed only if a change lands on a path in `docs/reference/sol-required-paths.md`.

## Granularity

One PR per group, in order:

1. Safety (REI, PHI, signal word) always printed on every page of the applicator sheet, including map-only prints; the option to leave it off removed (GAP-CHECK row 12).
2. "Hide tank contents" and "map pages only" print options (row 12).
3. Spray-order numbers 1, 2, 3 on printed maps; numbers restart per job (rows 9a, 13; Sol 86).
4. Directions link per field on the sheet (row 14).
5. Loader sheet shows water to add vs finished gallons, in the loader's units (rows 15, 16 and the gap check's loader items).

## Worktree

`C:\CRX_wt\field-w1-paperwork`, branch per group `feat/field-w1-paper-<n>` from current `origin/staging`. Owns: `src/lib/applicatorPrintOptions.ts`, `src/lib/applicatorSheet*.ts`, `src/lib/jobMapImages.ts`, `src/lib/loaderWorksheet*.ts`, `src/lib/newJobLoaderPrint.ts`, `src/components/jobs/LoaderWorksheetsPanel.tsx`, their tests, and the "W1 paperwork" section of `docs/plans/field-application/PROGRESS.md`. May add one entry to the existing print menu in `src/pages/JobDetail.tsx` and nothing else there; must not edit `src/types/index.ts`, or any migration.

## Definition of done

All five groups merged into `staging` and checked there, each PR showing rendered pages for a one-field and a multi-field job (first and later pages, map-only and full prints), directions links opened, the printed safety values matched against the product records, a saved print preference that used to hide safety, and a two-job bulk print with spray numbers restarting per job (Sol 131). Anything parked is in `PROGRESS.md` with the reason, and the lane reports PARTIAL.

## Delivery gate

`GOALS.md` › Delivery gate applies in full: landing in `staging` only under AGENTS.md › Autonomous landing with every `ship.md` gate on the current head; nothing reaches `main` or production without Mason's explicit yes.
