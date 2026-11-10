# REG-1 Step 2 redesign: a restricted-use record points at its invoice line (behavior contract)

**Status 2026-11-10:** settled after one Astra challenge (40 findings, see the end); built. Replaces PR #1688 (parked after 13 Sol rounds, head `d8416e042`).
Facts read at `origin/main` `b291ed9ad`; nothing live was changed. Build sheet: `2026-11-06-product-REG1-BUILD-SHEET.md`.

## Why #1688 did not converge

`rup_sales_records` has no link to the invoice line it records. Posting, Sales to check, the per-registration list
and the seed each matched records to lines by an inferred key (number, unit, price, signal word, customer, order).
Every Sol round found another way that key goes wrong. This design removes the key: **a record names its line.**

## 1. Outcome and authority

**Result.** Every posted sale line captured as restricted use gets exactly one active restricted-use record at
posting, and "has a record" is a lookup of that line's id, never a match on facts. A line that becomes restricted
use after posting is listed on Sales to check for a person (recording it from the list is a later step).

**Smallest change (three files, the #1688 shape, restamped after current main):**

1. `…_epa_registration_tools.sql` — carried over from #1688 unchanged except the reason cap (max 1,000 characters,
   Sol r13 LOW) and `_epa_registration_unrecorded_posted_lines` (below).
