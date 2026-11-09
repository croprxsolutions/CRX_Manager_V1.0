## 2026-11-08 — The office can close a queued customer receipt (KI-25 follow-up, database part)

- New migration `20261221100000_close_delivery_receipt.sql` (applied live 2026-11-09, ledger `20261109152447`) (record in `docs/reference/migrations.d/`). Adds
  `close_delivery_receipt`: the office marks a receipt on "Customer receipts to check" as handled, and Email
  Confirmation pauses a queued receipt on that list before emailing it by hand (then marks it handled once the email
  went out), so the server sender cannot send the customer a second copy afterwards and a failed hand send still
  leaves the receipt on the list. While the server is in the middle of sending one, the office is told to try again
  in a minute; the answer always says whether the server already sent (or may have sent) it.
- Nothing on screen changes yet: the list button and the Email Confirmation change ship in the next PR.
- New proof `scripts/smoke/prove-close-delivery-receipt-real-schema.mjs`; the receipt-queue proof skips this file in
  its "later files" check (it changes nothing that proof covers).
