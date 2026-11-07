## 2026-11-07 — Product weights: approved pounds per gallon and per pack, kept on saved tickets and worksheets (database)

- New migration `20261207100000_product_weights.sql` (record in `docs/reference/migrations.d/`), the
  database half of DM-2 (`docs/plans/2026-11-06-product-DM2-BUILD-SHEET.md`). No screen changes; the
  screens (section 4 of the sheet) come in a follow-up PR.
- Liquids get one approved weight per gallon on their product parent (entered as lb/gal or specific
  gravity, stored as lb/gal to 4 decimals, 0 < value <= 20). Dry sizes stocked by the pack ("Ea") get one
  approved net weight per pack (0 < value <= 4000 lb). A dry size stocked in a weight unit (Lb, oz, MG...)
  needs no entry: its weight comes from the unit. Seed and each products have no weight.
- Only an approved value is ever read. An admin saving a value directly approves it; values typed by the
  coming DM-1 import are drafts until an admin approves them (`approve_weights`, all-or-nothing).
  Trust order measured > SDS > label > supplier: a lower-trust value cannot replace a higher one except
  through a correction with a reason and evidence. Every save, correction, approval and automatic
  return to draft is logged in `product_weight_events`, which can never be changed or deleted.
- A pack change (container size, unit, type or unit size) returns that size's net weight to draft; a
  change to a parent's form, formulation or safener returns its density to draft.
- Blend tickets and loader worksheets keep the weight each product had when first saved on them, so later
  catalog edits never change a saved record. A worksheet's saved weight stops being used (never revived)
  once the pack, parent identity or parent membership changes.
- Readers: `get_product_weights`, `get_blend_ticket_weights`, `get_loader_worksheet_weights`.
  Writers (admin only, retry-safe keys): `set_parent_density`, `correct_parent_density`,
  `set_size_net_weight`, `correct_size_net_weight`, `approve_weights`.
- The migration refuses to apply if any blend ticket already exists (live had none when written).
- Proof: `node scripts/smoke/prove-product-weights-real-schema.mjs` (disposable real-schema database).
