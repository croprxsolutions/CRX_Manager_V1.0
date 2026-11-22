# Behavior contract: Transfer to Invoice bills the sent quote price

Read at `origin/staging` f08df8ad6 (2026-11-21). Decision: Mason, 2026-11-21 (chat, answering Taha's Week 4 report):
a completed spray job's Transfer to Invoice bills the price on the grower's sent quote for that field; list price only
when there is no sent quote for it. Field application invoices are Mason's own work (CLAUDE.md, 2026-11-06).

## Facts (source)

- `_transfer_job_to_invoice_intent_impl_20260908` (newest body `20261120100000:301`; later files only mention it) bills
  each chemical line at `safe_cents_qty(job_chemicals.price_per_unit_cents, quantity)` and never reads a quote.
  Single-owner path: header and `invoice_shares` use `jobs.total_price_cents`, not the line sum. Multi-owner path
  (more than one `field_billing_defaults` customer): each line's price is split across owners by acre share
  (`calculate_billing_splits`), and each member header is the sum of its lines.
- `job_chemicals.price_per_unit_cents` is filled by the job screen from the customer's tier (list) price
  (`JobDetail.tsx:3845`) and may be typed over (`:4661`); a job built by Schedule Job from a quote section copies the quote
  prices after the sent-price lock (`20261027040000`). A job typed directly for a quoted field carries list price.
- `job_chemicals.unit` is the unit the price and quantity are in. The job screen prices a line only when that unit equals
  the stock unit, else leaves the price blank for staff (`chemCalculator.ts:655 priceTextInLineUnit`); there is no
  stock-unit trigger on `job_chemicals` (`20270121110000` covers order, delivery and PO lines only, no conversion).
- KI-81 (`20270125163000`, `20270129140000`, `20270129180000`; live since release #1990 on 2026-11-21) built
  `_field_app_sent_quote_price_cents(product, fields, customers, on_date)`: the grower's own quote only; on one of the
  given fields; not deleted; actually sent; status sent, revised, accepted, expired, closed_by_application or
  closed_short; written on or before the date and not expired by it (Chicago dates); passes the sent-price lock;
  quote unit and sent unit must match the stock unit; a line moved or removed since sending, a product quoted on only
  some of the fields, or a non-whole-cent price stops with `QUOTE_RESEND_REQUIRED`; two different prices stop with
  `FIELD_APP_QUOTE_PRICE_CONFLICT`; none returns NULL. It returns cents per stock unit and holds the quotes FOR SHARE.
  Used today by the single and split field-app saves and the blend-ticket invoice.
- Live, read-only 2026-11-21: 0 completed-and-unbilled jobs, 1 job ever invoiced, 0 completed multi-owner jobs, 0
  completed job lines whose unit differs from the stock unit. No stored invoice is re-priced by this change.
- Escape hatch: `FieldAppSplitInvoiceEditor` bills a source job with typed prices and marks it invoiced
  (`_save_field_app_split_invoice_impl`, p_source_job_id).

## Outcome and authority

- Result: Transfer to Invoice bills each chemical line at the billed grower's sent quote price for the job's fields when
  the KI-81 lookup finds one; otherwise exactly as today (the job line's own price). Customer-supplied lines stay $0.
- Smallest change: one new migration re-emitting only `_transfer_job_to_invoice_intent_impl_20260908`, with the
  existing helper reused; no new table, column, lock or screen change. Files: the migration, its changelog.d record,
  its migrations.d record, a real-schema prover under `scripts/smoke/`, KNOWN_ISSUES/DECISION_LOG lines, this contract.
- Per line (not customer-supplied), with the job date (`jobs.job_date`, else Chicago today) as the date:
  - Single-owner: grower = the paying grower: the one `field_billing_defaults` customer of the job's fields when there
    is one (their share pays the whole job), else the job's customer; fields = all job fields.
    Quote price `q` found: line price = `safe_cents_qty(q, quantity)`, `price_source = 'quoted'`. When any line was
    quote-priced, header and shares start from the sum of the written lines, not the stored job total (figured at
    the old prices, possibly null on legacy rows); otherwise exactly as today. A per-acre all-inclusive field price
    (`price_override_cents`) still sets that grower's share, as today (Decision 5).
  - Multi-owner: each owner priced from their own quote on the job fields they have a share in; owner line =
    `safe_cents_qty(q, quantity * owner acre share)`, `'quoted'`; an owner with no quote keeps today's acre split of the
    job price for that line. (Own quote only: Mason, 2026-11-17 and 2026-11-18.)
  - Quote found but the job line's unit is not the stock unit: the quantity is converted into the stock unit with exact
    same-kind factors (fl oz/Pt/Qt/Gal; Dry oz/Lb) and billed at the quote price, rounded to the nearest cent by
    `safe_cents_qty`; units that can't be converted that way stop (Decision 3).
  - Any helper refusal stops the whole transfer, nothing written; the message tells staff to fix or resend the quote,
    or bill the job from Field Invoices and type the price.
- Cost, quantity, units, fee, commission rules unchanged; commission follows the new line profit automatically
  (computed from the written lines).
- Who may act: unchanged (admin, sales_rep; actor bound to auth.uid()). Screen sends only the job id. Grants, owner,
  SECURITY DEFINER, `search_path = public, pg_temp`, idempotency key handling unchanged; preflight pins the live body md5.
- Automatic record changes (plan-contract, #2153): (1) Create Invoice prices an untyped chemical line from the paying
  grower's sent quote instead of the job line's price; the job itself is not changed, only the new invoice's lines,
  header and shares (Mason, 2026-11-21, rules 1-4). (2) A job save that omits `price_typed` (an older open screen)
  keeps an existing mark on the line with the same product, price, unit and position instead of clearing it; it never sets a
  new mark (Luna rounds 1, 2 and 4; keeps rule 2's typed price from silently turning into a quote price). Nothing else
  changes, moves or cancels a record automatically.

## State and failure

- Always holds: a quote-sourced line equals a price the sent-price lock accepts, read under the quote FOR SHARE lock in
  the same transaction as the insert. Header = sum of shares (single) and = sum of lines + fee (each member).
- Existing rows: none change. The deployed screen keeps working; only new refusals can appear. A job built from a
  quote section usually gets the same price it already carries; if its quote was revised and not re-sent since, the
  transfer now stops (it used to bill silently).
- Timing: idempotency unchanged (same key returns the stored result). A quote re-sent while a transfer waits on the
  FOR SHARE lock is billed at the newer sent price or refused by the lock; no partial invoice.
- Undo: void the invoice as today; nothing new.

## Proof cases (real-schema replay, local, test data)

1. Job typed directly at list $50/gal, 10 gal; grower's sent quote prices that field at $42/gal → line, header, share
   $420 (before this change: $500), price_source quoted.
2. Same job, no quote → $500, price_source NULL (unchanged).
3. Same job, quote is only a draft (or declined) → $500.
4. Quote revised to $40 and not re-sent → transfer stops QUOTE_RESEND_REQUIRED, no invoice, job still completed.
5. Multi-owner 60/40 job: owner A has a sent $42 quote, B none → A's line from $42 on 6 gal = $252; B's line = 40% of
   the job price; member headers equal their lines + fee.
6. Customer-supplied line with a sent quote → $0.
7. Job line unit differs from the stock unit while a quote exists → converted: 16 Pt at a $40/Gal quote = 2 Gal = $80.00;
   10 Qt at $42 = $105.00; 3 fl oz at $42 = 98.4375 cents → $0.98. A Lb or Ea line against a per-Gal quote stops.
9. Typed price (Decision 2): typed $50 vs a $42 quote bills $500 with a warning; typed equal (also $10.50/Qt vs
   $42/Gal) gives none; a quote needing a resend still bills the typed price, with a warning.
8. Same idempotency key twice → one invoice.

## Open business decisions

1. Two sent quotes for the same field and product at different prices. Options: (a) stop and have staff type the agreed
   price on Field Invoices (Mason 2026-11-17 for the field-app invoices, "Stop, type the price"); (b) the most recently
   sent quote wins. Recommend (a): one rule for every invoice path; (b) would bill differently from the Field Invoices
   screen for the same job. **Decided (a): Mason, 2026-11-21, "1. sounds good" (relayed by the parent session).**
   **Decision 4 decided: the job line's own price (Mason, 2026-11-21, "4. yes sounds good").** Decision 5 is being
   **Decision 5 decided: as today (Mason, 2026-11-21: he never bills an all-inclusive per-acre price, "No, never").**
   **Decision 3 decided: convert automatically (Mason, 2026-11-21, "Build a unit converter").** Guard rails (parent
   session): exact factors within one kind only; whole cents by the documented rounding; anything else stops.
   **Decision 2 changed by Mason, 2026-11-21:** a price typed by hand stays and is what posts; warn when it differs
   from the sent quote. Built: `job_chemicals.price_typed` stored by the job save (Mason approved the plan 2026-11-21);
   the job screen's mark and the Unbilled Applications warning come in a follow-up screen PR.
2. A price typed on the job line itself versus the sent quote. Recommend: the sent quote wins (the job can't tell a
   typed price from the auto-filled list price); staff can still change the line on the unposted invoice afterwards.
3. Job line unit differs from the quote's (stock) unit, e.g. job in Pt, quote per Gal. Options: (a) stop and ask staff
   to put the job line in Gal or bill on Field Invoices; (b) convert the quantity. Recommend (a): the job screen and the
   stock rules already refuse to convert units; live has 0 such lines.
4. No sent quote: bill the job line's own price (today's behavior: the list price the job screen filled in, or a
   price staff typed, or the price a quote-born job copied) versus re-pricing from today's list. Recommend the job
   line's own price: smallest change, and it never undoes a price staff agreed by hand.
5. A grower with an all-inclusive $/acre field price and also a chemical quote. Recommend the $/acre price still sets
   their bill (today's rule; the chemical lines are shown at the quote price for the record).

## Cold challenge (Astra gpt-6.2-astra high, 66 findings) — settlement

- Fixed in the migration: #19 the single-owner line now reads the job quantity; #1 a quote-priced invoice's header and
  shares come from the written lines, not the stored job total (`save_job` derives that total from the same
  `safe_cents_qty(price, qty)` sum, `20260904185900:1105`, so for current jobs the two agree before quoting); #4/#5 the
  single-owner lookup uses the grower whose share pays, not the job's customer when they differ; #36 refusal text
  points at the job and Split Billing, not a non-existent invoice line.
- Inherited from KI-81, already decided by Mason 2026-11-17/18, not re-opened: which quotes count, dates and expiry
  (#22-#24), sent-price lock and resend rules (#25-#29, #47, #48), unrelated unreadable quotes stopping a grower
  (#26, fail-closed), different prices on different fields stop (#12, #13).
- Business decisions to Mason: #13 → Decision 1; #11 → Decision 2; #30-#33 → Decision 3; #8-#10 → Decision 4;
  #2/#3 → Decision 5.
- Unchanged existing behavior, out of scope (named, not fixed): quantity-1 invoice line shape (#38), commission rules
  (#45), void/rebill (#56-#58), invoice-number gaps on refusal (#54), rep scope and public wrapper (#42-#44, wrapper
  and grants untouched), idempotency (#51, #52), blend/manual race (#53), multi-owner acre proration (#15) and
  per-owner nearest-cent rounding (#14: each owner pays their own quote on their own share, rounded once).
- Proof covers: positive and negative controls, a nonzero machine fee (#18), a mismatched stored job total (#1), a
  payer different from the job's customer (#4), a refusal after other lines with nothing left behind (#55), and the
  public wrapper as a signed-in user (#42).
