## 2026-11-11 - Release flow files reach main (bootstrap)

The release-flow and staging-database workflows and scripts are copied byte for byte from `staging`
onto `main`. GitHub runs scheduled and manual ("Run workflow") workflows only from the default branch
(`main`), and the label and release-gate jobs read their rules from main's copy of the script. So until
now these never ran:
- the nightly staging schema check (02:30 Dubai);
- the Thursday release PR job;
- the label rules.

Files: `.github/workflows/{release-flow,release-labels,release-pr,release-tag,db-apply}.yml`,
`.github/scripts/` (release-flow, db-apply, schema fingerprint and rebuild),
`.github/{CODEOWNERS,pull_request_template.md,release-pr-template.md}`.

Still waiting for the repository variable `RELEASE_FLOW=on` (not set):
- the branch guard;
- labels and label comments;
- the release PR;
- tags;
- the back-merge PR.

What does start:
- The nightly read-only schema check of staging, and "Run workflow" for the staging database job (apply
  to staging, edge deploy to staging, schema check). They touch only the staging project.
- PRs into `main` get the "Migration stamps" check: a new migration must be stamped above main's newest.
  It is not a required check. A PR whose stamp has fallen behind shows red until it is restamped with
  `npm run next-migration-stamp`.
- Each push to `main`, and each Thursday, runs a release job that stops at the `RELEASE_FLOW` check.
  Its first run makes GitHub create the `release-bot` environment, with no rules. Set its deployment
  branches to `main` only before adding the App key.
- `CODEOWNERS` names Mason and Taha for `.github/`. GitHub requests their review on PRs that change it.
  It is enforced only where a ruleset requires code-owner review (staging today, not main).

The app changes that come with the flow (environment banner, What's new) are not in this PR. They
reach `main` with the first release.
