## 2026-11-10 — Invoice lines always carry a unit, so returns can be credited (KI-76)

- New migration `20261230100000_blank_unit_fill_and_post_refusal.sql`. A new order line with no unit takes the
  product's unit. An invoice line with no unit (from a delivery or an order) takes the order line's unit, else the
  product's. A delivery always completes. Posting a chemical-sale invoice is refused, with a message saying what to
  set, while any product line still has no unit (field-application and misc-charge invoices are not checked). "Create Invoice" from an order refuses a line with no unit.
- Old rows are not changed. The 2 open drafts with a no-unit line are listed in KI-76.
- KI-76's season item was already fixed by `20261204110000` (KI-18 batch 2); the entry is updated.
