# Order edit concurrency — To-Do 1.12

Candidate: `20261028185500_order_edit_and_number_concurrency.sql`.
Status: local candidate, not applied or deployed. This task expressly prohibits merging,
live migration apply, deployment and production writes.

Orders carry a database-maintained `row_version`. Header changes and line changes advance it.
The editor confirms its header and line reads belong to the same version, then submits that
version to `update_order_items`. A stale or missing version is refused before the existing
order-edit implementation runs. Existing pricing, inventory, billing and lifecycle rules stay
in that implementation.

The screen retains an unsaved draft after a conflict. Keep editing allows the user to copy
their work. Reload Order replaces the draft only after a successful complete read; a failed
reload retains the draft and retry key. Reconcile desired edits against the reloaded order,
then save again. A retry with the same request and key returns its original receipt without
writing twice. A changed request under that key requires reconciliation.

Ticket numbers are serialized within the transaction that generates and inserts the ticket.
Allocation-set versions are assigned under a per-entity transaction lock at insert time. The
existing uniqueness constraints remain in force. Document year selection and payment dates
are owned by separate tasks.

## Verification

- `node scripts/smoke/prove-order-edit-concurrency-real-schema.mjs`: network-disabled,
  disposable PostgreSQL 17; supported baseline plus ledger-selected main migrations. Runs
  the actual order-edit and payment RPCs, concurrent editors, concurrent retries, stale/missing
  versions, header/child invalidation, actor and role refusals, ticket creation transactions,
  order totals and reservation checks. The ticket transactions call the real generator and
  insert as the local owner; the full upload/OCR RPC is outside this proof.
- `npx playwright test --config=playwright.order-edit.config.ts`: actual order page against
  a loopback intercepted backend; two browser editors, conflict recovery, failed reload,
  missing version and uncertain-response retry. This verifies the UI separately from SQL.

## Future rollout and rollback

No rollout is authorized in this task. A future applying session must refresh the live
migration ledger, check other pending migrations touching these objects, finish all review
and delivery gates, and record the candidate in migration history. The additive version
column and replacement RPC must be applied before deploying the frontend. An older editor
without a version will be refused; arrange a quiet rollout and ask staff to reload the app.

Rollback is a reviewed forward migration restoring the prior public order-edit signature/body
and ticket-number body, and removing the three new triggers and their functions. Keep the
additive version column. Roll back the frontend with the database contract. No business rows
are deleted by this candidate.

Proposed shared to-do status (for later integration): **1.12 implemented locally; concurrency
proof observed; parked pending final review and protected delivery. Not live.**

## Parking evidence — 2026-10-28

- The isolated real-schema proof printed `ORDER_EDIT_CONCURRENCY_REAL_SCHEMA_PASS`, including
  the before/after overwrite reproduction and final order totals/reservation checks.
- The combined local browser run passed all three scenarios. The affected page/dialog suites
  passed 53 tests across seven files after the snapshot helper extraction and version-fixture updates.
- The first broad run completed 480 files: 473 passed, seven failed, with 6595 tests passed,
  37 failed and 123 skipped. Those seven files exposed version-fixture and column/trigger
  integration mismatches, corrected in this branch. Their focused reruns pass; a final full
  480-file rerun has not been performed, so the broad-suite gate is not claimed green.
- The final combined focused rerun passed **180 tests in nine files**, including every file
  that failed in the first broad run and the shared conflict-dialog suite.
- TypeScript, lint, production build, code-health, agent-guidance and agent-workflow checks
  passed. The larger regression suite is tracked separately at closeout.
- Scoped security, compliance and type reviews found no BLOCKER/HIGH. Migration drift review
  requested a migration-history record; an explicitly parked, unnumbered candidate record is
  now present. The later applying session must assign its live entry only after actual apply.
- **Delivery gate unavailable:** this session's SQL guard refused the generated read-only
  live sweep queries with “Codex only permits clearly read-only SQL.” The required sweep
  could not be checked, try again. No sweep pass is claimed. The four-layer workflow runtime
  is also absent from this session's tools. Do not substitute the scoped reviews for it.
- Luna and final exact-SHA Sol review, guarded push and a draft PR remain outstanding because
  the prerequisite gates are not green. This task is parked locally, not ready to deliver.
