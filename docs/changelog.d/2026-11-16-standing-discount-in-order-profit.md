## 2026-11-16 — Reports count the standing discount

- New migration `20270117130000_standing_discount_in_order_profit.sql` (not applied live; record in `docs/reference/migrations.d/`).
- The financial dashboard, the profitability, sales summary and sales detail reports, the season comparison and the sale page's profit tile now take the standing discount off, as the invoice and the P&L already do. Stored sale totals and commission don't change.
