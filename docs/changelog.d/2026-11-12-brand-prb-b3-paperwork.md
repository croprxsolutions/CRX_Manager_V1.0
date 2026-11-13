## 2026-11-12 — Brand PR B-3: delivered brands on the paperwork, warnings before posting (not applied)

- Migration `20270109100000_delivery_receipt_brands.sql`: the customer's delivery receipt email lists each line's
  delivered brands with EPA number and amount ("Brand not recorded" when a branded line has none; names without
  amounts when the amounts do not add up). Also #1833: a brand reviewed No under a product with no EPA number no
  longer stays on Sales to check.
- The delivery receipt PDF, the load sheet and the office resend print the same brand notes from the current picks.
- The invoice PDF (Print, Old Print, batch, emailed copy) prints the brands under each line, the joined numbers for a
  split, and "on the load" on a Bill Split payer's invoice. The invoice screen shows them read-only.
- Posting warns (never blocks) in the one Post confirm, now "Post anyway": lines that get no RUP record (split does not
  match delivered, billed above delivered) and follow-ups (brand not recorded, no EPA number, typed brand not yet
  checked, quantity changed from delivered).
- Edge Functions `send-delivery-receipts` and `send-email` need a redeploy; `send-delivery-receipts` before the apply.
