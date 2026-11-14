## 2026-11-10 - Release flow guard, "main inside staging" check and back-merge PR

New workflow `.github/workflows/release-flow.yml` for the staging-first release flow (Taha,
2026-11-10). Feature and fix PRs target `staging`; the only PRs into `main` are the weekly release
(`release/next`) and hotfixes (`hotfix/<name>`).

- **Release flow guard (main)** (PRs into `main`, including a PR retargeted there): refuses any
  other head branch, a branch from a fork, and a branch that doesn't contain all of `main`. The
  rule is read from `main`'s copy of the script, never the PR's own. The job reports per base
  ("Release flow guard (staging)" just passes), so only "(main)" is required on `main`.
- **Main inside staging** (pushes to `staging`, nightly 03:30 UTC, manual): fails while `main`
  has commits `staging` lacks.
- **Back-merge** (pushes to `main`): opens one `main → staging` PR when staging is missing main's
  commits (after a release or a hotfix), asking for a merge commit, same day. It uses the release
  bot GitHub App (secrets `RELEASE_APP_ID`, `RELEASE_APP_KEY`, kept in the `release-bot` GitHub
  Environment, which deploys only from `main` and `staging`, so no PR workflow can read them), because this repository doesn't let
  Actions open PRs and a PR opened by the built-in token gets no CI.
- "Main inside staging" must never be a required check (it is skipped on PRs, and GitHub counts a
  skipped required job as passed).
- **Release flow scripts** (every PR): `node --test .github/scripts/release-flow.test.mjs`.

`.github/CODEOWNERS` makes Mason and Taha the owners of `.github/`. Settings that close the remaining
gaps (Taha, with Mason's OK): "Require review from Code Owners" on `main` and `staging` (otherwise a
PR could edit this workflow itself); "Require branches to be up to date" on `main` (so a green guard
re-runs after a hotfix moves `main`); a ruleset letting only the release bot push `release/next`; and
the `release-bot` environment. A back-merge squashed by mistake turns "Main inside staging" red; the
fix is another back-merge with a merge commit.

Direct pushes to `main` stay impossible: `protect-main` requires a PR and has no bypass actors.

Nothing is enforced until the repository variable `RELEASE_FLOW` is set to `on`, which Taha does
together with the branch rulesets once Mason agrees. Until then each check passes with a notice.
Actions are pinned to commit SHAs, each job has only the permissions it needs, and there is no
`pull_request_target`.

**Doc stamps (evidence):** `docs/manual/CURRENT_STATE.md` and `KNOWN_ISSUES.md` move to "Last verified 2026-11-10, for the live ledger only". Read-only `list_migrations` on live (2026-11-10, Taha's OK): 1,186 ledger rows, newest `20261110061547` (`20261229160000_convert_to_gl_lb_dry_oz`). The five files dated 20261110 that made the stamps due were all applied live on 2026-11-05 (rows `20261105203216`, `…205727`, `…213209`, `…224006`, `…225320`). Nothing else was re-checked; KI-30 keeps its 2026-11-09 date.
