## 2026-11-07 — Active ingredients on product parents, with cost per lb of active (database)

- New migration `20261209100000_product_chemistry.sql` (record in `docs/reference/migrations.d/`), the
  database half of DM-1 and CMP-1 (`docs/plans/2026-11-06-product-DM1-BUILD-SHEET.md`). No screen changes;
  the screens come in a follow-up PR.
- One shared list of active ingredients (`active_ingredients`), each one specific chemical form (for
  example glyphosate isopropylamine salt), with an optional CAS number (format and check digit checked)
  and, for a salt or ester, the acid it is measured as and its acid-equivalent fraction. An entry with a
  CAS that is already on the list reuses that ingredient; a name is never renamed by a lookup.
- Duplicates are replaced, never linked: swap the duplicate out on each parent (a correction with a
  reason and evidence, which carries its mode-of-action entries), then retire it. Retiring is refused
  while anything still uses it. Admins get a "needs CAS" and "possible duplicates" worklist.
- Each product parent gets ingredient rows (strength as % w/w or lb/gal, on the active or acid basis),
  mode-of-action rows (HRAC/FRAC/IRAC) and fertilizer analysis rows, all under one chemistry version.
  Adding or filling in a value is a plain save; changing or removing one is a correction with a reason
  and evidence, previewed first. A parent that carries a usable EPA number takes its chemistry from the
  EPA lookup only (DM-4); typed entries are refused there.
- Cost per lb of active (admin only): from each size's catalog cost and unit, in exact whole cents, per
  active and, for a salt with a known fraction, per lb of acid. Fertilizer P and K are shown on the oxide
  and elemental basis. Every figure that cannot be computed is refused by name (unit, missing cost,
  unknown strength, no approved weight per gallon, ...). The parent's figure comes from its active bulk
  size, or a size an admin picks.
- `ingredient_map` (empty, unused) is frozen: every insert, update, delete and truncate is refused.
- Readers: `get_parent_chemistry`, `search_active_ingredients` (active users); `get_parent_active_costs`,
  `get_active_ingredient_worklist`, `preview_parent_chemistry_correction`,
  `preview_active_ingredient_change` (admin). Writers (admin only, retry-safe keys): `set_parent_chemistry`,
  `correct_parent_chemistry`, `save_active_ingredient`, `retire_active_ingredient`,
  `reactivate_active_ingredient`, `set_parent_cost_reference`. Ingredient and chemistry history is
  append-only.
- Works before or after DM-2's weight migration: if DM-2's weight function is absent, a private stand-in
  is created that approves no weight, so % w/w liquids refuse their cost figure until DM-2 is live.
- Proof: `node scripts/smoke/prove-product-chemistry-real-schema.mjs` (disposable real-schema database).
