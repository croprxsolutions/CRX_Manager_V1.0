## 2026-11-25 — Commission after the standing discount

- New migration `20270304100000_commission_after_standing_discount.sql` (not applied live; record in `docs/reference/migrations.d/`).
- A sale's commission is now split on its profit after the standing grower discount, the same profit the invoice and the P&L show, and never on sales tax. It moves when the delivery's invoice is drafted, its discount is changed, or it is voided. Paid or batched commission doesn't move. Sales with no discount are unchanged.
