## 2026-11-04 - Merge guards cover the `staging` branch (before #1363 creates it)

Mason on #1363 (3 Nov): "yes with the guard updates first". This is that first step, so `staging` is never open to ungated agent merges.

- Both merge guards (`.claude/hooks/pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`) give a merge into `staging` every gate a merge into `main` has: no CHANGES_REQUESTED, the pinned head, no `--auto`, every check green, and the Sol proof where the Sol list needs it. The shared list is `GATED_MERGE_BASES` in `sol-risk-lib.mjs`.
- The Sol proof stays bound to `origin/main` (`write-codex-push-proof.mjs` is unchanged), so a proof is accepted for a merge into `staging` only when `staging` already contains the `main` it was reviewed against.
- **Migrations do not go through `staging` yet.** Both merge guards refuse a merge into `staging` whose GitHub comparison has a file in `supabase/migrations/` (fail closed if the list can't be read). The apply gate's existing "PR must target main" refusal now says why. A migration PR targets `main` and is applied live first, as today, until Mason approves the job that applies migrations to the staging database.
- Bringing `main` into `staging` is a PR `main → staging` merged by Taha or Mason. The release PR `staging → main` is a merge into `main`.
- `AGENTS.md` (Protected Delivery) and `.claude/commands/ship.md` (new "Staging" section) say the same.
- Tests: `sol-risk-lib.test.mjs` (the base list, migration detection including renames and Windows paths, fail-closed reads), `production-action-guard.test.mjs` (a staging merge needs Sol and the pin, lands with a proof, refuses a migration, fails closed when GitHub can't be read) and `pr-merge-guard.test.mjs` (the staging check runs before any allow point).
