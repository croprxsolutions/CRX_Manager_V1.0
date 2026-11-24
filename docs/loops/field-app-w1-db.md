# MISSION: field application, slice 1 database lane (plus loads and stock for slice 2)

You build the foundation of the field application system: who pays for each field, billable acres, and batches that take stock at mixing. Read `docs/plans/field-application/BUILD-PLAN.md` (rules every session follows) before anything else.

## Driver

Claude, autonomous, in this session. Each item: plan-contract (or the contract in this kit) → build → proof → Luna until clean → Sol → PR into `staging`. The next item starts when the current one is **verified** on staging (merged, applied, scenarios re-run, registry regenerated). Order 1.1 → 1.2 → 1.3. If 1.1 or 1.2 is parked or blocked, 1.3 may start anyway (it does not depend on them); 1.2 never starts before 1.1 is verified. Mason's questions and approvals go in `PROGRESS.md` and in the session's closing message.

## Granularity

One item = one PR (split into a database PR and a screen PR when the item has screens, database first). Items in order:

1. **1.1 FP-1** field splits with history, per `docs/plans/field-application/CONTRACT-who-pays.md` FP-1 (product and application shares). Its `I approve` gates (the customer foreign-key change from cascade to restrict, revoked grants) wait for Mason's yes; build and prove everything else first.
2. **1.2 FP-2** billable acres, per `CONTRACT-who-pays.md` FP-2. Not before 2026-12-15 (its quote-to-job change is in Taha's quotes area; Taha reviews it).
3. **1.3 Batches and stock**, per `docs/plans/field-application/CONTRACT-batch-stock.md`. Partial hold release, leftover claims and the duplicate-load flag are spring. First confirm read-only the facts the contract lists under "Check read-only before building".
4. **1.4 Chem Man field import**: Mason's export file imported on staging through the FP-1 writer, spot-checked by the office, then live once, only with Mason's yes and only after Taha's live reset (#2407) has run; a count of fields imported vs fields in the file, and the office checks the list by hand (Mason 2026-11-24: one-time import, no re-run matching).

## Worktree

`C:\CRX_wt\field-w1-db`, branch per item `feat/field-w1-<item>` from current `origin/staging`. Owns: new files under `supabase/migrations/`, `src/types/index.ts`, the schema registry, `src/pages/FieldSetup.tsx` (1.1), `docs/changelog.d/` records for its migrations, tests for these items, and the "Slice 1 · DB" section of `docs/plans/field-application/PROGRESS.md`. Must not edit `src/pages/JobDetail.tsx` or any applicator-sheet, loader or print file (owned by the paperwork lane).

## Definition of done

Each item is **verified** on staging (`BUILD-PLAN.md` › Rules 5): merged, applied, its scenarios run as the real roles with expected vs observed in the PR. An item that cannot get there is parked or blocked in `PROGRESS.md` with the reason and both positions, and the lane reports PARTIAL, not done. `PROGRESS.md` shows every item's state and a one-line plain-English summary for Mason.

## Delivery gate

`BUILD-PLAN.md` › Delivery gate applies in full. Landing in `staging` only under AGENTS.md › Autonomous landing with every `ship.md` gate on the current head. Mason's explicit yes in his own conversation for: the contracts' `I approve` gates, any permission change, anything into `main` or production, any live data change.
