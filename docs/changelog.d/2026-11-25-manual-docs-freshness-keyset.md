## 2026-11-25 — manual docs freshness stamp (orders_list_keyset_page came due)

`20261125100000_orders_list_keyset_page.sql` came due today (America/Chicago), so the docs
freshness check failed every staging PR that adds a migration or touches the two live-state docs.

Read-only `list_migrations` on production (`get_project_url` returned `rhyzpcqhnizqbxphqdkr`
first), 2026-11-25: 1245 ledger rows; newest live row `20261124070916`
(`20270301100000_live_test_data_reset`). `20261125100000_orders_list_keyset_page` has been live
since ledger version `20261106173420`.

`CURRENT_STATE.md` and `KNOWN_ISSUES.md` "Last verified" lines move to 2026-11-25 for the live
ledger only; nothing else in either file was re-certified.
