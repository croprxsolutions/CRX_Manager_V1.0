## 2026-10-20 - Goal 3: invoices made from scratch carry charge lines only

- An invoice with no order and no delivery behind it (a `misc_charge` or `chemical_sale` from the
  New Invoice page) can no longer carry product lines (Mason, 2026-10-14 decision 6e and
  2026-10-15). Product is sold through an order and a delivery; a counter sale uses a quick
  delivery.
- Migration `20261020150000_from_scratch_invoices_charge_lines_only` (not applied yet): new column
  `invoice_items.charge_type` (freight, application fee, service, other) with a shape check (no
  product, quantity 1, no cost, a positive amount); two triggers refuse a product line on such an
  invoice on every write path and at posting (`FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED`); the
  `save_invoice` writer stores the charge type and refuses an untyped line on such an invoice; a
  line from any other writer (today only finance charges) is typed "other" automatically, and the
  shape check then refuses anything that is not a single charge.
- The New Invoice page shows **Add Charge** (type, description, amount) instead of Add Product on
  such an invoice and explains why. Order-backed, field-application, blend-ticket and job invoices
  and return credit memos are unchanged.
- Proof: `scripts/smoke/prove-from-scratch-invoice-charge-lines-real-schema.mjs` builds the
  production schema baseline plus every migration in a throwaway database and checks every refusal
  and every still-allowed case of the Goal 3 done-test, before and after the migration.
- Not in this change: the quick-delivery improvements (quantities below 1 unit, "completed now").
