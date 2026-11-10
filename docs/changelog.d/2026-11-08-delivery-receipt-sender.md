## 2026-11-08 — Server sender for delivery receipts (KI-25, part A: sender, no app switch)

- New Edge Function `send-delivery-receipts` (not deployed yet): woken every 2 minutes by the live
  `deliver-receipt-queue` timer, it emails each receipt owed in `delivery_receipt_queue` and retries on failure.
  Every attempt for one receipt sends the identical email under the email provider's duplicate key
  `delivery-receipt/<queue id>`, so a retry after a lost answer cannot email the customer twice.
- Not in this change: the app still emails the receipt from the phone. The switch to the server sender
  (completions ask for it with `p_email_receipt`) is a separate follow-up PR that lands only after this function is
  deployed, so the app can never stop sending before the server starts.
- New "Customer receipts to check" card on Deliveries (admins and sales reps): every receipt not confirmed as emailed
  (no age cut-off; 50 at a time with Show more), each linking to its delivery for Email Confirmation.
- The receipt email template moved to `supabase/functions/_shared/deliveryReceiptHtml.ts` so the app and the
  sender render the same email.
- Proof: `scripts/smoke/prove-delivery-receipt-queue-real-schema.mjs` now runs the sender's own code against the
  real schema: a failed first send, then a lost finish, ends with exactly one receipt emailed.
- Order of going live: land this, deploy the function and store its secrets (Mason's approval), then land the app switch.
  Deploy it with `verify_jwt` OFF (the repo has no `supabase/config.toml`, so set it on the deploy call): the
  timer's wake carries only the `x-receipt-worker-secret` header, and with JWT checking on the gateway refuses it
  and receipts stay queued. Function secret `DELIVERY_RECEIPT_WORKER_SECRET`; Vault secrets
  `delivery_receipt_worker_url` (the function URL) and `delivery_receipt_worker_secret` (the same value).
