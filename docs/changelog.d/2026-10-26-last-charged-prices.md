## 2026-10-26 — "What did we charge this customer before?" on the quote screen (To-Do 0.3, pricing plan slice 3)

The quote screen now shows, for each product on the quote, the last price this customer was charged,
with the tier and the date. Mason, 2026-10-14: sales reps "should see the last price we charged this
customer"; price history itself stays admin-only.

- **Database** (`20261026130000_last_charged_prices.sql`):
  - New read function `get_last_charged_prices`, for admins and sales reps. A rep sees charges billed
    by any rep, because invoice access alone would hide another rep's bills. It returns only the price,
    tier, date and whether it came from an invoice or an order. It never returns cost, margin,
    quantity, document numbers or who sold it.
  - What counts as a charge: a posted, paid or overdue invoice line, or a priced confirmed or
    delivered order line not yet on such an invoice. Quotes, drafts, unposted, cancelled or voided
    invoices, credit memos, misc charges, returns and cancelled orders never count.
  - Every new order and invoice line now records the tier it was sold at (`price_tier_at_sale`), set
    by the database whichever screen writes the line. That includes the invoice editor's save, which
    re-adds lines and then restores their link to the order. Older lines show "Tier unknown" (not
    guessed). $0 no-charge lines are not a "last charged" price.
  - The split-billing fingerprint (`_split_invoice_content_claim`) ignores the new column, so split
    invoices already waiting keep posting.
  - No price, cost, quote, order or invoice value is touched. One-time effect: an invoice open on
    screen during the apply is refused once at Post and posts after a reload.
- **Quote screen** (admins and sales reps): a "Last Charged" card above the totals lists each product
  once, with its last price and the size it was sold in, tier, date and source, or "Never charged to
  this customer". It is hidden in
  Customer View and is not on the PDF. A failed load says so, with Try again.
- **Proof:**
  - `node scripts/smoke/prove-last-charged-prices-real-schema.mjs` runs the migration on a disposable
    copy of the production schema. It covers every status, invoice type and line kind that counts or
    does not, the same-date tie, another customer, every role, the tier stamp on each path, grants,
    preflight drift and a role-gate mutation, and it runs the live smoke chain once.
  - The live self-undoing chain `smoke-get-last-charged-prices.sql` runs after the apply.
