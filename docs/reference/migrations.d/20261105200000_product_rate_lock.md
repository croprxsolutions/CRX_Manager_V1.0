**LOCAL CANDIDATE, not applied.** `20261105200000_product_rate_lock.sql` (LF SQL sha256: `dece2470d4678bf0c1047d9b576825e546b187fee91bf3bbe69966f62849ef8c`). WP-PM-11a-1. REQUIRES the price workbook tables (`product_info_change_set_rows`) and `unit_conversions`; its preflight refuses, changing nothing, when they are missing.

What it does:
- New one-row `product_rate_lock` (starts unlocked) and append-only `product_rate_events`. Every signed-in user can read both; nobody writes them directly, and updates, deletes and truncates are refused.
- While locked, a trigger on `products` refuses any change to `rate_per_acre`, `rate_unit` or `suggested_rate` (`PRODUCT_RATES_LOCKED`), and refuses a new product saved with rates. Saves that leave the rates unchanged (including spaces-only differences, and the seed/each rate unit that follows the inventory unit) still work.
- The price workbook can no longer stage rate changes: a change-set row whose changes name a rate column is refused (`PRODUCT_RATES_READ_ONLY_IN_PRICE_WORKBOOK`).
- The three per-acre tier prices must be whole cents (CHECK constraints). Read on live before writing: 0 of 604 products break this.
- New `set_product_rates(rows, performed_by, idempotency_key)`: admin only, actor-bound, idempotent bulk rate writer for the CSV import (WP-PM-10) and setup workbook (WP-PM-11a-2). Refused while locked. Each row carries the expected current values; stale rows, invalid rates (more than 6 decimals or 12 digits) and unknown units are refused by name, all or nothing.
- New `set_product_rate_lock(locked, reason, performed_by, idempotency_key)`: admin only, reason required (at most 500 characters), logged.
- New `correct_product_rates(product, rate, unit, suggested, expected_pricing_version, reason, performed_by, idempotency_key)`: while locked, an admin corrects one product with a reason; checks the pricing version, logs before and after, and reprices per acre.
- Rate writes still log price history through `write_product_pricing_history`, which labels them `product_page`; the reason lives in `product_rate_events`.

Grants: both tables are revoked from PUBLIC, anon, authenticated, service_role and metabase_ro, then SELECT to `authenticated`. Every function is revoked from PUBLIC, anon, authenticated and service_role; EXECUTE goes to `authenticated` only on `set_product_rates`, `set_product_rate_lock` and `correct_product_rates`. All three are SECURITY DEFINER with `search_path = public, pg_temp`.

Rollback: drop the triggers `trigger_zzz_guard_product_rate_lock` and `product_info_change_set_rows_rates_read_only`, the three whole-cent CHECK constraints, the ten functions this file creates, and the two tables. Dropping `product_rate_events` loses the lock and correction log, so export it first. Product rates written while it was live stay as written.

Proof: `node scripts/smoke/prove-product-rate-lock-real-schema.mjs` prints `PRODUCT_RATE_LOCK_PROOF_PASS`; `scripts/smoke/smoke-product_rate_lock.sql` pins every function body and ends `SMOKE_PASS_ROLLBACK`.

Live ledger preflight, read 2026-11-04 03:40 UTC (9:40 PM Central on 11-03) with read-only `execute_sql`: 1114 rows; effective high-water `20261105180000` (row by row, the name stamp else the version), which is `20261105180000_preferred_vendor_enforcement`; no ledger name contains `rate_lock`. Read the ledger again at apply time.
