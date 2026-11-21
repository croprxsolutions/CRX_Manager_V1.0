**LOCAL CANDIDATE — NOT APPLIED.** #1912: `20270129110000_adjust_inventory_key_printable_only.sql` (SQL sha256: `e85bbd9292f58a69d4b2ad128e494724cbda9e37d6e2d7c62c8fb42c75c7b261`). Re-emits `adjust_inventory` with one changed condition: the idempotency key is refused if it holds ANY character outside printable ASCII (`p_idempotency_key COLLATE "C" ~ '[^!-~]'`), instead of only when it holds no printable character. No table, row, grant or owner changes.

**Safety.** The preflight requires the live body to be exactly the `20270113100000` body (md5 `f004ee94ab89552797fb34d3f581248d`), so it cannot apply before that migration and a second apply is refused (`ADJUST_INVENTORY_KEY_1912_BASELINE_DRIFT`); the postflight checks the new body (md5 `a65294fccbf7d49375b96ed6c46ab29e`) plus unchanged owner, grants, settings, security mode, return type, volatility and arguments. Plan: `docs/plans/2026-11-19-adjust-inventory-key-printable-CONTRACT.md`.

**Proof (local real-schema container, network off, test data):** `node scripts/smoke/prove-adjust-inventory-key-real-schema.mjs` → `ADJUST_INVENTORY_KEY_PROOF_PASS`.

**Rollback:** a new reviewed migration re-emitting the `20270113100000` body.
