## 2026-11-11 - Release flow files reach main (bootstrap)

The release-flow and staging-database workflows and scripts are copied byte for byte from `staging`
onto `main`. They already run on staging, but GitHub runs scheduled, manual ("Run workflow") and
comment-triggered workflows only from the default branch (`main`), so until now these never ran:
- the nightly staging schema check (02:30 Dubai, `db-apply.yml`);
- the Thursday release PR (`release-pr.yml`);
- the `Staging proof:` comment labelling (`release-labels.yml`).

Files: `.github/workflows/{release-flow,release-labels,release-pr,release-tag,db-apply}.yml`,
`.github/scripts/` (release-flow, db-apply, schema fingerprint and rebuild),
`.github/{CODEOWNERS,pull_request_template.md,release-pr-template.md}`.

Nothing changes for anyone yet:
- Everything that enforces, opens PRs, tags or back-merges waits for the repository variable
  `RELEASE_FLOW=on`, which isn't set.
- The staging database jobs touch only the staging project.
- Two things do start working:
  - PRs into `main` get the "Migration stamps" check (a new migration must be stamped above main's newest).
  - `CODEOWNERS` names Mason and Taha for `.github/` (enforced only where a ruleset requires code-owner review).

The app changes that come with the flow (environment banner, What's new) are not in this PR. They
reach `main` with the first release.
