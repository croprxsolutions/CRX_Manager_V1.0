## 2026-11-25 - Return credits after a sales-tax change, and the tax ledger timing (#2066, #2091)

- A return made before the sale's sales-tax box was ticked (or a standing discount set) is no longer blocked at receive or credit. It is re-priced to what the customer was billed for those units on the posted invoices, tax included, and the re-price is recorded in the financial audit log. It never credits more than was billed.
- A return whose price went stale because an earlier return was cancelled still asks to be cancelled and recreated, as before.
- The sales tax a return credit refunds is now recorded in the tax ledger even when the sale invoice posted while the credit was being issued.
- Migration `20270306110000_return_tax_change_credit` (not applied).
