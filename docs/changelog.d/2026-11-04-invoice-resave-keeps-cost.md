## 2026-11-04 — Re-saving a draft invoice keeps the cost it was invoiced at (#13)

- New migration `20261106140000_invoice_resave_keeps_cost.sql` (APPLIED LIVE 2026-11-04 19:42 UTC, ledger `20261104194231`; record in
  `docs/reference/migrations.d/`). Saving a draft invoice rebuilt every product line at today's
  product cost, and the below-cost check judged the rebuilt line against today's cost. Once a
  product's cost rose above the invoiced price, even a note edit on the draft was refused. An
  order-linked line saved back at its saved price and the same or a smaller quantity now keeps its invoiced cost and order line, and the
  below-cost check treats it as the same descendant of its order line that delivery writes. A
  lowered price, a changed product or a larger quantity is still checked against today's cost.
- CodeRabbit and Codex App fixes: each saved line keeps its cost once and only at its saved price, so
  sending it twice, raising its quantity or changing its price is checked against today's cost
  (smoke cases C, D and E).
- Sol fix: a draft line repriced above its order price keeps that price and its invoiced cost on a
  note-only re-save after a later cost rise (smoke case F); repricing it again is still checked.
- Post-apply: both function bodies match the local replay; the live smoke (cases A-F) passes and
  rolls back.
- New smoke chain `smoke-invoice-resave-keeps-cost.sql` (spec `invoice_resave_keeps_cost`).
- `src/lib/rpcContracts.test.ts`: `_enforce_below_cost_line` is listed again as a re-emitted
  trigger-only guard while this candidate is not applied (as for `20261019010000`).
- Freshness re-check (read-only, 2026-11-04 14:41 UTC): the live ledger has 1117 rows and does not contain
  `20261106140000`; this migration is not live yet. The 2026-11-04 re-stamp of `CURRENT_STATE.md` and
  `KNOWN_ISSUES.md` comes from #1431 (S16b), which this branch is stacked on.
