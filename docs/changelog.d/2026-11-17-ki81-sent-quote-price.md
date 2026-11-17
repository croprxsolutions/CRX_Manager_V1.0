## 2026-11-17 — Invoices bill only a quote price the customer was sent (KI-81)

- Mason, 2026-11-17: fix now. Behavior contract `docs/plans/2026-11-17-ki81-sent-price-invoices-CONTRACT.md`
  (cold-challenged by Astra, 37 findings settled there). One migration, not applied live:
  `20270123100000_ki81_invoices_bill_sent_quote_price.sql`.
- Field-application invoices (single save and split-bill save) took a chemical's price from any quote line for the
  product on one of the fields: any customer, any status, deleted, expired or never sent, chosen effectively at
  random. Now only the billed grower's own quote (Mason, "Own quote only": on a shared field a co-owner's quote never
  prices another grower's share) that was sent, is not a draft, declined, cancelled
  or deleted, and has not expired by the application date (and expires in that season) can price it (Mason,
  "Sent + not expired"). Its prices must pass the sent-price lock (a price changed after sending needs a re-send, or
  a change `save_quote` recorded since). Two such quotes, or two lines, at different prices refuse
  `FIELD_APP_QUOTE_PRICE_CONFLICT`; typing the price on the line saves (Mason, "Stop, type the price"). No eligible
  quote: the price list, as before. If an eligible quote changes while one save is pricing several growers, the
  save refuses `FIELD_APP_QUOTE_PRICE_CHANGED` ("save again") rather than price them differently.
- The blend-ticket invoice priced from the job's quote without the lock; it now locks that quote and runs the lock
  before any price is read or invoice number drawn (`QUOTE_RESEND_REQUIRED`). A never-sent job quote still prices
  the blend, as Convert and Schedule Job allow.
- The invoice screen's preview uses the same rule, so it shows what the save will bill.
- New private `_field_app_quote_eligible` and `_field_app_sent_quote_price_cents` (no API role may run them); the private
  `resolve_field_app_chemical_price` gains the billed growers and the application date (old signature dropped; still
  closed to API roles). The public RPCs keep their names and arguments, so the deployed screens are unchanged.
- Live, read-only 2026-11-17: no stored invoice line was priced from a quote by these paths, and none is re-priced.
- Proof: `node scripts/smoke/prove-ki81-sent-quote-price-real-schema.mjs` (KI81_SENT_QUOTE_PRICE_PROOF_PASS).
  Rollback: `scripts/smoke/ki81-sent-quote-price-reverse.sql` (restores all five bodies by md5, drops the helpers).
