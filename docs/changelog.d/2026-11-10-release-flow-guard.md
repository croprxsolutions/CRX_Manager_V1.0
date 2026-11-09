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
  bot GitHub App (secrets `RELEASE_APP_ID`, `RELEASE_APP_KEY`), because this repository doesn't let
  Actions open PRs and a PR opened by the built-in token gets no CI.
- "Main inside staging" must never be a required check (it is skipped on PRs, and GitHub counts a
  skipped required job as passed).
- **Release flow scripts** (every PR): `node --test .github/scripts/release-flow.test.mjs`.

Settings that close the remaining gaps (Taha, with Mason's OK): CODEOWNERS with code-owner review on
`.github/**` (otherwise a PR could edit this workflow itself), and "require branches to be up to date"
on `main` (so a green guard is re-run after a hotfix moves `main`).

Nothing is enforced until the repository variable `RELEASE_FLOW` is set to `on`, which Taha does
together with the branch rulesets once Mason agrees. Until then each check passes with a notice.
Actions are pinned to commit SHAs, each job has only the permissions it needs, and there is no
`pull_request_target`.
