# MISSION: field application, wave 1, database lane

You build the foundation of the field application system: who pays for each field, billable acres, and batches that take stock at mixing. Read `docs/plans/field-application/GOALS.md` (rules every goal follows) before anything else.

## Driver

Claude, autonomous, in this session. Each item: plan-contract (or the contract in this kit) → build → proof → Luna until clean → Sol → PR into `staging`. The next item starts when the current one is **verified** on staging (merged, applied, scenarios re-run, registry regenerated). Order 1.1 → 1.2 → 1.3. If 1.1 or 1.2 is parked or blocked, 1.3 may start anyway (it does not depend on them); 1.2 never starts before 1.1 is verified (Sol r2 123). Mason's questions and approvals go in `PROGRESS.md` and in the session's closing message.

## Granularity

One item = one PR (split into a database PR and a screen PR when the item has screens, database first). Items in order:

1. **1.1 FP-1** field split groups with history, per `docs/plans/2026-11-08-fields-who-pays-BUILD-SHEET.md` FP-1 plus its section 0 decisions and `SPEC.md` (product and application shares; store the grower each field was added under on the job-field link; a field with no split defaults 100% to that grower, GR5). The build sheet's `I approve` gates (delete foreign key, revoked grants) wait for Mason's yes; build and prove everything else first.
2. **1.2 FP-2** billable acres, per the build sheet.
3. **1.3 Batches and stock**, per `docs/plans/field-application/CONTRACT-batch-stock.md`. Not the partial hold release (item 3.4, after 2026-12-15). First confirm read-only the UNVERIFIED facts the contract lists.

## Worktree

`C:\CRX_wt\field-w1-db`, branch per item `feat/field-w1-<item>` from current `origin/staging`. Owns: new files under `supabase/migrations/`, `src/types/index.ts`, the schema registry, `src/pages/FieldSetup.tsx` (1.1), `docs/changelog.d/` records for its migrations, tests for these items, and the "W1 DB" section of `docs/plans/field-application/PROGRESS.md`. Must not edit `src/pages/JobDetail.tsx` or any applicator-sheet, loader or print file (owned by the paperwork lane).

## Definition of done

Each of the three items is **verified** on staging (`GOALS.md` rule 6): merged, applied, its scenarios run as the real roles with expected vs observed in the PR. An item that cannot get there is parked or blocked in `PROGRESS.md` with the reason and both positions, and the lane reports PARTIAL, not done. `PROGRESS.md` shows every item's state and a one-line plain-English summary for Mason.

## Delivery gate

`GOALS.md` › Delivery gate applies in full. Landing in `staging` only under AGENTS.md › Autonomous landing with every `ship.md` gate on the current head. Mason's explicit yes in his own conversation for: the build sheet's `I approve` gates, any permission change, anything into `main` or production, any live data change.
