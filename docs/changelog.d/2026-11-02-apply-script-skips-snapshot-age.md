## 2026-11-02 - Apply script reads the live migration list itself

`scripts/apply-migration-file.mjs` no longer refuses when the local applied-migration snapshot is more than 24 hours old, and when `SUPABASE_ACCESS_TOKEN` is set it rebuilds that snapshot from the live ledger before its gate runs. That replaces the manual "list migrations, pipe to refresh-applied-migrations, re-run" step. The script still re-reads the live ledger right before it transmits. The MCP `apply_migration` path keeps the 24-hour rule because it has no live re-check.
