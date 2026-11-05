## 2026-11-05 — Delivery receipts are recorded with the completion (KI-25, database part)

- New migration `20261108100000_delivery_receipt_queue.sql` (not applied yet; record in `docs/reference/migrations.d/`).
  When a driver completes a delivery and leaves "email the customer" ticked, the receipt is now owed in the database
  from the same save, instead of depending on the phone still having signal afterwards. A server worker sends it and
  retries (five tries over about 30 minutes); anything it cannot confirm goes to an office list to check by hand.
- `complete_delivery` gains an optional `p_email_receipt`; left out, it behaves exactly as before.
- Nothing is sent yet: the worker, its secrets and the app change ship in the next PR.
- New proof `scripts/smoke/prove-delivery-receipt-queue-real-schema.mjs`.
