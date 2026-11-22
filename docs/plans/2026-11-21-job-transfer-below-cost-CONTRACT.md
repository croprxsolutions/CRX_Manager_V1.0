# Behavior contract: Create Invoice on a spray job stops refusing small and customer-supplied chemical lines

Read at `origin/staging` 3a9694685 (2026-11-21). Decision: Mason, 2026-11-21 ("Yes, fix it next", relayed by the
parent session): a spray job's Create Invoice must stop refusing (a) a chemical line whose total is under one stock
unit's cost and (b) a customer-supplied $0 line, without weakening the below-cost wall for orders or invoices. A
normal line that is genuinely sold below cost must still be refused. Field application invoices are Mason's own work.

## Facts (source)

- The transfer (`_transfer_job_to_invoice_intent_impl_20260908`, newest body `20261120100000:301`) writes each chemical
  line as quantity 1, unit = the job line's unit, unit price = extended = the line total
  `safe_cents_qty(price_per_unit_cents, quantity)`, cost = `safe_cents_qty(cost_per_unit_cents, quantity)`; the
  multi-owner path splits that total by acre share (`:563-598`); single owner `:807-831`. Customer-supplied lines are
  written at $0 price and $0 cost with `price_source='manual'`. It declares no below-cost context.
- `job_chemicals.price_per_unit_cents` and `quantity` are in the job line's unit (`job_chemicals.unit`), proven by
  `save_job` (`20260904185900:1030-1077`); nothing ties that unit to the stock unit.
- The wall `_enforce_below_cost_line` (newest `20270201180000:47`, body md5 pinned `:397`) compares an invoice product
  line's `unit_price_cents` with ONE stock unit of `products.current_cost` (`:194-195`, `:234-250`, `:275`) and, with
  no context, raises `BELOW_COST_CONTEXT_REQUIRED` (`:361`). So today a 3 fl oz line ($1.17) against a $30/Gal cost and
  every customer-supplied $0 line are refused, while 10 Gal sold for $250 total at $30/Gal cost ($300) passes. Browser
  roles have no INSERT on `invoice_items`; the only $0 exemption is the grower-share context (`:72-77`, `:279+`).
- KNOWN_ISSUES:125 records that a job with a below-cost line cannot be auto-invoiced and is billed by hand.
- Writing the real quantity and a per-unit price instead (the first idea) was checked and rejected: `invoice_items.
  quantity` keeps 4 decimals (3 fl oz = 0.0234375 Gal is lossy), a later `save_invoice` re-save recomputes
  `ROUND(qty x price)` and would move cents, and the
  invoice PDF, statement, prep card and purchase/year-end summaries would print or count different numbers. That is an
  unrequested change to what customers see.
- Live, read-only 2026-11-21: 0 completed-and-unbilled jobs; no stored invoice changes.

## Outcome and authority

- Result, per chemical line at Create Invoice, judged on the WHOLE job line before any owner split:
  - Customer-supplied: written as today ($0, labelled) and no longer refused, even when the product has no cost.
  - Otherwise the transfer locks the product row FOR SHARE and reads its cost, stock unit
    (`inventory_unit`, else `unit_size`) and form from that locked row. When the job line's own unit converts exactly
    to the stock unit (`field_app_priced_quantity`; same unit counts), the line is compared exactly, with no rounding:
    line total in cents >= cost in cents x quantity in stock units. At or above: written as today and no longer refused
    for being under one unit's cost. Below: Create Invoice stops, nothing written, with "<product> is priced below its
    cost on this job. Nothing was invoiced; its price must be corrected before this job can be invoiced." The cost
    amount is never shown (cost is admin-only).
  - Unit not convertible (for example Ea on a Gal product), cost missing or invalid, blank unit, zero quantity or a
    negative price: exactly today's path (the wall judges the line as before). This is a deliberate exception: such
    lines can still be refused as today, and are billed by hand.
- Mechanism: the transfer declares a new context `field_app_job_transfer` and the product id (`crx.job_transfer_product`)
  only around the inserts of a line it has cleared, restoring the previous values right after. The wall treats that
  context as "no context" for every other check, and accepts an `invoice_items` INSERT under it only when it is a line
  for that same product, with no order link, not a fee, quantity 1, unit price = extended, on a `field_application`
  invoice that has a job. Orders, quotes, invoices, deliveries, field-app saves and the fee lines are unchanged.
- Who may act: unchanged (admin, sales_rep; actor bound to auth.uid()). No approval row is written for these lines (they
  are not below-cost sales). Grants, owners, SECURITY DEFINER, `search_path = public, pg_temp`, idempotency unchanged.
  The new helper is not SECURITY DEFINER and only `postgres` may run it.
- Automatic record changes (plan-contract, #2153): no additional kinds of writes beyond the existing transfer (the
  invoice, its lines, the job's billed state); no product or approval row is changed.
- Smallest change: one new migration re-emitting the transfer impl and the wall (preflight pins both live bodies'
  md5; postflight pins the new ones and the unchanged ACLs) plus the helper, its changelog.d and migrations.d records, a
  real-schema prover, the error message mapping in `src/lib/errorSanitizer.ts`, KNOWN_ISSUES:125 updated. No screen
  change: both Create Invoice buttons already show the cleaned database message.

## Tests (before and after, real schema)

- 3 fl oz line, Gal stock, priced above cost per Gal: before refused; after billed, same cents.
- Half a gallon (64 fl oz, or 0.5 Gal on a Gal line) above cost: before refused; after billed.
- Customer-supplied line: before refused; after billed at $0, cost $0, labelled.
- One full Gal line priced below cost: refused before and after; 10 Gal at a total below 10 Gal of cost: passed before,
  refused after (the hole closed).
- Split two-owner job with a small line: billed, shares sum to the line.
- Unconvertible unit (Ea line on a Gal product): behaves as before.
- An order line and a normal invoice line below cost with no context: still refused; the new context outside a job
  line shape (a fee line, an order-linked line) gives no exemption.

## Risks

- A cleared line's acceptance trusts the transfer's own check; only the transfer sets the context and browsers cannot
  insert lines. Mitigation: shape check in the wall, context scoped to the insert, prover cases above.
- Pre-existing, unchanged here: an admin's below-cost override and the invoice header checks behave as before (Astra
  1, 2); this change neither adds nor removes them.
- A job unit spelled in a way the converter does not know (for example "gals") also takes today's path (security
  review LOW 1). Not normalised here: `normalize_rate_unit` maps "fl oz" to "oz", which would price a fluid-ounce line
  on a dry product as weight. Same as before this change, never looser.
- Re-saving a transfer invoice later through the invoice screen (`save_invoice`) still judges a quantity-1 small line
  against one stock unit, so a rep is refused and an admin needs a reason. Named as a follow-up, not fixed here.
- Overlap: Taha's open issue #2061 (job transfer re-billing a soft-deleted blend ticket's job) touches the same function
  but no open PR re-emits it or the wall (checked 2026-11-21); whoever lands second re-pins the md5. The quote-price
  branch rebases onto this one.
