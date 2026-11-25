## 2026-11-24 - Ingredients: an admin can merge a duplicate ingredient on an EPA-numbered product

- Migration `20270305100000_epa_gated_same_name_swap.sql`: re-issues `_apply_parent_chemistry` so that, on a product with an EPA number, a correction may replace an ingredient row with an existing ingredient of the same name. Before, Ingredient review -> Duplicates -> "Replace on <product>" was refused with `CHEMISTRY_FROM_EPA_ONLY`, so duplicate records (e.g. three Zeta-Cypermethrin rows the EPA lookup added without a CAS) could never be merged and the resistance-group load skipped them.
- What moves: only which shared ingredient record the product points at. Strength, unit, basis, source, note and every mode of action (EPA-confirmed ones stay EPA-confirmed) carry over unchanged.
- Not allowed even with the same name: when both records already carry a CAS number (CAS is unique, so they are different chemicals).
- Unchanged: a different-name swap, a swap to a new ingredient, consolidate, strength changes and mode edits on an EPA product still refuse; admin only; reason and evidence required; preview fingerprint; one `corrected` chemistry event.
- Screen (`ChemistryCorrectionModal`): on an EPA product the correction offers "Replace with another ingredient" and, for it, hides the strength and mode fields with a note that they carry over; "add a new ingredient" is hidden there. Picking a record that is already on the EPA product shows an error instead of turning into a merge the server would refuse.
- Proof: `node scripts/smoke/prove-epa-gated-same-name-swap-real-schema.mjs` (`EPA_SAME_NAME_SWAP_PROOF_PASS`, local Docker) and the local test copy in a browser.
- Not verified: the staging database (applied by the staging DB job after merge). Not applied live.
