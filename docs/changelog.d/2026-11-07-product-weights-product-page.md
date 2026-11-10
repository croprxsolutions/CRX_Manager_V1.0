## 2026-11-07 — Product weights on the product page (DM-2 screens, part 1)

- A Weight card on each liquid and dry product page shows the one approved weight (lb/gal from the
  product's parent, or net lb per pack), where it came from, and who approved it when. A dry size
  stocked in a weight unit says its weight comes from that unit; seed and each products show no card.
- Admins enter a weight (lb/gal or specific gravity, shown as the exact stored lb/gal before saving),
  correct one with a reason and evidence when the new source is lower trust, or approve a workbook draft
  only when it was entered for the current pack or formulation; otherwise the card asks for a new entry.
  A Weight history list shows every save, correction, approval and return to draft.
- `PRODUCT_WEIGHT_*` refusals read "Nothing was saved." with the database's own explanation.
- Ticket, loader worksheet and batch summary weights follow in later PRs (sheet section 4.3, 4.4).
