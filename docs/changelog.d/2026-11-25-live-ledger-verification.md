## 2026-11-25 - Recheck the live migration ledger

Read the production migration ledger at 06:09:36 UTC (12:09 a.m. Central). It held 1,245 rows. Its most recent recorded version was `20261124070916` for `20270301100000_live_test_data_reset`, also the effective authored high-water. The check's due Orders migration, `20261125100000_orders_list_keyset_page`, is present under ledger version `20261106173420`, matching its migration record.

This refresh is scoped to the live migration ledger in Current State and Known Issues.
