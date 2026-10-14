## 2026-10-14 — Invoice page: a failed price-tier lookup while adding a product now says so

**Why.** Follow-up from the Sol review of PR #908 (merged as d12fc0f2a). When the invoice's customer
is not in the picker list, Add Product reads that customer's price tier by id. If that read *threw*
(a network failure) rather than returning an error, the product was correctly not added and Add
Product / Save unlocked, but no message was shown and nothing reached Sentry, so the user could not
tell that the product was missing and needed to be added again.

**What changed** (`src/pages/InvoiceDetail.tsx`). The by-id tier lookup in `addProduct` gained a
`catch`. It runs the same "is this lookup still current?" checks as an answered lookup: a lookup
cancelled by an invoice switch or a closed picker stays silent; if the customer changed meanwhile, it
shows the existing "customer changed" toast. Otherwise it reports the error to Sentry
(`invoice_add_product_customer_tier`) and shows the existing toast "Could not load this customer's
price tier. The product was not added; try again." Every branch returns, so a thrown lookup can never
fall through to pricing the product at tier 1.

**Proof.**
- New test in `src/pages/InvoiceDetail.test.tsx` ("refuses to add the product and says so when the
  tier lookup throws"): the by-id lookup rejects; the test expects the toast, the Sentry report, Save
  enabled, and an empty saved item list. Against the old page it fails (no toast, plus an unhandled
  rejection); with the fix it passes. The whole file passes (46 tests); `npm run typecheck` and eslint
  on both files are clean.
- Not verified on screen: forcing a network failure on a signed-in live invoice was not attempted;
  the rendered-page test is the proof.
