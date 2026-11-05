## 2026-11-05 — Freight and other charges on a delivered chemical sale (billing plan M1)

- New migration `20261108110000_delivery_invoice_charge_lines.sql` (not applied; record in
  `docs/reference/migrations.d/`). A delivery invoice now accepts typed charge lines (freight,
  application fee, service, other) beside its products. Before, the delivered-quantity guard
  refused every line with no product on a delivery invoice, so freight had to be billed on a
  separate misc-charge invoice (in Chem Man it was entered as a fake product, "Shipping 255 EA x
  $1.00"). A line with no product and no charge type is still refused, and every product rule
  stays: no extra product, nothing beyond what was delivered.
- Invoice screen: a chemical sale backed by an order or a delivery shows **Add Charge** beside
  **Add Product**. A charge is a type, a description and one amount, checked before saving like
  the charges on a misc-charge invoice. A plain message explains the refusal of an untyped line.
- $0 lines (customer-supplied or included product, 14% of last year's Chem Man lines) already work
  for an admin: the invoice screen's below-cost prompt takes the reason and records the approval.
  A sales rep is still refused. Unchanged here.
- Proof: billing scenarios B02, B03 and B04 pass on the local test copy (B03 failed before);
  smoke chain `smoke-delivery-invoice-charge-lines.sql` passes after and fails on the old body at
  A and D.
