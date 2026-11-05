## 2026-11-05 — replay-binding batch 4c: purchase orders, quote copies, deliveries, cycle counts, blend tickets (KI-10)

- New migration `20261110100000_bind_money_inventory_replay_receipts_batch4c.sql` (not yet applied): twelve
  functions now hand back a saved retry answer only to the same person for the exact same request —
  `submit_purchase_order`, `cancel_purchase_order`, `delete_purchase_order`, `duplicate_quote`,
  `edit_delivery`, `reassign_delivery`, `batch_reschedule_deliveries`, `confirm_delivery`,
  `create_delivery_with_items`, `create_followup_delivery`, `cancel_cycle_count` and
  `reverse_blend_ticket_approval`. A retry key reused for a different purchase order, quote, delivery,
  cycle count or blend ticket (or with a different reason, date, driver or set of lines) is refused with
  nothing changed, instead of reporting a false success. Each now requires a retry key and runs its
  permission check before any saved answer is returned (`confirm_delivery` keeps its driver check in the
  body, where it was). A quote copy retried with an approved below-cost reason still replays.
- `start_and_complete_delivery`'s internal start step now calls the renamed confirm body directly, so
  one-tap Delivered keeps working with no key of its own for that step.
- Screens: every caller already sends a retry key. Customer page "New from Last" now keeps a separate key per
  source quote, and Cycle Counts' Cancel keeps one per count, so a lost reply followed by acting on a different
  quote or count is not refused as a mismatch. Rescheduling several deliveries treats the same set of deliveries
  in any order as the same request.
- `scripts/smoke/smoke-start-and-complete-delivery.sql` now sends the completion evidence the live function has
  required since the evidence change, so it runs again (it covers the one-tap Delivered path this batch rewires).
- Proof: `scripts/smoke/prove-replay-binding-batch4c-real-schema.mjs` with the new chain
  `scripts/smoke/smoke-replay-binding-batch4c.sql`.
