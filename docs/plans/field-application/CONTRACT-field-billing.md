# Behavior contract: field billing from sprayed work (wave items 4.1 and 5.1)

**Status: DRAFT, Sol round 1 folded in (2026-11-24).** A **change set on top of FP-5a and FP-5c** in `docs/plans/2026-11-08-fields-who-pays-BUILD-SHEET.md` (reviewed by Sol four times, by Opus and by Astra). Everything in those packages stands unless a line below replaces it; wave item 0.3 folds these changes into the build sheet before 4.1 starts. Design source: `SPEC.md` stages 8–10; numbers: `SCENARIOS.md`. Sol finding numbers are in `SOL-KIT-REVIEW.md`.

## Facts (with sources)

- Four routes bill field work today with different math (GAP-CHECK row 62, KI-198): the field-app location save, the per-line Split Billing save, the job transfer (`transfer_job_to_invoice`), and the blend-ticket invoice.
- The per-line engine (`compute_line_split_allocation`, `20260720214000`) splits by micro-percent with the largest-remainder method, ties by customer id, and supports `chemical`, `service`, `fuel_surcharge` and `flat_fee` lines.
- The job route bills **planned** acres (`job_fields.acres_to_treat`; GAP-CHECK row 50, KI-185).
- A rep can post only their own invoices; a typed-up invoice goes under the saving rep with no commission (GAP-CHECK row 59).
- Split Billing creates zero-dollar payer invoices (GAP-CHECK row 51).
- The emailed invoice PDF is built in the `send-email` Edge Function; changing it needs an Edge Function deploy (Mason's yes).

## Changes to FP-5a / FP-5c

| # | FP sheet says | This contract says | Source |
|---|---|---|---|
| B1 | Drafts can be made from a job at any time | Drafts are made **only when every field of the job is settled** (acres recorded or closed) and every load it shares with another job is settled (S16) | G2, SPEC 9.1 |
| B2 | Quantity from the job's planned acres | Each field bills **sprayed acres**; each product at the rate of **the load(s) that sprayed that field**, summed per field (S4, S4b) | D1, Sol 4/5 |
| B3 | Leftover cent to the line's **primary payer**; "1 gal at 10.01 over two equal fields bills 10.01" | **Each field line is priced on its own** (quantity × price, rounded once), so a corrected field never moves another field's cents (S24). Split: largest remainder, ties to the bigger share, then payer rank; never a 0% payer. FP-5a's 10.01 pin becomes 5.01 + 5.01 | Sol kit 001, SCENARIOS rules 1–2; **M1** |
| B4 | Flat fee lines allowed | **No flat fee lines on job-sourced field drafts**; refused by the server | Sol 67 |
| B5 | Billing date = the job's legal application date | Each **dated work entry** picks the field split in force on its Central spray date; a field sprayed across a split change gets one line per split, each priced on its own acres (S7) | Sol kit 068 |
| B6 | Price as the job's quote prices, refresh logged | Locked quote or booking prices carry forward; an unlocked price is the product's price on the job's **first spray day** (Central date of the first work entry with acres above zero) for every field. A substitute with no price that day is flagged and blocks posting until priced. If a correction moves the first spray day, open drafts are flagged, not repriced | Sol 66, kit 072, S8 |
| B7 | — | "**Bill actual used**" is an office choice per load: it replaces that load's rate for every field it sprayed. For a load shared by two jobs, it is chosen once on the load, not per job (S5) | G5, Sol 39, kit 071 |
| B8 | A payer at 0% may still get an invoice | **No zero-dollar invoices**: a payer whose lines are all zero gets none. A payer with only customer-supplied zero-price lines still gets the lines printed on their invoice if they have any priced line; otherwise none (S9, S10) | Sol 75, kit 074 |
| B9 | No tax rule stated | **No sales tax** on field drafts | Sol 48 |
| B10 | Posting by the invoice's rep | **Any admin or any sales rep may open, save, refresh and post a field payer set** (field sets only); commission per payer invoice comes from that payer's customer rep, snapshotted at posting | F2, Sol 74, kit 079, 080 |
| B11 | Invoice date = posting date | Defaults to the posting date (Central). The office may set an earlier date; the month-close check uses **the invoice date**; each payer's due date follows that payer's terms (S28) | GR7, kit 081 |
| B12 | Unpost the set when no money and month open; else credit and rebill | Unchanged, plus: a reposted invoice whose content changed is marked **"Corrected"**; the original posted version stays readable (append-only); credit-and-rebill covers only changed invoices (**M3** defines "changed") (S24, S25) | Sol 45, 46, 79, kit 084, 087 |
| B13 | The other three routes retire in the FP-5a cutover | See the route table below | Sol kit 066, 067 |

## Every route after 4.1 (Sol kit 066, 067)

| Record or route | Rule after 4.1 |
|---|---|
| New job-sourced field drafts (`transfer_job_to_invoice`) | The one engine above (B1–B11) |
| Per-line Split Billing save on a job-sourced field draft | Same engine; edits re-checked on the server |
| Converted legacy drafts (`legacy_fixed`) and hand-typed invoices (no job) | Keep today's per-line rules; editable; hand-typed field work warns on overlap with a job (S29) |
| Field-app location save | Retired; refuses with a pointer to the job route |
| Blend-ticket invoice | Refused for **batch-path** jobs; unchanged for others until FP-5b (spring) |
| Externally billed (Chem Man) work before go-live | Never re-billed; the import marks it billed (wave 0 cut-off, Dec 31) |

## Precedence for who pays (Sol kit 069, 070)

1. A job office override (FP-4), saved with a reason, wins.
2. Else the field split in force on the work entry's Central spray date.
3. Else (no split version) 100% to the grower the field was **added under** on the job (stored on the job-field link at add time), never a guess from the field owner.
Legacy job shares that differ from the field split are kept as overrides (rule 1); nothing stored is discarded at cutover.

## Authority

- Draft creation: admin or sales rep; the server checks B1 and the one-bill-per-job link under a row lock on the job, so two transfers with different keys create one set (Sol kit 077).
- Edits before posting: admin or sales rep, with a reason on price, quantity and date edits [D9]. Each override kind (share, quantity, price, "bill actual used", invoice date) is a named field the server checks; nothing else from the screen is trusted (Sol kit 073).
- A save regenerates the set's membership: a payer who drops to zero loses their draft; a payer who gains a cent gets one (Sol kit 075). Editing is **set-level**: the screen sends the set revision it read; an older revision is refused (S23, kit 076).
- Posting (B10) changes `post_invoice` / `post_invoice_group`, which Taha's chemical invoices share: limited to field payer sets, needs Taha's review (5.1, after 2026-12-15). Every single-invoice post entry point refuses a member of a field set (posts go through the set) (Sol kit 082).
- Values the screen sends are locators and named overrides. Prices, acres, rates and payer eligibility are derived on the server.

## State, timing, undo

- A draft set is created in one transaction: all payer drafts or none. A retry with the same key returns the same set.
- Posting is all-or-nothing per set (S22).
- Unpost: re-checks payments, prepays, credits, write-offs, voids and month close inside the same transaction, under the same locks posting uses (Sol kit 083).
- Credit and rebill (FP-5c): the credit reverses the named posted version's remaining cents per line; the replacement links to the invoice it replaces; the job's one-bill link moves to the replacement set in the same transaction, so the job is never billable twice and never stuck (Sol kit 085, 086).
- Correcting a spray record after posting flags the invoices whose recomputed amounts would change plus those with that field's section; it never changes them (S26, Sol kit 088). The office spray-record correction gets its own narrow permission; `JOB_INVOICED_LOCKED` stays for everyone else (Sol kit 089).

## Posting switch (Sol kit 082)

| `split_field_invoice_posting_enabled` | Behavior |
|---|---|
| Off (production until the pilot) | Field drafts can be made and edited; posting a field set is refused; single-payer legacy posts unchanged |
| On, staging | Turned on on staging when 5.1 lands, so posting, unpost and rebill are proven there before wave 6 (Sol r2 152) |
| On, production | Only with Mason's yes in the conversation, for the pilot first: the first real job is reviewed on screen before anyone posts it (Sol r2 127, 158) |

## Delivery

4.1 is one database PR (engine changes, refusals, route table, cutover), then 4.2 screens after it is live on staging. 5.1 is its own database PR after 2026-12-15 with Taha's review. The PDF change (5.2) needs an Edge Function deploy: Mason's yes.

## Proof cases

Every money scenario in `SCENARIOS.md` (S1–S10, S16, S20–S29) becomes a SQL test as the real caller on a migrated database, expected cents from the scenario tables, plus:

1. A job with an unsettled field: draft creation refused with a plain message.
2. A `flat_fee` line on a job-sourced field draft: refused; on a hand-typed invoice: allowed.
3. A sales rep who is not the customer's rep opens, edits and posts a field set; each payer invoice's commission goes to that payer's rep.
4. A sales rep posting another rep's **chemical** invoice: refused as today.
5. One invoice in a set cannot post: none post.
6. Two transfers of the same job with different keys at once: one set.
7. Single-invoice post of a field set member: refused.
8. Unpost racing a payment: one wins, the other is refused, no half state.
9. Credit and rebill after a timeout between steps: retry finishes; the job is billed once.

## Open business decisions

- **M1** leftover cent; **M2** per-payer price tiers (Sol kit 010); **M3** what counts as a changed invoice (Sol kit 087). See `MORNING-QUESTIONS.md`.
