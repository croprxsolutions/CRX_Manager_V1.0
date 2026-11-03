## 2026-11-03 - Provers seed live's Main Warehouse from one place (KI-85)

Since `20261102220000_receive_po_items_active_warehouse_only` (KI-85), its postcondition needs an active
Main Warehouse, which the schema-only baseline lacks, so real-schema provers stopped with `KI85_POSTCONDITION`.
`scripts/decompress-schema-baseline.mjs --with-live-rows` now appends live's single warehouse row after the
schema; every `scripts/smoke/prove-*` that decodes the baseline passes it, and the batch-4b and use-timings
in-loop stop-gaps are gone. Without the flag the output is byte-identical (manifest hash unchanged), so a
real restore is unaffected. Never pass it on a real restore.

**Live ledger read (for the CURRENT_STATE and KNOWN_ISSUES stamps):** read-only `schema_migrations` read
2026-11-03 06:06 UTC. All 12 migration files stamped 20261102–20261103 on `main` are applied, the last being
`20261103210000_product_use_timings` (version `20261103052726`). No file from those two days is unapplied.
