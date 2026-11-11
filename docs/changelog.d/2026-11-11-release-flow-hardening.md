## 2026-11-11 - Release flow hardening before switch-on

Sol reviewed the bootstrap PR (#1787) and raised 12 findings in the release flow. Each was checked
against the code. This PR fixes the ones that were real:
- **The guard compared only file names on `release/next`.** It now also checks what is inside the bot's
  files. `package.json` and `package-lock.json` may differ from staging + main only in their version
  fields. `src/releaseNotes.ts` must be exactly the module the bot generates: a version, a date and a
  list of strings, and no code (`check-release-content`, `botFileProblems`).
- **Release-gate refreshes failed silently.** They ignored a failed `gh workflow run` (`|| echo`), so a
  stale gate status could stand. That fallback was for before `release-pr.yml` reached main (#1787), and
  it is gone from `release-labels.yml` (two places) and `release-flow.yml`.
- **A release or hotfix merged by squash or rebase still got its tag.** Main then lacks the branch's
  commits and the next release counts them again. `release-tag.yml` now refuses to tag such a merge and
  says how to fix it.
- **A `-- crx: no-transaction` migration could hold several statements.** It runs outside a transaction,
  so a failure after the first statement leaves half a change. The stamp check now refuses more than one
  statement.
- **A new one-shot migration was checked as if it would run.** It is only recorded, so only its encoding
  is checked now, as the apply job does.
- **Stamps could name an impossible date** like 31 February. They must now be a real calendar day.
- **"Held off: flag X" isn't checked against the flag.** That is by design, since a person judges it. The
  release PR checklist now asks for it.

Not changed:
- Comment matching for the gate refresh. GitHub's `contains()` already ignores case.
- The reference-data replay. Its inputs are frozen files that replay cleanly.
- Rebase merges. They are turned off by the staging ruleset at switch-on.
- Storage table grants in the schema fingerprint. These need a look at what the platform grants on
  staging first, or the job would go red on platform defaults.
- Release-PR stamps for migrations already applied on staging (M4b, M4a). That needs a decision with
  Mason.

Tests: `.github/scripts/db-apply.test.mjs`, `.github/scripts/release-flow.test.mjs`.
