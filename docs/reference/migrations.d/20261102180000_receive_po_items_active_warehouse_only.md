**LOCAL CANDIDATE, NOT APPLIED (2026-11-02).** `20261102180000_receive_po_items_active_warehouse_only.sql` (SQL sha256: `70c0ea066d78b095b8e0a26b35ab18c26f60d1cdb5294483fdfada895c46b7f8`).

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
