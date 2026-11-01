## 2026-11-01 - Sol cut to database, logins and money; changelog notes only for migrations

Mason approved three further harness cuts in chat ("Yes, all three").

- **Sol list:** now the database, logins and permissions, and money and inventory (`sol-risk-lib.mjs`, `docs/reference/sol-required-paths.md`). Dependency, deployment and guard-file changes land on green checks.
- **Ledger check:** `scripts/check-ledger-update.mjs` now fires only on `supabase/migrations/`, so small hook, command, script and test fixes commit freely.
- **Removed rule:** the test that required every Codex-protected file to need Sol.

Kept: the keep list in `AGENTS.md`, including exact-head Sol before a migration applies. Decision: `docs/manual/DECISION_LOG.md`, 2026-11-01.
