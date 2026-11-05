## 2026-11-05 — Three list functions get a unique tie-breaker so screens can page them (Goal 4 part 4)

- New migration `20261111110000_paged_read_tiebreakers.sql` (not yet applied): `get_receiving_log`, `get_watchdog_flags` and `get_fields_with_geojson` now add the row id as the last sort key. Rows that share a time or a field name can no longer swap between page requests, so a page-by-page read of a list that is not changing sees every row once (rows added or removed mid-read are still caught by the screens' paged reader, which re-reads to confirm). Rows, filters, columns, role checks, grants and security mode are unchanged.
- Proof script `scripts/smoke/prove-paged-read-tiebreakers-real-schema.mjs` (scratch container, 25 tied rows per function, pages of 7).
- The screens that page these functions ship in a separate PR after this is live.
