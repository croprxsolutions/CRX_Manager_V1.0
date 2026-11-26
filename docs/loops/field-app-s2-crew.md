# MISSION: field application, slice 2 crew screens lane

You build the mixer tablet and the applicator phone screens. Read `docs/plans/field-application/BUILD-PLAN.md` (rules every session follows), `SPEC.md` stages 4–7, `CONTRACT-batch-stock.md` and `PROGRESS.md` › Slice 2 first. Written 2026-11-25.

## Start gate

- Screens may be built against the accepted contracts now; each **merges** only after the database PR it calls is VERIFIED on staging and the registry and types are refreshed (`BUILD-PLAN.md` › How the work stays safe 1).
- **Map parts wait for the map engine swap.** Codex owns the Google Maps build (`docs/research/2026-11-24-google-maps-design.md`, steps 0–1). Any map on the phone (field map, Follow me, extra-field pick on a map) is built on the new engine after step 1 merges into staging. Until then, build the phone's lists and forms with no map, and never edit `src/components/map/*` or `jobMapImages.ts`.
- Applicator screens read only the safe-column paths the applicator data-access fix lands (#2574's database half: `jobs_crew`, `job_chemicals_crew`, `get_job_billed_customers`). Never show an applicator a price, cost, memo, commission or split %.

## What to build

- **Mixer tablet:** job list from `get_mixable_jobs()`; confirm a load (name pick, real contents, per-load mix edit, warehouse pick), add to a load, correct a load (reason), leftover (ran dry, carried, to tote, none); the office's load entry for no-tablet jobs. Every call sends a retry key made once per action.
- **Applicator phone:** work entries per field per day, load segments, gauge, Now buttons, weather, Job done, pause with acres left and a resume note; restricted-use fields per state; the extra field (picker from the narrow read function in the database brief, or a typed note) (Mason said yes 2026-11-25).
- The next load's proposal shows "X acres to finish on field Y" and the resume note; spray record print per field (calls existing print libraries; does not edit them).

## Files

`C:\CRX_wt\field-crew`, branches `feat/field-2-crew-<slug>` from current `origin/staging`. New pages and components under `src/pages/` and `src/components/field-app/`, one route line each in `src/App.tsx` (rebase before merge), their tests, and `PROGRESS.md` › Slice 2 · crew. Not `FieldSetup.tsx`, `JobDetail.tsx`, map files, `src/types/index.ts` or migrations (database lane).

## Review and done

Terra final review for screen-only code; any screen that writes money, stock or permissions goes through Luna and Sol (`ship.md` Step 6). Done when S11–S15 and S27 are observed in the browser on staging as an applicator and as the mix-site account (until that account exists, as an applicator login; the mix-site case runs once it exists). Ready PRs go to the merge captain with a READY line; the lane never merges.
