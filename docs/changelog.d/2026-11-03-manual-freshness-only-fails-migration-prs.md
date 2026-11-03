## 2026-11-03 - Manual-freshness check fails only PRs that add a migration or edit the two live-state docs

**Guard narrowed (Mason, 2026-10-30: fewer guards, more product work).** `npm run check:docs` row
"manual freshness" (`CURRENT_STATE.md` / `KNOWN_ISSUES.md` "Last verified" at least the newest
migration's date, capped at Chicago today) failed PRs #1266, #1335, #1338 and #1345. #1335 and #1338
changed only scripts and docs. They went red because another PR had landed a migration stamped that day.

On a pull request the check now FAILS only when the PR adds or renames a `supabase/migrations/*.sql`
file or edits either doc. Every other PR gets a `WARN` row and passes. The PR's files come from
`git diff --name-status <merge-base with the event's base SHA> HEAD`, read through the event file
GitHub Actions provides. If that read fails, the check enforces in full.

**Remaining enforcement:** pushes to `main` (the post-merge CI run) and every local
`npm run check:docs` run stay fully enforced, so a stale stamp on `main` still turns `main`'s CI red.
A PR that adds a migration must still bump both stamps, as before.

**Proof:** new cases in `scripts/check-doc-drift.test.mjs` failed before the change (no
`manualFreshnessStatus`) and pass after. End to end in a throwaway copy of `main` with both stamps
set to 2026-11-01, the old script failed a scripts-only PR (exit 1) and the new one passes it with
two WARN rows (exit 0). A PR that adds a migration still fails (exit 1), and so does a push to `main`
(exit 1). Not verified: a live GitHub Actions run of the WARN path. This PR's own CI run takes the
PASS path, because today's stamps are fresh.
