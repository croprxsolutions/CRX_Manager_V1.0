## 2026-11-03 — Re-saving a draft invoice no longer adds a cent to a split delivery (S16b)

- New migration `20261106130000_invoice_resave_keeps_line_cents.sql` (applied live 2026-11-04; record in
  `docs/reference/migrations.d/`). An order line delivered in parts carries its cents through each
  part: 5 gal at $5.33 ($26.65) delivered in two halves is invoiced $13.33 + $13.32. Saving the
  second draft invoice again with only a note changed re-rounded its line to 2.5 × $5.33 = $13.33,
  so the customer was billed $26.66. A line saved back with the same quantity and unit price now
  keeps the total it was given, and the invoice total is the sum of its lines; a changed quantity
  or price is re-priced as before. Field-application invoices are unchanged.
- New smoke chain `smoke-invoice-resave-keeps-line-cents.sql` (spec `invoice_resave_keeps_line_cents`).
- Freshness re-check (read-only, 2026-11-04 14:41 UTC): the live ledger has 1117 rows. Its newest are
  `20261106110000` (ledger `20261104112804`) and `20261106130000` (`20261104131837`); every migration on
  `main` through `20261105190000` is live, and `20261106140000` (#13) is not. `KNOWN_ISSUES.md` no longer
  calls `20261029090000` (PR #1200, ledger `20261031103934`) or `20261029120000` (PR #1203, ledger
  `20261031130629`) unapplied. `CURRENT_STATE.md` and `KNOWN_ISSUES.md` are re-stamped 2026-11-04 for the
  live ledger only; nothing else in them was re-certified.
