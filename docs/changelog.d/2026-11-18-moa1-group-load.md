## 2026-11-18 — MOA-1 part 3: one-time load of the approved resistance groups (not applied)

- Migration `20270127140000_ingredient_modes_of_action_load.sql` (build sheet section 3.6).
- Loads the 123 resistance groups (73 HRAC, 30 FRAC, 20 IRAC) from the cited list Mason approved on 2026-11-18 onto
  the ingredients already in the system, matched by CAS number or exact name. Each group keeps its source.
- Never overwrites a group list someone already saved; skips and reports any ingredient the list would give two
  different codes; reports list rows that matched no ingredient. Running it again changes nothing.
- Groups attach to existing ingredient rows, so the live apply should follow the EPA batch fill on live (which adds
  most ingredients). Ingredients added later get their groups with the per-ingredient editor.
