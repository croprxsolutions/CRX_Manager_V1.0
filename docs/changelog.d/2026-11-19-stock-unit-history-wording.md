## 2026-11-19 - Stock-unit history refusal names movements and holds once (#1957)

- New migration `20270129140000_stock_unit_history_names_movements_holds.sql` re-emits the stock-unit history guard with one wording change. When a product's only history is stock movements or an active hold, the refusal used to read "...stock movements or holds (stock movements or holds)." It now says "(stock movements)", "(an active hold)" or "(stock movements and an active hold)".
- Nothing else changes: the same unit changes are refused and allowed, and the guard stays private. Screens cannot reach this message (they cannot change a saved product's stock unit).
- Proof: `node scripts/smoke/prove-units-batch-real-schema.mjs` prints `UNITS_BATCH_PROOF_PASS` (case H2 shows the old and new wording; case R proves the rollback `scripts/smoke/stock-unit-history-wording-reverse.sql`). Not applied anywhere; staging applies it after the merge.
