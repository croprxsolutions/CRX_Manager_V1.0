## 2026-10-26 — Three container provers run and pass on current main again

**What was wrong.** Three disposable-database provers in `scripts/smoke/` stopped before proving
anything on current main, because newer migrations and smoke edits landed after they were written
(#1106 could only run two of them from old checkouts):

- `prove-money-replay-binding-batch1-real-schema.mjs` required its candidate (20261016060000) to be the
  newest migration; 29 newer ones exist.
- `prove-cost-margin-admin-only-rpc-leaks-real-schema.mjs` refused any later file that merely *named* a
  covered function, and five later files name them inside their own preflight pin lists.
- `prove-quote-customer-row-version-real-schema.mjs` (candidate 20260730235031) ran smokes that have
  since been rewritten for newer rules: `smoke-backfill-refuse-split-billing.sql` is fail-first against
  20261006200000 (CRX-LIFE-001, #885), and `smoke-save-quote-customer-row-version.sql` expects
  20261013220000's `REP_CANNOT_REASSIGN` (#907), neither of which a July database can have.

**Fix (the pattern the working provers already use).**

- Batch 1 and cost/margin: replay up to the candidate, then refuse any later file that (re)defines,
  alters, drops or re-grants a covered function (`FUNCTION <name>`, as in
  `prove-post-binds-reviewed-invoice-version-real-schema.mjs`). Batch 1 now covers the nine wrappers,
  their nine impls, the fingerprint/binder/guard helpers and `check_idempotency_intent`, and adds a new
  check: a later file that rebuilds the `require_bound_replay_receipt_20261015` trigger (batches 2, 3a,
  3b) must still list all nine batch-1 operations.
- Row version: unchanged up to the candidate (legacy smokes, candidate apply, missing-default drift
  check; the default is then restored and verified). `smoke-backfill-refuse-split-billing.sql` leaves
  the legacy list with a note, like `smoke-restore-version-drawn-guard.sql` before it; its replay-based
  proof is `prove-order-invoice-type-gate-real-schema.mjs`. The prover then replays every later
  migration on main (LF text, ledger rows, live `auth.uid()`, live storage shape, the same parked and
  ledger-only files as the other provers) and runs the candidate's three smoke matrices there.

No smoke chain, migration or app code changed.

**Proof (each run locally on this branch, Docker):**
`MONEY_REPLAY_BINDING_BATCH1_PROOF_PASS`, `COST_MARGIN_RPC_LEAKS_PROOF_PASS`,
`ROW_VERSION_REAL_SCHEMA_RESTORE_PASS ... post_baseline_replay=through_candidate_then_125_later
smoke_matrices_on=20261023100000_revoke_load_recipe_into_job_app_access legacy_lifecycle_smokes=5/5`.
