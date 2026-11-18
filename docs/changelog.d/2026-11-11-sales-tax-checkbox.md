## 2026-11-11 — Sales tax checkbox on chemical sales (billing plan M4a)

- New migration `20261231120000_sales_tax_checkbox.sql` (not applied; record in `docs/reference/migrations.d/`).
- A sale has a sales tax box, off by default. Ticked, each of its chemical-sale invoices gets one "Sales tax 6.25%" line on the products and charges, after the standing discount, to the cent.
- The rate (6.25) is in Settings. A draft keeps the rate it was taxed at; new drafts take a changed rate.
- On a Bill Split, every payer is taxed on their own share.
- Changing the box (`set_order_sales_tax`, an admin or the sale's own rep) updates the sale's drafts; posted invoices keep their tax.
- A return of a taxed sale credits the tax paid.
- The invoice editor shows the tax line read-only and never sends it back.
- No screen for the box or the Settings rate yet.
