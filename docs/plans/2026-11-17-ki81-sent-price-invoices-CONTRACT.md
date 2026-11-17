# KI-81 behavior contract: invoices bill the price the customer was sent

Read at `origin/staging` 10070370e (2026-11-17). Decision: Mason, 2026-11-17 (DECISION_LOG, PR #1936): fix now, Claude builds it.

## Facts (source)

- The sent-price lock `_assert_quote_prices_as_sent(quote_id)` (newest body `20261101100000`) passes a never-sent quote,
  and otherwise refuses (`QUOTE_RESEND_REQUIRED`) unless every current line price equals the last sent version's price
  or is the latest change `save_quote` recorded since that send (`20261029120000`). Convert, Partial Order and Schedule
  Job call it under the quote row lock.
- Blend invoice `create_invoice_from_blend_ticket` (newest `20261022020000`) prices lines from the job's own quote
  section (same customer, not deleted, the job's quote), reading `quote_items.price_per_unit` live. It never calls the lock.
- Single field-app invoice `_save_field_app_invoice_impl_20260714` (newest `20270120150000`) prices a billed chemical
  from `quote_items` joined to any section on one of the invoice's fields: no customer, status, deleted, season or
  expiry filter, `ORDER BY qi.id LIMIT 1` (random over UUIDs). Same lookup in `resolve_field_app_chemical_price`
  (`20260720233000`), used by the split-bill save `_save_field_app_split_invoice_impl` (newest `20261204100000`).
- Live, read-only 2026-11-17: 0 field-app lines ever priced `quoted`; 0 blend-ticket invoices; 0 field/product pairs
  on more than one quote; 0 split billing sets; every quote has `season` NULL (so a season filter must come from
  dates, not that column). Existing invoices are stored lines and are never re-priced by this change.
- Quote statuses (registry): draft, sent, revised, accepted, declined, expired, cancelled, closed_by_application,
  closed_short. Quotes expire at season end (`20261029100000`).

## Outcome and authority

- Business result: an invoice that takes a price from a quote takes only a price the customer was sent (or an
  approved change recorded since the send). Otherwise it refuses with "send the quote again", like Convert.
- Smallest change: one migration, no new table or column, no screen change.
  1. New private helper `_field_app_sent_quote_price_cents(product, field_ids, customer_ids, on_date)`: finds the
     eligible quote lines (below), locks those quotes (FOR SHARE, id order), runs the lock on each, and returns the
     one price in cents; NULL when none; refuses when eligible quotes disagree.
  2. `resolve_field_app_chemical_price` takes the billing customers and the application date and uses (1).
  3. The single and split field-app saves use (1)/(2) once per billed grower; nothing else in their bodies changes.
  5. The invoice screen's preview (`_preview_field_app_invoice_split_impl_20260908`) picks the same quotes per grower
     through the shared `_field_app_quote_eligible`, so the preview shows what the save bills (Sol round 2).
  4. The blend invoice locks the job's quote row and runs the lock before any price is read or invoice number drawn.
- Eligible quote (field-app): its customer is the grower being billed (Mason, 2026-11-17, "Own quote only": on a
  shared field each grower pays their own quoted price, else the price list; a co-owner's quote never prices
  another grower's share); not deleted; it was actually sent (has a sent version);
  status sent, revised, accepted, expired, closed_by_application or closed_short (not draft, declined, cancelled);
  not expired before the application date (Chicago date; falls back to the invoice date, then today) and expiring
  in that date's season.
- Who may act: unchanged (admins and reps through the existing wrappers). Every price stays server-derived; the screen
  sends only ids and a manual override, which still wins as today.
- Files: `supabase/migrations/20270123100000_ki81_invoices_bill_sent_quote_price.sql`, its ledger and
  migrations.d record, a real-schema prover + reverse script under `scripts/smoke/`, KNOWN_ISSUES, this contract.

## State and failure

- Rules that always hold: a quote-sourced invoice price equals a price the lock accepts, read in the same transaction
  that holds the quote lock, so a concurrent `save_quote`/send cannot change it between check and insert.
- Existing rows: none change. Writes from the deployed app keep working: the public RPCs keep their names and
  arguments (only the private `resolve_field_app_chemical_price`, callable by no API role, gains two inputs and
  becomes VOLATILE because it now takes row locks); only new refusals (QUOTE_RESEND_REQUIRED,
  FIELD_APP_QUOTE_PRICE_CONFLICT) can appear, with plain-English messages.
- Editing an existing draft field-app invoice re-prices its lines today (the save rebuilds them); after this change
  that rebuild uses the new rule, so an edit can now refuse or move a line from "quoted" to the price list. Live has
  0 quoted field-app lines (3 field-app invoices), so no current invoice changes; this is the intended rule going forward.
- Blend invoices follow the lock exactly as Convert and Schedule Job do: a never-sent (draft) job quote still prices
  the blend (Mason, 2026-10-13/14: a draft keeps its own prices). The field-app rule is narrower because its lookup
  is not tied to a quote staff chose (Mason's 2026-11-17 answer 1).
- Timing: a retry or double click runs the existing idempotency of each save unchanged; a quote re-sent in between
  is simply the newer sent price. Locks: field-app saves take FOR SHARE on eligible quotes (shared locks never block
  each other, so two invoice saves cannot deadlock on quotes); the blend invoice takes FOR UPDATE on its one job quote.
  `save_quote` and the send path lock one quote and never wait on invoices, blend tickets or fields, so no cycle with
  either invoice path. Proof case 9 runs a save_quote against a held field-app save.
- Undo: nothing new; a refused save writes nothing.

## Delivery

Database only, one PR to `staging`; the screens already show server errors. No screen depends on it.

## Proof cases (real-schema prover, local Docker, test data)

1. When a field-app chemical is on the customer's sent quote at the sent price, then the line bills that price, source quoted.
2. When the quote's price was changed after sending and not re-sent (no recorded change), then the save refuses QUOTE_RESEND_REQUIRED and writes nothing.
3. When the price change was recorded by save_quote since the send, then it bills the new price.
4. When the only quote on the field is a draft, declined, cancelled or deleted quote, or another customer's, or expired before the application date, then it bills the tier price.
5. When two eligible quotes list the product on the field at different prices, then it refuses FIELD_APP_QUOTE_PRICE_CONFLICT; a manual price saves.
6. Split-bill save: cases 1, 2 and 4 through `_save_field_app_split_invoice_impl`.
7. Blend invoice: the job's quote re-priced and not re-sent refuses QUOTE_RESEND_REQUIRED; sent price bills; never-sent quote bills as today.
9. When a field-app save holds a quote and save_quote edits that quote's price at once, then save_quote waits and the invoice bills the sent price.
8. Rollback script restores all five bodies byte-identical (md5).
10. Own quote only: on a shared field only grower B has a sent quote; B bills it, A bills A's tier (single and split saves).
11. The preview shows each grower the price the save bills, and never a draft quote's price.

## Cold challenge (Astra, gpt-6-astra high, 2026-11-17: 37 findings) — settled

Changed because of it:
- Season bound (7): an eligible quote also expires in the application date's season (quotes expire at season end),
  so a next season's quote never prices a backdated application. Expiry (a calendar date) is inclusive; a NULL
  expiry counts (live: 0 quotes have none) (8).
- One answer per transaction (21, 37): the helper records its first answer for the same inputs; every later call
  in that transaction recomputes and refuses `FIELD_APP_QUOTE_PRICE_CHANGED` ("save again") if the answer moved, so
  the split save, which asks once per grower, cannot price one grower from a quote sent mid-save. The record can
  only refuse, never supply a price (Luna round 2: a planted record refuses; proof case F6).
- A quote sent by another user while a save runs, after the save chose its quotes (Luna round 2), is not part of that
  save: the result equals the save committing just before that send, a price the customer was sent.
- Negative quote prices are ignored, as the blend path already does (4); cent scale and finiteness are a table
  constraint (`quote_items_price_per_unit_cent_scale_chk`); live has 0 bad prices.
- Wording: the lock's rules are as in Facts (a raise also needs the grower tick) (1); the draft job quote is the
  stated exception (2); conflict covers two lines of one quote too (3); the split save's existing rules stay — it
  refuses an unresolved or $0 price and a $0 manual price, so "tier price" means each path's existing fallback (5, 6).

Settled by evidence or an existing decision (no change):
- Whole-quote lock (12, 13): the blend invoice bills from the job's own quote, exactly the quote Convert and Schedule
  Job check whole (Mason, 2026-10-14: the lock covers every price on the quote); it refuses before any number is drawn.
- Billing customers (10, 11): superseded by Mason's answer 3 (own quote only, after Sol round 2); the lock compares
  line, product and price, not the field (Mason's 2026-11-17 answer 1 is about which quotes, not which field).
- Dates (9): single save reads `invoice_date`; split reads the job date, then `invoice_date`, then Chicago today.
- Locks (20, 22, 23): FOR SHARE re-checks the quote row's conditions after any wait (PostgreSQL re-evaluation), and
  the prices are read by a later statement; the blend path locks the job (existing) and the quote before its section,
  the order save_quote uses. Proof case 9.
- Live, read-only 2026-11-17: 0 quote lines whose section belongs to another quote (14); `products.product_name` is
  NOT NULL (15); 4 eligible-status sent quotes, 1 with an untrusted last version, which refuses "send again", the safe
  outcome (16, 31); 0 draft field-app invoices; 0 unbilled blend tickets on quote jobs (31).
- Outside this change, owned by the existing send workflow and lock (17, 18, 19), the wrappers' role checks (27), the
  screens (29, 30: the server already chose the quote price; messages say what to do, and a typed price saves),
  idempotency (24) and transaction atomicity (25; invoice-number gaps already happen on any refused save).
- Grants and rollback (26, 28, 34): the prover checks the helper and the new resolver are closed to API roles, only
  one resolver signature exists, and the reverse restores all five bodies byte-identical, the old resolver closed,
  and the helper dropped. Undo of a successful draft re-price (35) is a normal draft edit. Rollout (36): staging-first
  release flow. Audit references on invoice lines (33): not needed for this fix.

## Open business decisions

Mason, 2026-11-17 (in session):
1. Which quotes price a field-application chemical: "Sent + not expired" (the eligible-quote rule above).
2. Two eligible quotes disagree on the price: "Stop, type the price" (FIELD_APP_QUOTE_PRICE_CONFLICT; the manual price saves).
3. Shared field, one grower's quote (Sol round 2): "Own quote only": each grower pays a quoted price only from a quote
   sent to them; otherwise the price list.

## Sol round 2 (2026-11-17)

- The preview read the old lookup, so it could show a price the save would not bill: it now uses the same eligibility.
- One grower's quote priced another grower's share (and, in the single save, a skipped deleted recipient's quote could
  price the others): pricing is now per grower, so both go away.
- The preview runs no sent-price lock (it is read-only); a quote changed and not re-sent previews its current price and
  the save refuses "send the quote again", which is the message the grower-facing step needs.
