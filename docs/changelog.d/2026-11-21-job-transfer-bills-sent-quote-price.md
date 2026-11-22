## 2026-11-21 — Create Invoice on a completed spray job bills the sent quote price

Mason's decision 2026-11-21 (answering Taha's Week 4 report): Transfer to Invoice on a completed field application job
bills the grower's sent quote price for that field, and the job's own price (usually list) only when there is no
sent quote for it. Contract: `docs/plans/2026-11-21-job-transfer-bills-sent-quote-price-CONTRACT.md`.

- Migration `20270207130000_job_transfer_bills_sent_quote_price.sql` (local candidate, not applied): a private helper
  asks KI-81's `_field_app_sent_quote_price_cents` (unchanged, so KI-81's quote rules apply) and re-emits
  `_transfer_job_to_invoice_intent_impl_20260908` so each chemical line uses the paying grower's sent quote price.
  When a quote priced any line, the invoice total and statement shares come from the lines. Grants, owner,
  search_path and idempotency are unchanged.
- Units (Mason, 2026-11-21, "Convert automatically"): a job line in another unit than the quote's is converted with
  exact factors within the product's form by `field_app_priced_quantity` (the converter field-app invoices already
  use; a dry product's oz is a dry ounce), then billed at the quote price rounded to the nearest cent (16 Pt at a
  $40/Gal quote = 2 Gal = $80.00). Units that can't be converted (volume vs weight, Ea, seed, unknown) stop
  (`JOB_QUOTE_UNIT_MISMATCH`). Only treated fields (acres above zero) are looked up.
- Payer (Mason, 2026-11-22): when the grower who pays for the job's fields has a sent quote that sets the price but the
  job is for another customer, Create Invoice stops (`JOB_QUOTE_PAYER_MISMATCH`) and says how to fix it. A multi-owner
  line bills quote x quantity x the owner's acres / all acres, rounded once.
- Locks (Sol round 1): the payers' quotes are locked before the job (the blend-ticket invoice's order), the job's
  fields are held while it bills (a payer added in between stops with `JOB_PAYERS_CHANGED`; try again), and each
  product row is held from the stock-unit read to the bill. The below-cost check of `20270207125000` is kept and
  judges each line at what it is actually billed.
- An all-inclusive per-acre field price still sets that grower's bill, as today (Mason, 2026-11-21).
- Typed prices (Mason, 2026-11-21): new column `job_chemicals.price_typed` (false for every existing line), stored by
  the job save (`_save_job_cost_step2_impl`, re-emitted from its live body with only that column added). A typed line
  bills its own price and is never re-priced from a quote; when the sent quote differs or can't be read, Create Invoice
  returns a plain sentence in `price_warnings`. A save that omits the mark (an older open screen) keeps it on a line
  whose product, price and unit are unchanged (and its position, when the payload has more than one such line). On a
  completed or invoiced job the marks can't change (`JOB_PRICE_MARK_LOCKED`; Mason, 2026-11-22). No backfill: every
  existing line starts unmarked.
- Screens (Mason, 2026-11-22, same PR): the job screen marks a price typed by hand ("Typed by hand: bills this price,
  not the quote") and sends the mark on save; product autofill, a unit change that clears the price and re-pricing an
  un-ticked customer-supplied line clear it. Both Create Invoice buttons (job screen, Unbilled Applications) show each
  price warning, and the Unbilled confirmation says the total can differ from "Est. $".
- Proof: `node scripts/smoke/prove-job-transfer-sent-quote-price-real-schema.mjs`
  (`JOB_TRANSFER_SENT_QUOTE_PRICE_PROOF_PASS`): 10 Gal at list $50 with a sent $42 quote bills $500.00 before and
  $420.00 after; a typed $50 bills $500.00 with a warning naming the $42 quote.
- Builds on `20270207125000` (below-cost whole line; lands first): its checks are kept in the re-emitted transfer.
- Not verified: a machine fee alongside a quote price (fee code unchanged); staging and live.
- Overlap: Taha's #2061 plans a separate double-billing change in the same function.
