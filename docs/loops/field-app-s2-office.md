# MISSION: field application, slice 2 office screens lane

You build the office side of slice 2: job creation additions, the dispatch board by rig, application services, the office review screen and the season reports. Read `docs/plans/field-application/BUILD-PLAN.md` (rules every session follows), `SPEC.md` stages 2–3 and 8, and `PROGRESS.md` › Slice 2 first. Written 2026-11-25.

## Start gate

- Each screen **merges** only after its database PRs (application services, review checks, FP-3, FP-4) are VERIFIED on staging (`BUILD-PLAN.md` › How the work stays safe 1). FP-3 and FP-4 come after 2026-12-15 with Taha's review, so their screens come last.
- **The dispatch board waits for the map engine swap.** Codex owns the Google Maps build (`docs/research/2026-11-24-google-maps-design.md`, steps 0–1). `DispatchBoard.tsx` and its maps are rebuilt on the new engine after step 1 merges into staging. Build the other screens first. Never edit `src/components/map/*`, `jobMapImages.ts` or `FieldSetup.tsx`.
- Job creation's quote-to-job and booking-to-job paths are Taha's until 2026-12-15: change only the office job screen's own fields there.

## What to build (in this order)

1. `ApplicationServices.tsx` / `ApplicationServiceDetail.tsx`: billed flag and outside company (application services PR).
2. Job creation: product "sourced from" (a vendor sets the line as not CRX stock), application service with prefill from `customers.default_application_service_id`, rig carrier default. The field picker by any payer waits for FP-4.
3. Office review screen: planned / mixed / billed per job, flags, settle a load, close (review checks PR).
4. Season acres and blend reports (the "billed by CRX" column shows the service flag only; invoices are slice 3).
5. After the map swap: `DispatchBoard` list by rig with drag-and-drop spray order, tick several jobs to print and map (calls the paperwork print libraries; proof: a two-job print, combined and per-field maps, numbers restarting per job).

`JobDetail.tsx` is one lease at a time (`PROGRESS.md`); take it only when free and record it.

## Files

`C:\CRX_wt\field-office`, branches `feat/field-2-office-<slug>` from current `origin/staging`. The pages above, their tests, one route line per new page in `src/App.tsx`, and `PROGRESS.md` › Slice 2 · office. Not migrations or `src/types/index.ts` (database lane).

## Review and done

Terra final review for screen-only code; the review screen's settle and close, and anything else that writes money, stock or permissions, goes through Luna and Sol. Done when S16, S17, S20, S21, S33 and S34 are observed on staging as admin and as a sales rep. Ready PRs go to the merge captain with a READY line; the lane never merges.
