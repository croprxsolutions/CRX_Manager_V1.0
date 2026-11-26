**LOCAL CANDIDATE — NOT APPLIED.** `20270312233100_enable_liquid_density_review.sql` (SQL sha256: `9b0d3416383b730b6bf486cbd9b902ff9f02f07a1e46f9468162bdfce42edbec`). Opens the liquid weight review switch only in the verified staging database job.

The migration checks that the prior manufacturer-link columns, review reads and actions, brand trigger, and legacy guards match the tested database definitions and function permissions before opening the switch. The reject action comes from `20270307205900_reject_liquid_density_draft.sql` (#2521). The Weight card must ship with or before this migration. Verify it on staging before approving this candidate there. Run `node scripts/smoke/prove-liquid-density-cutover-real-schema.mjs` after the prerequisites are in the checkout. The staging proof covers two-admin review, workbook draft protection, brand joins, active EPA or manufacturer changes, and both saved paperwork outputs. Existing approvals carry forward until changed by an approved review action or a change in the active brands or their identity.

The staging database job preparation landed in #2633. The migration leaves both the switch and original brand trigger in place without the job's transaction marker. On staging, a substantive active-brand rename returns the approval to draft or preserves the draft already waiting and withdraws the approval. Case and whitespace edits keep approval. The local proof covers these changes and the saved ticket's weight, along with the exact ledger hash, the staged schema rebuild, failed prerequisites, and draft rejection.

Verify the blend ticket and loader PDF on staging for approved, missing, and rechecked weights. Reprint a ticket saved before activation to verify its captured weight is unchanged.

The [production release hold](../../manual/known-issues.d/2026-11-25-liquid-weight-production-hold.md) stays open until the previously approved multi-brand groups are reviewed and any confirmed mismatches are split and reapproved.

Rollback uses a reviewed migration that restores the switch to false. It keeps every recorded draft, approval and event as history.
