## 2026-11-25 — Commission settles on the profit after the standing discount when an invoice is posted

- New migration `20270306100000_commission_settles_on_posting.sql` (not applied live; record in `docs/reference/migrations.d/`).
- When a chemical-sale invoice is posted, voided or unposted, the sale's pending commission is put on its profit after the standing grower discount (the same profit the invoice and the P&L show), never on sales tax. Drafts never move it. While a sale is only part-posted, the posted invoices' discount rate carries across the rest of the sale, so the P&L never earns more commission than the posted profit after its discount, except where a payout already froze an amount: paid or batched commission doesn't move. Sales with no discount are unchanged.
