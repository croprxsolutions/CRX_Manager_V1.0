## 2026-11-15 — Grower-share chemical cost is booked in the product's sold unit (KI-156)

- Product Master repair step 3 (To-Do 0.17), behavior contract
  `docs/plans/2026-11-15-product-master-steps-1-3-CONTRACT.md`, PR C. One new migration, not applied live.
- `20270111130000_grower_share_cost_in_sold_unit.sql` re-emits `_save_field_app_invoice_impl_20260714` (preflight pins
  the live body, md5 `29d699a8b0698424345a78e9aac9dcd1`). Only the grower-share branch changes: a chemical included in
  a grower's per-acre price is converted from the rate unit into the unit its cost is per (the product's sold unit; a
  manual line's own unit), refused with the billed line's message when the units do not convert, stored in that unit,
  and costed on the stored quantity. 16 oz/ac x 100 ac of a $30/gal product now books $375 of cost, not $48,000.
  The bill's amounts (the $0 line and the per-acre grower price) and the billed branch are unchanged; the printed
  grower-share line now shows the converted quantity (12.5 Gal, was "1600 Gal"). A product line's unit is read on the
  server, as the billed line does. New refusal: a manual grower-share line whose unit is not its rate unit and does
  not convert (the screen cannot produce one).
- Checked and unchanged: the split field-app saver refuses grower-price fields (`MODE_A_UNSUPPORTED`) and already costs
  in the sold unit; the generic invoice saver refuses to re-save an invoice with a grower price
  (`FIELD_INVOICE_SPLIT_LOCKED`); the split preview has no cost; the blend-ticket path already converts. Live has no
  grower-share lines (read-only, 2026-11-15), so no rows need re-costing.
- Found, not changed: no field-app path declares a below-cost context, so today the below-cost wall refuses any
  field-app save whose grower-share line is a costed catalog product (`BELOW_COST_CONTEXT_REQUIRED`). Unblocking it is a
  separate business decision (KI-156 note); the prover declares that context to reach the cost math and proves the
  refusal is unchanged.
- Proof: `node scripts/smoke/prove-grower-share-cost-unit-real-schema.mjs` (GROWER_SHARE_COST_UNIT_PROOF_PASS).
  Rollback: `scripts/smoke/grower-share-cost-unit-reverse.sql` (proven; restores the live body by md5).
- Sol owed: blocked by #1868 (Sol refuses staging-based branches).
