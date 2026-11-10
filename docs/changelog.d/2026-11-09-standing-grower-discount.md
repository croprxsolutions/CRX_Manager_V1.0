## 2026-11-09 — Standing grower discount on chemical-sale invoices (billing plan M4b)

- New migration `20261231110000_standing_grower_discount.sql` (not applied; record in `docs/reference/migrations.d/`).
- A customer can have a standing discount rate (admin only). Their chemical-sale invoices get one
  "Standing discount 3%" line off the products, before tax; freight and other charges aren't discounted.
- On a Bill Split, each payer's invoice uses that payer's own rate on their share.
- The office can change or remove the rate on one sale's draft (`set_invoice_standing_discount`, kept in its own `invoice_standing_discount_rates` table).
- The line is worked out by the database on every draft save, so it can't be counted twice or edited by hand.
- A return of a discounted sale credits the discounted price; partial returns add up to what was billed.
- The invoice editor shows the discount line read-only, saves a discounted draft and never sends that line back, so switching a discounted draft to another type works.
- No screen yet; commission after the discount comes with the commission PR (week 4).
