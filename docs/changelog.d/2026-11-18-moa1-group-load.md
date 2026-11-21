## 2026-11-18 — MOA-1 part 3: one-time load of the approved resistance groups (not applied)

- Migration `20270201160000_ingredient_modes_of_action_load.sql` (build sheet section 3.6).
- Loads the 123 resistance groups (73 HRAC, 30 FRAC, 20 IRAC) from the cited list Mason approved on 2026-11-18 onto
  the ingredients already in the system, matched by CAS number (or by exact name where a CAS is missing). Each group keeps its source.
- Never overwrites a group list someone already saved; skips and reports any ingredient the list would give two
  different codes; reports list rows that matched no ingredient. Running it again changes nothing.
- No built-in "is it time yet?" check (Mason, 2026-11-18): it fills whatever ingredients exist when it runs. It goes to
  staging only once staging holds the EPA batch fill, and to live only after Mason confirms the live EPA batch has run.
  Ingredients added later get their groups with the per-ingredient editor.
