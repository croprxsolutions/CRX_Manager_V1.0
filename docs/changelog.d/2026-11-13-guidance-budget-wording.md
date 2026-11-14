## 2026-11-13 - Correct the MOA migration record

The earlier shared-contract wording edit was superseded by staging's release-flow contract while this branch was open. This branch carries staging's contract text unchanged.

Corrected the MOA-1 migration record from local candidate to applied, using the read-only live ledger's actual version/name pair. Supabase assigned ledger version `20261112230412` to the authored file `20270108100000_ingredient_modes_of_action.sql`; these intentionally differ. No SQL or live schema changed.
