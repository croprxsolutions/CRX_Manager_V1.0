## 2026-11-11 — Brand PR B, part B-1a: delivery brands (database, applied live 2026-11-11)

- Migration `20270104120000_delivery_brands.sql`; build sheet `docs/plans/2026-11-08-product-BRAND-PRB-BUILD-SHEET.md`
  section 15; issue #1697.
- A delivery line can record which brand went off the truck: one listed brand, a split across several, or a brand
  typed from the jug (typed ones wait for an admin to link or dismiss). Every change is kept in a history that
  cannot be edited.
- Nothing about brands ever stops a delivery from completing (Mason, 2026-11-09), not even an out-of-date screen: the completion goes through, is marked "picks not confirmed", and its picked lines go on the office list with the other gaps
  (`get_deliveries_missing_brands`).
- After completion only an admin can correct brands, with a reason; a posted invoice must be voided first.
- The customer receipt is unchanged for now: brands on it come with B-3, together with the sender that prints them and a fresh receipt after a correction.
- Screens (B-2), the invoice and restricted-use copies (B-1b) and the receipt (B-3) come in later PRs.
- Proof: `node scripts/smoke/prove-delivery-brands-real-schema.mjs`.
