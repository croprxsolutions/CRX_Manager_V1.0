## 2026-10-29 - Invoice cap: review round 2 (delivery-link match, strict rounding bound)

- The new void/cancel check now finds a delivery's own invoices by the delivery link
  alone; the order match only applies to the older unlinked-invoice shape. Every real
  delivery has an order, so nothing changes today, but the check no longer depends on it.
- The over-delivery rounding allowance is now strictly under 0.001 of a unit (it was
  "up to and including"). Field-split rounding (0.6667 x 3 = 2.0001) is still allowed.
- Proof: the real-database proof (`ORDER_INVOICE_DELIVERED_CAP_PROOF_PASS`) re-ran from
  scratch on this content. No live data was touched.
- Round 2 follow-up: the "void the invoice first" message now also names a reversed
  (unposted) invoice, because that state blocks a delivery void too. Two more
  real-database proofs show that an order invoice cannot be detached from its order and
  that a completed delivery cannot be voided by a bare status write; both are refused by
  guards that were already live, so the migration SQL is unchanged by this round.
