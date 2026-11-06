## 2026-11-06 — Five split billing smoke chains reach their checks again

- `smoke-order-invoice-refuses-field-split`, `smoke-split-invoice-cross-customer-lineage`,
  `smoke-split-payer-return-credit`, `smoke-void-order-governed-split-drafts` and
  `smoke-backfill-refuse-split-billing` stopped in their setup, before any check, once delivery
  evidence (20261022075000) and the order invoice cap (20261029160000) arrived. Their fixtures now
  record evidence and complete deliveries first. No assertion changed.
- No app or database change.