2. `…_rup_records_by_line.sql` — replaces `…_rup_records_by_sold_number.sql`:
   - `rup_sales_records.invoice_item_id uuid REFERENCES invoice_items(id) ON DELETE SET NULL`.
   - `CHECK (invoice_item_id IS NOT NULL OR voided_at IS NOT NULL)`: an active record always has its line. Because
     the link nulls on a line delete, deleting a line that still has an active record fails on this check.
   - `UNIQUE (invoice_item_id) WHERE voided_at IS NULL`: at most one active record per line.
   - `invoice_line_rup_captures` and its save trigger: kept from #1688 as written (Mason, 2026-11-10, "Capture it
     at save"; "a Yes always wins").
   - `generate_rup_sales_records` re-issued: one record **per line** captured Yes that has no active record, with
     that line's own quantity, unit, price and amount. No grouping, no conflict matching, no duplicate handling
     (the unique index is the rule). It skips `credit_memo` invoices. The customer is the order's customer when the
     invoice has an order (unchanged; Mason's bill-split rule), otherwise the invoice's own customer (field
     applications have no order and get no record today).
   - A trigger on `rup_sales_records`: an active record's line must be on the record's invoice, with the record's
     product, and the invoice posted and not a credit memo (so the rule holds for any writer, not only posting).
   - A deferred trigger on `invoices`: at commit, an invoice that is not posted, paid or overdue, or is deleted,
     has its active records voided. `unpost_invoice` still voids its own first and reports the count; the trigger
     covers void, group void, batch void, any override and any later path without re-issuing those money functions.
   - `get_epa_sales_to_check()` and `_epa_registration_unrecorded_posted_lines`: a line is recorded when an active
     record links to it. Credit memos are never listed. The two fingerprint functions (`_rup_record_covers_line`,
     `_rup_record_for_line_key`) are not created.
   - `rup_sales_records`: INSERT, UPDATE, DELETE revoked from `anon` and `authenticated` (table and columns) and the
     admin insert policy dropped. Only the posting function writes records, so a record's line, invoice and product
     always belong together. No screen writes this table (checked: `src/` only calls `get_rup_sales_register`).
   - Q7 `invoice_items` revoke: kept from #1688.
3. `…_epa_registration_seed.sql` — carried over; still refuses while any active record exists (live: 0).

**New objects and why the existing path cannot do it.** The link column: nothing existing identifies a record's
line. The status trigger: `void_invoice` is a chain of four money functions; a trigger is smaller than re-issuing
them and also covers paths added later. The capture table: already decided.

**Who may act.** Posting: active admin or sales rep (unchanged gate inside the generator, reached only from
`post_invoice` paths). Sales to check and registration edits: active admin. Nobody writes records or captures
directly. All functions are `SECURITY DEFINER`, owned by postgres, `search_path = public, pg_temp`.

**What the screen sends.** Only the invoice id (and a retry key). The server derives lines, restricted-use answer,
number, signal word, customer, quantity and amounts.

## 2. Invoice types and lifecycle (the full checklist)

| Case | Rule | Enforced by |
|---|---|---|
| `chemical_sale` posted | one record per Yes line | generator |
| `field_application` posted | one record per Yes line, under the invoice's customer (Mason, 2026-11-10) | generator |
| `misc_charge` posted | lines have no product: nothing | generator reads product lines only |
| `credit_memo` (born posted, lines negative) | never creates or needs a record; never on Sales to check; the original sale's record is untouched (Mason, 2026-11-10) | generator and both lists exclude the type |
| Bill-split payer invoice (chemical sale) | each payer invoice records its own lines, naming the order's customer | generator (unchanged rule) |
| Field-application split member | each member invoice records its own lines under its own customer | generator |
| Two lines of one product on one invoice | two records (today only the first line is recorded) | per-line insert |
| Posted, paid or overdue lines edited | quantity, product, price, unit and number cannot change (only cost and tote fields can): `trg_refuse_posted_invoice_child_write`; save-versus-post serialization stays deferral #18 | existing trigger |
| Unpost (posted/overdue → unposted) | records voided, count in receipt and audit | `unpost_invoice` (unchanged) |
| Edit while unposted (lines deleted and rebuilt) | voided records keep their text and lose the link; new lines are captured again | FK `SET NULL`; capture trigger |
| Re-post | a fresh record per Yes line; voided ones are ignored | generator + unique index |
| Void (posted/paid/overdue → voided), single, group or batch | records voided at commit, reason "Invoice <number> voided" (Mason, 2026-11-10) | new deferred trigger |
| A zero or negative line on a sale | not a sale to record; never listed | generator and lists read `quantity > 0` |
| Cancel a draft | never had active records | — |
| Delete (draft, unposted or voided only) | no active record can exist; the trigger also voids on `deleted_at` | status trigger |
| paid ↔ posted ↔ overdue | records unchanged | trigger ignores these |
| Second post / retry / two people posting at once | invoice row lock, then "no active record for this line"; unique index refuses a race | generator |

**Rules that always hold.**
- An active record has a line, and that line is on the record's invoice with the record's product.
- A line has at most one active record.
- An active record's invoice is posted, paid or overdue, not deleted, and not a credit memo.
- All inside the posting or status-change transaction; nothing outside it.

**Existing rows.** Live 2026-11-10: 0 restricted-use records, 6 posted product lines on 3 invoices. Mason,
2026-11-10: *"we will not make sales before it is turned on so it doesnt matter this is not a live active SAAS"*.
So: no backfill of links; the migration refuses if any record exists with no line (`SELECT count(*) FROM
rup_sales_records` expected 0 at apply). Lines already posted at the seed get no special listing (`posted_before_seed` is dropped: it could never be
cleared, and old data is out of scope); they are judged like any other line from the seed day's capture. Before the seed runs, posting keeps today's rule and
writes the link for the line it records. The deployed app keeps working: `post_invoice` and
`get_rup_sales_register` signatures and columns are unchanged (one added column).

**Timing (at the generator; `post_invoice`'s own replay is unchanged and calls it without a key).** A second call
for a posted invoice finds every line already recorded and writes 0; the same key returns the stored count, and
only for the same invoice. Two calls at once queue on the invoice row; the unique index is the backstop. A registration edit
during posting: the shared REG-1 lock, as in #1688.

**Undo and history.** Voided records keep `voided_at`, `voided_by`, `void_reason` and every sale fact as text. A
record voided by the status trigger says which status the invoice moved to. A repeated void does nothing.

## 3. Delivery

Database only, one PR targeting `main`, replacing #1688 (closed with a pointer to the new PR). No screen depends
on it yet. Recovery: a forward migration; the link column and captures stay.

## 4. Proof cases (Docker prover on the real schema, fail-then-pass)

1. When a chemical sale with two Yes lines of one product at one price is posted, then two active records exist, each linked to its own line.
2. When that invoice is posted again (no key), then 0 new records; with the same key, the first count is returned; the same key on another invoice is refused.
3. When a posted invoice is unposted, then its records are voided and the receipt counts them; re-saved and re-posted, then new active records link to the new lines and the voided ones have no line.
4. When a posted invoice is voided (single and group), then its records are voided with the reason; when it is then deleted, nothing changes.
5. When a return credit is issued against a restricted-use sale, then no record is written, the original record is unchanged, and Sales to check does not list the credit lines.
6. When a field-application invoice with a Yes line and no order is posted, then one record exists under the invoice's customer.
7. When a bill-split group is posted, then each payer invoice has its own linked records naming the order's customer.
8. When a line is captured No and any Yes applies now (its number's registration, its size's tick, or the number its size carries today), then Sales to check lists it (`now_restricted_use`); a Yes line with a record and a number is not listed; a Yes line whose record was voided by hand is listed.
9. When a label changes between save and post, then posting records what was captured at save.
10. When a second active record for one line is inserted, or an active record is given no line, or a line with an active record is deleted (all as postgres), then each is refused.
11. When `authenticated` (admin included) inserts, updates or deletes a record directly, then it is refused; an applicator calling the generator is refused.
12. When the migration is applied to a database holding a record with no line, then it refuses.
13. Carried from #1688's prover: registration edit, reason required and capped, `infinity` dates, seed preview/seed/locks, grants.

## Decisions (Mason, 2026-11-10, this session)

1. Return credits never create or need a restricted-use record.
2. Voiding an invoice voids its restricted-use records.
3. Field-application invoices get restricted-use records.
4. No sales before switch-on; old data is out of scope (quoted above).

Earlier #1688 decisions that stand: capture at save; a Yes always wins; any Yes records it; the product's own
number; "Unit not set"; the seed refuses while records exist; reason required. Made moot by the link: every rule
about which record "covers" a line (Sol r1, r6, r7, r12 customer-and-order match, duplicate handling).

## Accepted deferrals carried over

Old count-only replay receipts; KI #15 "Unit not set"; #18 posted-child serialization; #20 generator returns 0 on
a missing invoice; #22 rollback is a forward repair; #24 licence pick with a NULL expiry; seed lock timeout;
BRAND-PRB sheet stamps; list paging; delete-and-rebuild saves capture again; a product change resets a Yes; KI-117.

## Astra challenge (gpt-6-astra, high, 2026-11-10): 40 findings, settled

Corrected in the design: the record/line/invoice/product rule is a database trigger, not a writer convention (2, 3);
one deferred trigger covers every exit from posted, `unposted` included (7, 40); Sales to check and the
per-registration list also read the product's number today (19); `posted_before_seed` dropped (17); zero and
negative lines are not sales (22); customer precedence is by invoice type (24); the seed's rollback note keeps the
run row and captures (34); a plain index on the link (39); wording of the guarantee, retries and posted-line edits
(8, 9, 11, 18, 20); file 1 keeps its #1688 helper and file 2 re-issues it after the column exists (1).

Disproved or covered by evidence: every sale-posting path calls the generator
(`_post_invoice_impl_20260714` at `20260702160000:139`, used by single, group and batch post; the deleted-delivery
recovery post at `20260721014858:598`) (6); the generator is callable directly by a signed-in admin or rep and that
is safe, because it only writes records the posted invoice should have (5); `src/` reads records only through
`get_rup_sales_register`, unaggregated (38, 27); effective privileges are asserted in the migration's postflight (4);
the constraint and the preflight under a table lock refuse a database holding an active record (28).

Named proof cases: 37 (void, delete, override exit, unpost count) is case 15; 10 (header changes after posting)
— a record is a snapshot of the sale as posted.

Not reopened (already decided or deferred): no number and no tick means No (21, Mason 2026-11-09); a missing
capture is captured at posting (25); record date and season follow the invoice date for every type (23); retry-key
cycles and helper concurrency are the existing idempotency design (12, 13, 14); seed default, picks, invalid-number
handling, lock timeout and the switch-on run are the seed's own carried-over behaviour: the feature is installed by
this PR and switched on only when an admin runs the seed (29–33, 35); a correction tool for a line that turns
restricted use after posting is the named later step (15, 16); void attribution is the acting user and the status
text, with the invoice's own audit event (36); captures on save paths are #1688's proven behaviour (26).
