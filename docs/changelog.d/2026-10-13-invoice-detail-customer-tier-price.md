## 2026-10-13 — A product added on the invoice screen is priced at the customer's tier

**Why.** A types reviewer on the reps-work-any-customer change noticed that the invoice editor
(`src/pages/InvoiceDetail.tsx`) loaded its customer list without the `assigned_tier` column, while
Add Product priced the new line with `cust?.assigned_tier || 1`. The `as Customer[]` cast hid the
missing column, so every product added there got the tier-1 price for every customer, for admins and
reps alike.

**Not display-only.** The live `save_invoice` chain (seven layers) and the six triggers on
`invoice_items` never read a tier price or `assigned_tier`; the server stores the price the screen
sends. So the tier-1 price was what got saved and billed unless someone typed over it.

**Live impact on 2026-10-13 (read-only).** 150 active customers are tier 1, one is tier 3, none are
tier 2, and the tier-3 customer has no invoices yet. Tier prices rise with tier in the current price
list, so the bug would have under-charged, and it had not yet affected a saved invoice.

**What changed.**
- `src/pages/InvoiceDetail.tsx`: the customer-list query also selects `assigned_tier`.
- `src/pages/InvoiceDetail.test.tsx`: a tier-2 and a tier-3 customer each add a product and Save;
  the price sent to `save_invoice` must be that tier's price. The test's customer mock returns only
  the columns the page asked for, so removing `assigned_tier` from the query turns it red (verified
  against the unfixed code: tier 3 saved 1000 cents instead of 799).

**Visible change.** Admins and reps now see the customer's tier price, not the tier-1 price, when they
add a product to an invoice on this screen. Tier-1 customers (all but one today) see no change.
