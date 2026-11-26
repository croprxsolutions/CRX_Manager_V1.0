**LOCAL CANDIDATE — NOT APPLIED.** `20270309050000_enable_liquid_density_review.sql` (SQL sha256: `131420b753303bf41e225376f173bd9a564106368f33f4b3bffd07f6ce1a106e`). Opens the liquid weight review switch only in the verified staging database job.

The migration checks that the prior manufacturer-link columns, review reads and actions, brand trigger, and legacy guards match the tested database definitions and function permissions before opening the switch. The reject action comes from `20270307205900_reject_liquid_density_draft.sql` (#2521). The Weight card must ship with or before this migration. Verify it on staging before approving this candidate there. Run `node scripts/smoke/prove-liquid-density-cutover-real-schema.mjs` after the prerequisites are in the checkout. The staging proof covers two-admin review, workbook draft protection, brand joins, active EPA or manufacturer changes, and both saved paperwork outputs. Existing approvals carry forward until changed by an approved review action or a change in the active brands or their identity.

Before applying, land the separate staging database job preparation. The migration leaves the switch closed without the job's transaction marker. The local cutover test verifies that unmarked and wrongly marked replays stay closed, the staging wrapper rejects an activation that fails to open, and the successful apply has the exact ledger hash and the same function as the staging schema rebuild. It also checks failed prerequisites, draft and approval rules, and draft rejection.

Verify the blend ticket and loader PDF on staging for approved, missing, and rechecked weights. Reprint a ticket saved before activation to verify its captured weight is unchanged.

The [production release hold](../../manual/known-issues.d/2026-11-25-liquid-weight-production-hold.md) stays open until the previously approved multi-brand groups are reviewed and any confirmed mismatches are split and reapproved.

Rollback uses a reviewed migration that restores the switch to false. It keeps every recorded draft, approval and event as history.
