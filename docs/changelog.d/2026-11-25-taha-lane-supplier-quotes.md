## 2026-11-25 — Taha lane block: supplier quotes are Supplier Pricing, not customer quotes

- The Taha lane block counted any file or function with "quote" in its name as Taha's, so the Supplier Pricing
  migration `20270305200000_supplier_quote_unit_floor.sql` (#2524) needed Mason's `taha override` code, although
  Taha's own review said it touched nothing in quotes.
- `.claude/hooks/taha-lane-lib.mjs` now skips "quote"/"quotes" when "supplier" sits right before it
  (`supplier_quote_*`, `SupplierQuote*`, `get_supplier_quote_sheet`), the same way vendor bills are not billing.
  A customer quote that only mentions a supplier elsewhere in its name, and a supplier file with another lane word
  (invoice, hold, booking…), still count as Taha's. Mason approved this exact cut in the 2026-11-25 retro.
- Still enforced: every other lane word, Taha's table and function lists, and the block's own files.
