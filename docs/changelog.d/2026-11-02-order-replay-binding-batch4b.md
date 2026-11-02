## 2026-11-02 — replay-binding batch 4b: order pricing, order edits and inventory verification (KI-10)

- New migration `20261102235000_bind_order_replay_receipts_batch4b.sql` (not yet applied): three
  functions now hand back a saved retry answer only to the same person for the exact same request —
  `price_order`, `update_order_items` and `mark_inventory_row_verified`. A retry key reused for a
  different order, inventory row, set of prices or order lines is refused with nothing changed,
  instead of reporting a false success. Each now requires a retry key, and runs its permission check
  before any saved answer is returned. A retry that only adds the approved below-cost reason still
  replays.
- Screens: Order Detail's pricing button retires a refused key when the server proves nothing ran
  under it. The order-edit save and the inventory verify button already handle refusals.
- Proof: `scripts/smoke/prove-order-replay-binding-batch4b-real-schema.mjs` with the new chain
  `scripts/smoke/smoke-order-replay-binding-batch4b.sql`; the draw-lock and role-reads chains now
  pass retry keys.
