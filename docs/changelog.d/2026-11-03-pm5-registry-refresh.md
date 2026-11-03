## 2026-11-03 - Registry refresh after WP-PM-5 Use Timing went live

- Regenerated `.claude/schema-registry.json` from live after `20261103210000_product_use_timings` was applied (ledger `20261103052726`); it now knows `product_use_timing_options` and `products.use_timings`.
- `src/lib/costFields.test.ts` no longer allows `use_timings` as a not-yet-live column.
- The migration record is marked applied live, with its read-only post-apply check.
- Freshness re-check (read-only, 2026-11-03 06:11 UTC): the live ledger has 1101 rows. `20261103120000` (ledger `20261103003731`), `20261103130000` (`20261103013009`), `20261103150000` (`20261103015728`) and `20261103210000` (`20261103052726`) are all live, so `KNOWN_ISSUES.md` no longer calls 4b or the Chicago-date migration "not yet applied". `CURRENT_STATE.md` and `KNOWN_ISSUES.md` are re-stamped 2026-11-03 for the ledger only.
