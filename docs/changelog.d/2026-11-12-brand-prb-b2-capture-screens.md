## 2026-11-12 — Brand PR B, part B-2: brand capture screens (screens only, no database change)

- Build sheet `docs/plans/2026-11-08-product-BRAND-PRB-BUILD-SHEET.md` section 5; issue #1697. Uses the live B-1 functions.
- The driver stop and the delivery page show a brand picker per line whose product has brands: currently bought first,
  then old stock, plus "Other brand…" typed from the jug (EPA number optional). Split records an amount per brand.
- Complete saves unsaved brand choices first, then completes against the saved picks. When it cannot confirm them
  (brands did not load, or a choice was left out, refused or overtaken), it still completes, marked not confirmed,
  so the picked lines land on the office's missing-brands list (Mason, 2026-11-12). A missing or mismatched brand
  only warns ("Complete anyway" / "Pick brand"); nothing about brands blocks a completion (Mason, 2026-11-09).
  Brand saves need signal, like completion. Leaving with unsaved choices asks first.
- Editing a delivery says which lines lost their brand picks.
- Admins get "Correct brands" on a completed delivery (reason required; a posted invoice must be voided and reissued
  first) and a "Brands to review" list on Products for brands drivers typed.
- The Deliveries list's one-click Mark Delivered is unchanged; a branded line with no pick lands on the missing-brands list.
