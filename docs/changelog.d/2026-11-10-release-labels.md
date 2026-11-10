## 2026-11-10 - Release labels: on-staging, verified-on-staging (with proof), held-off

New workflow `.github/workflows/release-labels.yml`, part of the staging-first release flow (Taha,
2026-11-10). It only acts on PRs into `staging` from branches in this repository.

- **`on-staging`** is added automatically when a PR merges into `staging` (not the back-merge PR,
  whose head is `main`).
- **`verified-on-staging`** is added by whoever tried the change on staging. It stays only if the PR
  is merged into staging and its description or a comment has a line `Staging proof: <https link>`;
  otherwise the bot removes it and comments with the exact line to add.
- **`held-off`** marks work that is on staging but not shipping this week; it needs a line
  `Held off: <revert PR or flag name>` naming a PR (`#123` or a link) or `flag <name>`.

The rules are plain functions in `.github/scripts/release-flow.mjs` (`proofLink`, `heldOffNote`,
`isBackMerge`, `labelProblem`) with tests in `release-flow.test.mjs`, and the workflow runs the script as it was on
staging before the PR (its base commit), never the PR's own copy. It reads the PR fresh before
removing a label, so an edit made while it queued counts. The weekly release gate (next PR) reads these labels.
