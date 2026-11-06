## 2026-11-05 — Delivery receipts are recorded with the completion (KI-25, database part)

- New migration `20261113140000_delivery_receipt_queue.sql` (applied live 2026-11-05; record in `docs/reference/migrations.d/`).
  When a driver completes a delivery and leaves "email the customer" ticked, the receipt is now owed in the database
  from the same save, instead of depending on the phone still having signal afterwards. A server worker sends it and
  retries (five tries over about 30 minutes); anything it cannot confirm goes to an office list to check by hand.
- `complete_delivery` gains an optional `p_email_receipt`; left out, it behaves exactly as before.
- Nothing is sent yet: the worker, its secrets and the app change ship in the next PR.
- New proof `scripts/smoke/prove-delivery-receipt-queue-real-schema.mjs`.
- Simplified the same day (Mason's decision after six review rounds): the lock that stopped the office emailing a
  receipt while the worker owed one is gone, so a customer may occasionally get two receipts, never none. The worker
  now re-checks right before each send (delivery still completed, same customer, same email) and the migration no
  longer touches the email log.
- Sol round 1 on the simplified version: for the few seconds a receipt is being emailed, its delivery cannot be
  voided or moved and the customer's email cannot change (the office gets "try again in a minute"), so a receipt
  never goes to an address that was changed right after the final check. Only the attempt the final check
  approved can record a receipt as sent.
- Sol round 2: email addresses now compare exactly (a change of capital letters counts as a new address), and
  receipts the worker skips no longer use up its batch.
- Applied live 2026-11-05 8:32 PM Central (ledger `20261106023253`) as `20261113140000_delivery_receipt_queue`
  (restamped after another migration went live first). Nothing is sent yet: the worker ships in the next PR.
