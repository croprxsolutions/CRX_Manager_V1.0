## 2026-11-03 — Re-saving a draft invoice no longer adds a cent to a split delivery (S16b)

- New migration `20261106130000_invoice_resave_keeps_line_cents.sql` (NOT APPLIED; record in
  `docs/reference/migrations.d/`). An order line delivered in parts carries its cents through each
  part: 5 gal at $5.33 ($26.65) delivered in two halves is invoiced $13.33 + $13.32. Saving the
  second draft invoice again with only a note changed re-rounded its line to 2.5 × $5.33 = $13.33,
  so the customer was billed $26.66. A line saved back with the same quantity and unit price now
  keeps the total it was given, and the invoice total is the sum of its lines; a changed quantity
  or price is re-priced as before. Field-application invoices are unchanged.
- New smoke chain `smoke-invoice-resave-keeps-line-cents.sql` (spec `invoice_resave_keeps_line_cents`).
