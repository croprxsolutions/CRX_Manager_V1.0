## 2026-11-17 — Inventory clean-up: delivery lines match their order lines, completions lock stock in one order, two stock-history gaps (KI-161, KI-150, KI-163)

- Product Master repair step 5, part 2 (To-Do 0.17); behavior contract
  `docs/plans/2026-11-17-inventory-cleanup-ki161-163-150-CONTRACT.md`. One new migration, not applied live:
  `20270122100000_inventory_cleanup_ki161_163_150.sql`.
- **KI-161:** every delivery line must belong to its delivery's order, for the same product and unit as its order
  line, and an order line can appear once per delivery. The database checks this for every writer, not only the
  edit screen. A delivery that has lines cannot be moved to another order. Signed-in users can no longer write
  delivery lines directly (the delivery functions still do; reading is unchanged). Refusals reach the screen as
  plain messages (`src/lib/errorSanitizer.ts`).
- **KI-150:** two delivery or job completions that share products now lock the stock rows in the same order, so one
  waits instead of both failing on a deadlock. Receipt reversal vs vendor bill needed no change (the bill paths
  never lock PO lines; evidence in KI-150).
- **KI-163:** cancelling a quick delivery records what it really released (none when nothing was held). Count lines
  keep 4 decimals, so a count completes exactly on the counted figure. The PO header that looked 1¢ off is correct
  (sum of its lines rounded to whole cents). Linking return/reversal rows by column stays open.
- Proof: `node scripts/smoke/prove-inventory-cleanup-real-schema.mjs` (INVENTORY_CLEANUP_PROOF_PASS): shows the
  deadlock and the wrong figures before the migration, and the fixes after. Rollback:
  `scripts/smoke/inventory-cleanup-ki161-163-150-reverse.sql` (proven; the count columns stay at 4 decimals).
- Not in this change: a stock row that does not exist yet when two completions start (0 on open deliveries live);
  other writers' lock orders; `edit_delivery`'s replace-all-lines behavior.
