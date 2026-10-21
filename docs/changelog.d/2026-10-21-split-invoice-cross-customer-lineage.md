## 2026-10-21 — split billing can bill a field owner who is not the order's customer

- New migration `20261021150000_split_invoice_cross_customer_lineage.sql` (not applied yet): the
  invoice guard `guard_invoice_terminal_order` used to refuse every order invoice for a customer other
  than the order's, so a field split onto another customer's field rolled back. It now admits exactly
  one exception: a governed split invoice, created inside `create_split_invoices_from_order`'s claim
  for a customer the order's field split resolves to, and afterward only under its private
  provenance row. Every other mismatch is still refused. Needed before PR #1006 (Sol, HIGH).
- Proof: `scripts/smoke/prove-split-invoice-cross-customer-lineage-real-schema.mjs` over the
  container chain `smoke-split-invoice-cross-customer-lineage.sql` (a four-customer split created,
  replayed, posted and voided; refusals at the exception's limits and of the unchanged rule; four
  mutations), plus
  `src/__tests__/splitInvoiceLineageMigration.test.ts`.
