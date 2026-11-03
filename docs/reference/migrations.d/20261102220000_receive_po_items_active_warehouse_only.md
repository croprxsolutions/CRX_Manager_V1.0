**APPLIED LIVE 2026-11-02 20:37:02 UTC (2:37 PM Central)**, ledger version `20261102203702` carrying name `20261102220000_receive_po_items_active_warehouse_only` (match on the name, the B7 rule, no rename); applied before the merge through `scripts/apply-migration-file.mjs` from PR #1289 head `7ef186119` (exact-head Sol clean, both apply proofs clean). Post-apply live catalog read: both functions carry the Main-only refusal, SECURITY DEFINER with `search_path = public, pg_temp`, EXECUTE for authenticated and not anon. Post-apply rolled-back live checks: an active non-Main warehouse was refused for receiving and Add Inventory; a Main receipt of 3 replayed with the same key stayed at 3; an Add Inventory into Main replayed with the same key made one row of 1 unit. The text below describes the pre-apply candidate and is kept as history. `20261102220000_receive_po_items_active_warehouse_only.sql` (SQL sha256: `70c0ea066d78b095b8e0a26b35ab18c26f60d1cdb5294483fdfada895c46b7f8`).

KI-85 Part A. Replaces the public wrappers `receive_po_items(jsonb, uuid, text, boolean)` (previous body
`20260831233000`) and `manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric, text, numeric, numeric)`
(previous body `20261016140000`) with the same bodies plus one check each: when there is no saved replay, every
location must be Main Warehouse with its `warehouses` row active (missing means Main Warehouse), else
`UNKNOWN_STORAGE_LOCATION` (P0001) and nothing changes. Other active warehouses are refused too until a transfer
function exists; that migration must lift this guard (DECISION_LOG 2026-11-02). Request fingerprints are unchanged, so existing replays still match. `receive_po_items`'
actor-mismatch message gains the `ACTOR_MISMATCH:` prefix. No grants are issued; the postcondition checks anon cannot
and authenticated can execute both, and that Main Warehouse is active. The inner bodies are untouched.

Rollback: a reviewed migration restoring the two previous wrapper bodies. No rows are written or changed. The local
classifiers returned `changesAccess=false` and `rewrites=false`. A rolled-back live run proved each refusal and
pass-through case (see `docs/changelog.d/2026-11-02-receiving-active-warehouse-only.md`).

**Live ordering re-read — 2026-11-02 20:29 UTC (read-only `execute_sql` over `supabase_migrations.schema_migrations`):** 1094 rows. Effective high-water computed row by row (each row's name timestamp, falling back to its version when the name has none) is `20261102200000` (`20261102200000_cost_definer_leaks_closed`, ledger version `20261102183928`); `20261102180000_bind_money_replay_receipts_batch4a` (ledger `20261102184730`) sits below it. `20261102220000` is strictly greater, so ordering holds. No ledger name contains `warehouse_only`, and no other open pull request or file on main uses `20261102220000`. Renumbered from `20261102180000` after batch 4a took that stamp.
