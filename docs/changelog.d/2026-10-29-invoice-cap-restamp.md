## 2026-10-29 — Invoice delivered-cap migration re-stamped (PR #1174)

- Brought PR #1174 up to date with main. Its migration is renamed from
  `20261028175633_cap_order_invoices_at_delivered` to
  `20261029160000_cap_order_invoices_at_delivered`, because
  `20261028185500_order_edit_and_number_concurrency` applied live first and the
  ordering guard refuses an older timestamp.
- Tightened the cumulative delivered-quantity guard to cover every active order
  invoice (including delivery-linked ones) and to report malformed invoice lines
  (`ORDER_INVOICE_LINE_INVALID`) separately from over-delivery.
- Voiding, cancelling or reducing a completed delivery is deliberately NOT blocked:
  `void_delivery` keeps a billed delivery voidable and warns. That gap stays with
  to-do 3.5, so an admin void can still leave billing above delivered quantities.
- Dropped the draft-only `vercel.json` setting that kept this branch from
  deploying previews; main's `ignoreCommand` stays.
