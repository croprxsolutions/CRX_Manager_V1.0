## 2026-11-13 - Restore guidance budget and correct the MOA migration record

At an intermediate local checkpoint, redundant wording was removed from the shared contract introduction to fit the startup-context size check. That edit was already incorporated into staging before this branch's final diff; the current branch preserves the staging version of the shared contract and does not change its guidance.

The application change in this branch's final staging diff corrects the MOA-1 migration record from local candidate to applied, using the read-only live ledger's actual version/name pair. Supabase assigned ledger version `20261112230412` to the authored file `20270108100000_ingredient_modes_of_action.sql`; these intentionally differ. No SQL or live schema changed.
