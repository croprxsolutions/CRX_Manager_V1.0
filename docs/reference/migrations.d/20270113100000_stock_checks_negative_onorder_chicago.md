**LOCAL CANDIDATE — NOT APPLIED.** Repair step 5, part 1 (KI-139, KI-141, KI-162): `20270113100000_stock_checks_negative_onorder_chicago.sql` (SQL sha256: `b461225cf8bd0130a03c452b27dde3e370d321ad3aa728de13c3616e47d7594e`). Three stock and receiving checks, re-emitting three function bodies. No table, row, grant or owner changes.

**What it does.**
- `_reconcile_negative_inventory_replay_impl_20261015` (KI-139): refuses a row whose on-hand is not below zero ("Only stock below zero can be reconciled here ..."), and refuses `NaN` / `Infinity`. A same-key retry still returns the first answer (the impl's `check_idempotency` runs first).
- `_retire_inventory_item_replay_impl_20261015` (KI-141): refuses while the row has stock on order. It takes the row with `FOR UPDATE NOWAIT` and *tries* the on-order recompute's advisory lock `73492009`; if either is held elsewhere it refuses with a "try again in a moment" message. It never waits on a lock, so it cannot deadlock with receiving or a PO save.
- `get_receiving_log` (KI-162): the From/To filter uses the America/Chicago business day (bounds on the `timestamptz` column, so the index stays usable).

**Safety.** The preflight pins each live body's md5 (read 2026-11-16) and refuses a second apply (`STOCK_CHECKS_STEP5_BASELINE_DRIFT`); the postflight checks the new bodies plus unchanged owner, grants, settings, security mode, return type, volatility and arguments. Plan: `docs/plans/2026-11-16-stock-checks-CONTRACT.md`.

**Proof (local real-schema container, network off, test data):** `node scripts/smoke/prove-stock-checks-real-schema.mjs` → `STOCK_CHECKS_PROOF_PASS`: reconcile −10 → 0 with one ledger row; refusals at 0, +5, NaN, Infinity with nothing changed; retire deletes a row with nothing on order and refuses one with 4 on order; a sales rep is refused by both; retire is refused at once (no wait) while another session holds the recompute lock or the row, then succeeds; Receiving Log Nov 1 / Nov 2 bounds on Chicago time; second apply refused.

**Rollback:** a new reviewed migration re-emitting the prior bodies (from `20261016140000` and `20261113110000`).
