## 2026-11-13 - Correct the applied MOA migration record

An intermediate commit removed redundant wording from the shared contract introduction. The later staging merge retained staging's guidance, so this branch's final change against staging includes no `AGENTS.md` edit. The remaining record correction below changes no rule, gate, workflow, authority or limit.

Corrected the MOA-1 migration record from local candidate to applied, using the read-only live ledger's actual version/name pair. Supabase assigned ledger version `20261112230412` to the authored file `20270108100000_ingredient_modes_of_action.sql`; these intentionally differ. No SQL or live schema changed.
