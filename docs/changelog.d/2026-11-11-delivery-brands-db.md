## 2026-11-11 — Brand PR B, part B-1a: delivery brands (database, not applied yet)

- Migration `20270104120000_delivery_brands.sql`; build sheet `docs/plans/2026-11-08-product-BRAND-PRB-BUILD-SHEET.md`
  section 15; issue #1697.
- A delivery line can record which brand went off the truck: one listed brand, a split across several, or a brand
  typed from the jug (typed ones wait for an admin to link or dismiss). Every change is kept in a history that
  cannot be edited.
- Nothing about brands ever stops a delivery from completing (Mason, 2026-11-09). Gaps go on an office list
  (`get_deliveries_missing_brands`).
- After completion only an admin can correct brands, with a reason; a posted invoice must be voided first.
- The customer receipt lists the brands on each line.
- Screens (B-2) and the invoice and restricted-use copies (B-1b) come in later PRs.
- Proof: `node scripts/smoke/prove-delivery-brands-real-schema.mjs`.
