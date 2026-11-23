## 2026-11-22 — "Mark handled" for customer receipts, and Email Confirmation no longer doubles a queued receipt (KI-25 follow-up, screens)

- "Customer receipts to check" (Deliveries) gets a "Mark handled" button on each row: after a confirm, the receipt
  leaves the list and the server sender never emails it.
- Email Confirmation (delivery page) first pauses any receipt still queued for the server, sends the email, then marks
  it handled. If the email fails, the receipt stays on "Customer receipts to check". If the server already emailed it
  (or may have), the office is asked before a second copy goes out; while the server is mid-send it says to try again
  in a minute.
- Uses `close_delivery_receipt` from `20261221100000` (PR #1678), live since 2026-11-09 (ledger `20261109152447`). No migration.
