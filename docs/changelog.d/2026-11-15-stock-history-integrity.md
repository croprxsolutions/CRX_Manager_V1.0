
## 2026-11-15 — Stock history integrity: cancelled returns read right, one open count per stock row (KI-159, KI-160 part)

- Product Master repair step 2 (To-Do 0.17), behavior contract
  `docs/plans/2026-11-15-product-master-steps-1-3-CONTRACT.md`, PR B. One new migration, not applied live.
- KI-159: the Integrity Report's "Inventory Ledger" check and the stock history screen read a `returned` row by its
  sign (a return receipt adds, its cancellation removes), so a received-then-cancelled return no longer shows a false
  20-unit gap. The check now compares each product once, summed over all its warehouse rows (history rows do not name
  a stock row, so a product held in two warehouses was flagged on both).
- New database sweep `stock-matches-history` (same rules, every sweep run): 0 rows live on 2026-11-15, 116 products
  checked.
- `20270111120000_one_open_count_per_stock_row.sql` (KI-160 part): one in-progress count per warehouse; a stock row on
  only one line of any in-progress count (two at once: exactly one wins); a count's status only moves forward (no reopen,
  and a reversed count cannot be marked completed and reversed twice); signed-in users lose direct
  UPDATE on `cycle_counts` and `cycle_count_items` (the app only uses the save-line, complete, cancel and reverse
  RPCs), so a completed count can no longer be marked cancelled without its reversal, and a line's variance is only
  ever what the save RPC computed. Plain messages for each refusal.
- Proof: `node scripts/smoke/prove-one-open-count-real-schema.mjs` (ONE_OPEN_COUNT_PROOF_PASS). Rollback:
  `scripts/smoke/one-open-count-reverse.sql` (proven).
- Not in this change (left open in KI-160): the three-request count creation.
- Sol owed: blocked by #1868 (Sol refuses staging-based branches).
