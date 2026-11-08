## 2026-11-08 — KI-30: correct 48 products' EPA registration numbers (data migration)

- New data-only migration `20261214100000_ki30_epa_registration_corrections.sql` (record in
  `docs/reference/migrations.d/`). Mason chose a reviewed migration over hand edits on 2026-11-08.
- Sets `products.epa_registration` on the 48 products whose HIGH or MEDIUM proposal in the KI-30 review
  (re-measured against EPA PPLS on 2026-11-08) differs from what is stored: 40 wrong numbers (moved by EPA
  to a new number, or belonging to another brand) and 8 blank ones with a registry match. The 4 products
  that need a person to read the jug are not touched.
- A product changes only if its stored number and name still match the reviewed list and it is not in a
  product family; otherwise nothing changes and the migration stops. The existing change-history trigger
  logs each old and new number. Saved invoice lines and sprayed-job EPA copies are not touched (the only
  two invoice lines on these products are drafts with no number).
- Proof: `node scripts/smoke/prove-ki30-epa-corrections-real-schema.mjs` (KI30_EPA_CORRECTIONS_PROOF_PASS).
- Applying it live changes existing rows, so it needs Mason's own approval through the apply gate.
