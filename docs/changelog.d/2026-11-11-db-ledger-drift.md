## 2026-11-11 - Staging DB job: ledger drift check after every apply

The staging database job (`.github/workflows/db-apply.yml`) now runs a read-only drift check right
after it applies migrations: `node .github/scripts/db-apply.mjs drift`. For every ledger row after the
baseline, it reports:

- **a row with no migration file:** applied outside the repo (the SQL Editor, an unmerged branch), or
  renamed after it ran;
- **a row whose file changed after it ran:** the stored text's sha256 differs from the file;
- **a file not applied yet:** a warning only.

It starts in report mode (`DRIFT_MODE: report`): findings show as warnings and the job passes. Once the
first staging report is reviewed, that line comes out and drift fails the job.

Still to come: the nightly run, and comparing the real schema with one rebuilt from the files.
Scheduled runs start from `main`, so the nightly needs a read-only environment that `main` can use;
it comes with the read-only staging login.
Tests: `.github/scripts/db-apply.test.mjs` (16); checked on a throwaway local database (clean, then an
SQL Editor change).
