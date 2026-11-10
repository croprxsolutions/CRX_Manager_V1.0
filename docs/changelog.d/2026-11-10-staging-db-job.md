## 2026-11-10 - Staging database job: migrations and edge functions apply on merge into staging

New workflow `.github/workflows/db-apply.yml` and script `.github/scripts/db-apply.mjs` (staging half
of the self-applying database job, approved by Mason on 2026-11-03). It replaces Taha's laptop
script `local-supabase/catchup-staging.sh`.

- **On every push to `staging`** (GitHub Environment `staging-db`, secret `STAGING_DB_URL`):
  - Every migration file after the baseline that the staging ledger lacks is applied in stamp order,
    the same way live applies work today: one transaction holding the file byte for byte plus its
    `supabase_migrations.schema_migrations` row (version = UTC apply time, name = file name,
    statements = the file).
  - Inside that same transaction, the job proves the file didn't commit on its own and that the
    stored text hashes to the file's bytes (sha256). Any failure rolls everything back.
  - One-shot data migrations (`supabase/baselines/one-shot-migrations.json`) are recorded, never run.
  - The run stops before applying anything if:
    - a file isn't plain UTF-8, starts with a byte-order mark, has its own
      `BEGIN;`/`COMMIT;`/`ROLLBACK;` line, or has a psql backslash command;
    - a missing file is older than the newest applied one;
    - an already-applied migration no longer matches its ledger row.
  - Staging rows after the baseline that `catchup-staging.sh` wrote without `statements` get the
    file text once. Baseline rows are left alone.
  - A file whose header says `-- crx: no-transaction` runs on its own, then gets its ledger row
    (Mason's point 6).
- **Then every edge function deploys to staging** (`supabase@2.122.0 functions deploy --use-api`,
  secret `SUPABASE_ACCESS_TOKEN`). `send-delivery-receipts` deploys with `--no-verify-jwt`, as its
  header requires (the pg_cron wake carries no user token). The others keep verify_jwt on. Deploying
  all of them each run means a failed or replaced run never leaves one stale. Removing a deleted
  function stays a manual, approved step.
- **On PRs into `staging` or `main` that touch migrations,** the "Migration stamps" check needs:
  - a well-formed name, a stamp no other file shares, and a stamp newer than every migration already
    on the base branch;
  - no edited, renamed or deleted existing migration;
  - the same file rules as above.

  The rule comes from the base branch's copy of the script.
- **Target rules:** the script reads the project ref from the connection string (the pooler user
  `postgres.<ref>` or the host `db.<ref>.supabase.co`) and runs only on exactly the expected
  project. It never runs on live or MetaHive. A psql failure never prints the connection string.

Inert until the repository variable `STAGING_DB_JOB` is `on`. Before the secrets go in, the
`staging-db` environment must be limited to the `staging` branch, and code-owner review on
`.github/` must be on for staging (see the PR's setup steps).

Taken through these cases on a throwaway local database:
- apply, one-shot record, backfill (rows after the baseline only), re-run (no-op);
- a failing migration (nothing kept, no ledger row);
- a file with its own COMMIT (refused before anything ran);
- an edited applied migration (stopped);
- out-of-order (stopped);
- live or wrong-project URLs (refused);
- password never printed.

Tests: `.github/scripts/db-apply.test.mjs`.
