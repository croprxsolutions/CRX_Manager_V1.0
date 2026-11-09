## 2026-11-08 — KI-96 part 1: delete code nothing runs

No user-visible change. Each file below was checked against every tracked file (code, `package.json`
scripts, CI workflows, hook manifests, smoke specs and current docs). The only mentions left are in
dated history notes.

- **Offline sync** (`src/lib/offlineSync.ts`): removed the replay handlers for `allocate_payment`,
  `receive_po_items`, `update_order_items`, `cancel_delivery`, `cancel_order`, `confirm_delivery` and
  `match_quick_receive_items`. No screen has ever queued them: git history shows only `complete_delivery`
  (queued until #955, 2026-10-19) and `complete_job` (still queued by `FieldView`). Both keep their
  handler. Any other saved action already lands as "needs attention" (never run, never deleted), as
  before. The below-cost runner that only `update_order_items` used is gone from `OfflineBanner`.
- **Old one-off proofs** in `scripts/smoke/` (June to September 2026): `prove-gauntlet-closeout-concurrency.mjs`,
  `prove-gauntlet-write-boundary-concurrency.mjs`, `prove-offline-action-receipt-failures.mjs` with its
  `setup-offline-action-receipt-failure-proof.sql`, `prove-offline-action-review-resolution.mjs` with its
  `setup-offline-action-review-resolution-proof.sql`, `revalidate-offline-action-receipts.sql`, and
  `smoke-field_geo_search_path_fix.sql`. Newer unreferenced proofs (October and November) stay, because
  recent or in-flight work may still use them.
- **12 `tmpclaude-*-cwd` files** at the repo root (each held one folder path). `.gitignore` now ignores them.
- **Kept on purpose:** all six Playwright configs are run by an npm script or documented as a proof
  command. The two hooks unwired on 2026-10-27 (`active-area-guard.mjs`, `rls-on-new-tables.mjs`) are still
  on disk, because the review-proof guard refuses shell deletes under `.claude/hooks`. CI's
  `check-migration-hard-rules.mjs` still refuses a new table without row security.
- Proof: `npm run typecheck`, `lint`, `build`, `test`, `check:code-health`, `check:docs`; `offlineSync`,
  `OfflineBanner`, `offlineQueue`, `connectivity` and `assertRpcCoverage` tests.
