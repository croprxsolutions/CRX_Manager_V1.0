# Pricing history, cost tracking and quote pricing — next section of work (DRAFT)

**Status: DRAFT for iteration. NOT approved to build.** Mason, 2026-10-13: "I dont want to start building
anything but want to leave top of list on to do this is next section of work. I want more iteration on it
before start building." Nothing here is a build instruction yet. Each round of iteration should update this
file; building starts only when Mason says so in chat.

**Decided so far.** A sent quote's prices stay locked until the quote is accepted or expires (Mason,
2026-10-13; `docs/manual/DECISION_LOG.md`).

**Where this came from.** The 2026-10-13 GitHub branch cleanup ran two read-only reviews of all 185 old
branches for work worth reusing, led by Mason's question about "pricing history lookup and cost tracking on
products for quoting". The first review's report is summarized below; the branches that carry reusable
work are kept (see "Reusable work").

## 1. What the app already has (checked 2026-10-13)

| Capability | Where | State |
|---|---|---|
| Product cost and three tier sell prices, changed through a preview-then-apply path | Products page, "Pricing .xlsx" workbook; RPCs `preview_product_cost_basis_changes`, `apply_product_cost_basis_change_set` | Live. Used once (4 rows, 2026-08-18). |
| Cost change log | `cost_history` table, admin-only | Live, 33 rows (counted live 2026-10-13). It also stores tier sell-price changes (`old_tier1_price` … `new_tier3_price`), but no screen shows those. |
| Price-history chart on the product page | `src/components/products/ProductPriceHistory.tsx`, admin-only | Live. Shows supplier quotes, the chosen cost and purchase-order paid cost. Cost only, no sell prices. Per the salvage review the points are evenly spaced rather than placed by date, and most purchase-order points show "supplier unknown". |
| Supplier Pricing page and supplier evidence | `src/lib/supplierPricing.ts`, Supplier Pricing page | Live. Run once (Wells pilot, 10 products, 2026-07-21). The "use supplier evidence as the cost basis" switch is off; per the 2026-09-02 TODO check, 602 of 604 product costs are still the original setup load. |
| Cost frozen when a quote is saved | `quote_items.cost_at_quote_cents` | Live. |
| Order and invoice cost locked by the database | trigger `zz_crx_below_cost_order_items` overwrites any browser-sent cost with the locked product cost | Live; the trigger was confirmed enabled 2026-10-13. A claim that "the database accepts any cost sent from New Order" is wrong. |
| Quote SELL price frozen | — | **Not built.** Per two independent reviews on 2026-10-13 (read from `save_quote`'s live body, not exercised), every save, including Convert to Order, re-prices each line without a manual override to today's tier price. This is what Mason's 2026-10-13 decision changes. |

## 2. What is missing

1. **Sell-price lock on sent quotes** (decided; design open, see section 5).
2. **The quote screen's half of quote-time cost.** The database already keeps each line's quote-time cost
   and accepts line ids, but the screen never sends a line's id. So a quote holding the same product twice
   can't be saved again, and the screen shows today's cost instead of the frozen one (recorded in
   `docs/manual/KNOWN_ISSUES.md` by the cleanup change).
3. **"What did we charge this customer before?"** inside the quote screen: the last quoted, ordered and
   invoiced price per customer and product, with date and tier. The data exists in quote, order and invoice
   lines.
4. **Sell-price history on the product page**, and a real date axis on the existing chart.
5. **Cost freshness.** An "as of" date on cost, a stale-cost report, and wider use of supplier evidence.
6. **Per-product margin targets** and a below-the-floor warning.
7. **Named or seasonal price lists** ("Early Bird").
8. **Profitability reports on cost at time of sale.** The server report `get_profitability_report` is live
   but no screen calls it; the Reports page computes from stored order profit.

## 3. Reusable work (kept branches and recoverable documents)

Every pointer below was confirmed to exist on 2026-10-13. The branches are kept on GitHub until this plan
is built or the work is consciously dropped (Mason, 2026-10-13: "keep all of the branches you have in
question"). Each is also restorable from its closed PR page.

- **PR #397, `codex/pr389-coderabbit-fixes`** (the largest quote-pricing branch):
  - quote line identity and quote-time cost on screen: commits `dec5d3378`, `8e147f40d`, `b3d2bba0d`,
    `81240c6f3` (`src/pages/QuoteBuilder.tsx`, `src/lib/quoteCalc.ts` and tests);
  - Convert to Order without marking the quote accepted first: `dc4ad87fd`
    (`quoteConversionAtomicity.test.ts`). Warning: as written it breaks "Book as Order" from a draft, so
    the status handling must be redone;
  - profitability reports on the as-of-sale report: `d03a60fc9` (`src/pages/Reports.tsx`,
    `Reports.profitability.test.tsx`);
  - below-cost database tests (`scripts/smoke/smoke-below-cost-admin-wall.sql`,
    `scripts/smoke/smoke-below-cost-quote-lifecycle.sql`), written against August function signatures.
- **PR #350, `claude/pricing-audit-strategy-jym8rr`.** An earlier version of the line-identity screen code
  that installs the `item_ids` the database returns, plus August pricing notes. Its owner decisions are
  recorded by the cleanup change.
- **Deleted designs in main's history:**
  - Early Bird / seasonal price lists:
    `git show 842bcfccf:docs/plans/2026-02-23-price-list-versioning-design.md` (marked "future project").
    It has a business design and four open questions; its database plan must be redone under today's rules
    (money in whole cents, row-level security in the same migration).
  - Supplier pricing, price history and variants plan (rev 5):
    `git show a16925315^:docs/plans/2026-07-16-supplier-pricing-and-variants-plan.md`.
    - §3 and §5a hold the rule "show replacement cost, last paid and recent average beside each quote
      line", and note that about 80% of sales are quoted before any purchase order exists.
    - §6–§9 hold Mason's 2026-07-16/17/20 supplier-pricing decisions: no AI or automatic reading of
      supplier PDFs; imports never change sell prices; never merge the 163 variant products. These are not
      yet in `DECISION_LOG.md`, and the wording needs Mason's confirmation, because the plan says
      "parked" where other docs say "permanently retired".

**Not reusable (checked, so nobody re-litigates):** #397's three pricing migrations, which are identical to
live `20260812115235/6/7`; #397's draw-down owner restriction, which contradicts Mason's 2026-08-16 "any
rep" decision; the old `BelowCostConfirmModal` / `belowCostRpc.ts`, replaced on main; and the parked "New
Order cost" migration, made redundant by the live trigger.

## 4. Draft build path (to iterate, not to start)

Small slices, each its own change. Order and scope are open for discussion.

1. **Quote line identity and quote-time cost on screen.** Rebuild by hand from #397's commits (main's
   QuoteBuilder has moved on). Do the money math in `src/lib/money.ts`. Re-picking the same product keeps the
   line's frozen cost; swapping to a different product starts fresh. Proof: save a quote with one product in
   two sections, edit it and save it again.
2. **Sell-price lock** (Mason's 2026-10-13 decision). Freeze each line's sell price when the quote is sent,
   the same way cost is frozen, and stop Convert to Order from re-pricing. Depends on slice 1.
3. **"Last charged" panel in the quote screen.**
4. **Sell-price history on the product page.** A read function over the tier columns `cost_history`
   already stores; a real date axis on the chart; deleting a product refuses rather than erasing history.
5. **Cost evidence beside each quote line** (admin only, hidden in Customer View and on PDFs).
6. **Profitability reports on cost at time of sale** (independent; can go first). Copy #397's three report
   fetchers and its test. The numbers will change, because lines on deleted or cancelled orders drop out.
7. **Cost freshness.** Turn on supplier-evidence cost selection beyond the 10 pilot products (a live
   switch: needs Mason's yes) and map the remaining purchase-order vendor names. Mostly data entry. This
   overlaps the TODO deadline item "test the pricing/repricing path before sales season".
8. **Margin targets and floor.**
9. **Early Bird price lists**, from the deleted design. Only after slice 2.

## 5. Open questions for the next iteration

From Mason's sell-price-lock decision. Facts found by the second salvage pass, read from code and not
exercised:
- `main` today lets a sent quote be edited, which makes it `revised`. The status trigger, `save_quote`'s
  status rules and `docs/workflows/QUOTE_TO_DELIVERY.md` (about lines 28-66) all permit it.
- Convert to Order saves the quote again first (`src/pages/QuoteBuilder.tsx`, about lines 3053-3055), so a
  rebuilt Convert fix must not re-price a sent quote on the way to the order.

Questions:
- **Does "locked" mean prices only, or no edits at all** once a quote is sent?
- **When does "sent" start the lock?** On the first move to `sent`, or on every send?
- **Can an admin unlock a sent quote**, and should that be recorded?
- **Expiry already runs automatically, but not for every quote.** Checked live 2026-10-13: the cron job
  `auto-expire-quotes` (daily at 06:05 UTC) runs `auto_expire_quotes()`. It sets `sent` and `revised` quotes
  whose `expires_at` is before the current date to `expired` and releases their stock holds. It deliberately
  skips planned quotes (`is_planned`) and quotes with any partial draw-down, which staff close by hand. So
  under the lock decision, a planned or partly drawn quote would stay price-locked until someone closes it.
  - Should those quotes stay locked indefinitely, or does the lock need its own end?
  - How is `expires_at` set from `valid_days`, and from creation or from sending? Not yet checked.
  - Does a separate 30-day stale rule matter here? The review mentioned one.
  - After expiry, does the quote re-price on its next save, or must it be re-sent?
- **What if cost rises above a locked price before conversion?** The below-cost check uses today's cost, so
  converting a locked quote could be refused.
- **What about a revision?** A sent quote can become `revised`. Does a revision keep the locked prices, or
  re-price to today's catalog until it is sent again?
- **What about manual price overrides and below-cost approvals** on a locked line?
- **The cost side.** Should quote-time cost also stay locked for the margin shown, given that the
  below-cost check today uses today's cost (a line can look profitable on screen and still be refused)?

Carried from the salvage review:
- **(b) Visibility.** Should sales reps see "last charged" prices and sell-price history? Cost history is
  admin-only under the 2026-07-20 decision.
- **(c) Which cost the quote screen shows:** quote-time cost, today's cost, or both.
- **(d) Supplier quotes.** Who supplies fresh supplier quotes, and should the supplier-evidence switch be
  turned on for all products?
- **(e) Margin targets:** one per product, a company default, or seeded from past selling prices?
- **(f) Early Bird.** The design's four open questions, including what happens when a committed price is
  below today's cost.

## 6. Not verified yet

- No old branch code was run in a browser. Every screen behavior above is read from code and live function
  text.
- The quote re-pricing behavior was read from code by two reviews, not exercised.
- Live counts other than `cost_history` (33) and `quote_items` (20) come from the review agents' read-only
  queries.
