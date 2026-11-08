## 2026-11-08 — KI-30: EPA registration numbers re-measured (docs only)

- Read-only check of live `products` against EPA PPLS: 203 distinct stored numbers, 169 match, 30 confirmed
  wrong, 4 await a label read; 8 unnumbered products have a registry match. No live row changed; the
  per-product list is in Mason's private review workbook.
- Live ledger re-read 2026-11-08 11:06 America/Chicago (Supabase `list_migrations`): 1,172 rows, latest
  `20261108043505` = `20261211100000_product_chemistry_confirmed_swaps`. `20261207113000_parent_epa_correction`
  and `20261210100000_epa_registrations` are applied. Only the "Last verified" ledger lines of
  `CURRENT_STATE.md` and `KNOWN_ISSUES.md` were re-certified.
