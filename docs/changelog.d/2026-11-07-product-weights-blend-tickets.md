## 2026-11-07 — Product weights on blend tickets (DM-2 screens, part 2)

- Each blend ticket line shows its weight in pounds and where the weight came from: the weight saved
  with the ticket (kept even after the product's weight is later changed), or, for a line not yet
  saved, the current approved weight the save will keep. A line with no weight says why, by name.
- The ticket shows its total product weight, or why it is withheld. The header total is checked
  through the unit table: a weight header against the line weights, a spray-tank header against the
  liquid lines. When weights cannot be read the check says "not checked" instead of passing.
- A new ticket warns after saving if a product's weight was approved while it was being saved.
- Product page Weight card: "Show older" for history beyond 25 rows, and Save is held back for a
  weight above the database's limit (20 lb/gal, 4000 lb per pack).
- Loader worksheet, batch summary and PDF weights follow in a later PR (sheet section 4.3).
