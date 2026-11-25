## 2026-11-25 — Restamp also moves the SQL header's name line

- `scripts/restamp-migration.mjs` swapped only the SQL header's link to its migrations.d record, so a header line
  that is just the migration's own name (`-- 20270304140000_supplier_quote_unit_floor`, #2524) kept the old stamp
  and had to be fixed by hand in a second commit.
- It now also moves a leading-header line that is exactly `-- <old name>`. The restamp-carry rule in
  `scripts/write-codex-push-proof.mjs` (`restampHeaderLine`, shared by both) accepts that same edit and nothing more:
  the name inside longer header text, or anywhere in the SQL body, still refuses the carry. Mason approved this in
  the 2026-11-25 retro.
