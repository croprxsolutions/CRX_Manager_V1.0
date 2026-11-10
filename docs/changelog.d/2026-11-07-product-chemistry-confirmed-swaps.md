## 2026-11-07 — Active ingredients: replacing a duplicate states its values (database)

- New migration `20261211100000_product_chemistry_confirmed_swaps.sql` (record in `docs/reference/migrations.d/`),
  fixes from the DM-1 landing review. No screen changes.
- Swapping or consolidating a duplicate ingredient no longer copies the old row's strength or modes of action
  (Mason, 2026-11-07): the admin confirms the strength, unit, basis and source and picks which modes of action
  stay; the coming screen pre-fills them from the old row.
- Modes of action record whether the EPA lookup confirmed them. On a product with an EPA number, a typed
  ingredient whose mode of action the EPA lookup confirmed can no longer be removed by hand.
- A liquid's ingredients can no longer be saved heavier than its approved weight per gallon.
- A unit with a bad or disagreeing second spelling is refused instead of costed; the cost reference records
  when it last changed.
