## 2026-11-12 - Agents work staging-first (release flow)

Agents now land feature work in `staging`, and only the weekly release and hotfixes reach `main`.
This matches the release flow (`.github/workflows/release-*.yml`) and Mason's OK on the protocol.

- **Feature PRs target `staging`, migrations included,** with every gate a merge into `main` has.
  Both merge guards (`.claude/hooks/pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`)
  no longer refuse a migration into `staging`. The staging database job applies it after the merge,
  checks the ledger and compares staging's whole schema with one rebuilt from the files.
- **An agent never merges into `main`,** nor the back-merge of `main` into `staging`. Both guards refuse
  them (`agentMergeProblem` in `.claude/hooks/sol-risk-lib.mjs`). Taha or Mason merges the weekly
  release PR (`release/next`), hotfixes and back-merges, with "Create a merge commit". A back-merge under
  another branch name is caught by its commits: while `main` has commits `staging` lacks, a PR into
  `staging` carrying any of them is refused (`mainCommitsInPrOnGitHub`: one GitHub call normally, two while a back-merge is pending; fail closed).
  It matches commit ids, so main's changes squashed or cherry-picked onto a branch aren't seen (known limit).
- **No live apply before a staging merge.** The apply gate already refused a migration from a PR that
  doesn't target `main`; its message now says why. Into `main` it now accepts only the release PR
  (`release/next`) and a `hotfix/<name>` PR, and only once main's `Release flow guard (main)` check is
  green on that head (it proves the release is exactly staging + main, and a hotfix carries no unreleased
  staging work). A stray feature branch is never applied live early.
- **Staging deploy check:** after a merge into `staging`, wait for the green `Database` run (the site can
  deploy a minute before its migration lands), then check the staging site's bundle and exercise the change
  there (test data), never production. Step 8 says plainly that an agent merges only into `staging`.
- **Prove it on staging:** a `Staging proof: <link>` line, then the `verified-on-staging` label, or
  `Held off: <revert PR or flag>` and `held-off`. The release gate needs every PR to be one or the other.
- `ship.md` (intro, autonomy bullets, Step 8 items 1 and 5–7: `gh pr create --base staging`, merge staging in, never main; Staging), `AGENTS.md` and `ARCHITECTURE.md`
  updated to match.

- **Release day (Mason's Decision A, 2026-11-12):** until the live database job is on, an agent applies
  the release's migrations live from the release PR, in stamp order, before Taha or Mason merges it, once
  one of them says in the PR they'll merge right after. Agents merge nothing into `staging` from the first
  apply until that merge, since a staging merge moves `release/next`. `ship.md` › Staging has the steps.
