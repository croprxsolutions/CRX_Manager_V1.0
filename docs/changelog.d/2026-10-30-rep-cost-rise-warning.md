## 2026-10-30 — Sales reps see when a line's cost has gone up, without cost numbers

- Mason, 2026-10-26: a rep confirming a booking weeks later must see a warning that cost has gone
  up, so a big increase can be discussed. Cost and margin stay admin-only (2026-10-15). Admins
  already see both costs on each quote line; reps saw nothing.
- New migration `20261030090000_quote_cost_alerts.sql` (row 1006 placeholder, NOT APPLIED): a
  read-only `get_quote_cost_alerts(p_quote_id)` returns, per saved line, only two yes/no flags:
  cost has gone up since the line was quoted, and the price is below today's cost. Active admins
  and sales reps only; no cost, price or margin leaves the database.
- Quote Builder: for a rep, a saved line shows "Cost has gone up since this was quoted." or, when
  the price is now below today's cost, "Below today's cost: converting needs an admin's approval."
  The flags are read again after each save. Admins are unchanged (they see the costs).
- Proof (local replay of main, synthetic data): booking scenario S23 shows no flag before, "cost
  rose" after cost moves to $11.20, "below cost" after $12.80 on a $12.37 line, as flags only, and a
  driver is refused. Tests: `src/lib/quoteCostAlertsMigration.test.ts` and three Quote Builder
  tests ("cost-rise warning for reps").
