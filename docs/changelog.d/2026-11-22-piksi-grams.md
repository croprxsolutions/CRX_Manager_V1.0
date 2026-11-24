## 2026-11-22 — Piksi Dust is stocked, sold and rated in grams (KI-114, #1958)

- Behavior contract `docs/plans/2026-11-22-ki114-piksi-grams-CONTRACT.md`. One new data-only migration, not applied live.
- `20270228180000_piksi_mg_to_grams.sql` (data only, one-shot): the three Piksi Dust products, their two product
  groups, stock rows, order, delivery and PO lines, PO cost-unit snapshots and receiving records say `g` instead of
  `MG` (milligrams); four older Plus delivery lines that still said "Dry oz" say `g` too. Mason, 2026-11-22: the
  quantities and prices were always grams ("price is same as grams"). No quantity, price, cost, rate or per-acre price
  changes; `pricing_version` and the group versions step by one; each cost basis is replaced at the same cents with no
  gap. This reverses the 2026-11-13 reading in `20270121100000` ("MG means milligrams").
- Why it matters: the approved rates already say 18 g (Plus) and 6 g (Infurrow). Against stock in MG, the rate
  cut-over would have priced and deducted 1000 times too much. Piksi stays on legacy pricing (the cut-over hold list
  is unchanged); releasing it is a separate step.
- Proof: `node scripts/smoke/prove-piksi-grams-real-schema.mjs` (PIKSI_GRAMS_PROOF_PASS). Rollback:
  `scripts/smoke/piksi-grams-reverse.sql` (proven; refuses once new gram-era activity exists).
