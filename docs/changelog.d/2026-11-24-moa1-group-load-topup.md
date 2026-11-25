## 2026-11-24 — MOA-1: resistance groups for 12 ingredients added after the approved list (not applied)

- Migration `20270305120000_ingredient_modes_of_action_load_topup.sql` (build sheet section 3.6).
- The live EPA batch fill added 12 ingredients after Mason approved the main group list on 2026-11-18. This gives
  them their published groups (11 HRAC, 1 IRAC), the list Mason approved on 2026-11-24.
- Same rules as the main load (`20270205150000`): matched by CAS number, never overwrites a saved list, logs one
  change per ingredient, and running it again changes nothing. It runs after the main load (file order).
- With both, 131 of the 145 live ingredients show their groups; the rest have no resistance group, were not
  approved (Bacillus), or are duplicate rows (Zeta-Cypermethrin).
- Proof: `scripts/smoke/prove-moa-load-topup-real-schema.mjs`.
