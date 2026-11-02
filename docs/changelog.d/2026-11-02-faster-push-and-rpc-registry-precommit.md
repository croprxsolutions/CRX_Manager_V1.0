## 2026-11-02 - Pushes skip the Graphify refresh; migration commits run the RPC registry tests

Two local git-hook changes from the 2026-11-02 retro (PR #1298 session):

- `.husky/pre-push` no longer refreshes the Graphify map. On PR #1298 it re-extracted about 1,259 files on most pushes and found no change, at roughly 4-6 minutes a push. Containment, typecheck and build still run. Graphify stays on demand (`npm run graph:refresh`, the `graphify` skill). This removes a non-blocking local step under the AGENTS.md guard-cleanup exception; CI is unchanged.
- `.husky/pre-commit` runs `src/lib/rpcIdempotencyScope.test.ts` and `src/lib/rpcContracts.test.ts` when a commit stages a `supabase/migrations/` path, and blocks the commit if they fail. On PR #1298 a missing alias entry surfaced only in CI and cost a CI cycle and a Sol run. CI still runs both files.

Tests: `scripts/supplier-pricing-phase3-private-artifacts.test.mjs` now checks that pre-push never calls Graphify and that pre-commit blocks a migration commit whose registry tests fail, passes when they pass, and skips them without a migration.
