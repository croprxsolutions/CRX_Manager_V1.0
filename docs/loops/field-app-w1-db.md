# MISSION: field application, slices 0–1 database lane (plus loads and stock for slice 2)

You build the foundation of the field application system: tooling, who pays for each field, the Chem Man field import, billable acres, and loads that take stock at mixing. Read `docs/plans/field-application/BUILD-PLAN.md` (rules every session follows) before anything else.

## Driver

Claude, autonomous, in this session, after Mason's go (M7). Each item: plan-contract (or the contract in this kit) → build → proof → the `ship.md` Step 6 review route → PR into `staging`. Merges into `staging` go in order; while one PR waits (review, the 4-hour Taha hold, a Mason answer), the next may be built on a stacked branch (`BUILD-PLAN.md` › Stacking). A gate or a disputed finding parks that PR only (`BUILD-PLAN.md` › Rules); keep going with the next unblocked item. Every ask for Mason goes in the slice batch in `PROGRESS.md` and in the session's closing message.

## Items, in order (one PR each; a screen part is a second PR after its database PR)

0.1 **Merge the kit into `staging`** (docs-only PR from #2415).
0.2 **Tooling:** registry and type generation from staging (`BUILD-PLAN.md` › Slice 0 step 2). No field migration merges before it.
0.3 **Staging-only migrations and read-only facts** (`BUILD-PLAN.md` › Slice 0 steps 3–4), recorded in `PROGRESS.md`. A conflicting migration gets a replacement migration as its own PR here.
1.1 **FP-1** field splits with history and payer notes (`CONTRACT-who-pays.md` FP-1), then its Field Setup screen PR.
1.2 **Chem Man field import** (`CONTRACT-who-pays.md` › Chem Man field import): trial on a local test copy (not staging); the live run once, only after Taha's reset, with Mason's yes from the batch.
1.3 **Loads and stock** (`CONTRACT-batch-stock.md`); may start while FP-2 waits for 2026-12-15. Must not change `inventory_holds` or `_sync_job_holds`.
1.4 **FP-2** billable acres (`CONTRACT-who-pays.md` FP-2), after 2026-12-15 with Taha's review; its Job Detail and `SelectLocationsModal` change is a second PR under the `JobDetail.tsx` lease.
1.5 **Write the slice 2 briefs** (`docs/loops/field-app-s2-*.md`) from `BUILD-PLAN.md` › Brief outlines and what was really built; then wait for Mason's go.

No field-application migration is applied live before Taha's reset has run.

## Worktree

`C:\CRX_wt\field-db`, branch per item `feat/field-<item>` from current `origin/staging` (which holds the kit after 0.1). Owns: new files under `supabase/migrations/`, `src/types/index.ts`, `.claude/schema-registry.json`, the registry and type scripts and skill (0.2), `src/pages/FieldSetup.tsx` (1.1), the `JobDetail.tsx` lease and `src/components/field-app/SelectLocationsModal.tsx` (1.4), `docs/changelog.d/` and `docs/reference/migrations.d/` records for its migrations, tests for these items, the import script, and the "Slice 0" and "Slice 1 · DB" sections of `PROGRESS.md`. Must not edit any applicator-sheet, loader or print file (paperwork lane).

## Definition of done

Each item is **verified** on staging (`BUILD-PLAN.md` › Rules): merged, applied, its scenarios run as the real roles with expected vs observed in the PR. Live applies, post-apply checks and the live import belong to the release (`BUILD-PLAN.md` › Release evidence), not to this lane. An item that cannot get there is parked or blocked in `PROGRESS.md` with the reason and both positions, and the lane reports PARTIAL. `PROGRESS.md` shows every item's state and a one-line plain-English summary for Mason.

## Delivery gate

`BUILD-PLAN.md` › Delivery gate applies in full.
