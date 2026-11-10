## 2026-11-10 - Staging database job: migrations and edge functions apply on merge into staging

New workflow `.github/workflows/db-apply.yml` and script `.github/scripts/db-apply.mjs` (staging half
of the self-applying database job, approved by Mason on 2026-11-03). It replaces Taha's laptop
script `local-supabase/catchup-staging.sh`.

- **On every push to `staging`** (GitHub Environment `staging-db`, secret `STAGING_DB_URL`):
  - Every migration file after the baseline that the staging ledger lacks is applied in stamp order,
    the same way live applies work today: one transaction holding the file byte for byte plus its
    `supabase_migrations.schema_migrations` row (version = UTC apply time, name = file name, statements
    = the file).
  - The stored text's sha256 is then checked against the file.
  - One-shot data migrations (`supabase/baselines/one-shot-migrations.json`) are recorded, never run.
  - A missing file older than the newest applied one stops the run before anything is applied.
  - Older staging rows without `statements` get the file text once.
  - A file whose header says `-- crx: no-transaction` runs on its own, then gets its ledger row
    (Mason's point 6).
- **Then changed edge functions deploy to staging** (`supabase@2.122.0 functions deploy --use-api`,
  secret `SUPABASE_ACCESS_TOKEN`). If `_shared` changes, or on a manual run, all functions deploy.
- **On PRs into `staging` or `main` that add migrations:** the "Migration stamps" check needs a
  well-formed name, a stamp no other file shares, and a stamp newer than every migration already on
  the base branch. The rule comes from the base branch's copy of the script.
- **Refusals:** the script refuses the live project and MetaHive, and any URL that isn't the expected
  project. A psql failure never prints the connection string.

Inert until the repository variable `STAGING_DB_JOB` is `on`. Taken through these cases on a
throwaway local database: apply, one-shot record, backfill, re-run (no-op), a failing migration
(nothing kept, no ledger row), out-of-order stop, live URL refused, password never printed.
Tests: `.github/scripts/db-apply.test.mjs`.
