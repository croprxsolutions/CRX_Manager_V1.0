## 2026-11-12 — MOA-1 part 1: resistance groups stored once per ingredient (not applied)

- Migration `20270108100000_ingredient_modes_of_action.sql` (build sheet `docs/plans/2026-11-12-product-MOA1-BUILD-SHEET.md`).
- Each active ingredient can carry one reviewed list of its resistance groups (FRAC, HRAC, IRAC). Every product
  containing the ingredient shows them, worked out when the product is read, so nobody retypes them per product and
  one fix shows everywhere. A salt or ester with no list of its own shows its acid's groups. A group typed by hand on
  a product that disagrees with the ingredient's list stays showing and is flagged (the D-L rule).
- Only admins save a list (`set_active_ingredient_modes`); every save needs a reason, refuses a list that changed
  since the screen opened it, and is logged on the ingredient's history. Everyone with an active login can read
  (`get_parent_mode_groups`). `get_ingredient_mode_users` tells the editor how many products a list feeds.
- No screen calls these yet (the screen PR follows). The one-time load of every ingredient's groups is a later,
  separate migration after Mason spot-checks the list.
- Proof: `node scripts/smoke/prove-ingredient-modes-of-action-real-schema.mjs`.
