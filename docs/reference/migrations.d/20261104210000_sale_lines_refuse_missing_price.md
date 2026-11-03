**LOCAL CANDIDATE — NOT APPLIED.** `20261104210000_sale_lines_refuse_missing_price.sql` (LF SQL sha256: `8a00907e99132ee39fcb8db0e1983acf1680f27c72475ccbcaf95a47017a261a`). WP-PM-6b missing-price refusals: one trigger function, `_sale_line_price_required()`, on `quote_items`, `order_items` and `invoice_items`. It refuses, by product name, a line that would show or bill $0 because its product has no price for the line's tier (own tier price, else tier 1): `QUOTE_PRICE_MISSING`, `ORDER_PRICE_MISSING`, `INVOICE_PRICE_MISSING`. A stated $0 price, a typed price, a price-later order line, an order line copied from a quote line, and invoice lines not priced from the tier are not refused. No data, grants on existing objects, policies or RPC bodies change.

Today such a $0 line is already stopped by the below-cost check, except when an admin approves it below cost with a reason; that check never says the product had no price. This rule fires first, so the person sees the missing price by name, and an admin can no longer approve a $0 line for a product with no price (type a price, use a quote line's price override, or give the product a stated $0 price).

Routine (non-destructive): it adds a function and three triggers and changes no rows. The function is SECURITY DEFINER with `search_path = public, pg_temp`, owned by `postgres`, and no API role may execute it.

Rollback: `DROP TRIGGER trigger_b_quote_item_price_required ON public.quote_items; DROP TRIGGER trigger_b_order_item_price_required ON public.order_items; DROP TRIGGER trigger_b_invoice_item_price_required ON public.invoice_items; DROP FUNCTION public._sale_line_price_required();`. Nothing else depends on them.

Proof: `node scripts/smoke/prove-sale-lines-refuse-missing-price-real-schema.mjs` prints `SALE_LINES_PRICE_REQUIRED_PROOF_PASS`.

Live read (read-only `execute_sql`, 2026-11-03, counts only): rows the rule would catch today are 0 quote lines, 0 tier-priced invoice lines and 2 order lines on open orders. Those two stay as they are; an edit that rewrites their price or product is refused until a price is entered, and deliveries against them are unaffected. 2 active products have no tier price at all.

Read the live ledger again at apply time; `20261104190000` (PR #1377) and `20261104200000` (PR #1374) sit below this stamp.
