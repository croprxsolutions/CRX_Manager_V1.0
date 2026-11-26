**LOCAL CANDIDATE — NOT APPLIED.** Applicator price hide, database step 3 of 3 (contract `docs/plans/2026-11-25-applicator-crew-read-path-CONTRACT.md`): `20270311160000_applicator_crew_base_read_lockdown.sql`. Limits SELECT from four price-bearing base tables to admins and sales reps while applicator and dispatched-crew reads continue through the existing crew views.

## What changes

The four price-bearing base tables (`jobs`, `job_chemicals`, `job_field_shares`, and `field_billing_defaults`) now allow SELECT rows only for admins and sales reps. The existing four crew views remain the applicator and dispatched-crew read path. The two location-dispatchee base-table policies are removed.

The migration refuses to run unless all four crew views exist and the six current base-table SELECT policies match the expected deparsed policy hash (`82812af55c7565208df9dfaf907f8869`, count 6). It also pins the four crew views by an exact fingerprint (kind, owner, options, definition: `e86b95ce92e6ac220d93bd7ccfd0c645|4`), refuses a crew view carrying a protected column or not owned by an RLS-bypassing role or set to security_invoker, refuses a base table with RLS off or forced, refuses when `authenticated` cannot SELECT a crew view, and refuses autocommit, restrictive policies, extra SELECT/ALL policies, and a second application. It changes only those six policies and verifies that exactly four office-only SELECT policies remain and that RLS is still on (and not forced) for all four base tables and `authenticated` can still SELECT all four crew views, then prints `POSTFLIGHT_OK`. Before any check it takes an ACCESS EXCLUSIVE lock on the four base tables and holds each crew view with a zero-row read (ACCESS SHARE, which blocks redefining it), both to commit, so nothing it checked can change underneath it. Its 1s lock_timeout caps each lock wait (on timeout nothing has changed and the apply is re-run); once the locks are held, app readers wait for the rest of the transaction, which is only catalog checks and six policy statements. Apply it in a quiet window. Precondition: the crew-view frontend (PR #2574) is live first; a tab open from before that deploy shows empty crew lists until reloaded.

## Behavior and recovery

Applicators and location dispatchees no longer receive rows from the four base tables; their crew-view results and writes remain as before. Admin and sales rep reads are unchanged. No data, grants, write policies, views, or functions change.

To recover, a reviewed corrective migration may use `scripts/smoke/applicator-crew-lockdown-reverse.sql`. It refuses unless the current SELECT policies are exactly the four the lockdown wrote (so a later tightening is never silently overwritten), then restores the six earlier policies and re-opens crew reads from the price-bearing base tables, so it requires Mason's yes under the contract's Undo / recovery rule.

## Proof

`node scripts/smoke/prove-applicator-crew-lockdown-real-schema.mjs` uses the step-1 fixture and probes, full visible-row payloads, office roles, rolled-back writes, and the applicator's own-upload/delete path. Success prints `CREW_LOCKDOWN_PROOF_PASS`. It is configured to reuse a network-disabled `crx-crp-*` or `crx-undo-paths-*` container with `CREW_LOCKDOWN_PROOF_REUSE=1`.

Out of scope (Mason, 2026-11-26): another admin changing these policies, grants, views or their helper functions at the same moment this migration or its reverse runs. The apply script runs alone in its apply window; the locks above stop schema changes to what is checked, and grant or function changes made mid-apply are treated like changes made right after it.
