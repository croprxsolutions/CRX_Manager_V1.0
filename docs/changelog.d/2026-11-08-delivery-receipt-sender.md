## 2026-11-08 — Delivery receipts are emailed by the server (KI-25, sender and app)

- New Edge Function `send-delivery-receipts` (not deployed yet): woken every 2 minutes by the live
  `deliver-receipt-queue` timer, it emails each receipt owed in `delivery_receipt_queue` and retries on failure.
  Every attempt for one receipt sends the identical email under the email provider's duplicate key
  `delivery-receipt/<queue id>`, so a retry after a lost answer cannot email the customer twice.
- Driver (Field Mode) and office completions now ask for the receipt in the completion itself
  (`p_email_receipt`) instead of the phone sending it afterwards. A dropped signal can no longer lose a receipt.
- New "Customer receipts to check" card on Deliveries (admins and sales reps): receipts not confirmed as emailed
  in the last 14 days, each linking to its delivery for Email Confirmation.
- The receipt email template moved to `supabase/functions/_shared/deliveryReceiptHtml.ts` so the app and the
  sender render the same email.
- Proof: `scripts/smoke/prove-delivery-receipt-queue-real-schema.mjs` now runs the sender's own code against the
  real schema: a failed first send, then a lost finish, ends with exactly one receipt emailed.
- Order of going live: deploy the function and store its secrets (Mason's approval), then merge this app change.
