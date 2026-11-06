## 2026-11-06 — KI-18 batch 1: money, compliance and stock decisions use the Chicago date

- New migration `20261128100000_ki18_batch1_chicago_today.sql`. The database clock is UTC, so after 6 PM
  (7 PM in summer) Central it thought it was already tomorrow. 34 functions now take "today" from the
  Chicago date: overdue marking, accounting-month checks on payments and credits, commission payment
  dates, quote expiry, AR reminder day counts, applicator-license and RUP dates, inventory holds and
  stock checks, and default delivery, bill and payment dates. Four column defaults change the same way.
- Nothing else in those functions changes. Boards and reports follow in batch 2; statement and AR aging
  ranges in batch 3.
- Proof: `scripts/smoke/prove-ki18-batch1-chicago-today-real-schema.mjs`.
