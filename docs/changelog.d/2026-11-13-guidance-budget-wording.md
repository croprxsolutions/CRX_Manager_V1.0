## 2026-11-13 - Correct the applied MOA migration record

Corrected the MOA-1 migration record from local candidate to applied, using the read-only live ledger's actual version/name pair. Supabase assigned ledger version `20261112230412` to the authored file `20270108100000_ingredient_modes_of_action.sql`; these intentionally differ. No SQL or live schema changed.
