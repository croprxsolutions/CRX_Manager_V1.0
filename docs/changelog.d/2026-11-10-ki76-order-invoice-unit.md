## 2026-11-10 — Invoice lines always carry a unit, so returns can be credited (KI-76)

- New migration `20270106100000_blank_unit_fill_and_post_refusal.sql`. A new order line with no unit takes the
  product's unit. An invoice line with no unit (from a delivery or an order) takes the order line's unit, else the
  product's. A delivery always completes. Posting a chemical-sale invoice is refused, with a message saying what to
  set, while any product line still has no unit (field-application and misc-charge invoices are not checked). "Create Invoice" from an order refuses a line with no unit. A quick-delivery line always records its product's own unit, whatever unit the request names (Mason, 2026-11-10).
- 2026-11-11: re-dated from `20261230100000` to `20270106100000` so it sorts after migrations already live.
  Saving a draft whose line had no unit now works (the save's line-restore check accepts the filled unit; before
  this it failed with `GENERATED_INVOICE_LINEAGE_RESTORE_FAILED`). A direct edit of a quick-delivery line keeps the unit
  it was recorded in, unless the product changes (after Taha's review and Sol round 5).
- Old rows are not changed. The 2 open drafts with a no-unit line are listed in KI-76.
- KI-76's season item was already fixed by `20261204110000` (KI-18 batch 2); the entry is updated.
