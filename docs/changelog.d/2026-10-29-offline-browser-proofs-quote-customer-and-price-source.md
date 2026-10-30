## 2026-10-29 — Offline browser proofs catch up with the quote-customer and price-source changes

The Codex Cloud setup run found two self-contained Playwright proofs failing on `main` because
they lagged recent app changes.

- `tests/row-version-ui/quote-customer-row-version.spec.ts`: the mocked quote now embeds its
  customer, as Quote Builder's real read does (`customer:customers(*)`); without it the screen
  correctly refuses to save.
- `tests/phase1a-ui/supplier-pricing-phase1a.spec.ts`: the Product page's pricing reviews now fill
  the required "Where did this price come from?" source and reason form, and the test checks both
  values reach the preview request.
- `src/pages/ProductDetail.tsx`: the margin-floor card no longer shares its React key with the
  brands card beside it (both used the product id). React warned that it could mix the two up;
  the proof's no-console-errors check caught it.

Proof: `npm run test:e2e:row-version` (3 passed) and
`npx playwright test --config=playwright.phase1a.config.ts` (1 passed).
