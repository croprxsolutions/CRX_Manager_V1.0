**LOCAL CANDIDATE — NOT APPLIED.** Issue #1868 (Sol HIGH, MED): `20270109100400_sales_tax_not_revenue.sql` (SQL sha256: `919aef270d5e5fee3e5206ee3c0e6afac9821cde7aca5cb1370af52665cf768b`). Sales tax on sales invoices stops counting as revenue in the two profit reports, and the two billing setters get `DEFAULT NULL` on `p_idempotency_key`.

**Why.** A taxed chemical sale's invoice total includes its `sales_tax` line (`20270109100200_sales_tax_checkbox`). `get_monthly_summary` (Month-End Close) and the P&L report (`get_bottom_line_pnl` → `_get_bottom_line_pnl_cost_impl_20261019`) summed invoice totals as revenue, so a $100 sale with $6.25 tax showed $106.25 revenue and $6.25 too much gross margin.

**What it does.**
- `_invoice_sales_tax_cents_20270109(invoice)` (internal; service_role only): the invoice's `sales_tax` line (only a chemical sale has one; `guard_sales_tax_line_scope_20261231` refuses it elsewhere).
- `get_monthly_summary`: `invoices.total_amount_cents` is revenue without that tax, so Month-End Close's Recognized Invoices and Gross Margin (total − cost) leave it out. Same keys, no screen code change; on a taxed month that figure no longer equals the invoice list's sum (the difference is the tax).
- `_get_bottom_line_pnl_cost_impl_20261019`: Revenue without that tax; Gross Profit, Net Profit and every % follow. Its `search_path` gains `pg_temp` (last), like its wrapper.
- `set_invoice_standing_discount` and `set_order_sales_tax`: `p_idempotency_key text DEFAULT NULL`. Full definitions re-emitted; postflight checks each body's md5 unchanged, the default, owner and grants. Preflight refuses if a second overload of either setter exists.

**Not changed:** return credit memos. They carry the tax they refund inside their line amounts (no tax line of their own), so a taxed return still reduces revenue by the tax it refunds. Follow-up before sales tax goes live (it ships with the commission change): record each credit's tax when the return is made, and leave it out of revenue the same way. Also not changed: invoice totals, balances, posting, statements, AR, customer purchase summaries, `close_accounting_period`'s `total_invoiced_cents`, commission. Untaxed invoices give the same numbers.

**Proof (local synthetic DB, rolled back):** P&L Revenue, Gross Profit and Net Profit fell by exactly 3,049,465 cents = the posted sales-tax lines; COGS unchanged; credit memos and untaxed invoices give 0; a 50/50 split sale moves Month-End and P&L by the same amount; both setters show `NULL::text` defaults with unchanged bodies; the helper is refused to authenticated and anon, and a rep is refused on both reports.

**Ordering:** after `20270109100300_sales_tax_rep_no_salesman` (the restamped billing trio). Ships with them. Rollback: its own reviewed migration (restore the two report bodies pinned in the preflight, drop the helper, DROP and re-create the two setters without the default, same body, owner and grants).
