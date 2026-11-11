## 2026-11-11 - Staging schema check: platform lines out, a difference now fails

The first staging report (run 42996813824, after #1773) compared 11,714 objects. It found 7 differences, all
from the Supabase platform, none in `public`:
- `supabase_realtime_admin` is a member of `anon`, `authenticated` and `service_role` on staging, not in the
  rebuild (it runs with realtime off). It is a platform role, not a login of the app.
- Storage tables that come and go between storage versions: `storage.bucket_lifecycle_states` and
  `storage.lifecycle_abandoned_artifacts` exist on staging, `storage.iceberg_namespaces` and
  `storage.iceberg_tables` only in the local rebuild.

`.github/scripts/schema-fingerprint.sql` now leaves out only those three memberships, and only with
the platform's options (no admin, no inherit, set only): a changed option, or `supabase_realtime_admin`
joining any other role, is still compared. Storage tables are listed when they are `objects` or
`buckets`, have a policy, or have RLS off, so the platform's own RLS-on tables can come and go; storage
policies are still compared in full.

`SCHEMA_MODE: report` is removed from `.github/workflows/db-apply.yml`, so any remaining difference fails
the "Staging schema matches the files" job. As since #1773, that job runs after the apply and the edge
deploy does not wait for it: a mismatch shows as a red job, not as functions held back.
