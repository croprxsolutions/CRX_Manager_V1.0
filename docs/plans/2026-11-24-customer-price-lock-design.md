# Customer season price lock: agreed design (Mason, 2026-11-24)

Status: design agreed in a brainstorm with Mason, then reviewed by Sol (gpt-6.2-sol, high, 54 findings) and revised. Not built. Customer price locks are in Taha's lane through 2026-12-15, so Taha builds this or it waits. Start with `plan-contract`; Sol again before merge.

## The problem
Today a price is held only by a sent quote (its sent version plus logged price changes) or by prices already copied onto order, invoice or job lines. With no eligible quote, unquoted sales price at the customer's tier at today's price: quick deliveries, walk-in orders, invoice add-product, and the blend-ticket and field-app fallbacks. Rush orders are created unpriced (`needs_pricing`, a suggested tier price) and priced later. A customer promised January pricing can be billed March pricing unless someone types it in. Invoice lines show a source pill (Quoted / Tier / Manual price); there is no side-by-side price check at posting.

## What it does
An admin locks a customer to their tier's prices as of a chosen date (past dates allowed). At the moment the lock is saved the app works out every product's price for that tier on that date and saves that copy with the lock; it never moves afterwards. New sale lines with no stronger price use the lock. Posting shows a price check.

## Mason's answers
1. **Who locks:** an admin, by hand, per customer ("Lock pricing" on the customer page). Price date (past allowed), end date (default: the next Sept 30), optional note (for example "financed"). Not automatic.
2. **Quote vs lock:** the sent-quote price wins for products on that quote; the lock covers everything else.
3. **Prices go down after the lock:** bill the locked price; the price check shows today's lower price so staff can choose to drop it.
4. **Quotes:** keep today's rule. Sending holds the prices; no acceptance, order or payment needed. Every sent version and every logged price change stays tracked.
5. **Two quotes disagree:** never guess; staff pick (see "when" below), with quote number, version and date sent shown.
6. **Mismatch at posting:** flag, never block. Price check per invoice: Billed | Source (quote #, version, date sent, click opens the quote in a pop-up) | Locked (price date) | Today. Post All warns "N invoices need a price look" and still posts.
7. **Backdating:** yes, an admin may lock to an earlier date's prices (for example in March, honour Jan 15). The price log is complete for every governed price change, so the app rebuilds that date's prices once, at lock time.

## Price order for a NEW sale line
1. Prepaid booking price (decision 2026-11-17: a prepay linked to a booking keeps its prices until refunded; does not lapse at quote expiry). Not built yet; this slot reserves its place.
2. Sent quote price for that customer, using the existing sent-price rule (latest sent version or a logged price change since; KI-81 eligibility by grower, field and date for blend/field lines).
3. The customer's active lock (saved copy).
4. Today's tier price.
5. A typed-in manual price overrides any of these; it is allowed, records who and why, and is flagged in the price check.
Extra product drawn beyond a booking: staff's choice stays (booked or today's price); with a lock, "today's" means the locked price.

## Rules added after the Sol review
- **Freeze:** a price already on an order line, delivery or draft invoice never changes because a lock is added, changed or ended, or a quote expires. The lock prices new lines only. Posting reviews saved money; it never re-prices. Posted invoices never change.
- **Which date counts:** the sale's own date (delivery or application date), not the posting date. Dates are Chicago business dates, start and end inclusive.
- **Quote conflicts are picked when the line is priced** (as the blend-ticket pop-up does today), because the app already stops before the invoice exists. The choice is saved on the line and shown in the price check.
- **Shared fields / split billing:** each grower is priced from their own quote, lock and discount.
- **Price check highlights only real problems:** billed doesn't match its saved source, or today's price is lower than billed. A normal quoted or locked price is not a warning.
- **End lock** button for mistakes or early end; the old lock stays in history. Re-locking ends the old lock and starts the new one in one step.
- **Existing guards stay:** below-cost admin approval, missing-price (`needs_pricing`) block, and every current posting check. "Flag, never block" applies only to the new price check.
- **Standing grower discount** still applies on top of a locked price, as it does on quoted prices; the price check compares before-discount prices and says so.
- **New quotes for a locked customer** start at the locked price, not today's (so a quote never undercuts the promise by accident).
- **Rush orders:** the suggested price uses the lock; the office still prices them as today.
- **Returns and credits** keep the price originally billed, never the lock or today's price.

## Building on the price log
- Every tier price change goes through the governed, logged path (`trigger_y_require_governed_product_pricing` refuses others; `write_product_pricing_history` logs). Every product got a starting entry on 2026-10-26 (migration 20261026140000, applied live, 0 products without history).
- Gap to close: a product created later gets no starting entry until its first price change. Log the starting price on product creation.
- Rebuild rule: for each product, the last logged tier price at or before the end of the chosen Chicago date; ties broken by a fixed order. A product that did not exist yet on that date uses today's price and is labelled so. A NULL tier 2/3 falls back to tier 1 from the same date; a stated $0 is a real price.
- Earliest lockable date: 2026-10-26.
- If a product's sale unit or package size changed since the price date, that line is flagged in the price check for staff to confirm.

## Not in this version
Automatic locks on payment or a deadline; custom per-customer prices; early-bird price lists; locking quantities.

## Technical notes for the builder (from Sol; normal build care)
- Lock changes: admin-only, enforced in the database; one active lock per customer; serialize per customer with a stale-version check; idempotency key on every lock RPC; record who, when, why.
- Pricing: resolve the lock once per sale transaction (one lock state per payer per sale); fall through to the lock only on "no eligible quote price", never on a quote refusal (`QUOTE_RESEND_REQUIRED`, `FIELD_APP_QUOTE_PRICE_CONFLICT`, unit/field mismatch).
- Store on each priced line where its price came from (quote item + version/change, lock id, manual, today), so the price check can explain it months later. `price_tier_at_sale` should record the tier actually used.
- Sales reps cannot read `cost_history`; pricing must go through a scoped RPC that returns only the sell price and its source.
- Post All price check must be fast for 100+ invoices (reads the saved lock copy, not the log).
- Paths that must use the lock: quick delivery / walk-in, rush-order suggestion, invoice add-product (`src/pages/InvoiceDetail.tsx`), blend-ticket fallback, field-app fallback, over-draw extra, new quote lines.
- Fix along the way: `getTierPrice` treats a $0 tier-2/3 price as missing; `getQuoteTierPrice` keeps it (`src/lib/quoteCalc.ts`).
- `docs/manual/DECISION_LOG.md` (2026-10-13 entry) still says the sent-quote lock is "not built"; it is live.
- Full Sol output kept outside the repo; findings 1 (history baseline not applied) was refuted: the ledger shows 20261026140000 applied live 2026-10-27 04:47 UTC with 0 products lacking history.
