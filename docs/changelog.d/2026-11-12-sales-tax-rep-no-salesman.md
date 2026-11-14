## 2026-11-12 — Sales tax box: a rep can't change a sale with no salesman

- New migration `20270103190000_sales_tax_rep_no_salesman.sql` (not applied; record in `docs/reference/migrations.d/`).
- `set_order_sales_tax` let any sales rep change the box on a sale with no salesman (a NULL slipped past the check). Now refused, as the screen already showed.
