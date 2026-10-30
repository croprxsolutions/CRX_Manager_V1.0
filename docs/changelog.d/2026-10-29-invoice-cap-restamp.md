## 2026-10-29 — Invoice delivered-cap migration re-stamped (PR #1174)

The fractional-tolerance and quick-draft completion notes below are superseded by [the final quantity rules](2026-10-30-invoice-delivery-edge-cases.md).

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
  or overdue invoice is linked to the delivery. Voiding or cancelling a completed
  delivery also counts an order-level invoice with no delivery link. An unposted
  invoice blocks a void (void_delivery would leave it billing undelivered units) but not
  a cancel (cancel_delivery cancels it). Draft invoices never block; the void or cancel
  still cancels them. The trigger row-locks the candidate invoices without waiting
  (`ORDER_LIFECYCLE_BUSY_RETRY` asks for a retry), so a post running at the same moment
  cannot slip past. The automatic-credit design in to-do 3.5 is not built.
- Review round 1 (security, drift, compliance, 2026-10-29): fixed the unposted gap and
  the post-versus-cancel race above, the screen message, and the offline queue check;
  the proof now voids invoices through the real `void_invoice` RPC and covers unposted,
  paid, overdue and the concurrent cancel. Deferred, with owners: direct edits of a
  completed delivery's soft-delete or order link by an admin or rep bypass the status
  trigger (pre-existing; owner Claude, follow-up PR); `batch_cancel_deliveries`
  aborts as a whole when one delivery is blocked (acceptable, retry after voiding); the
  stale "posted invoice needs review" toasts on the delivery screen are now unreachable
  for completed deliveries (cleanup follow-up).
- Live evidence for the KNOWN_ISSUES stamp: the ledger's latest row was version
  `20261029143642` (authored stem `20261028185500_order_edit_and_number_concurrency`);
  the widened read-only preflight covered 11 orders with active order-backed non-credit
  invoices: zero over cap, zero invalid lines. No live writes ran.
- The cap tolerates under 0.001 of a unit over delivered, because field-split shares are
  rounded to four places (0.6667 x 3 = 2.0001). Deferred, fails closed: a short quick
  delivery whose draft was split into linked and unlinked lines can need a manual
  draft edit before completion (no overbilling is possible).
- Dropped the draft-only `vercel.json` setting that kept this branch from
  deploying previews; main's `ignoreCommand` stays.
