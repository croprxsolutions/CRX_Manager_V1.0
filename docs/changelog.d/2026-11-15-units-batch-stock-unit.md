## 2026-11-15 — Units batch: every line counts in the product's stock unit (KI-136, KI-158, KI-140, KI-137)

- Product Master repair step 1 (To-Do 0.17), behavior contract
  `docs/plans/2026-11-15-product-master-steps-1-3-CONTRACT.md`, PR A. Two new migrations, not applied live.
- `20270113110000_ki137_powder_keg_each_piksi_mg_labels.sql` (data only, one-shot): Powder Keg Corn and Soybeans
  become sold and stocked by the each (Mason, 2026-11-13), with their family, stock rows and open order lines; a new
  cost basis at the same cents. Piksi Dust Plus's stock row and open PO, order and delivery lines say MG (milligrams)
  instead of "Dry oz"; the numbers were already milligrams. Treaty Extra's received PO-2026-0011 line and stock row
  say "Dry oz" instead of "oz" (the last purchase-order line in another unit; Mason, 2026-11-16). No quantity, price or
  cost changes.
- `20270113120000_line_unit_is_stock_unit.sql` (rules): a PO, order or delivery line with no unit gets the stock
  unit; a different spelling of the same unit is stored as the product's own (`EA` -> `Ea`); any other unit is
  refused with a plain message (the spelling is not rewritten on a receipt or on delivery lines). Receiving re-checks the PO line, so a legacy line in another unit cannot add the
  wrong amount to stock. Undoing a receipt or raising the ordered amount re-checks the line too. A product's stock unit cannot change while lines are open in the old unit or while it has stock (Mason, 2026-11-16). The one open
  PO line with no unit gets its stock unit. A quote line with a non-zero rate refuses an unknown rate or stock unit,
  and the per-acre price helper gives no figure for one (it used to price it as 1 oz).
- The product picker on the PO edit screen now starts a line in the product's stock unit.
- Proof: `node scripts/smoke/prove-units-batch-real-schema.mjs` (UNITS_BATCH_PROOF_PASS). Rollback:
  `scripts/smoke/units-batch-rules-reverse.sql`, then `scripts/smoke/ki137-units-data-reverse.sql` (both proven).
- Not in this change: liquid-vs-dry quote checks (KI-140 rest; 4 live dry-ounce products use an `oz` rate that
  means weight ounces, so a refusal would block quoting them before the KI-114 rates work), unit conversion on receiving (the per-line factor
  has only ever been 1 or blank), historical balances (fixed from counts, KI-29).
