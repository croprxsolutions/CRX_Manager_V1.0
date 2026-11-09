## 2026-11-06 — The Bill Split card bills: one invoice per payer on a chemical sale (billing plan M2)

- New migration `20261215110000_chem_sale_bill_split_invoices.sql` (not applied; record in
  `docs/reference/migrations.d/`). Until now the Bill Split card saved percentages nothing read.
  When a delivery on a sale with other payers completes, it now drafts one invoice per payer:
  one sale number with a suffix (CS-2026-0412-1, -2), in one split group that posts together.
- Each line shares its delivered cents and quantity. Every other payer gets their share rounded
  down and the main customer gets the rest, so each line adds up exactly ($100.00 three ways is
  33.34 / 33.33 / 33.33). A card under 100% leaves the rest with the main customer.
- New table `order_item_shares`: a line's own shares override the card for that line, such as a
  farmer paying 100% of one product and the landlord 0%. No screen for it yet.
- The card and the line shares lock at the first billed delivery, and voiding its invoices or the delivery reopens them. A row can't move to another sale, and a card can't total over exactly 100%.
- A payer's draft stays editable until it posts, so a freight charge can go on one payer's invoice.
- Create Invoice on a delivery drafts per payer too. A sale with other payers refuses one invoice
  to one customer. Reps can now read the card, which any rep could already write.
- A sale with no other payers bills exactly as before. Field/acre splits keep their own engine.
- Proof: billing scenarios B05, B06, B07 and B08 pass on the local test copy (all four failed
  before); smoke chain `smoke-chem-sale-bill-split-invoices.sql` passes.

A Bill Split draft's product lines now follow the split: changing them means voiding the group, while charges can still be added. A one-customer draft on a sale has to go before a payer can be added. The payers' drafts delete together, not one at a time. A line with its own shares can't move to another sale. Each payer's invoice cost is the cost of its own lines, as on every invoice. If drafting fails at completion the delivery still completes, an activity record is written and the result says so. A price-later (rush) sale drafts nothing until it is priced; Create Invoice on the delivery drafts per payer after.

A posted split group now unposts together: `unpost_invoice` refuses one member (`GROUP_UNPOST_REQUIRED`), for field-split groups too, and the screens already use the group call. A payer's line bills in the order line's unit, so every payer can return it. One line too small to show and worth no cents no longer stops the rest of a delivery billing. The card can't be truncated by a signed-in user.

Another payer's quantity is in whole hundredths, so a payer can return a share in full. Create Invoice works on a Bill Split sale after a field allocation is removed from a part delivery. A payer's invoice takes its season from its date. Line shares can't be written on a soft-deleted order. An inactive customer can't be added to a bill split. A draft holding a share under 0.01 of a unit can't be edited: it posts as drafted, or the group is voided.

A restricted-use line too small to show refuses the split instead of being left off, so the restricted-use register never misses it (Mason, 2026-11-06).

An order line with its own payer shares can't be deleted once the sale is frozen, and a retried unpost from before this change gets its saved answer.

A single invoice with a made-up group number cannot slip past the Bill Split rule.

A plain invoice can not be given a group number later either. Each line splits on its own: another payer rounds down to the cent and the main customer takes the leftover cent (Mason accepted, 2026-11-06).

An invoice keeps the type it was created with; a draft can still switch between chemical sale and misc charge (Mason, 2026-11-06).
The Delivery and Integrity screens offer Create Invoice on a Bill Split sale left to bill after a field split was removed, and the sale keeps its billing flag until every delivery is billed.
A payer share under 0.01 of a unit that is worth cents now refuses the split, so every billed quantity can be returned (Mason, 2026-11-06, option B). Payer invoices from Create Invoice take the delivery date, and invoices are locked briefly while the change is applied.
A Bill Split bills only delivered quantities in whole hundredths (2.12, not 2.125), so every payer, the main customer too, can return a share in full (Mason, 2026-11-06, an independent Opus review agreed). A finer delivery still completes, the office is told, and Fix Delivery corrects it before Create Invoice.
An unposted Bill Split invoice can be corrected like a draft: header edits and charges save, its product lines stay locked, and the group posts again.
Each other payer pays exactly their percentage of each line again, rounded down to the cent, on their quantity in whole hundredths; the main customer takes the rest, under a cent per other payer on each line (Mason, 2026-11-06, restoring exact cents over quantity times price). A line delivered past its planned quantity splits its capped total by percentage the same way. A save retried after a lost response still answers once the group posts.
A one-customer draft given a group id with no split record blocks adding a payer. A delivery that drafts its payers clears the split flag, and Create Invoice returns every payer's invoice number.

**Mason's answers, 2026-11-09.** A Bill Split now bills the real delivered amount, as a plain sale does: a 2.125 delivery bills each payer their share to 4 places (0.85 of 2.125 at 40%), the main customer takes the rest, and every payer's money is exact to the cent. No one has to use Fix Delivery to get an invoice out. This replaces the Nov 6 whole-hundredths rule; as on a plain sale, a sliver under 0.01 may not be returnable. Only a delivered amount with more than 4 decimal places, which an invoice line can't hold, still refuses. Create Invoice on a Bill Split delivery is dated the day it runs, as a plain Create Invoice is, so a rush sale billed after pricing lands in the month it was billed, and nothing is dated into a closed month.
A return holds 2 decimal places, so creating a return of a finer quantity (a payer's 0.7083, or a plain 2.125 line) is now refused in plain words instead of being created and then stuck at receive. The Returns screen offers a payer's share rounded down to 2 places.
Another payer's quantity stays in whole hundredths whenever the share allows, so they can return it in full (1 unit at 33.33% bills 0.33, not 0.3333); only a share under 0.01 falls back to 4 places so it still bills. The main customer takes the rest, so a 2.125 delivery still bills like a plain sale.
