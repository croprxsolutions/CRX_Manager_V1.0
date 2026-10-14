## 2026-10-14 - Pricing plan: rewind keeps line identity; the goals plan lists the quote price lock

Documentation only. No code or database changed, and nothing is built.

- **`docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md`:** slice 2 records the
  review note deferred from PR #917, confirmed against the live database. An ordinary quote save keeps each
  line's ID, but a rewind (`_restore_quote_version_owner_impl`) re-creates every line with a new ID. So restore
  must keep the snapshot's line IDs or record an old-to-new map, and the proof adds rewind-then-convert. It
  also states the price authority after a price change: a revision that changes any price must be re-sent
  before Convert, which then bills the newly sent prices.
- **`docs/plans/2026-10-13-direction-and-goals.md`:** gap 2 now names the live problem that accepting a sent
  quote re-prices it to today's tier price. Goal 3 gains "Sent quotes keep their prices", including the
  re-send rule for price-changing revisions, and a matching done-when case, both pointing to the pricing
  plan's slice 2.
