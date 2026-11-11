## 2026-11-11 - Release flow hardening before switch-on

Sol reviewed the bootstrap PR (#1787) and raised 12 findings in the release flow. Each was checked
against the code. This PR fixes the ones that were real:
- **The guard compared only file names on `release/next`.** It now also checks what is inside the bot's
  files. `package.json` and `package-lock.json` may differ from staging + main only in their version
  fields. `src/releaseNotes.ts` must be exactly the module the bot generates: a version, a date and a
  list of strings, and no code (`check-release-content`, `botFileProblems`).
- **The bot could lose staging's other edits to `package.json` or its lock** when it resolved a conflict
  by keeping release/next's old copy. It now starts both, and `CHANGELOG.md`, from staging + main (the guard's
  expected side), then sets only the version and adds the release's section.
- **`CHANGELOG.md` and the other bot files could be deleted or emptied.** All four must exist on
  release/next, and the changelog must keep every earlier release's section word for word, ending where it did.
  `src/releaseNotes.ts` must always be the bot's exact module (date `YYYY-MM-DD`), even when it equals staging's copy.
- **Versions weren't checked.** They must now be one plain `X.Y.Z` (no leading zeros), the same in `package.json`, both
  version fields of the lock, and `src/releaseNotes.ts`, and CHANGELOG.md needs a section for it. It must differ from staging + main's version. The content check reads big files in full (no
  1 MB cap) and fails on any git error other than "file not in this tree".
- **Release-gate refreshes failed silently.** They ignored a failed `gh workflow run` (`|| echo`), so a
  stale gate status could stand. That fallback was for before `release-pr.yml` reached main (#1787), and
  it is gone from `release-labels.yml` (two places) and `release-flow.yml`.
- **A release or hotfix merged by squash or rebase still got its tag.** Main then lacks the branch's
  commits and the next release counts them again. `release-tag.yml` now refuses to tag such a merge and
  says how to fix it.
- **A `-- crx: no-transaction` migration could hold several statements.** It runs outside a transaction,
  so a failure after the first statement leaves half a change. The stamp check now refuses more than one
  statement; only `SET lock_timeout` / `statement_timeout` may come before it, nothing may follow it, and the file must hold that one statement.
- **A new one-shot migration was checked as if it would run.** It is only recorded, so only its encoding
  is checked now, as the apply job does.
- **Stamps could name an impossible date** like 31 February. They must now be a real calendar day.
- **"Held off: flag X" isn't checked against the flag.** That is by design, since a person judges it. The
  release PR checklist now asks for it, along with a fresh gate run right before merging, and a check that
  only the bot pushed to `release/next`. The planned `release-next` ruleset enforces that last point.

**Covered elsewhere:**
- The version the bot calculated, and the notes' wording, can't be checked by the guard. The guard can't
  see the plan. The `release-next` ruleset lets only the bot push there, and the checklist asks for it.
- A gate refresh is asynchronous, so a proof removed seconds before merging can't be caught. The
  checklist asks for a fresh run right before merging.
- A `DO` block that commits inside a no-transaction file. That predates this PR; the rule counts
  statements, it doesn't parse procedural code.
- A hand-made changelog that keeps old sections but adds a contradicting copy, or mismatched dates. These
  need a push to `release/next`, which only the bot may make.
- A squash-merged release is detected (no tag), not prevented. The `protect-main` ruleset, set to merge
  commits only, prevents it.

**Before `RELEASE_FLOW=on`:** copy `.github/` to `main` again (a `hotfix/` PR, like #1787). The guard
runs main's copy of the script, and `check-release-content` exists only once main has it. Until then the
guard fails closed on a release PR.

Not changed:
- Comment matching for the gate refresh. GitHub's `contains()` already ignores case.
- The reference-data replay. Its inputs are frozen files that replay cleanly.
- Rebase merges. They are turned off by the staging ruleset at switch-on.
- Storage table grants in the schema fingerprint. These need a look at what the platform grants on
  staging first, or the job would go red on platform defaults.
- Release-PR stamps for migrations already applied on staging (M4b, M4a). That needs a decision with
  Mason.

Tests: `.github/scripts/db-apply.test.mjs`, `.github/scripts/release-flow.test.mjs`.
