## 2026-11-03 — Screens warn before save when a product has no price (WP-PM-6b follow-up)

- Since #1389 the database refuses a quote, order or tier-priced invoice line at $0 whose product
  states no price for the line's tier (`QUOTE_PRICE_MISSING`, `ORDER_PRICE_MISSING`,
  `INVOICE_PRICE_MISSING`). Quote Builder, New Order and the field-app chemical lines now show an
  amber "No tier N price" warning as soon as such a product is picked, and clear it once a price is
  typed. A stated $0 is a price and is not warned on. The database stays the authority.
- Shared rule: `isTierPriceMissing` in `src/lib/quoteCalc.ts` (own tier price, else tier 1; the
  trigger's rule).
- New Order's tier lookup now matches the database and Quote Builder (`getQuoteTierPrice`): a stated
  $0 tier-2/3 price stays $0 instead of showing the tier-1 price; only a missing one falls back to
  tier 1. Its price box shows a grey `0.00` placeholder like Quote Builder's.
- Field app: the line keeps the picked product's tier prices, so the warning follows the primary
  customer's current tier, as the price preview does. Not warned (the save refusal still catches
  them): lines reloaded from a saved invoice, and other customers in a split billed at a tier the
  product has no price for. The tier preview price is now exact cents.
- Proof: local test copy (invented data, no live data), tier-2 customer. New Order: unpriced product
  warned, cleared after typing $15; tier-1-only product priced $20; stated-$0 tier-2 product $0, no
  warning. Quote Builder (tier 2) and field-app line: unpriced product warned, cleared after typing a
  price. The local copy could not apply migrations past 20261104140000 (unrelated
  `PRODUCT_FORMS_SOURCE_BODY_DRIFT`), so save-time refusals were not exercised there.
