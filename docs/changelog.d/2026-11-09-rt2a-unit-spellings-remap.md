## 2026-11-09 — RT-2 step 1: one spelling per unit on 22 products (data migration)

- New data-only migration `20261229140000_unit_spellings_remap.sql` (record in `docs/reference/migrations.d/`),
  per the RT-2 build sheet (`docs/plans/2026-11-09-product-RT2-BUILD-SHEET.md`, section 4) and Mason's answers
  of 2026-11-09.
- Moves 11 products' stock unit from `Oz` to `oz`, 8 from `Qt` to `qt`, Imazuron Herbicide's rate unit from `LB`
  to `Lb`, and the two dry products Autumn Super 51 WDG and Cimarron Plus to a `Dry oz` rate unit. No price
  changes (every pair has the same conversion factor); the unit list itself is untouched until step 2.
- Every listed product must still match its reviewed id, name, form and spelling, or nothing changes. The
  change history logs each move. New paperwork for those products shows `oz` / `qt`; old documents keep theirs.
- New migration `20261229130000_convert_to_gl_lb_dry_oz.sql`, applied first: a field job's pound equivalent
  now reads `Dry oz` on a dry product as pounds (16 Dry oz = 1 lb), on screen, on new invoice lines and on the
  applicator sheet, chemical summary, master-mix and projected-use reports. Before it, the 76 products already
  on `Dry oz` showed a dash; invoice lines saved before keep their dash. Job billing's unit matching is unchanged.
- After the live apply, download fresh pricing and setup workbooks (older downloads refuse the moved rows).
- Proof: `node scripts/smoke/prove-unit-spellings-real-schema.mjs` (UNIT_SPELLINGS_STEP1_PROOF_PASS).
