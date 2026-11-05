## 2026-11-05 — Transfer-created invoices follow the customer's payment terms (KI-14)

Migration `20261112090000_transfer_invoice_due_date_follows_terms.sql` stops "Transfer to invoice" from stamping every new field invoice as due 30 days after the invoice date. The transfer now stamps the due date from the billed customer's terms with `parse_payment_terms_days`, the helper the posting path already uses, so it is the date posting itself would set: Net 15 is due in 15 days, Net 30 or blank terms in 30, due on receipt the same day. Posting keeps it. The date is stamped at transfer rather than left blank because an unposted invoice can be emailed, and the emailed PDF prints a blank due date as "On receipt" (found by the Sol review). Saving terms on either invoice screen still clears the due date, so posting re-derives it from the new terms. Both the single-invoice and the multi-owner split paths change; nothing else in the transfer body changes.

Invoices already saved keep their due dates. On 2026-11-05 live had one transfer-created invoice, and its due date already matched its customer's terms (every live customer is Net 30 or blank), so no saved invoice disagrees with its terms.

Not changed here: saving a field invoice on the field-application screen writes the screen's terms picker onto the invoice, and the picker shows Net 30 when the invoice has no terms of its own, so a saved-then-posted invoice for a Net 15 customer is still due in 30 days. That screen behaviour applies to every field invoice; it is tracked under KI-14.

Proven on a disposable real-schema database by `scripts/smoke/prove-transfer-invoice-due-date-real-schema.mjs` (transfer, then post, for Net 15, Net 30, due on receipt and a split). This candidate has not been applied to production.
