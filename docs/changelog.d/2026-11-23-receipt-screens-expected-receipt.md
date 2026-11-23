## 2026-11-23 - #2251: the receipt screens close only the receipt they saw

- "Mark handled" on Customer receipts to check, and the delivery page's close after Email Confirmation, now send the receipt's `created_at` / `queued_at` exactly as the server gave it (`p_expected_queued_at`, migration `20270223120000`, on staging since #2281). If the delivery's receipt was queued again since, the server refuses with `DELIVERY_RECEIPT_CHANGED`: the list says nothing was closed and reloads; the delivery page says the email went out and the newer receipt was left alone.
- After a close that cannot be confirmed, the delivery page no longer says to mark the receipt handled (it could be a newer one the customer is owed); it says to check the list first. A hand send that started with no receipt queued warns if one was queued during the send.
- Proof: 50 unit tests over the two screens and the helper; staging HTTP check of the four-argument call (see the migration record).
