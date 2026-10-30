## 2026-10-29 — Invoice delivered-cap migration re-stamped (PR #1174)

- Brought PR #1174 up to date with main. Its migration is renamed from
  `20261028175633_cap_order_invoices_at_delivered` to
  `20261029160000_cap_order_invoices_at_delivered`, because
  `20261028185500_order_edit_and_number_concurrency` applied live first and the
  ordering guard refuses an older timestamp.
- Tightened the cumulative delivered-quantity guard to cover every active order
  invoice (including delivery-linked ones) and to report malformed invoice lines
  (`ORDER_INVOICE_LINE_INVALID`) separately from over-delivery.
- Owner decision (Mason, 2026-10-29): void the invoice first. A database trigger on
  deliveries (`zz_delivery_void_needs_invoice_void`) makes `void_delivery` and
  `cancel_delivery` refuse (`DELIVERY_HAS_POSTED_INVOICE`) while an active posted, paid
  or overdue invoice is linked to the delivery (a completed delivery's void also counts
  an order-level invoice with no delivery link). Draft invoices never block; they are
  still cancelled by the void. Billing can no longer be stranded above delivered
  quantities by a void. The automatic-credit design in to-do 3.5 is not built.
- The cap tolerates under 0.001 of a unit over delivered, because field-split shares are
  rounded to four places (0.6667 x 3 = 2.0001). Deferred, fails closed: a short quick
  delivery whose draft was split into linked and unlinked lines can need a manual
  draft edit before completion (no overbilling is possible).
- Dropped the draft-only `vercel.json` setting that kept this branch from
  deploying previews; main's `ignoreCommand` stays.
