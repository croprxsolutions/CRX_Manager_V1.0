## 2026-11-23 — Sol skip records go one file per PR (no more DIRTY sibling PRs)

`node scripts/owner-accept-sol-finding.mjs --log` now writes Mason's Sol skip entry for a PR into
`staging` as its own new file, `docs/manual/decision-log.d/<date>-pr<n>-sol-skip-<head>.md`,
instead of inserting it into `docs/manual/DECISION_LOG.md`. Why: on 2026-11-23 #2323, #2337 and
#2248 all inserted skip entries into `DECISION_LOG.md`; GitHub ignores `merge=union`, so the second
to land went DIRTY, and catching it up with staging voided its exact-head owner-accepted carry
(a new Sol round and another skip from Mason).

- `--carry-owner-accepted` accepts exactly that one new file holding exactly the entry, the same
  strictness as before (one commit, one file, byte-exact entry).
- A review against `main` (hotfix or release) still writes `DECISION_LOG.md`: the release check
  (`.github/scripts/release-flow.mjs`) lets only that file ride on a release head, and this PR does
  not change `.github/`.
- Readers already read the folder: the Sol round-5 stop (`decisionLogAt`), the future-date
  pre-flight and the ledger guards. Existing entries are not moved.
