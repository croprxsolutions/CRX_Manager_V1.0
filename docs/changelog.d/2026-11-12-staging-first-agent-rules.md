## 2026-11-12 - Agents work staging-first (release flow)

Agents now land feature work in `staging`, and only the weekly release and hotfixes reach `main`.
This matches the release flow (`.github/workflows/release-*.yml`) and Mason's OK on the protocol.

- **Feature PRs target `staging`, migrations included,** with every gate a merge into `main` has.
  Both merge guards (`.claude/hooks/pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`)
  no longer refuse a migration into `staging`. The staging database job applies it after the merge,
  checks the ledger and compares staging's whole schema with one rebuilt from the files.
- **An agent never merges into `main`,** nor the back-merge of `main` into `staging`. Both guards refuse
  them (`agentMergeProblem` in `.claude/hooks/sol-risk-lib.mjs`). Taha or Mason merges the weekly
  release PR (`release/next`), hotfixes and back-merges, with "Create a merge commit".
- **No live apply before a staging merge.** The apply gate already refused a migration from a PR that
  doesn't target `main`; its message now says why. A hotfix's migration is still applied live before
  its merge, as before.
- **Prove it on staging:** a `Staging proof: <link>` line, then the `verified-on-staging` label, or
  `Held off: <revert PR or flag>` and `held-off`. The release gate needs every PR to be one or the other.
- `ship.md` (intro, autonomy bullets, Step 8 items 5–7, Staging), `AGENTS.md` and `ARCHITECTURE.md`
  updated to match.

**Not in this change:** how a release's migrations are applied live on release day. That waits for
Mason's Decision A; `ship.md` › Staging says so, and until then no agent applies a release's migration.
