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
  exact same-kind factors (fl oz/Pt/Qt/Gal; Dry oz/Lb) by `_job_transfer_qty_in_stock_unit_20270207`, then billed at
  the quote price rounded to the nearest cent (16 Pt at a $40/Gal quote = 2 Gal = $80.00). Units that can't be
  converted that way (volume vs weight, Ea, grams, unknown) stop (`JOB_QUOTE_UNIT_MISMATCH`).
- An all-inclusive per-acre field price still sets that grower's bill, as today (Mason, 2026-11-21).
- Typed prices (Mason, 2026-11-21): new column `job_chemicals.price_typed` (false for every existing line), stored by
  the job save (`_save_job_cost_step2_impl`, re-emitted from its live body with only that column added). A typed line
  bills its own price and is never re-priced from a quote; when the sent quote differs or can't be read, Create Invoice
  returns a plain sentence in `price_warnings`. A save that omits the mark (an older open screen) keeps it on a line
  whose product, price, unit and position are unchanged. The screens that set the mark and show the warning are a follow-up PR; until
  it lands, no line is marked, so every line with a sent quote bills the quote price.
- Proof: `node scripts/smoke/prove-job-transfer-sent-quote-price-real-schema.mjs`
  (`JOB_TRANSFER_SENT_QUOTE_PRICE_PROOF_PASS`): 10 Gal at list $50 with a sent $42 quote bills $500.00 before and
  $420.00 after; a typed $50 bills $500.00 with a warning naming the $42 quote.
- Not changed: a customer-supplied $0 line already meets the below-cost wall on Create Invoice
  (`BELOW_COST_CONTEXT_REQUIRED`) before and after this change. The same wall compares a job line's whole total
  (written as quantity 1) with the cost of ONE stock unit, so a small line (e.g. 3 fl oz, or half a gallon) is refused
  too. Both are live today (live `_enforce_below_cost_line` md5 1069cd14... = main's); a follow-up, not this change.
- Not verified: the screen (the Unbilled Applications "Est. $" still shows the job's own total, a follow-up); a
  machine fee alongside a quote price (fee code unchanged); staging and live.
- Overlap: Taha's #2061 plans a separate double-billing change in the same function.
