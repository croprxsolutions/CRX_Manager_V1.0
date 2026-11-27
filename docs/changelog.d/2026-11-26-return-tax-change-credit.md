## 2026-11-26 - Return credits after a sales-tax change (#2066)

- A return made before the sale's sales-tax box was ticked (or a standing discount set) is no longer blocked at receive or credit. It is re-priced to the customer's share of what the sale bills for those units, tax and discount included, and the re-price is recorded in the financial audit log. It never credits more than is charged.
- A return that covers units still on a draft invoice waits until that invoice is posted (Mason, 26 Nov: keep it simple). The office is told to post the draft first; after that the return is priced from what was billed, tax included.
- Units that are on no invoice yet stay refused once the sale has tax (its tax box is ticked) or a discount on any of its invoices: invoice them first.
- A sales rep who can't see all of the customer's invoices for the order is told so first, before any message about those invoices.
- If the product was billed at more than one price on the sale (a price change between deliveries), the return is not re-priced automatically; the office credits it by hand from the right invoice line. Per-line pricing (A2, planned) will replace this.
- Each return line now records how it was priced (order price or billed share), so the re-price never guesses. Returns made before this change keep today's behaviour, including today's refusal while a draft of the sale carries tax or a discount.
- While an older return priced before the tax change is not yet credited, a newer return of the same product for that customer waits (Mason confirmed, 25 Nov).
- A field split never triggers the re-price; only the sale's tax box or a sales-tax or discount line on its invoices does.
- Only the return being received or credited changes. If another open return of the same product for that customer still has its old price, the office is asked to cancel and recreate that one first.
- A return whose price went stale because an earlier return was cancelled still asks to be cancelled and recreated, as before.
- Migration `20270313040000_return_tax_change_credit` (not applied).
