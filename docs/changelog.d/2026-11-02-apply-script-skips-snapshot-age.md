## 2026-11-02 - Apply script no longer refuses an old migration snapshot

`scripts/apply-migration-file.mjs` stopped refusing when the local applied-migration snapshot is more than 24 hours old. The script re-reads the live migration list right before it transmits (added 2026-11-02), so the snapshot's age proved nothing there and only forced a manual refresh. The snapshot must still exist, and the MCP `apply_migration` path keeps the 24-hour rule because it has no live re-check.
