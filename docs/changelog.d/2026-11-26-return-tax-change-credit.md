## 2026-11-26 - Return credits after a sales-tax change (#2066)

- A return made before the sale's sales-tax box was ticked (or a standing discount set) is no longer blocked at receive or credit. It is re-priced to the customer's share of what the sale bills for those units, tax and discount included, and the re-price is recorded in the financial audit log. It never credits more than is charged.
- Units still on a taxed or discounted draft invoice can be credited now (Mason, 26 Nov). They are credited at that draft's price, tax and discount included; the draft still bills them when it posts, so the two cancel out exactly. The tax ledger records the tax those units' credit refunds.
- Units that are on no invoice yet stay refused once the sale has tax (its tax box is ticked) or a discount: invoice them first.
- Each return line now records how it was priced (order price or billed share), so the re-price never guesses. Returns made before this change keep today's behaviour, including today's refusal while a draft of the sale carries tax or a discount.
- While an older return priced before the tax change is not yet credited, a newer return of the same product for that customer waits (Mason confirmed, 25 Nov).
- A field split never triggers the re-price; only a sales-tax or discount line on the sale's invoices does.
- Only the return being received or credited changes. If another open return of the same product for that customer still has its old price, the office is asked to cancel and recreate that one first.
- A return whose price went stale because an earlier return was cancelled still asks to be cancelled and recreated, as before.
- Known limit: a draft edited, voided or deleted after it priced a credit is not reconciled automatically; the office corrects it by hand.
- Migration `20270311100000_return_tax_change_credit` (not applied).
