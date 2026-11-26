**LOCAL CANDIDATE — NOT APPLIED.** `20270309020000_pricing_history_append_only.sql` (SQL sha256: `0e95441b7e78e483aef3d11762d6b540f4b862dc8283200271d9869015572af3`). The two history tables refuse UPDATE, DELETE and TRUNCATE with `COST_HISTORY_APPEND_ONLY` or `QUOTE_PRICE_HISTORY_APPEND_ONLY`. The existing insert paths retain their access. The migration uses a five-second lock timeout and verifies that all four triggers are enabled.

- `cost_history.product_id` already prevents product deletion when history exists. A referenced pricing change set cannot be deleted because `ON DELETE SET NULL` would update that history.
- `quote_price_changes.quote_id` uses `ON DELETE CASCADE`. A quote with history cannot be hard-deleted. The Quotes screen uses `deleted_at` for removal.
- Proof command for disposable PostgreSQL 17. `node scripts/smoke/prove-pricing-history-append-only-real-schema.mjs`. The proof exercises inserts, refusals of all three mutation commands on both tables and the effects on the parent records.
- Rollback uses a reviewed migration with the four `DROP TRIGGER` and two `DROP FUNCTION` statements listed in the SQL header.
