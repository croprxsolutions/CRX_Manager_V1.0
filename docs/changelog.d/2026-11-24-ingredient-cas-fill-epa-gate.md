## 2026-11-24 - Ingredients: an admin can add a missing CAS on an EPA-numbered product's ingredient

- Migration `20270304150000_ingredient_cas_fill_passes_epa_gate.sql`: re-issues `_edit_active_ingredient` so that filling a CAS that is currently empty, and nothing else, is no longer refused with `CHEMISTRY_FROM_EPA_ONLY` when a product using the ingredient has an EPA number. Before, an ingredient the EPA lookup added without a CAS (EPA gave none) could never get one; the EPA review itself asks the admin to "correct the ingredient to link them".
- Unchanged: changing or clearing a CAS already set, the acid fields, or a mix of fields still refuse on an EPA product; admin only; reason and evidence still required when products use the ingredient; CAS format, check digit and CAS-taken checks; the ingredient event and one `corrected` chemistry event per affected product. Product rows (strength, source, modes of action) are not touched.
- No screen change: Ingredient review -> Needs CAS -> Add CAS already calls this path; its preview now shows the change instead of "would be refused".
- Proof: `node scripts/smoke/prove-ingredient-cas-fill-epa-gate-real-schema.mjs` (`INGREDIENT_CAS_FILL_PROOF_PASS`, local Docker) and the local test copy in a browser.
- Not verified: the staging database (applied by the staging DB job after merge). Not applied live.
