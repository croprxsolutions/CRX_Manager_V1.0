# Behavior contract: Create Invoice on a spray job stops refusing small and customer-supplied chemical lines

Read at `origin/staging` 3a9694685 (2026-11-21). Decision: Mason, 2026-11-21 ("Yes, fix it next", relayed by the
parent session): a spray job's Create Invoice must stop refusing (a) a chemical line whose total is under one stock
unit's cost and (b) a customer-supplied $0 line, without weakening the below-cost wall for orders or invoices. A
normal line that is genuinely sold below cost must still be refused. Field application invoices are Mason's own work.

## Redesign: real quantities (Mason, 2026-11-22, "Redesign")

Supersedes the quantity-1 mechanism below (kept for history). Read at `origin/staging` def05e704. Sol round 2 found four
HIGHs that all came from the quantity-1 placeholder (an unconverted "fl. oz" cost booked per gallon, an override saved
between check and bill, a restricted-use register entry of "1", and an invoice-editor re-save refusing the line).
Mason chose to remove the placeholder. Customers will see real quantities (Mason, relayed 2026-11-22).

### Facts (source)
- Field-app invoices already write a chemical line as quantity in the product's sold unit (`inventory_unit`, 4
  decimals), price and cost per sold unit, extended = `safe_cents_qty(price, qty)` (`20270205100000:531-568`).
- The invoice editor re-save (`save_invoice` -> `_save_invoice_lineage_unaware_impl_20260827`,
  `20261106140000:280-349`) stores the sent unit price and cost (no tier or quote lookup on a field invoice), and
  recomputes extended = `ROUND(qty x unit price)` and cost total = `sum ROUND(cost x qty)`. So a line whose extended
  already equals `ROUND(qty x price)` re-saves to the same cents.
- The below-cost wall compares an invoice product line's `unit_price_cents` with ONE sold unit of
  `products.current_cost` (`_enforce_below_cost_line`, `20270201180000`). A line priced per sold unit is judged
  exactly right by it, in every context, with no exemption.
- Restricted-use register (`generate_rup_sales_records`, `20270106110000:879-921`) copies `quantity` and `unit_size`.
  The prep card, year-end and purchase summaries sum `quantity` (by `unit_size` where grouped). The invoice and statement
  PDFs print rate, total applied, unit price per gal/lb (or `unit_size`) and amount, not `quantity`, for chemical lines.
- Stock is deducted at job completion from `job_chemicals`, not from invoice lines (`20261217100000:840-893`).
- `invoice_items` has no CHECK tying extended to qty x price; quantity is `numeric(12,4)`.

### Behavior
- Each non-supplied chemical line whose job unit converts exactly to the product's sold unit (`field_app_priced_quantity`
  after the job-completion spelling fold; a fluid-ounce spelling stays "fl oz") is written as: quantity = the amount in
  sold units rounded to 4 decimals; unit = the sold unit; unit price = the job's price per job unit converted to the sold
  unit, rounded to the cent; cost = the product's current cost per sold unit (KI-156 precedent: server cost, never the
  job's recorded cost); extended = `safe_cents_qty(unit price, quantity)`; `price_source` = 'manual' (the job's agreed
  price). A multi-owner line gives each owner quantity x their acre share, rounded to 4 decimals, at the same unit price.
