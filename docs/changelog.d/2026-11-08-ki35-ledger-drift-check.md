## 2026-11-08 — KI-35: one read-only command compares the live migration ledger with `main`

- `npm run db-drift:live` (`scripts/check-migration-drift.mjs`) reads the live ledger read-only and lists, in plain
  English: live rows with no file on `main`, files on `main` never applied, and live rows whose name or SQL differs
  from the file (CRLF and whole-line comments ignored on both sides). `--rows <file>` judges a saved ledger read;
  `--ref` compares against another branch. Exit 0 clean, 1 drift, 2 could not run.
- Matching reuses `.claude/hooks/migration-pending-lib.mjs` (renumbered and shared-name rows); the live read reuses
  the sweeps' token path. `scripts/migration-drift-allowlist.json` lists the 159 pre-baseline rows with no file
  (KI-62) by version, plus parked drafts and accepted mismatches, each with a reason.
- First live run: 1174 rows vs 1087 files, 259 SQL bodies matching; the one finding is KI-30's migration applied
  before PR #1653 merged, clean against that branch. Tests: `scripts/check-migration-drift.test.mjs` (in
  `npm run test:correction-guards`).
