## 2026-10-26 — quote-versions-rpc-owned sweep matches the cost-column lock

- Cause: since `20261022101000_cost_columns_admin_only` (PR #1089) went live, `authenticated` reads
  `quote_versions` through a column-level grant on every column except `snapshot_data`; the table-wide
  SELECT is gone on purpose. The predicate's `quote_versions:read-path-regressed` branch still required
  table-wide SELECT, so every full sweep reported one false violation and blocked DB-touching PRs.
- Fix: that branch now checks `has_any_column_privilege(..., 'SELECT')`, keeps the `qversions_select`
  check, and also requires `get_quote_versions(uuid)` to exist and stay callable by `authenticated`, since
  version history now reads its snapshot through that routine. A new branch,
  `quote_versions:snapshot-data-readable`, fires if `authenticated` or `anon` can read `snapshot_data`
  directly (including through a table-wide re-grant).
- The guard's predicate fingerprint in `.claude/hooks/live-testdata-lib.mjs` was regenerated, and
  `src/lib/quoteVersionWriteBoundary.test.ts` pins both branches. No migration.