- Rounding guard (Mason's 2026-11-17 rule "Refuse if off >$0.50"): Create Invoice stops if a line's billed amount or
  booked cost would differ from its exact value by more than 50 cents, or its quantity rounds to 0, with a message
  naming the product and saying to record it in a smaller sold unit. Smaller differences bill (the invoice total can
  differ from the job's Est. $ by a few cents).
- Below cost: the transfer checks unit price >= current cost per sold unit before writing and stops with
  `JOB_LINE_BELOW_COST` (cost never shown). No admin override (unchanged decision). The wall then agrees.
- Customer-supplied line (Mason 2026-11-21 (b)): written at $0 price, $0 cost, real quantity, 'manual', labelled. The
  wall accepts it in any context (Create Invoice or a later editor re-save) only when it is a product line on a
  field_application invoice with a job, not a fee, no order link, price, amount and cost all 0, and that job has a
  customer-supplied chemical for that product. Restricted-use or unknown-status supplied products keep today's path
  (refused), per Sol round 1 ("Fix all four").
- Unconvertible units (Ea on a Gal product, unknown unit, no sold unit, missing or invalid cost): exactly today's path
  (quantity 1 at the line total); the wall judges it as today.
- Invoice header, owner shares and commissions use the sum of the written lines (extended, and `ROUND(cost x qty)`),
  not the job's own total.
- Kept from Sol round 1: deleted job refused (`JOB_DELETED`); a deleted blend ticket with a live invoice blocks.
- Removed: the `field_app_job_transfer` context, `crx.job_transfer_product` and the helper. The wall changes only by the
  supplied-line rule. A per-acre price override needs no special case (no line is exempted).

### Timing, existing rows, delivery
- Product rows read FOR SHARE in the line loop (cost, sold unit, form); the wall re-reads under the same lock.
- Old transfer invoices keep quantity 1; every reader already handles both shapes; nothing is rewritten.
- One migration (this file, never applied, rewritten in place) + prover + docs; no screen change. The quote-price PR
  rebases onto it and bills quote price per sold unit x the same quantity.

### Proof cases (real schema)
- 3 fl oz at 39c/fl oz, $30/Gal cost: billed 0.0234 Gal x $49.92 = $1.17, cost 70c; a re-save through `save_invoice`
  keeps $1.17 and is not refused (as a sales rep).
- 10 Gal for $250 against $300 cost: refused `JOB_LINE_BELOW_COST`, nothing written.
- A "fl. oz" job line whose stored job cost is a per-Gal figure: cost booked from the product (no $90 cost).
- Restricted-use product, 3 fl oz: posting writes 0.0234 Gal to the register.
- Customer-supplied line, product with no cost: billed at $0 and a re-save through `save_invoice` keeps it (admin and
  rep); a $0 line for a product the job did NOT mark supplied is refused.
- Rounding: a tiny amount of a costly product whose rounding moves more than 50c: refused; Gal job line on a Qt product
  at a price not divisible by 4: billed within a few cents.
- Two-owner split: each owner's lines, header and share tie; commission = line profit.
- Unconvertible (Ea on Gal): unchanged from today. Deleted job, deleted ticket: refused.

### Cold challenge (Astra high, 2026-11-22: 60 findings, 3 BLOCKER) and how it is settled
- Simplified (removes Astra 2, 3, 4, 5, 28, 29, 34-37, 50): invoice header, owner shares, per-acre overrides, machine
  fees, owner selection and `SPLIT_OVERRIDE_UNSUPPORTED` stay exactly as today. Only the chemical line's quantity, unit,
  unit price and cost change, and every place that reads a chemical line's `cost_cents` as a line total (single-owner
  `v_total_cost_cents`, member totals, both commission sums) reads `ROUND(cost x quantity)` instead, as the invoice
  re-save already does (fee lines keep their total cost).
- Below cost is judged on the EXACT agreed price before any rounding: job quantity x job price per job unit >= current
  cost x exact quantity in sold units; then the rounded stored unit price must also be >= cost per sold unit (Astra 1).
- Converter guards (Astra 18, 19, 26): both units must be recognized, non-blank units of the same kind; no '/acre'
  stripping; quantity must be > 0, finite and fit `numeric(12,4)`; otherwise the unit is "not convertible" (decision 3).
- Owner split: owner quantities are allocated by largest remainder so they sum to the whole line's rounded quantity
  (Astra 23); an owner whose share rounds to 0 is refused with a clear message (Astra 24).
- Pre-existing and untouched by this change (named, not fixed): restricted-use register de-duplication and capture
  rules (Astra 17, 43-45), stock deduction at completion (49), blend-ticket race and idempotent replay order (52, 53),
  invoice-group undo (55), the wall's later re-checks against a changed current cost or catalog unit on re-save (30,
  31) and the editor's submitted-cost handling (32, 33). Proof cases cover the touched paths only.
