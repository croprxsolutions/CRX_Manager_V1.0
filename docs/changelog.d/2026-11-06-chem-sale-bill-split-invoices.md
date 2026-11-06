## 2026-11-06 — The Bill Split card bills: one invoice per payer on a chemical sale (billing plan M2)

- New migration `20261115170000_chem_sale_bill_split_invoices.sql` (not applied; record in
  `docs/reference/migrations.d/`). Until now the Bill Split card saved percentages nothing read.
  When a delivery on a sale with other payers completes, it now drafts one invoice per payer:
  one sale number with a suffix (CS-2026-0412-1, -2), in one split group that posts together.
- Each line shares its delivered cents and quantity. Every other payer gets their share rounded
  down and the main customer gets the rest, so each line adds up exactly ($100.00 three ways is
  33.34 / 33.33 / 33.33). A card under 100% leaves the rest with the main customer.
- New table `order_item_shares`: a line's own shares override the card for that line, such as a
  farmer paying 100% of one product and the landlord 0%. No screen for it yet.
- The card and the line shares lock at the first completed delivery, and voiding it reopens them. A row can't move to another sale, and a card can't total over exactly 100%.
- A payer's draft stays editable until it posts, so a freight charge can go on one payer's invoice.
- Create Invoice on a delivery drafts per payer too. A sale with other payers refuses one invoice
  to one customer. Reps can now read the card, which any rep could already write.
- A sale with no other payers bills exactly as before. Field/acre splits keep their own engine.
- Proof: billing scenarios B05, B06, B07 and B08 pass on the local test copy (all four failed
  before); smoke chain `smoke-chem-sale-bill-split-invoices.sql` passes.

A Bill Split draft's product lines now follow the split: changing them means voiding the group, while charges can still be added. A one-customer draft on a sale has to go before a payer can be added. The payers' drafts delete together, not one at a time. Each payer's invoice cost is the cost of its own lines, as on every invoice. If drafting fails at completion the delivery still completes, an activity record is written and the result says so.
