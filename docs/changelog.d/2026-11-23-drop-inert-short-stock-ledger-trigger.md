## 2026-11-23 - #2225: drop the inert short-stock ledger trigger

- Migration `20270224210000_drop_inert_delivery_short_stock_trigger` drops `trg_mark_delivery_aggregate_short_stock` and its function `_mark_delivery_aggregate_short_stock`. Since #2135 nothing sets the settings it reads, so it changed no row. Delivery completion still flags short products for review exactly as before (the completion body does it). No user-visible change.
- Proof: `scripts/smoke/prove-drop-inert-delivery-short-stock-trigger-real-schema.mjs` on a rebuilt production schema; rollback `scripts/smoke/drop-inert-delivery-short-stock-trigger-reverse.sql`.
