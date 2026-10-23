## 2026-10-23 - Job Detail: picking a product with no price no longer keeps the old price

Frontend only, no migration. Follow-up from PR #1049.

- **Job Detail.** Picking a product on a chemical line that states no price (no price for the job customer's tier and no tier-1 price) used to leave the previous product's price on the line, so the new product could be billed at the old product's price. The line's price is now blanked, and the existing "This line cannot be saved" check refuses the save until a price is typed. A product priced at $0 still sets the line to exactly $0. Loading a recipe or crop program works the same way: a line whose product states no price (and, for a recipe, has no recipe price) arrives with a blank price instead of $0, so a recipe saved from such a line cannot slip a $0 price past the check. A customer-supplied line is never billed, so its blank price does not block the save (it is saved as $0).
