## 2026-11-10 - Weekly release PR with a release gate and Taha's template

New workflow `.github/workflows/release-pr.yml`, part of the staging-first release flow (Taha,
2026-11-10). Every Thursday at 04:00 UTC (08:00 Dubai), and on demand, it:

1. lists every commit on `staging` that `main` lacks (`--no-merges`, so back-merges and catch-ups
   don't count) and finds its PR through GitHub's commit-to-PR link, accepted only when that PR was
   merged into `staging` as exactly that commit; anything else is listed as "commit without a PR"
   and blocks the release;
2. cuts `release/next` from `staging` (or merges `staging` and `main` into the open one) and adds one
   commit: the version in `package.json`/`package-lock.json`, a section in the root `CHANGELOG.md`
   grouped by conventional-commit type, and `src/releaseNotes.ts` (the "What users see" lines);
3. opens or updates the PR `release: vX.Y.Z` into `main` from `.github/release-pr-template.md`
   (Taha's template plus the PR status table, "What users see", a post-deploy checklist and the
   rollback plan). It rewrites only the parts between its `<!-- bot:… -->` markers, so ticked boxes
   and deployment notes stay;
4. posts the `release-gate` commit status: green only when every PR is `verified-on-staging` with
   its proof link still present, or `held-off` with its reason.

Pushes to `staging` or `main`, label changes and PR edits refresh an open release PR (through a
secret-less `workflow_dispatch` of main's copy); only the schedule or a manual run opens a new one.
The status goes on the exact commit the bot pushed, so anything pushed to `release/next` afterwards
has no green gate. Proof lines count only from the PR body and from people with access to the
repository. Versions: a release bumps the minor over the highest of the tags and `main`'s
`package.json` (`v0.1.0` first); the releaser can change it by editing the PR title. A hotfix PR gets
its `release-gate` from the release bot after the same checks as the guard, plus "carries no
unreleased staging work". The release bot GitHub App (environment `release-bot`, deployments from
`main` only) does the writes, because work created with the built-in token triggers no CI; its token
is limited to contents, pull requests, statuses and workflows.

Settings this relies on (Taha, with Mason's OK): `release-gate` required on `main` and pinned to the
release bot App, so no one else's status counts; a ruleset letting only the App update
`release/next`; merge commits only on `main`. `.github/pull_request_template.md` adds "What users see",
"Staging proof" and "Follow-ups" to new PRs. Inert until `RELEASE_FLOW` is `on`.

Checked with a dry run on the last 30 PRs on main (`DRY_RUN=1`): v0.1.0, 30 PRs, gate red as
expected, CHANGELOG grouped correctly. Tests: `.github/scripts/release-flow.test.mjs`.
