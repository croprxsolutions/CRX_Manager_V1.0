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
The generator is owner-only; the authenticated `create_blend_ticket` RPC remains the entry point.
Allocation-set versions are assigned under a per-entity transaction lock at insert time. The
existing uniqueness constraints remain in force. Document year selection and payment dates
are owned by separate tasks.

## Verification

- `node scripts/smoke/prove-order-edit-concurrency-real-schema.mjs`: network-disabled,
  disposable PostgreSQL 17; supported baseline plus ledger-selected main migrations. Runs
  the actual order-edit and payment RPCs, concurrent editors, concurrent retries, stale/missing
  versions, header/child invalidation, actor and role refusals, ticket creation transactions,
  order totals and reservation checks. Ticket transactions use the real authenticated manual
  `create_blend_ticket` RPC with no products, images or OCR. The proof also checks the SQL
  receipt contract, replay after a later edit, and refusal after the actor's role is revoked.
- `npx playwright test --config=playwright.order-edit.config.ts`: actual order page against
  a loopback intercepted backend; two browser editors, conflict recovery, failed reload,
  missing version and uncertain-response retry. This verifies the UI separately from SQL.

## Future rollout and rollback

No rollout is authorized in this task. A future applying session must refresh the live
migration ledger, check other pending migrations touching these objects, finish all review
and delivery gates, and record the candidate in migration history. The additive version
column and replacement RPC must be applied before deploying the frontend. An older editor
without a version will be refused; arrange a quiet rollout and ask staff to reload the app.
The candidate narrows an existing function's EXECUTE permissions. Future live application
requires Mason's explicit approval for that permission change in the applying conversation.

Rollback is a reviewed forward migration restoring the prior public order-edit signature/body
and ticket-number body and prior ACL, and removing the three new triggers and their functions. Keep the
additive version column. Roll back the frontend with the database contract. No business rows
are deleted by this candidate.

Proposed shared to-do status (for later integration): **1.12 implemented locally; concurrency
proof observed; parked pending final review and protected delivery. Not live.**

## Parking evidence — 2026-10-28

- The isolated real-schema proof printed `ORDER_EDIT_CONCURRENCY_REAL_SCHEMA_PASS`, including
  the before/after overwrite reproduction and final order totals/reservation checks.
- The combined local browser run passed all four scenarios. The affected page/dialog suites
  passed 53 tests across seven files after the snapshot helper extraction and version-fixture updates.
- Both renewed full runs passed **6,632 tests, zero failures and 123 skipped**. The final
  trigger timing and proof assertions also passed the affected 127-test contract rerun and
  a fresh real-schema run. The proof checks the installed trigger timing before its local
  rollback-only mutation and verifies corrected concurrent operations and parent versions.
- The final combined focused rerun passed **180 tests in nine files**, including every file
  that failed in the first broad run and the shared conflict-dialog suite.
- TypeScript, lint, production build, code-health, agent-guidance and agent-workflow checks
  passed. The larger regression suite is tracked separately at closeout.
- Scoped security, compliance and type reviews found no BLOCKER/HIGH. Migration drift review
  requested a migration-history record; an explicitly parked, unnumbered candidate record is
  now present. The later applying session must assign its live entry only after actual apply.
- **Delivery gate unavailable:** this session's SQL guard refused the generated read-only
  live sweep queries with “Codex only permits clearly read-only SQL.” The required sweep
  could not be checked, try again. No sweep pass is claimed.
- **Canonical workflow completed on retry:** native Claude background session `49b86c41`
  ran `wf_d74f383a-6ac` to completion in 670 seconds. All four layers and both requested
  skeptics returned evidence; no layers or verifier results are missing. The broad audit
  is evidence-complete but not clean: one confirmed pre-existing HIGH and 31 lower-priority
  findings require separate triage. This does not erase the clear scoped candidate reviews.
  Full operational details are retained privately; no overall clean verdict is claimed.
  Earlier plan-mode and foreground attempts remain failed runs, superseded by this retry.
- **Live-sweep setup checked:** the strict runner fails closed without `SUPABASE_DB_URL`
  and `psql`. Claude found no saved read-only connection. An existing backup account is
  present, but its credential was not available; the approved CLI connection is writable.
  No new login, credential rotation, permission change or denied sweep execution occurred.
- **Compatibility repair blocked:** shared safety code already recognizes fingerprinted
  sweep packets, while the Codex SQL guard rejects them. Its documented Claude repair
  handoff was itself refused by the active protected-harness guard. No repair was applied
  or activated, no query was rerouted, and no guard was weakened. A clean isolated repair
  checkout and private handoff are prepared for the authorized maintainer route.
- Luna round one identified a SQL/UI receipt mismatch and retry and generator contract
  issues. The candidate now emits explicit success, replays a bound receipt after later
  edits without writing again, and keeps number generation inside owner transactions.
  Local mutation proof reproduced the missing-success mismatch before checking the fix.
- A reported role-revocation replay issue is refuted by the existing active-role check
  before receipt lookup, with a local refusal proof. The version trigger runs before
  line changes and locks affected parent orders in stable order ahead of totals updates.
  Both parents are invalidated when a privileged workflow moves a line.
- Three Luna iterations found no remaining confirmed issue after fixes and evidence-backed
  refutations. The final LOW grant question was resolved with fresh read-only catalog
  evidence: order SELECT policies apply only to authenticated users; anonymous users have
  no role memberships, superuser status or RLS bypass, and order RLS is enabled. Keeping
  the column grant follows the existing column-carved convention without exposing rows.
- Final exact-SHA Sol review, guarded push and a draft PR remain outstanding because
  prerequisite gates are not green. The supported Sol wrapper dry-run also refuses
  preflight without an identified PR. No Sol proof was minted. This task is parked
  locally, not ready to deliver. Finish the remaining sweep evidence and audit triage in a
  supported session before PR and final review; no merge/apply/deploy is authorized.

The unpublished local branch was refreshed onto `origin/main` at `9b7150416`. Upstream
changes include planning documentation and CI/final-review tooling; product code and
SQL in this candidate were unchanged by the rebases. Scoped security and drift reviews are clear;
the final local agent-workflow test suite also passed.
