## 2026-11-25 - Manual docs: freshness stamp after the 20261125 migration came due

- `CURRENT_STATE.md` and `KNOWN_ISSUES.md` "Last verified" stamps move to 2026-11-25 for the live ledger only.
- Evidence: read-only `list_migrations` on production on 2026-11-25 shows 1,245 rows; the newest is `20261124070916` (`20270301100000_live_test_data_reset`, applied 2026-11-24, recorded in `2026-11-24-live-test-data-reset-applied.md`). The migration that came due today, `20261125100000_orders_list_keyset_page`, is in that ledger by name under version `20261106173420`; the ledger version is the apply time, not the file's stamp.
