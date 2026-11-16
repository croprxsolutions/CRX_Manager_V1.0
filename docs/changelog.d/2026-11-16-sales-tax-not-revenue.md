## 2026-11-16 — Sales tax is no longer counted as revenue

- New migration `20270109100400_sales_tax_not_revenue.sql` (not applied live; record in `docs/reference/migrations.d/`). Issue #1868.
- Month-End Close's Gross Margin and the P&L report counted sales tax inside invoice totals as revenue. Both now leave it out, including the tax a return credit refunds (worked out once when the credit posts, so past months never shift). Invoice totals, balances and statements don't change.
- `set_invoice_standing_discount` and `set_order_sales_tax`: `p_idempotency_key` now defaults to NULL.
