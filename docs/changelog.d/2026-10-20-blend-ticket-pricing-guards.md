## 2026-10-20 - Blend-ticket pricing guards (Goal 3 "Pricing", migration 20261020210000)

**What.**
- **Order from a blend ticket never prices a product at $0 for a missing tier price.** The order
  body (`_create_order_from_blend_ticket_replay_impl_20261015`) used `COALESCE(tierN_price, 0)`
  with no tier-1 fallback. Today that $0 line is then refused by the below-cost line guard (every
  order line needs a cost), so staff got a confusing `BELOW_COST_CONTEXT_REQUIRED` error and no
  order. It now uses the customer's tier price when it is above zero, otherwise the tier-1 price,
  and refuses with `BLEND_TICKET_PRICE_MISSING` (naming the products) before any row is written
  when neither exists.
- **Blend-ticket invoice stops on an ambiguous quote.** When the job's quote lists the same product
  more than once at different prices, `create_invoice_from_blend_ticket` raises
  `BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED` with the choices (JSON in the error detail) before any
  invoice number is drawn. The Blend Ticket screen opens a "Pick the quoted price" window; the pick
  is saved by the new `set_blend_ticket_product_quote_price` (admin or sales rep, own-name rule,
  key required and bound to the caller) onto `blend_ticket_products.unit_price_cents`, and the
  invoice then bills it as `quoted`. Same-price duplicates bill as before.
- The same invoice also refuses a tier-priced product with no usable price instead of billing $0,
  and its quote lookup skips quote lines that carry no price.
- Shared rule: private helper `_blend_tier_price_cents_20261020` (tier price, else tier 1, whole
  cents; executable only by postgres).

**Why.** Goal 3 "Pricing" in `docs/plans/2026-10-13-direction-and-goals.md`; Mason 2026-10-15:
exact quoted-line matching is future work, "so Goal 3 adds a small guard: when the quote lists that
product more than once, the blend invoice stops and staff pick the price".

**Proof.** `node scripts/smoke/prove-blend-ticket-pricing-guards-real-schema.mjs` (Docker,
production schema baseline plus every post-baseline migration): the new chain
`smoke-blend-ticket-pricing-guards.sql` fails first before the change (the order is refused because
its line was priced at $0),
passes after it, and fails at the matching step with each guard removed. Screen tests:
`src/pages/BlendTicketDetail.test.tsx`, `src/lib/blendTicketPricing.test.ts`.

**Not changed.** The order wrapper and its replay binding, `save_blend_ticket`, every policy, grant
and table. Automatic exact-line matching stays future work.
