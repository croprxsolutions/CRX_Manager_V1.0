## 2026-11-11 - Staging DB job: existing migrations with odd stamps or self-wrapping are accepted

The staging database job's first live run (re-run of Database #3) stopped before writing anything. It
had refused three applied migrations whose stamps carry an impossible time (`20261022086000`,
`20261022086500`, `20261022087000`, i.e. 08:60–08:70). A dry check against every real file also showed
`20260727231652_quote_and_rate_reads_office_only` would stop the one-time backfill, because it wraps
itself in `BEGIN;`/`COMMIT;`.

- Existing files only need the `<14 digits>_<lower_snake>` shape. A real date and time is required
  only for new migrations, in the PR "Migration stamps" check.
- Files the job only stores (the backfill of older staging rows, and one-shots it records) need
  clean UTF-8 so the hash matches. The run rules (own transaction control, psql backslash commands)
  apply only to files it runs.

Checked against all 267 post-baseline migration files on `staging`: none blocks the run.
Tests: `.github/scripts/db-apply.test.mjs` (15).
