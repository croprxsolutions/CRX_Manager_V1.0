## 2026-10-25 — A sent quote keeps the prices the customer saw (To-Do 1.2; migration 20261025200000, not applied)

Mason's decisions of 2026-10-13/14 (pricing plan slice 2,
`docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md`). Before this, every
`save_quote` re-priced each line without a manual price to today's tier price, so a price change between
send and accept reached the order.

**Database (`supabase/migrations/20261025200000_quote_sent_price_lock.sql`, not applied yet):**
- New `_assert_quote_prices_as_sent(uuid)` (invoker rights, executable by no API role). The version last sent
  to the customer is the price authority: it refuses with `QUOTE_RESEND_REQUIRED` when the customer changed or
  a line is not a sent line for the same product at the same price. A quote never sent passes (a draft keeps
  its own prices). A last version from before the protected send workflow is refused. Versions written before
  this change carry no line ids; for them lines pair one to one by product and fail closed.
- `save_quote`: once a quote has been sent, a saved line keeps its price on every save; only a manual price or
  the line's new `use_todays_price` flag changes it, and a new line takes today's price. Editing a sent quote
  keeps its expiry. A save that accepts the quote must pass the check.
- Every send (`create_quote_version`) records each line's id and manual price and each section's field, and
  sets the expiry to the Chicago business date plus the quote's valid days.
- Rewind (`restore_quote_version`) puts a version's lines back under their own ids with their manual prices and
  section fields, so a rewound quote matches the version as sent.
- Convert to Order, Partial Order (`draw_down_quote`) and Schedule Job (`create_job_from_quote_section`) run the
  check before writing anything. If cost has risen above a locked price, Convert keeps the price and still
  needs an admin's below-cost approval with a reason (unchanged; proven).

**Quote screen (`src/pages/QuoteBuilder.tsx`):** a sent quote's saved lines keep their price through edits, tier
and customer changes. Each line offers "Use today $X" when today's price differs, and the revised-quote banner
offers "Use today's prices" for the whole quote. A line whose price was not sent shows "Sent at $X" or "New
since V1", the banner says a re-send is needed, and "Rewind to V1" restores the version last sent in one
confirmed step. Refusals show the server's plain-English instruction. A tier or customer change no longer
erases manual (negotiated) prices on any quote (plan section 7, finding 3).

**Not covered (follow-ups):** the blend-ticket invoice and field-application invoice paths read a quote line's
current price directly (`create_invoice_from_blend_ticket`, `_save_field_app_invoice_impl_20260714`,
`resolve_field_app_chemical_price`); they need the same rule.
