# Behavior contract: field billing from sprayed work

**Master copy (2026-11-24).** Self-contained: replaces FP-5a and FP-5c of the 2026-11-08 build sheet and every earlier draft of this file (git history keeps them). Newest answers only. Business rules: `SPEC.md` stages 8–10 and section 9; numbers: `SCENARIOS.md` + `scenarios-calc.py`; who pays: `CONTRACT-who-pays.md`; order and gates: `BUILD-PLAN.md`.

## Facts (checked in code)

- Four routes bill field work today with different math (KI-198): the field-app location save, the per-line Split Billing save, the job transfer (`transfer_job_to_invoice`) and the blend-ticket invoice.
- The job route bills **planned** acres (`job_fields.acres_to_treat`, KI-185).
- The per-line engine (`field_app_billing_sets`, `field_app_billing_lines`, `invoice_line_shares`, `compute_line_split_allocation`, `20260720214000`) is live and switched on but has never billed a real invoice. Its split is largest-remainder, which is **not** the chemical-sale rule.
- Chemical-sale split invoices (`_bill_split_line_shares`, `20261215110000`, applied 2026-11-09): every payer except the main customer is floored to the cent, the main customer takes the rest; if the main customer has 0%, the largest share takes it; quantity floored to 0.01 the same way (4 decimals for a share under 0.01); ties for the largest share by lowest customer id; credits floor every other share away from zero; groups post and unpost together. Chemical sales also have a per-sale tax checkbox, off by default (`20270109100200`).
- A rep can post only their own invoices today; Split Billing creates zero-dollar payer invoices.
- The emailed invoice PDF is built in the `send-email` Edge Function; changing it needs an Edge Function deploy (Mason's yes).

## The rules

| # | Rule | Source |
|---|---|---|
| B1 | Invoices are made **only when the job is closed**: every field has acres recorded or closed, and every load it shares with another job is settled (S16). The office can force a shared load with a reason | G2, Sol 6 |
| B2 | Each field bills **sprayed acres**; each product at the rate of **the load(s) that sprayed that field**, summed per field (S4, S4b). Each real pass bills its own service and fuel acres (M8). Never planned acres | D1, Sol 4/5, M5, M8 |
| B3 | **Money the chemical-sale way** (Mason 2026-11-24): (1) each product, and service and fuel, is priced **once per job**, total quantity × price rounded half up once, so the job never bills more or less than quantity × price; (2) that total is shared across the fields by quantity (acres for service and fuel): every field but the one with the most is floored to the cent, that one takes the rest (ties: earlier in spray order); (3) each field line is shared across its payers by `_bill_split_line_shares`'s rule with **the job's customer as main customer**, quantity at hundredths (4 decimals for a share under 0.01), ties by lowest customer id, credits floored away from zero, all as live. Built as a new field allocator that mirrors `_bill_split_line_shares`, with a test that both give the same cents on the same inputs. Pins: 1 gal at 10.01 over two equal fields = 5.01 + 5.00; thirds of 603.75 = 201.27 / 201.24 / 201.24 | SPEC 9; SCENARIOS rules 1–4, S30 |
| B4 | **No flat fee lines** on job-sourced field invoices; refused by the server | Sol 67 |
| B5 | Each dated work entry uses the field split in force on its Central spray date; a field sprayed across a split change gets one line per split (S7); the field's part is shared across those lines the round-down way, the larger line taking the rest. Products use **product shares**, service and fuel **application shares**. Precedence: job office split (with reason) → field split on the spray date → 100% to the grower the field was added under | Q3, Sol 41, A1, GR5 |
| B6 | Locked quote or booking prices carry forward; any other price is the product's price on the job's **first spray day** (Central date of the first entry with acres above zero), **one price per product per job**. A substitute with no price holds the whole payer set until priced (M9). A correction that moves the first spray day flags open invoices; it does not reprice them | Sol 66, M2, M9, S8 |
| B7 | No zero-dollar invoices: a payer whose lines are all zero gets none. Customer's own / already paid lines print at zero on a payer's invoice only if that payer has a priced line (S9, S10) | Sol 75, Sol 34 |
| B8 | **No sales tax** on field invoices and no tax checkbox (chemical sales have one; field work does not) | Sol 48; Mason 2026-11-24 "Keep no tax" |
| B9 | Any admin or sales rep may open, save, refresh and post a **field** payer set; commission per payer invoice comes from that payer's customer rep, worked out by the existing formula on that invoice's own profit, snapshotted at posting | F2, Sol 74 |
| B10 | Invoice date defaults to the posting day (Central); the office may set an earlier one; the month-close check uses the invoice date; each payer's due date follows their terms (S28) | GR7 |
| B11 | Posted correction: while no payment, prepay, credit or write-off is on any invoice in the set and the month is open, unpost the whole set, fix, repost; any invoice whose printed amount changes is marked **"Corrected"** (the office chooses whether to re-send); the original posted version stays readable. After money or month close: credit and rebill **only the invoices whose dollars changed**. Because of B3 step 2, a correction on one field can move a cent on another field's invoice (S24, S25) | D9, Q10, M3 |
| B12 | Correcting a spray record after posting flags the invoices whose amounts would change or that carry that field; it never changes them (S26). The office correction has its own narrow permission; `JOB_INVOICED_LOCKED` stays for everyone else | Sol 47 |
| B13 | A hand-typed invoice for the same field, spray day and product as a job warns (note optional); billing the same job twice is refused (S29) | B04 |
| B14 | **Billing switch-on date** (Mason 2026-11-24): an office setting holds the date CRX starts billing field work. Work sprayed before it is billed in Chem Man and marked so (`job_external_billings`, `CONTRACT-who-pays.md` FP-4); CRX refuses to bill a marked job or an entry dated before the switch-on date unless the office removes the mark with a reason (S31) | M5, GR11 |

**Spring, not February:** one-click "bill actual used" per load (G5; S5); per-payer prices on one field (M2); blend-ticket invoices on this engine; orders and deliveries reading field shares.

## Every route after the engine lands

| Record or route | Rule |
|---|---|
| New job invoices (`transfer_job_to_invoice`) | This engine (B1–B14) |
| Per-line Split Billing save on a job-sourced invoice | Same engine; edits re-checked on the server |
| Converted old drafts (`legacy_fixed`) and hand-typed invoices (no job) | Keep today's per-line rules; editable; hand-typed field work warns on overlap (B13) |
| Field-app location save | Retired; refuses with a pointer to the job route |
| Blend-ticket invoice | Refused for **batch-path** jobs; unchanged for others until spring |
| Work before the switch-on date | Billed in Chem Man; never billed in CRX (B14) |

## Storage

- **One field per billing line:** `field_app_billing_lines` gains `field_id`; a product over two fields is two lines, grouped under one heading on screen and PDF. A line with no single field (converted old lines) has `field_id` blank and is never re-split from a field.
- **Draft tables** (RLS, policies, grants in the same migration; office read; writes by RPC only; no applicator or `anon` access):
  - `field_app_billing_line_sources`: line, field, acres, spray date, source (`field_version` with version id, `job_override`, `legacy`, `grower_fallback`, `legacy_fixed`) and the full source payer list with both share sets.
  - `field_app_billing_line_payers`: line, customer, micro-percent, override reason, `hand_edited`. This is the draft's source of truth; `invoice_items` and `invoice_line_shares` are regenerated from it on every save.
- **Stable line ids:** saves update lines in place, insert only new ones, delete only lines the office removed (today every save deletes and re-inserts).
- **Posted record:** the append-only `invoice_line_share_snapshots` gains a **post revision** and, per line and payer, field, spray date, source and version, the full eligible set, override reasons, quantity and cents. Each post is a new revision; credits point at the revision they reverse.
- **Refresh log** `field_split_refresh_log`: per refreshed line, payers and shares before and after, scope, who, when, why. `refresh_split` gains its `invoice_draft` mode; nothing else re-reads a field's split for an existing draft.
- **Payer eligibility** (Q1): each line's eligible set is the payers in its snapshot; any of them may be re-weighted, including from 0% back up; a payer outside it is added to the field first, then brought in by a logged refresh.
- **Credits** reverse the named posted revision's remaining cents per line and payer, reduced under a row lock, so two half-returns of a 1-cent line refund 1 cent in total. The replacement links to the invoice it replaces; the job's one-bill link moves in the same transaction, so the job is never billable twice and never stuck.

## Authority and timing

- Invoice creation: admin or sales rep. The server checks B1 and the one-bill-per-job link under a row lock on the job, so two transfers with different keys create one set. A retry with the same key returns the same set. A set is created in one transaction: all payers or none.
- Edits before posting: admin or sales rep, with a reason on price, quantity and date edits. Each override (share, quantity, price, invoice date) is a named field the server checks; prices, acres, rates and eligibility are derived on the server, never trusted from the screen.
- A save regenerates set membership (a payer who drops to zero loses their invoice; one who gains a cent gets one). Editing is **set-level**: the screen sends the set revision it read; an older one is refused ("someone else changed this; reload") (S23).
- **Sets move together:** save, refresh, unpost and delete lock the whole set and are refused if any invoice in it is paid, credited or voided. Posting is all-or-nothing (S22). Unpost re-checks payments, prepays, credits, write-offs, voids and month close inside the same transaction, under posting's locks.
- **Posting:** a **separate post function for field sets**, so Taha's chemical post path is not rewritten; the shared single-invoice post functions (`post_invoice`, `post_invoice_group`, batch posting) gain one refusal: a member of a field set posts only through the set. That one refusal touches Taha's functions: built in a window agreed with Mason and Taha, with Taha's review.

## Old records at cutover

Unposted location-engine and job-transfer drafts (cutover inventory) are converted **cent for cent** to per-line drafts marked `legacy_fixed`: each payer invoice's lines billed 100% to that payer at their existing cents; a line keeps a field only when the old record names exactly one. A save never re-prices a `legacy_fixed` line until the office refreshes it. A draft whose lines do not add up to its payer totals, or a shared-header job draft with several `invoice_shares`, is not converted: the cutover stops until the office deletes and re-creates it. Proof compares invoice numbers, payer, every line's quantity, unit, price, cents and cost, due date, season, dates and links before and after. The same migration replaces the old engines' functions with refusals, so no old-style draft appears after the count. Posted old invoices stay as they are; one unposted later converts inside the unpost.

## Posting switch

| `split_field_invoice_posting_enabled` | Behavior |
|---|---|
| Off (production until the switch-on date) | Field invoices can be made and edited; posting a field set is refused; single-payer legacy posts unchanged |
| On, staging | Turned on when the posting PR lands, so posting, unpost and rebill are proven there first |
| On, production | Only with Mason's yes in the conversation, on the switch-on date; the first real multi-payer job is checked by hand before anyone posts it (D12) |

Direct writes on `field_app_location_shares` and `invoice_shares` are revoked in the engine PR. `I approve`.

## After posting

No new engine; prove and fix the paths after posting with one **ledger journey**: a multi-payer job → posted payer invoices → each payer's PDF and invoice detail (only their lines; "Shared with"; field total and your share) → balance and aging → a payment to one payer only → that payer's statement → a return credit and a void → one payer's prepay applied to their own invoice only. Inventory every reader first (`InvoiceDetail.tsx`, `Invoices.tsx`, the field invoice panels, `fieldInvoiceList.ts`, `invoiceBatchPosting.ts`, `splitGroupPostChecks.ts`, the PDF builder, statements, AR aging, commission). Commission across all payer invoices equals what the same work earns as one invoice; unpost and repost do not add a second commission record.

## Proof cases

Every money scenario in `SCENARIOS.md` (S1–S4b, S6–S10, S20, S22–S26, S28–S31) becomes a SQL test as the real caller on a migrated database, expected cents from the tables, plus:

1. A job with an unsettled field: invoice creation refused with a plain message.
2. A `flat_fee` line on a job-sourced invoice: refused; on a hand-typed invoice: allowed.
3. A rep who is not the customer's rep makes, edits and posts a field set; each payer invoice's commission goes to that payer's rep.
4. A rep posting another rep's **chemical** invoice: refused as today.
5. One invoice in a set cannot post: none post.
6. Two transfers of the same job with different keys at once: one set.
7. Single-invoice post of a field set member: refused.
8. Unpost racing a payment: one wins, no half state.
9. Credit and rebill after a timeout between steps: the retry finishes; the job is billed once.
10. Field allocator and `_bill_split_line_shares` give the same cents for the same line, shares and main customer (1 cent over thirds; −1 cent; main at 0%; 70/30 and 30/70 of 3 cents).
11. A re-save keeps every line id and every hand edit.
12. A marked (billed in Chem Man) job and an entry before the switch-on date: refused.