- Business decisions (Mason, 2026-11-22, the recommended answer each time: "Allow up to 50¢", "$0 info line", "Stop and name it";
  confirmed again in the parent session: "1 within 50 cents / 2.go with recommended / 3.go with recomnended"):
  1. Rounding (Astra 1, 7, 8, 21, 22): pricing per sold unit can move a line by a few cents from the job's Est. $.
     Recommend: bill within 50 cents per line (Mason's 2026-11-17 rule), refuse beyond, and refuse a positive line that
     would bill $0.
  2. Customer-supplied products (Astra 9-16): recommend writing them as $0 description lines with no catalog product link
     (name, EPA number, rate and amount applied still printed). No below-cost exception is needed, a re-save always
     works, and the grower's own product never counts as our sale in the restricted-use sales register or sales
     reports. Alternative: keep the product link with a narrow below-cost exception (bigger, more review rounds).
  3. Units that can't be converted (Astra 6, 42): recommend Create Invoice stops and names the product and unit to fix,
     as field-application invoices already do (`FIELD_APP_UNIT_UNCONVERTIBLE`). Alternative: keep today's quantity-1
     path for them, which keeps the "one unit" below-cost gap and a "1" in the restricted-use register.
- Screens (Astra 38, 40, 41): the invoice PDF and statement label a field line's unit price with `gl_lb_unit` first
  (GL or LB), so a product sold by another unit (Qt, Pt) prints its per-sold-unit price as "per GL". Field-application
  invoices from the editor already print that way; the transfer's lines now look exactly like them, so this change adds
  no new case. Relabelling every field invoice is a customer-facing change nobody asked for: named as a follow-up, not
  made here.

## Original quantity-1 design (superseded)

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
  - Sol round 1 (Mason, 2026-11-22, "Fix all four"): these also keep exactly today's path: a restricted-use product
    (or one whose restricted-use status is not yet known; the transfer writes quantity 1, which posting copies into the
    restricted-use sales register), customer-supplied ones included; and every line of a job whose fields carry a
    per-acre price override (the invoice bills that price, not the lines). A unit spelling is folded the way job
    completion folds it (`normalize_rate_unit`: "fl. oz", "gallons", "lbs" ...), except that a fluid-ounce spelling
    stays "fl oz", so a dry product never reads it as a dry ounce.
  - Also refused now (Sol round 1): a job with a blend ticket that was deleted while its invoice is still live
    (`BLEND_TICKET_ALREADY_BILLED`; voiding that invoice unblocks it), and a deleted job (`JOB_DELETED`).
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
- 1,280 fl. oz (10 Gal) below 10 Gal of cost: refused; 3 fl. oz above cost: billed. A restricted-use product's small or
  customer-supplied line and a small line on a per-acre-priced field: refused as before. A deleted blend ticket with a
  live invoice, and a deleted job: refused.
- An order line and a normal invoice line below cost with no context: still refused; the new context outside a job
  line shape (a fee line, an order-linked line) gives no exemption.

## Risks

- A cleared line's acceptance trusts the transfer's own check; only the transfer sets the context and browsers cannot
  insert lines. Mitigation: shape check in the wall, context scoped to the insert, prover cases above.
- Restricted-use lines keep being refused when small (Sol round 1): the real fix, invoice lines carrying their real
  quantity, changes the invoice line shape and is a follow-up.
- Not fixed (Sol round 1 MED 7): the file's one-transaction check runs at its end; the apply tool runs a file as one
  transaction, and a split run is caught there and undone by the reverse script.
- Pre-existing, unchanged here: an admin's below-cost override and the invoice header checks behave as before (Astra
  1, 2); this change neither adds nor removes them.
- A job unit spelled in a way the converter does not know (for example "gals") also takes today's path (security
  review LOW 1). Spellings are now folded as job completion folds them (Sol round 1), but never "fl oz" to "oz": `normalize_rate_unit` maps "fl oz" to "oz", which would price a fluid-ounce line
  on a dry product as weight. Without it, `field_app_priced_quantity` has no "fl oz" in its dry list, so a fluid-ounce
  line on a dry product does not convert and takes today's path. Same as before this change, never looser.
- Cost basis is the product's current cost, as the wall already uses for every order and invoice line (and for a
  full-unit job line before this change); the job's recorded cost is not compared (Luna round 3). If the cost rose after
  the job, the check is stricter; if it fell, the line is judged as any invoice line written today would be.
- Re-saving a transfer invoice later through the invoice screen (`save_invoice`) still judges a quantity-1 small line
  against one stock unit, so a rep is refused and an admin needs a reason. Named as a follow-up, not fixed here.
- Overlap: Taha's open issue #2061 (job transfer re-billing a soft-deleted blend ticket's job) touches the same function;
  the Sol round 1 fix above closes the live-invoice case of it, and no open PR re-emits the function or the wall (checked 2026-11-21); whoever lands second re-pins the md5. The quote-price
  branch rebases onto this one.
