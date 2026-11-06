**LOCAL CANDIDATE — NOT APPLIED.** `20261114220000_tote_fill_from_bulk.sql` (SQL sha256: `2e9c09554166f3cbf0f32457c3581693bbdda69bdd07966250aedbd439fc98a4`). BLK-1a, quantities only, fertilizer totes only (build sheet `docs/plans/2026-11-04-product-stage2-BUILD-SHEET.md` §6.1, §6.3). REQUIRES `20261108120000_product_parents` and `20261110150000_product_parent_stock_units` (both live).

What it does:
- Adds `tote_fill_out` and `tote_fill_in` to `inventory_transactions_transaction_type_check` (a superset of the 12 live values; the preflight pins the live definition).
- New append-only table `tote_fills` (RLS on; any active profile may read; no write grant; update, delete and truncate refused by trigger).
- `preview_tote_fill(p_tote_product_id, p_totes)` (admin, writes nothing), `fill_tote_from_bulk(p_tote_product_id, p_totes, p_expected, p_idempotency_key)` and `reverse_tote_fill(p_fill_id, p_reason, p_idempotency_key)` (admin, key required, replay through `_product_parent_replay`). The fill recomputes the preview under lock and refuses `TOTE_FILL_PREVIEW_CHANGED` unless it equals what the admin confirmed; the Bulk may go below zero, flagged `requires_review`. The undo is refused once either product has moved since (`TOTE_FILL_STOCK_MOVED`): its stock differs, or its ledger row count (recorded on the fill under the stock locks) has grown.
- Writes no cost, price or valuation. Lock order: parent, member rows, products rows (all FOR SHARE), unit_conversions (SHARE mode, so no factor changes mid-fill), then the two inventory rows in product-ID order.

Preflight refuses if `tote_fills` exists, a PAR-1 dependency is missing, the live CHECK differs, inventory lacks its `(product_id, location)` key, `Ea`/`Unit` are missing from `unit_conversions`, or the three fertilizer categories are missing. Postflight checks the 14-value CHECK and the grants.

Proof: `scripts/smoke/prove-tote-fill-real-schema.mjs` (prints `TOTE_FILL_PROOF_PASS`).

Rollback (forward migration): drop the three public and two private functions, the table and its trigger function, and restore the 12-value CHECK once no `tote_fill_*` rows exist.
