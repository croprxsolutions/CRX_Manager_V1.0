## 2026-11-09 - Sales reports show each payer's share of a split sale

Migration `20261229150000_sales_reports_per_payer` (not applied yet). A Bill Split sale used to show
wholly under its main customer in Sales Detail, Sales Summary and the dashboard's customer lists. Now
each payer gets their share, worked out by the same rule as their invoices: a $1,000 sale with a 40%
landlord shows the farmer $600 and the landlord $400. Totals, unsplit sales and field-split sales are
unchanged. Read only; who may see the reports is unchanged. Build sheet:
`docs/plans/2026-11-09-sales-reports-per-payer-BUILD-SHEET.md`.
