## 2026-11-04 — Re-saving a draft invoice keeps the cost it was invoiced at (#13)

- New migration `20261106140000_invoice_resave_keeps_cost.sql` (NOT APPLIED; record in
  `docs/reference/migrations.d/`). Saving a draft invoice rebuilt every product line at today's
  product cost, and the below-cost check judged the rebuilt line against today's cost. Once a
  product's cost rose above the invoiced price, even a note edit on the draft was refused. An
  order-linked line saved back unchanged now keeps its invoiced cost and order line, and the
  below-cost check treats it as the same descendant of its order line that delivery writes. A
  lowered price, a changed product or a larger quantity is still checked against today's cost.
- New smoke chain `smoke-invoice-resave-keeps-cost.sql` (spec `invoice_resave_keeps_cost`).
- `src/lib/rpcContracts.test.ts`: `_enforce_below_cost_line` is listed again as a re-emitted
  trigger-only guard while this candidate is not applied (as for `20261019010000`).
- Freshness re-check (read-only, 2026-11-04 14:41 UTC): the live ledger has 1117 rows and does not contain
  `20261106140000`; this migration is not live yet. The 2026-11-04 re-stamp of `CURRENT_STATE.md` and
  `KNOWN_ISSUES.md` comes from #1431 (S16b), which this branch is stacked on.
