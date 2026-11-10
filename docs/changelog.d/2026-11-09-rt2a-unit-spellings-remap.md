## 2026-11-09 — RT-2 step 1: one spelling per unit on 20 products (data migration)

- New data-only migration `20261229210000_unit_spellings_remap.sql` (record in `docs/reference/migrations.d/`),
  per the RT-2 build sheet (`docs/plans/2026-11-09-product-RT2-BUILD-SHEET.md`, section 4) and Mason's answers
  of 2026-11-09.
- Moves 11 products' stock unit from `Oz` to `oz`, 8 from `Qt` to `qt`, and Imazuron Herbicide's rate unit from
  `LB` to `Lb`. Those products' inventory records follow their stock unit, so the product page's "Total on hand"
  keeps adding them up (none exist live today; the count is pinned). No price changes (every pair has the same
  conversion factor); the unit list itself is untouched until step 2.
- Autumn Super 51 WDG and Cimarron Plus keep their `oz` rate unit for now: moving them to `Dry oz` would make the
  field-job over-rate warning skip their saved jobs. They move in step 2 together with a watchdog fix (Sol round
  10, Mason 2026-11-09).
- Every listed product must still match its reviewed id, name, form and spelling, or nothing changes. The
  change history logs each move. New paperwork for those products shows `oz` / `qt`; old documents keep theirs.
- New migration `20261229160000_convert_to_gl_lb_dry_oz.sql`, applied first: a field job's pound equivalent
  now reads `Dry oz` on a dry product as pounds (16 Dry oz = 1 lb), on screen, on new invoice lines and on the
  applicator sheet, chemical summary, master-mix and projected-use reports. Before it, the 76 products already
  on `Dry oz` showed a dash; invoice lines saved before keep their dash. Job billing's unit matching is unchanged.
- After the live apply, download fresh pricing and setup workbooks (older downloads refuse the moved rows).
- Proof: `node scripts/smoke/prove-unit-spellings-real-schema.mjs` (UNIT_SPELLINGS_STEP1_PROOF_PASS).
- **Status 2026-11-10:** `20261229160000_convert_to_gl_lb_dry_oz` is applied live. The spelling move
  (`20261229170000`) is parked (Mason: "Park it, REG-1 first"): its live apply refused safely and changed nothing,
  because 18 of its 20 products joined new product families that night. It will be redone for families after
  REG-1 lands, under a new migration number.
- **2026-11-10, redone for product families:** the spelling move is now `20261229210000` (the parked `20261229170000`
  was renamed; it never ran). 18 of the 20 products are each the only size of a product family; the families keep
  their `oz` rate unit, except the Imazuron Herbicide family, which moves from `LB` to `Lb` together with its product.
  The migration checks every family is exactly as read live on 2026-11-10, or changes nothing.
