## 2026-11-11 - Staging DB job: schema check against the files, nightly drift

New job "Staging schema matches the files" in `.github/workflows/db-apply.yml`. It runs after every
staging apply, nightly at 02:30 Dubai (22:30 UTC), and on "Run workflow".

1. `.github/scripts/rebuild-schema.sh` builds a throwaway local Supabase from the repo:
   - the baseline, plus the reference rows the baseline can't carry;
   - then every post-baseline migration in stamp order.

   One-shot data migrations are recorded, never run. These are the same steps as the local rebuild.
2. `node .github/scripts/db-apply.mjs schema` runs `.github/scripts/schema-fingerprint.sql` on staging and
   on the rebuild, then lists every line that differs. The fingerprint has one line per object in
   `public`: tables, columns, constraints, indexes, triggers, RLS policies, views, functions (body md5),
   enums, domains and grants. It never reads table data.
3. Nightly and manual runs also run the ledger drift check.

It logs in as `crx_drift_ro` (secret `STAGING_DB_READONLY_URL`, environment `staging-db-readonly`). That
login is read-only and can read only the ledger table and the catalog. It starts in report mode
(`SCHEMA_MODE: report`). Once the first report is reviewed, that line comes out and a difference fails
the job.

`urlRef` now accepts any `<role>.<project ref>` user on a Supabase pooler host, so the read-only login is
recognised. Host and project-ref checks are unchanged.
Tests: `.github/scripts/db-apply.test.mjs` (18). The fingerprint gives identical output for `postgres`
and a read-only role.
