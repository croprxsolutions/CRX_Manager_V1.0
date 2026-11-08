## 2026-11-08 — The app hands delivery receipts to the server sender (KI-25, part B: app switch)

- Driver (Field Mode) and office completions now ask for the receipt in the completion itself
  (`p_email_receipt`) instead of the phone emailing it afterwards, so a dropped signal can no longer lose a receipt.
  The server sender (`send-delivery-receipts`, part A) emails it and retries until it succeeds.
- A customer with no email on file gets a warning at completion; the receipt goes to the office
  "Customer receipts to check" list.
- Land only after part A is merged AND `send-delivery-receipts` is deployed (verify_jwt off) with its secrets stored.
  Landing this first means no receipt is emailed automatically (each would wait on the office list).
