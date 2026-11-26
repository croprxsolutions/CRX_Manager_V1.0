## 2026-11-26 - A return credit's tax refund counts sales posted before it commits (#2091)

- The sales tax a return credit refunds is now recorded in the tax ledger even when the sale invoice posted while the credit was being issued. Before, the ledger could record 0 tax for such a credit, which would misstate month-end revenue.
- Known limit (accepted): a sale posted later in the same transaction as the credit is counted too, as before. No app action does both at once.
- Migration `20270308070000_credit_tax_ledger_timing` (not applied).
