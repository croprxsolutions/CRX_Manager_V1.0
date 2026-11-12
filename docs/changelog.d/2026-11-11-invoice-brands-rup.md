## 2026-11-11 — Brand PR B, part B-1b: brands on invoices and restricted-use records (database, not applied)

- Migration `20270104130000_invoice_brands_rup.sql`; build sheet `docs/plans/2026-11-08-product-BRAND-PRB-BUILD-SHEET.md`
  sections 14.4 and 16; issue #1697.
- Each invoice line keeps a frozen copy of the brands that went off the truck for it (`invoice_items.brand_lines`).
  A line of one brand carries that brand's EPA number; several brands leave the product's number.
- Posting writes one restricted-use record per restricted brand on a line, under that brand's own number, with its
  share of the quantity and cents (cents always add up to the line). Lines with no brand information record exactly
  as before (#1746).
- Brands never stop a sale, a save, a posting or a correction (Mason, 2026-11-09). A line whose brands do not add up,
  bills more than was delivered, overlaps another invoice, or whose payers disagree gets no brand record and is
  listed on Sales to check with the reason; so is a brand with no EPA number and a delivery with no brand recorded.
- An admin correction of a delivery's brands re-copies open draft invoices when it saves; posted invoices never change.
- The RUP register and its CSV show the brand; typed brands on voided or cancelled deliveries leave the review list.
- Proof: `node scripts/smoke/prove-invoice-brands-real-schema.mjs`.

An invoice open on a screen when its brands are re-copied (or when this change is applied) asks for one reload before it posts. Split-billed drafts are never re-copied, so their split claim still matches when they post; if the delivery's brands were corrected after the split, the line posts with no brand record and is listed on Sales to check as stale.
