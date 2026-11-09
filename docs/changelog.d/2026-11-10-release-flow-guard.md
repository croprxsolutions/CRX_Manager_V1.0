## 2026-11-10 - Release flow guard, "main inside staging" check and back-merge PR

New workflow `.github/workflows/release-flow.yml` for the staging-first release flow (Taha,
2026-11-10). Feature and fix PRs target `staging`; the only PRs into `main` are the weekly release
(`release/next`) and hotfixes (`hotfix/<name>`).

- **Release flow guard** (PRs into `main`): refuses any other head branch, and refuses a branch
  that doesn't contain all of `main`.
- **Main inside staging** (pushes to `staging`, nightly 03:30 UTC, manual): fails while `main`
  has commits `staging` lacks.
- **Back-merge** (pushes to `main`): opens one `main → staging` PR when staging is missing main's
  commits (after a release or a hotfix), asking for a merge commit, same day.
- **Release flow scripts** (every PR): `node --test .github/scripts/release-flow.test.mjs`.

Nothing is enforced until the repository variable `RELEASE_FLOW` is set to `on`, which Taha does
together with the branch rulesets once Mason agrees. Until then each check passes with a notice.
Actions are pinned to commit SHAs, each job has only the permissions it needs, and there is no
`pull_request_target`.
