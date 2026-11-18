## 2026-11-17 — Invoices bill only a quote price the customer was sent (KI-81)

- Mason, 2026-11-17: fix now. Behavior contract `docs/plans/2026-11-17-ki81-sent-price-invoices-CONTRACT.md`
  (cold-challenged by Astra, 37 findings settled there). One migration, not applied live:
  `20270125163000_ki81_invoices_bill_sent_quote_price.sql`.
- Field-application invoices (single save and split-bill save) took a chemical's price from any quote line for the
  product on one of the fields: any customer, any status, deleted, expired or never sent, chosen effectively at
  random. Now only the billed grower's own quote (Mason, "Own quote only": on a shared field a co-owner's quote never
  prices another grower's share) that was sent, is not a draft, declined, cancelled
  or deleted, was written on or before the application date and has not expired by it, on a field that grower has a
  share of, can price it (Mason, "Valid + written before";
  "Sent + not expired"). Its prices must pass the sent-price lock (a price changed after sending needs a re-send, or
  a change `save_quote` recorded since). Two such quotes, or two lines, at different prices refuse
  `FIELD_APP_QUOTE_PRICE_CONFLICT`; typing the price on the line saves (Mason, "Stop, type the price"). No eligible
  quote: the price list, as before. If an eligible quote changes while one save is pricing several growers, the
  save refuses `FIELD_APP_QUOTE_PRICE_CHANGED` ("save again") rather than price them differently.
- The blend-ticket invoice priced from the job's quote without the lock; it now locks that quote and runs the lock
  before any price is read or invoice number drawn (`QUOTE_RESEND_REQUIRED`). The job quote now prices only the
  grower who owns it, and only if it was sent, written on or before the application date and not expired by it;
  every other grower on the ticket, and the owner for a product the job quote does not price, is priced from their
  own quote as on a field-app invoice, else their list price (Mason, 2026-11-18). A job quote that prices nobody on
  the ticket (its owner has no per-unit share, or it prices none of the ticket's products) no longer runs the
  sent-price lock.
- On a field-app invoice the resend refusal also says the price can be typed, and a per-person typed price on a split
  bill no longer needs that grower's quote to pass the lock.
- The invoice screen's preview shares the save's quote eligibility (`_field_app_quote_eligible`) but does not run the sent-price check: a quote changed since its send previews its current price, and the save refuses `QUOTE_RESEND_REQUIRED`. A preview price is not approval to bill it.
- New private `_field_app_quote_eligible` and `_field_app_sent_quote_price_cents` (no API role may run them); the private
  `resolve_field_app_chemical_price` gains the billed growers and the application date (old signature dropped; not
  executable by `anon` or `authenticated`; the existing `service_role` grant is preserved). The public RPCs keep their names and arguments, so the deployed screens are unchanged.
- Live, read-only 2026-11-17: no stored invoice line was priced from a quote by these paths, and none is re-priced.
- Proof: `node scripts/smoke/prove-ki81-sent-quote-price-real-schema.mjs` (KI81_SENT_QUOTE_PRICE_PROOF_PASS).
  Rollback: `scripts/smoke/ki81-sent-quote-price-reverse.sql` (restores all five bodies by md5, drops the helpers).
