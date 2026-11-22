# Known Issues — what is open today

**Last verified:** 2026-11-21 for the live ledger only (latest live row `20261121061349`); KI-30 EPA numbers 2026-11-09; other evidence retains its stated dates. Triage 2026-11-22: see changelog.d.

**WP-PM-3 local candidate source review: 2026-11-02.** WP-PM-3 (`20261103100000_product_active_guard`) was applied live 2026-11-02; KI-89–KI-91 closed 2026-11-08 and KI-92 closed 2026-11-10 (see the closed list).

**Shipment reconciliation: 2026-10-27 (America/Chicago).** Compared all 68 PRs in the October 25–27 UTC merge query with `main` at `fe258c2fe`, current source and the live read-only migration ledger. KI-15 is closed; KI-30's completed category/vendor work is removed from its open scope; KI-47/KI-52/KI-72 are narrowed. The [audit record](../audits/2026-10-27-shipped-work-reconciliation.md) lists every PR and the evidence limits. All other open and accepted risks remain; this is not a fresh full security audit.

**KI-18 verified: 2026-11-07 (America/Chicago)** for KI-18 only: read-only live function definitions show `generate_quote_number`, `generate_order_number` and the rebate-claim body take the Chicago year; `generate_ticket_number` and `financial_dashboard_summary` were then moved to the Chicago date by `20261121090000` (applied live 2026-11-06). On 2026-11-07 the live `get_ar_aging` and `get_detailed_statement_data` definitions were read after `20261208100000`, the last KI-18 part, so KI-18 is fixed. The rest of the file was last verified 2026-10-25; evidence for each re-check is in its PR changelog and timestamped live-ledger captures in [migration history](../reference/migration-history.md). Earlier verification notes are preserved in [the archive](archive/verification-notes-2026-10.md).
Every "applied live" statement not re-read since is the older record's claim, marked as such.

This file is the short list of things that are genuinely open, or that someone decided to live with. Everything
else (fixed, merged, retired, long write-ups, the evidence trail, old section numbers like §0d, §4b, F06) is
preserved word for word in
[`docs/manual/archive/KNOWN_ISSUES-history-2026-10.md`](archive/KNOWN_ISSUES-history-2026-10.md)
(the whole previous file, ~7,000 lines, unchanged). Comments in code or docs that cite an old section number
resolve there.

**How to read an entry.** *Severity* is HIGH / MED / LOW. *Area* groups the list. *Owner* is a named person only
where a record says so; "unassigned" means nobody is working on it. "Mason decision" means the fix is waiting on
a business or risk call that only he can make. *Status* is one of:
**OPEN** (confirmed still present on `main`), **PARTIAL** (some of it fixed, the rest open),
**ACCEPTED** (Mason decided to live with it; reason given), **UNVERIFIED** (could not be confirmed either way in
this pass; treat as open until someone checks).

**Where other facts live (not here).** Applied-migration ledger, row counts and high-water mark:
`docs/reference/migration-history.md`. Current status: `CURRENT_STATE.md`. Settled decisions: `DECISION_LOG.md`.

**Update rules.** When a finding is found, fixed, or decided, edit THIS file (do not start another issue list).
A fixed item is removed from here and its text (with the PR or migration that fixed it) is appended to the
archive. Do not re-fix something listed here as ACCEPTED without a new decision from Mason.

---

**Master fix plan (2026-11-21).** Every open item below was re-checked against `origin/staging` `3a9694685` on 2026-11-21 and grouped by business area. The fix order, owners and the top five live in [MASTER_FIX_PLAN.md](MASTER_FIX_PLAN.md); this file stays the canonical list. Each entry's first quoted line ("Re-checked 2026-11-21 …") is the current status and wins over older status words in the entry text (for example "FIX IN REVIEW" or "not applied live"). 40 entries found fixed were moved to the closed list and their full text to the archive.

---

## Summary

| Status (re-checked 2026-11-21) | Count |
|---|---|
| Open, partly open, check-first or waiting on a Mason decision (numbered entries; KI-201, KI-202 and KI-205 added 2026-11-22 from the [2026-11-22 staging rehearsal](../audits/2026-11-22-staging-rehearsal-issues.md)) | 86 |
| Fixed on staging, waiting for the production release | 8 |
| Accepted numbered entries in the area sections (the full accepted list is the "Accepted risks" table) | 10 |
| Backlog or roadmap entries, not defects (KI-204 added 2026-11-22) | 4 |
| Open items tracked only as GitHub issues or parked fixes (tables at the end of each area) | 59 |
| Closed as FIXED (closed list below; 40 added 2026-11-21, 1 added 2026-11-22) | 66 |

Fix first: see "Top 5" in [MASTER_FIX_PLAN.md](MASTER_FIX_PLAN.md).

## BLOCKER and HIGH at a glance (re-checked 2026-11-21; Sol un-park rounds added 2026-11-22)

There are 28 items: 2 BLOCKER and 26 HIGH.
- 6 (SOL-1 to SOL-6) are partly fixed locally. Sol round 2 found new holes; Mason chose to remove the staging-only release pass instead (PR #2203).
- 1 (SOL-7) is in PR #2201, open into staging.
- 3 are fixed on staging but not live yet.
- 18 are open or partly open, including 5 new release-pass findings (SOL-8 to SOL-12).

Each item's full entry is in its area section below. "Severity unsure" marks a rating that needs more checking. "Check first" means a credible report that reading the code could not settle.

| Area | ID | Sev | Status | Impact | Owner |
|---|---|---|---|---|---|
| Guards and release | SOL-1 | BLOCKER | Resolved by removing the pass (PR #2203; closes when it merges) | The production merge gate could accept a local copy, instead of the live database record, as proof that a reviewed database change was applied. | Agent (land #2203) |
| Guards and release | SOL-2 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A message that only mentioned a release, or added a condition or a future time, could count as Mason's go-ahead. | Agent (land #2203) |
| Guards and release | SOL-3 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A go-ahead given for one release could cover a different release PR or another repository. | Agent (land #2203) |
| Guards and release | SOL-4 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A new approval reset the 24-hour clock on older approvals. | Agent (land #2203) |
| Guards and release | SOL-5 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A production merge could skip Taha's 4-hour review window. | Agent (land #2203) |
| Guards and release | SOL-6 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A hotfix merged during a release could leave the release half-applied on the live database. | Agent (land #2203) |
| Guards and release | SOL-8 | BLOCKER | Resolved by removing the pass (PR #2203; closes when it merges) | The merge guard runs a helper from the working folder without first confirming it was reviewed, and that helper can reach live database credentials. Fix: the guard only runs reviewed code. | Agent (land #2203) |
| Guards and release | SOL-9 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | The merge guard's check of a PR's database changes can miss one on a very large PR, or read the file list and the files from different versions. | Agent (land #2203) |
| Guards and release | SOL-10 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | While a release is open, a hotfix's database change could go live while its app change is refused, leaving the two out of step. | Agent (land #2203) |
| Guards and release | SOL-11 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | The merge guard's 4-hour hold for Taha ends early once he comments, and does not keep honouring an explicit "hold". | Agent (land #2203) |
| Guards and release | SOL-12 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A release-pass command naming an invalid PR number counts as approval for the open release. | Agent (land #2203) |
| Guards and release | KI-48 | HIGH (severity unsure) | Open | Some protections around applying live database changes have known gaps; the live migration ledger is the backstop. | Mason decision |
| Reports | SOL-7 | HIGH | PR #2201 open into staging | A broken or absurd order total would distort the commission in profit reports. | Agent (land #2201) |
| Reports | KI-129 (+#2195) | HIGH | Partly open | Month-end close counts deleted payments and misses payments recorded through allocation sets, so a month can show $0 received. | Agent (unassigned) |
| Reports | KI-125 | HIGH | Fixed on staging, not live | Profit reports showed a fake large loss because commission was counted on sales billed elsewhere. | Taha (release) |
| Field applications | #2196 | HIGH | Open | A sales rep may still be able to delete a completed, billable job outside the screens, so it drops out of Unbilled Jobs. | Mason (field-app billing) |
| Field applications | KI-185 | HIGH | Open | A job sprayed on 80 acres but planned at 100 bills for 100, and deducts stock for 100. | Mason (field-app billing) |
| Field applications | KI-198 | HIGH | Open | The same shared-field job can bill different totals depending on which billing screen is used. | Mason (field-app billing) |
| Field applications | #2061 | HIGH (severity unsure) | Check first | A job could be billed twice. | Mason (field-app billing) |
| Field applications | #2063 | HIGH (severity unsure) | Check first | A job could be billed twice: once on a blend invoice, then again on a split field invoice. | Mason (field-app billing) |
| Field applications | KI-187 | HIGH | Open | One spray recorded through both a blend ticket and its job could deduct stock twice. Production has no blend tickets yet. | Mason (field-app billing) |
| Orders and deliveries | KI-199 | HIGH | Fixed on staging, not live | Partial deliveries are overstated, and field drafts can go to the wrong grower. | Mason (field-app billing) |
| Quotes and bookings | KI-190 | HIGH | Open | Two reps drawing from one booking can order at quantities or prices that neither of them saw. | Taha |
| Orders and deliveries | KI-167 | HIGH (severity unsure) | Open | The office must fix a line's unit by hand before it can be re-delivered. No amounts change. | Taha |
| Inventory | KI-168 | HIGH (severity unsure) | Open | That purchase cannot be used as an actual-cost basis. Nothing reads it yet because costing is parked. | Agent (unassigned) |
| Payments | KI-75 | HIGH (severity unsure) | Check first | Applying a credit memo could clash with another action happening at the same moment. | Taha |
| Permissions | KI-169 | HIGH | Open | Hiding Invoices or Record Payments from a person still lets them reach those actions in the database. | Taha |
| Permissions | KI-119 | HIGH | Fixed on staging, not live | A person with Reports hidden can still pull report data. | Agent (release) |


---

## Quotes and bookings

### KI-190 — Partial Order commits a booking's current terms, not the ones the rep reviewed

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · HIGH · Taha (to 2026-12-15) · plan W1-09 · #2181.

**HIGH · OPEN (source-confirmed on main and staging; not reproduced) · quotes/bookings · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 4) · unassigned (Taha builds Bookings Phase B) · GitHub #2181**
Whole Convert refuses a booking that changed since the screen loaded (`p_expected_row_version`, `QUOTE_STALE_WRITE`,
`20261027080400`). `draw_down_quote` (`20261106110000` ~L56) takes no revision and the Partial Order screen sends
none (`QuoteBuilder.tsx` ~L3838); the draw prices and splits against the current booking (remainder and booked/extras split `20261029110000` ~L545-573; booked versus today's tier price for extras ~L1503-1527).
Example: the rep sees 100 left and asks for 110 (10 extras); another rep draws 25 first; the stale request makes 75
booked and 35 extras. A newly approved booked price can also reach the order unreviewed. A same-key retry is safe.
Staging adds an inactive-customer refusal (`20270201120000` ~L190-200); the stale path is the same on both for an
active customer. Live (audit aggregate, not re-run): no partial orders yet. Not in the Phase B plan. Fix: bind the draw
to the booking revision and the booked and extra prices shown; refuse and show what changed. Proof: an overdraw with
extras, then separately a changed booked price and a changed tier price used for extras; each stale attempt writes nothing, and a
previous successful draw still replays under its original key and payload.

### KI-192 — A booking's "left to draw" dollars are wrong when its lines have different prices

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Taha (to 2026-12-15) · plan W2-01.

**MED (display only) · OPEN · bookings · found 2026-11-17 (bookings flow audit D2), re-verified 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md)) · unassigned (Bookings Phase B)**
`get_booking_settlement` (`20260702180000` ~L237-250) values the remainder at the booking's weighted-average price.
Fictional: the same product on two lines, 100 units at $1 and 100 at $3, with the $1 line drawn first (draws follow
section and line order, `20261029110000` ~L1167-1173), shows $200 left instead of $300 (and $300 booked instead of
$400). Orders use the real line prices, so only the card is wrong. Fix: value the remainder from the surviving line
quantities and prices, as a Phase B line item.

### KI-193 — A duplicated or template quote can be emailed without being repriced or checked

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Taha (to 2026-12-15) · plan W2-02 · #2182.

**MED · OPEN (source-confirmed; reproduced by the audit with stubbed calls) · quotes · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 3) · unassigned (Taha's quote area until 2026-12-15) · GitHub #2182**
`duplicate_quote` (`20260812115236` ~L1878, ~L1975) copies the old sale price and any manual override, with today's
cost. A template draft (`create_quote_from_template`, `20260611211058` ~L1074-1150) carries tier prices and rates
but no acres or quantities. "Email to grower" (`QuoteBuilder.tsx` ~L3277-3310) freezes the version through
`create_quote_version` without the save that reprices a never-sent draft and validates its lines. A duplicate
emailed without a save therefore goes out at the old price, which conversion later treats as the sent price, against
`QUOTE_TO_DELIVERY.md` ("a new draft at today's prices"). A save before sending reprices tier-derived lines, but a
copied manual override still wins (`20261104130000` ~L603-617). Fix: one first-send readiness check (save, reprice,
the rate/unit and rate/acres checks of `QuoteBuilder.tsx` ~L2388-2418) for never-sent drafts, and show which manual
prices carried over. Proof, two fixtures: a tier-derived line follows today's tier price, and a deliberately kept, different manual price
survives, each in the sent version, PDF and converted order; a template
with a rate but no acres, or no unit, is refused with no sent version or email; a valid template sends.

### KI-194 — Quote send and PDF gaps: "Sent" before the email result, and differing PDF dates

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Taha (to 2026-12-15) · plan W3-02.

**LOW · OPEN · quotes/documents · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 3) · unassigned**
- The version is frozen and marked Sent (`20261029100000` ~L957) before the mail call (`QuoteBuilder.tsx` ~L3393),
  on purpose so a retry of the same send attempt reuses that version. Expiry and stale-version failures have their own
  messages; a delivery failure after the freeze shows a generic error. "Sent" also covers Mark Presented,
  and the email log shows the last emailed time. Fix: after a successful freeze, say the version is saved and either that the email was refused or that its outcome
  is unconfirmed and may have sent (`emailService.ts` ~L102-129). Prove a definite refusal and a lost reply after
  acceptance, retrying with the same attempt keys, create no extra version or email.
  Related: To-Do 9.3.
- Preview and download use today's date and the editor's expiry (~L2968-2977); email uses the saved date and stored
  expiry (~L3346). Re-downloading an already-sent quote prints today's date and possibly another expiry. Fix: issued
  copies use the frozen dates.

### KI-105 — A quote's price tier is not checked against the customer's assigned tier

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Taha (to 2026-12-15) · plan W3-03. Screen warning is merged; only the database refusal is missing.

**LOW today, MUST before the first regular rep · PARTIAL (screen note merged: PR #1605, in main, 2026-11-07; the database refusal for reps is still open) · quotes/pricing · To-Do 1.6**
Quote Builder lets any tier be picked, so a quote can be priced at a tier other than the customer's assigned one
with no warning. A screen check (a note with "Use Tier N" and a "Quote at Tier M anyway" tick box that Save
needs) was merged as PR #1605 on 2026-11-07 (Mason, 2026-11-05: screen only,
then the database rule). Only office staff and admins quote today. Before the first regular
rep gets an account: the database must refuse a different tier from reps (admins may override). When it resumes,
also fix Sol's two MED findings on that screen check (not re-verified 2026-11-22): (1) the customer's assigned tier is read once, so an admin
changing it while a quote is open leaves the check comparing against the old tier; (2) "Use Tier N" on a sent
quote changes the tier label without repricing its locked lines.

### KI-140 — Per-acre price treats unknown units as 1 oz and mixes liquid with dry

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Taha (to 2026-12-15) · plan W3-04.

**LOW (latent) · OPEN · pricing · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 1 #8) · unassigned**
`product_price_per_acre` uses factor 1 for a unit not in `unit_conversions` and never checks liquid vs dry, giving a
confident wrong price. Only the 2 KI-114 products mismatch today. Fix: return NULL when a unit is unknown or the types
differ.
Widened 2026-11-13 ([Product Master review](../audits/2026-11-13-product-master-review.md) C-8): `save_quote`'s server
math (`_save_quote_below_cost_impl_20260810`, `20261104130000` ~L620-656, `COALESCE(factor_oz,1)`) has the same
fallback. That is the real money path; only the quote screen's unit picker keeps other units out today. It is part of
the units batch (To-Do 0.17): refuse an unknown or wrong-type unit in both places.
**Partly fixed (units batch, PR #1896, `20270121110000_line_unit_is_stock_unit`, in main via release #1990):** `product_price_per_acre` returns no figure for an unknown
rate or stock unit, and a quote line with a non-zero rate refuses an unknown rate unit (`QUOTE_RATE_UNIT_UNKNOWN`) or
stock unit (`QUOTE_STOCK_UNIT_UNKNOWN`), so `save_quote` never reaches its 1-oz fallback. **Still open:** the liquid vs
dry check (4 live dry products use a liquid `oz` rate; KI-114, rates work), and the quote screen's own 1-oz fallback
(quote screens are Taha's).

### KI-201 — Quote Compare drops a line when the same product is on two sections

> **Re-checked 2026-11-22 on staging `17a72d0ee`:** Open · MED · Taha (to 2026-12-15) · plan W2-52 · #2206. From the [2026-11-22 staging rehearsal](../audits/2026-11-22-staging-rehearsal-issues.md).

**MED · OPEN (reproduced in two browsers; source-confirmed) · quotes · found 2026-11-22 (rehearsal CRXN-02) · unassigned (Taha's quote area until 2026-12-15) · GitHub #2206**
Compare matches version lines by `product_id` only (`QuoteBuilder.tsx` ~L5861-5862), so the same product on two
sections collapses into one row with no section label. Rehearsal: the unchanged $24.00 line vanished while the other
showed $26.00 to $25.00. Saved versions, PDFs and totals ($50.00 and $49.00) were correct, so this is display only.
Fix: match on saved line identity and show section names. Proof: change either line; both stay visible and the PDFs
and totals still reconcile.

### Also open in this area (tracked as GitHub issues or parked fixes; plain-English detail in [the plan](MASTER_FIX_PLAN.md))

| ID | Sev | Status | What goes wrong | Owner | Plan |
|---|---|---|---|---|---|
| #2129 | LOW | Check first | One old saved retry record is oddly keyed; effect is cosmetic or a failed replay. Depends on a live data row. | Taha (to 2026-12-15) | W3-47 |
| #2075 | MED | Open | A quote written before but sent after the job date can set an earlier job's price. | Taha (to 2026-12-15) | W2-03 |
| #2071 | LOW | Check first | A quote sent mid-save could price some lines of one invoice and not others. | Taha (to 2026-12-15) | W3-48 |
| #1970 | LOW | Check first | Sections already refuse repeated keys (SECTION_ID_INVALID); items not confirmed. | Taha (to 2026-12-15) | W3-49 |

---

## Orders and deliveries

### KI-128 — Voiding or cancelling an order ignores its unposted, overdue and paid invoices

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Taha (to 2026-12-15) · plan W2-04.

**MED · OPEN · money/invoicing · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 3 #5) · unassigned**
`_void_order_impl_20260714` handles only draft/posted invoices (an unposted one stays postable); `_cancel_order_impl_20260714`
skips overdue and paid ones too. Such an invoice stays in AR (aging, reminders, finance charges) with no alert. 0 voided
orders live. Fix: add `unposted` to void's cancel branch and flag overdue/paid for manual voiding, or refuse the void.
Related: KI-102 (same function, stock side).

### KI-191 — Orders converted from a booking have no salesperson

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Taha (to 2026-12-15) · plan W2-05.

**MED · OPEN (source-confirmed; live 2026-11-21: no orders trigger fills it) · quotes/orders/reports · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 4) · rule decided 2026-11-21 (To-Do decision 30: the booking's salesperson; DECISION_LOG) · unassigned (Bookings Phase B)**
Whole Convert, Partial Order and the extras order insert no `salesman_id` (`20260914100500` ~L655, `20261029110000`
~L426 and ~L1531); the only orders trigger on that column is the rep-scope guard. Order Detail shows no salesperson,
salesperson-filtered sales reports leave the sale out (`20261229150000` ~L194, ~L249), and the rep cannot use the
order's tax checkbox when that feature is on. Commission is unaffected (it follows the booking split). Decided
2026-11-21: the booking's salesperson. The fix must set it on the server: the rep-scope
guard refuses an order where a rep names a salesperson other than themselves (`20261015130000` ~L137-166,
`20261027080400` ~L105-119), and a rep may convert another rep's booking. Rule needed: only the conversion functions may assign the salesperson taken from the locked booking; a rep still cannot name another salesperson by hand. Proof: cross-rep whole and partial
conversion, with commission still following the booking split, and a rep naming another salesperson by hand is still refused.

### KI-199 — Fixed on staging, waiting for the production release

> **Re-checked 2026-11-21 on staging `3a9694685`:** On staging, not live · HIGH · Mason (field-app billing) · plan R-08 · #2045, #2142, #2171, #2164.

**HIGH until released · OPEN (fixed on staging, awaiting the production release) · deliveries / field-app billing · recorded 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audits 5 and 6) · release owner: Taha or Mason (release/next)**
- **A stale partial-delivery form can overstate what shipped.** On production, a partial delivery missing one line's
  quantity delivers that line in full (`20261215110000` ~L1069-1073, reached through the KI-150 wrapper), which
  drives the stock deduction and the draft invoice. #2045 (`20270203120000_inventory_edge_cases_1942`) refuses it
  with `DELIVERY_QUANTITIES_STALE`. Migration not in the live ledger 2026-11-21.
- **Editing a standalone field draft onto another grower's field kept the old grower.** #2142
  (`20270205100000_field_app_refuses_payer_change` ~L221-233) refuses `FIELD_APP_PAYER_CHANGED`; its migration is
  not in the live ledger 2026-11-21. #2171 (closes #2164) fixes the lost-save message in browser code
  (`FieldApplicationInvoice.tsx` ~L2289-2295), live only once the release is deployed.
Close each bullet when its release is merged, its migration is applied live and the live body is read back; the
field-draft bullet also needs the deployed screen checked: lose the create reply, recover the draft, change its payer;
the change is refused, the original draft still exists with its payer, and the note explains the earlier save. KI-125,
KI-126 and KI-130 (#2149) keep their own entries.

### KI-25 — A customer receipt that fails to send after a delivery completion is not retried

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · MED · Agent (unassigned) · plan W2-06.

**MED · OPEN (sender and app switch live; close action live in the database, not on a screen yet) · UI/database/Edge Function · Claude**
The database half is live (`20261113140000`, PR #1495): a receipt asked for at completion is recorded in the same
save in `delivery_receipt_queue`. The sender (Edge Function `send-delivery-receipts`, PR #1647) was deployed live on
2026-11-08 with `verify_jwt` off, and the office "Customer receipts to check" card is on Deliveries. The app switch
that asks for the server receipt (PR #1649) merged 2026-11-09. Not built: provider bounce handling (no email
bounces are tracked today on any path). The database half of a "mark handled" action is live
(`20261221100000_close_delivery_receipt`, ledger `20261109152447`, PR #1678), but no screen calls it yet (checked on
`main` 2026-11-10), so the points below still hold. The office
card lists every unsent receipt with no age cut-off, so one the office already handled stays listed, and a manual
Email Confirmation does not pause a worker retry (Sol MED, PR #1647), so the customer can get a second copy. Mason
chose (2026-11-08) to land the app switch first; the close action's screen is the remaining follow-up.

### KI-26 — Delivery completion-evidence leftovers

> **Re-checked 2026-11-21 on staging `3a9694685`:** Accepted · LOW · Agent (unassigned).

**LOW · OPEN · UI/database/process**
Following `20261022075000` (PR #1024): old app versions are refused until reloaded; offline completions queued
before the change go to review; old completed deliveries have no proof stored; some old proof scripts fail;
abandoned signature files stay stored (deleting them is out of scope); file contents are not inspected. Photo proof
is now tied to who uploaded it (LIVE 2026-11-09, ledger `20261109173810`; see KI-77). Real-phone airplane-mode test PASSED
(Mason 2026-11-06, after the narrowing below): an offline signed completion synced and showed its signature.
The four older signature policies (fixed path `signatures/<id>.png`) are narrowed by
`20261116100000_permission_tightening.sql` (Mason 2026-11-05; APPLIED LIVE 2026-11-06 12:28 AM Central, ledger `20261106062807`): insert, update and delete dropped,
and reading needs the file to be the delivery's recorded signature.

### KI-152 — Completing a delivery re-derives the status of an already-cancelled order

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-05.

**LOW · OPEN · deliveries · found 2026-11-11 (PR #1805, live smoke fixes) · unassigned**
`complete_delivery` always recomputes the order status (fulfilled / partially fulfilled), even when the order is
cancelled. The app cannot reach this today, because `cancel_order` cancels open deliveries first, but no database
rule stops it. Fix: in a new migration, leave a cancelled order's status alone (or refuse the completion).

### KI-188 — Cancelling or voiding a follow-up delivery hides the still-owed quantity from Delivery Remainders

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Agent (unassigned) · plan W2-07 · #2179 (open).

**MED · OPEN (source-confirmed on main and staging; reproduced by the audit in an isolated database) · deliveries · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 5) · unassigned · GitHub #2179**
Cancel (`20270126110000` ~L431) updates remainders only where the cancelled delivery is the original, so a remainder
whose follow-up was cancelled stays `scheduled`. Completion marks the follow-up's remainder `fulfilled`
(main `20261215110000` ~L1187-1197 via `20270126110000` ~L197-227; staging `20270203120000` ~L590-600, same
behavior) and void (`20261107120000` ~L272) never reverts it. The order still shows the quantity owed
and reserved, but the pending queue (`DeliveryRemainders.tsx`, default filter `pending`) no longer lists it. Live
(audit aggregate, not re-run): no remainder rows yet. Fix: return the row to `pending` when its follow-up is cancelled
or voided and the order still owes product. Proof (rolled back): when product is still owed, the remainder returns to pending and staff can
schedule exactly one replacement for the exact owed amount; when nothing is owed, no pending row appears and no
replacement is created; for a partly completed follow-up, the successor remainder is not counted twice.

### KI-176 — Cancelling part of a large booking's jobs rebuilds its stock holds once per job

> **Re-checked 2026-11-21 on staging `3a9694685`:** Accepted · LOW · Taha (to 2026-12-15) · #2047.

**LOW · ACCEPTED · jobs/bookings · found 2026-11-21 (Sol round 5, #2047) · Taha (bookings, after 2026-12-15)**
The booking hold trigger runs once per cancelled job, so cancelling part of a booking rebuilds the remaining jobs' holds
every time. Today's screens do the same. It only matters with roughly 150+ open stocked jobs on one booking (measured
200 rebuilds = 11.3 s); live has 4 jobs and none on a booking (2026-11-19). Mason accepted it for #2047 (2026-11-21).
Fix: make the trigger rebuild once per statement (booking/inventory core).

### KI-179 — Two cancels on one booking at the same moment can make one fail

> **Re-checked 2026-11-21 on staging `3a9694685`:** Accepted · LOW · Taha (to 2026-12-15) · #2047.

**LOW · ACCEPTED · jobs/bookings · found 2026-11-21 (Sol round 6, #2047) · Taha (bookings, after 2026-12-15)**
The booking hold trigger upgrades a cancelled job's row lock while it rebuilds the booking's other jobs. If two people
cancel different jobs on the same booking at the same instant, PostgreSQL stops one: it saves nothing and shows an
error, and a retry works. Today's screens behave the same way. Mason accepted it (2026-11-21). Fix: lock the booking
before the job rows in the hold trigger's callers, or rebuild once per statement (booking/inventory core).

### KI-167 — Voiding a finished delivery can reopen an order line in an old unit that cannot be re-delivered

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · HIGH · Taha (to 2026-12-15) · plan W1-10 · #1896.

**HIGH (latent) · OPEN · deliveries · found 2026-11-17 (Sol round 6, #1896) · unassigned**
#1896 relabels only open lines. A completed order line still in an old spelling or unit (3 live 2026-11-17: "Gall",
"Gallon ", "oz") reopens if its delivery is voided, and the new line-unit guard then refuses its replacement delivery.
No amount is changed; the office must correct the line's unit by hand. **Decision (Mason, 2026-11-17: "Accept and
land"):** #1896 ships with this open. Fix: relabel completed lines to the stock unit, or relabel a line when a void
reopens it.

### KI-203 — Quick Delivery shows a dash for the unit of a product stocked in Gal

> **Re-checked 2026-11-22:** Merged to staging in PR #2213 · fresh deployed browser check pending · plan W3-56 · GitHub #2208 closed. [Acceptance checks](../audits/2026-11-22-staging-workflows-follow-up.md)

**LOW (clarity) · FIXED ON STAGING BRANCH (browser retest pending) · found 2026-11-22 · GitHub #2208**
The unit column shows the product's optional package size or a dash (`QuickDeliveryModal.tsx` ~L633), not the unit
the line is sold in. A two-Gal entry priced $10.00 and the saved delivery, order and invoice all used Gal correctly.
Fix: show the selected or implied sales unit before submit. Proof: a pack size and a converted unit on test records,
with visible quantity, saved units, stock and invoice reconciled.

### Also open in this area (tracked as GitHub issues or parked fixes; plain-English detail in [the plan](MASTER_FIX_PLAN.md))

| ID | Sev | Status | What goes wrong | Owner | Plan |
|---|---|---|---|---|---|
| #2018 | LOW | On staging, not live | Drivers saw an empty Available deliveries card; the card now loads open deliveries through get_available_deliveries_for_driver (#2165, on staging). Issue closed. | Agent (unassigned) | R-16 |
| #2097 | MED | Check first | Stock held for a grower could release early. The expiry job does skip quotes with quantity_drawn > 0, so the described gap was not reproduced. | Taha (to 2026-12-15) | W2-45 |
| #2065 | MED | Mason decision | Closing short releases holds and purchasing demand; needs Mason's rule (booking's rep or admin only). Guard currently blocks reps only when a live job exists. | Mason decision | D-01 |
| #1960 | LOW | Check first | An old retried save may not get section ids back. | Taha (to 2026-12-15) | W3-50 |

---

## Inventory, purchasing and products

### KI-100 — An open product page learns of a lock change only on reload or a refused save

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-07.

**LOW · product UI · `20261107060000` — APPLIED LIVE 2026-11-04**
If another admin locks rates while a product page is open, the page still offers rate edits; the save is refused by the database and the page then resets the rate fields to the saved values, so typed rate edits are lost. Other edits on the page save. Source: the WP-PM-11a-1 changelog note.

### KI-103 — Bulk product import: a row with an unknown extra field previews "ready", then the save refuses the file

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-08.

**LOW · OPEN, no fix planned · products/import · found 2026-11-05 (Sol LOW on #1486)**
`preview_product_import` ignores unknown top-level keys on a row, but `apply_product_setup` refuses them, so such a
file previews "ready" and then the whole save is refused with nothing written. The screen never sends extra keys,
and keys inside `insert` or `rates` are already refused by the preview. The Check File timeout first filed under
this number is fixed and live (archive, 2026-11-05).

### KI-109 — Product Master follow-ups named in the Wave 2 report but never filed

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-09.

**LOW · OPEN (two bullets CONFIRMED 2026-11-10; three not re-checked) · products · source: [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md)**
- CONFIRMED, LOW, re-checked 2026-11-10 (code-read + live read-only). No cancel for a previewed price change set.
  The screens call preview, approve and apply only. The November 3 test set `a27b2386` was still "previewed"
  (created 10:43 AM Central, expired 12:43 PM, never applied), and a second previewed row was still there.
  "expired" is allowed but never written. Apply refuses an expired set, and the preview screen says "This preview
  expired". Harmless clutter. Recommended fix, not applied: cancel or expire a preview that was never applied.
- No product-page list of open jobs still on old label values. Not re-checked 2026-11-10. STILL UNVERIFIED.
- CONFIRMED, LOW, re-checked 2026-11-10 (code-read + live read-only). `save_job` does not itself refuse edits to a
  completed job. The billed-job lock returns immediately unless the job is invoiced or cancelled, so a completed
  job stays editable. `20261204120000` freezes a completed or invoiced job's EPA numbers only. Recommended fix,
  not applied: refuse a completed job in `save_job`, or Mason accepts that only invoiced and cancelled jobs are
  locked. The entry's other three bullets were not part of that check.
- WP-PM-7 deferred LOWs: emoji character count, older `toFixed` displays, the raw select in the cost modal.
  Not re-checked 2026-11-10. STILL UNVERIFIED.
- "Piksi Dust Plus - 1800G Jar" is stocked in milligrams but billed by dry ounces on jobs; check its price before it
  goes on a job. Its cost basis is still an open question for Mason. Not re-checked 2026-11-10. STILL UNVERIFIED.

### KI-114 — Four kinds of old product rate data are wrong or have no rate basis

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Agent (unassigned) · plan W2-08 · #1958. Mason answered the label question 2026-11-21 (18 grams per acre); the remaining work is the data fix.

**MED · OPEN, planned (RT-2/RT-3) · products/rates · found 2026-11-08 ([RT-1 build sheet](../plans/2026-11-08-product-RT1-BUILD-SHEET.md) section 1)**
RT-1's draft rates (`20261229110000`, live 2026-11-10) copy these as they are; nothing here is fixed yet. RT-2 step 1
(PR #1706, open) has its unit converter live (`20261229160000`, ledger `20261110061547`); its spelling remap
`20261229170000` is not live (2026-11-10). Derive notes the basis doubts (`basis_suspect`, `unit_not_for_form`, no basis), but not the Piksi grams: its house row is an `18 mg/acre` quoting default beside an `18 g/acre` label row, so RT-3 must fix it before any draft is approved.
**Re-verified live 2026-11-21 (read-only, [2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md)):** Piksi Dust Plus is `18 MG` per acre with suggested-rate text "18 grams per Acre"; Piksi Dust Infurrow is `6 MG` ("1.5 gram per G"); all 456 product groups are still `rate_source = legacy` (cutover `20270125100000` live, ledger `20261121060539`). The code refuses BOTH Piksi parents by ID (`PRODUCT_PARENT_CUTOVER_HELD`, `20270125100000` ~L281, preflight ~L38), not only Plus. The three Piksi sizes appear on 4 order lines from March 2026, none rate-based, and on no quote or invoice line, so no bill has used the mg default. Tracked in #1958. **Label answered 2026-11-21 (Mason): 18 grams per acre**, so the stored `18 MG` unit is wrong; correct it through a reviewed change before the cutover releases Piksi.
**Derived on live 2026-11-17** (714 drafts, [run record](../changelog.d/2026-11-17-rt1-derivation-run.md)): as predicted, `Piksi Dust Plus` has an `18 mg` per-acre house draft proposed as the quoting default beside an `18 g` label draft; `Piksi Dust Infurrow` has a `6 mg` house draft (not default). The two dry `oz` products got no house draft (`unit_not_for_form`).
- Seed treatments: the 9 liquid seed treatments with `/unit` text store the per-seed-unit number as a per-acre rate
  (Ilevo 2.5 Gal: `1.18 oz` "per acre", text `1.18 oz/unit`), so a quote multiplies it by acres. RT-3.
- Liquid unit on a dry product: `Autumn Super 51 WDG` and `Cimarron Plus - 10 oz` are dry with `rate_unit = 'oz'`.
  RT-2 (spellings).
- Milligrams: the two `Piksi Dust` products store `MG` while their text says grams (`18 grams per Acre`). RT-3.
  Update 2026-11-17: Mason chose to keep both on today's values ("priced each for jar and by mg, which is actually
  gram's price"); RT-4a's switch refuses Piksi Dust Plus by ID and Infurrow is `needs_label_data`. The MG -> g rename
  is out of RT-4b (2026-11-18) by that decision; it waits for a label check and Mason's go.
- Per ton or per gallon: `BW-NLockDown`, `NanoCote Core` and `Tempo SC Ultra` have rates with no RT-1 basis. RT-3.

### KI-29 — Field-mode and inventory data decisions waiting on Mason

> **Re-checked 2026-11-21 on staging `3a9694685`:** Mason decision · LOW · Mason decision · plan D-04.

**LOW-MED · PARTLY RE-MEASURED 2026-11-08 · inventory/process · Mason**
Re-measured live, read-only, 2026-11-08 (no data changed): five products still flag until counted (Mason chose not to
count; no stock movement since 2026-10-07); six partially fulfilled orders (0161/0162/0172/0176/0331/0343) still
hold stock for unfilled lines; the same three deliveries are stuck (DEL-00075/00077/00082) plus nine more past their
date on confirmed orders; 19 negative inventory rows (not the same 19 as June: two are new, one is deeper) must only be
fixed from physical counts; PO-2026-0008 is a real fully-received PO with 7 short and 10 over lines, PO-2026-0015's
receipt gap is still there (corrected 2026-11-10 by the [2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 2 #10: line `e6559c38` shows 227.5
received with no receiving record; whether to add one is To-Do decision 23); 10 deliveries have no items (5 completed, 2 voided, 3 cancelled); one cancelled
zero-item invoice. Not re-measured (sales/billing): whole-order invoicing on 33 orders, eight SEED commission
batches. Returns/voids on Chem Man-billed deliveries stay allowed. Yes/no sheet in the side-session notes (not in
this repo).

### KI-138 — Stored tier margins disagree with stored prices on a few products

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Mason decision · plan W3-10.

**LOW · OPEN · pricing data · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 1 #6) · unassigned**
Product `8b9c7b32`'s stored Tier 1 margin is about 6 points off its price, and a legacy-mode recalculation would
reprice it; `a21ff506` is a cent off; 8 products have a stale `tier1_gross_margin`. Fix: a reviewed data fix
recomputing margins from prices; consider failing closed instead of defaulting to `legacy_margin`.
Re-checked 2026-11-13 ([Product Master review](../audits/2026-11-13-product-master-review.md)): 587 of 588 margins
consistent, 1 outlier. Related catalog gaps found the same day, all for Mason (To-Do decision 27): 3 products have
Tier 2 above Tier 3; 3 active products have no cost, 4 have no Tier 1 price, and 12 have no container size.

### KI-160 — Two stock counts open on the same product apply the same correction twice

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · MED · Agent (unassigned) · plan W2-09.

**MED (latent) · PARTIAL (migration `20270119130000_one_open_count_per_stock_row` in main via release #1990; count creation still open) · inventory/counts · found 2026-11-13 ([Product Master review](../audits/2026-11-13-product-master-review.md) C-6, C-14) · Claude**
`_complete_cycle_count_impl` adds the stored `variance` to current on-hand, and nothing stops two open counts on one
inventory row: no unique or partial index on `cycle_counts` or `cycle_count_items` (live-verified). Example: counts A
and B both record +10 on a shelf going from 90 to 100; after both complete, stock is 110. Named out of scope in the
KI-134 contract, with no KI until now. Smaller: admins hold a column UPDATE grant on `cycle_count_items.variance`,
which bypasses the KI-134 baseline. Count creation is also three browser requests (`CycleCounts.tsx` ~L246-292), so a
failed create leaves an empty open count. 0 open counts today. Fix: one open count per row, variance written only by
the RPCs, atomic create. Repair step 2 (To-Do 0.17), before the pre-season count.
**Part fixed (in main via release #1990):** one in-progress count per warehouse; a stock row on only one item of any in-progress count
(also refuses the same row twice on one count; concurrent claims serialized); a count's status only moves forward (in progress
to completed or cancelled, completed to cancelled), so no count can be reopened or reversed twice; signed-in users lose direct UPDATE on `cycle_counts` and `cycle_count_items`, so a
completed count cannot be marked cancelled without its reversal and a line's variance is only what the save RPC computed (a direct line insert may set only the four columns the app sends). **Still open here:** the three-request creation (a failed create leaves an empty open count, which
now blocks a new count at that warehouse until it is cancelled from the Cycle Counts screen). **In progress (Lane E, 2026-11-22):** `create_cycle_count` (`20270209160000`) does the whole start in one step; the screen switch and removing the direct inserts follow.

### KI-163 — Small stock-history gaps

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Agent (unassigned) · plan W3-11.

**LOW · PARTIAL (items 1 and 2 fixed; item 3 open) · inventory · found 2026-11-13 ([Product Master review](../audits/2026-11-13-product-master-review.md) C-15, C-16) · unassigned**
**Fixed 2026-11-17:** `20270126110000_inventory_cleanup_ki161_163_150` (in main via release #1990) fixes (1) (the `released` row records what was really released; none when nothing was) and (2) (count lines keep 4 decimals). (4) is not a defect: the header equals the sum of its lines each rounded to whole cents (house rule); only the unrounded sum is 1¢ lower, and it has no vendor bill. (3) stays open (needs a link column; no figure is wrong). Old `released` rows stay as written.
(1) Quick-delivery cancel (`_cancel_delivery_replay_impl_20261015`) clamps `quantity_prebooked` at 0 but logs a
`released` row for the full amount, so reservation history can disagree with the figure. (2) Count rounding in
`update_cycle_count_item` (`20270103170000`) can leave up to 0.005 on 4-decimal bulk rows. (3) Return and
application-reversal history rows are linked to their source only by note text (`reverse_application_record`). (4) One
fully received PO's header total is 1¢ off the sum of its 39 lines (rounding order). Fix opportunistically.
Repair step 5 (To-Do 0.17).

### KI-144 — A purchase order's vendor is free text, not a link to the vendor list

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Agent (unassigned) · plan W2-10.

**MED-LOW · OPEN · purchasing/vendors · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 2 #3) · unassigned**
`purchase_orders.vendor` is text with no foreign key; vendor rename updates only products; Bulk PO Import suggests
names from products. Live: 3 POs match no vendor (PO-2026-0030, PO-2026-0018, PO-2026-0020). Root of part of KI-143.
Fix: add `vendor_id` set by `save_purchase_order`, keep the text as a snapshot; backfilling the 3 is To-Do decision 23.

### KI-151 — Changing PO line costs is still checked against the ordered value

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-12.

**LOW · OPEN · purchasing/payables · found 2026-11-11 (PR #1769 review) · unassigned**
Since KI-143, vendor bills are checked against what arrived (capped at the ordered total). `set_purchase_order_item_costs`
still compares billed amounts with the ordered value. Fix: decide whether it should follow the same rule.

### KI-170 — Two admins changing a product's vendors at the same moment can show the wrong preferred vendor

> **Re-checked 2026-11-21 on staging `3a9694685`:** On staging, not live · LOW · Claude · plan R-15 (fixed by #2185, 2026-11-22).

**LOW · FIXED ON STAGING (Product Master Wave 2 piece 6; live with the next release) · products/purchasing · found 2026-11-20 (Sol 6.2 plan review, shared data loading pilot) · Claude**
After an admin links a vendor, the Vendors section re-reads the product's vendors to learn which one is preferred.
If that re-read failed, it fell back to "the vendor just made preferred, or the first vendor". If two admins linked the
first vendor to the same product at the same moment, or one made V2 preferred just before the other made V1 preferred
(Luna, 2026-11-20), that fallback could name the loser's vendor, and the product page mirrored that name into its form
until a reload. The database always kept the true preferred vendor. Fix (screen only; Mason, 2026-11-21, after Sol
found a new race in each of three rounds of patching the name in place): the page no longer copies a vendor name from
the Vendors section at all. After any vendor link (or one whose answer was lost) it re-reads the whole product, whose
vendor the database keeps right, and Save, New product and Add a size stay off until that read lands; a failed read
locks editing until Reload Product succeeds. Vendor changes are off while the product has unsaved edits ("Save or
discard your Product changes before changing vendors") or is saving or loading, so the re-read never discards typing.
Proof: `ProductVendorsSection.test.tsx` (every link, and a failed one, asks for the re-read; controls off with the
reason) and `ProductDetail.pricing-flow.test.tsx` (Save and copies off until the re-read lands, even from a callback
held since the click; a failed re-read locks until Reload Product; unsaved edits lock vendor changes), plus the
running local test app.

### KI-196 — Product search, package labels and the Chemical Summary disagree across screens

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-14.

**LOW · OPEN (source-confirmed) · products/reports · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 1) · unassigned**
- The Field Application Invoice picker searches name and EPA only (`FieldAppChemicalEntry.tsx` ~L183); Quote Builder
  searches SKU, category, vendor, group and nickname but not EPA (`QuoteBuilder.tsx` ~L4316).
- The shared package label prefers the packaging variant, then the old `unit_size`, then the size pair
  (`ProductOptionPresentation.tsx` ~L32-37), so a jug with no variant and `unit_size` "Gal" reads "Gal". To-Do 2.14
  (retire `unit_size`) must also say which text wins afterward.
- Chemical Summary groups by product name and unit (`chemicalSummaryReportData.ts` ~L158); an active product may reuse
  a retired one's name (`20261107130000` ~L70), and a renamed product regroups. No completed-job group spans two
  products today (audit aggregate). Fix: group by product id and normalized unit (units stay separate, ~L147-158), with
  a fallback for lines lacking an id.

### KI-197 — PO cost corrections can overwrite each other; "Most recent received PO" sorts by PO date

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-15.

**LOW · OPEN (source-confirmed) · purchasing · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 2) · unassigned**
- `set_purchase_order_item_costs` (`20261021140000` ~L513, only definition) takes the line and new cost only
  (`PurchaseOrderDetail.tsx` ~L1370). Saves are serialized and logged in cost history, but a second admin working from
  a stale screen silently replaces a newer correction. Admin-only. Fix: send and compare the cost the admin saw (same
  pattern as KI-170).
- Product History's "Most recent received PO" (`ProductPriceHistory.tsx`, main ~L165, staging ~L176) comes from
  `get_supplier_market_evidence` (`20260720230000` ~L1095-1124), which keeps received lines but sorts by PO submission (or creation) date.
  The audit found 3 of 76 products would pick another PO by receipt date, at the same cost. Fix: sort by receipt
  date or relabel.

### KI-165 — A cycle count open across a stock-unit change would save in the new unit

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Agent (unassigned) · plan W2-11 · #1896.

**MED (latent) · OPEN · inventory · found 2026-11-16 (Luna, #1896 whole-branch round) · unassigned**
The #1896 stock-unit lock (`20270121110000`) refuses a unit change while stock is on hand, but a cycle count opened on
an empty stock row in the old unit can be completed after the change, recording the counted number in the new unit.
Not reachable today: the product setup guard refuses any stock-unit change on a saved product, so the lock is a second
layer. **Decision (Mason, 2026-11-16: "Ship, log the gap"):** #1896 ships with this open. Fix before saved-product
unit changes are ever allowed: refuse a unit change while a count is open on the product, or refuse completing a count
whose unit differs from the product's.

### KI-168 — A received PO line spelled differently from its product's unit gets no cost snapshot

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · HIGH · Agent (unassigned) · plan W1-11 · #1896.

**HIGH (latent) · OPEN · purchasing/costing · found 2026-11-17 (Sol round 6, #1896) · unassigned**
The #1896 line guard accepts an alias spelling (e.g. "EA" for `Ea`) on a received PO line without rewriting it, and the
PO cost-snapshot trigger needs the exact spelling, so the receipt saves no conversion snapshot and that purchase cannot
be chosen as an actual-purchase cost basis. 1 live open line (a Powder Keg line in "EA"). Purchase-cost valuation is
parked, so nothing reads it yet. **Decision (Mason, 2026-11-17: "Accept and land"):** #1896 ships with this open. Fix
before actual-purchase costing ships: compare units case-insensitively in the snapshot trigger, or normalize the
spelling on receipt.

### Also open in this area (tracked as GitHub issues or parked fixes; plain-English detail in [the plan](MASTER_FIX_PLAN.md))

| ID | Sev | Status | What goes wrong | Owner | Plan |
|---|---|---|---|---|---|
| #2190 | MED | Open | Two deliveries completing at the same moment on the same products can make one fail and need a retry; nothing is saved wrongly. | Agent (unassigned) | W2-12 |
| #2193 | MED | FIXED-ON-STAGING | If applied before the EPA batch, the one-time load commits with some ingredients missing their groups and never fills them later. Fixed: the live-apply tooling refuses the load until at least 90 of its 123 list rows match an active ingredient on live (shows the count). | Agent (Lane D) | W2-13 |
| #2172 | LOW | Open | A very large batch (about 3,000 approvals) could make Confirm silently send nothing. Not reachable today (hundreds of rates). | Agent (unassigned) | W3-16 |
| #2135 | LOW | Fix in review (`20270213100000`, branch `claude/lane-c2-single-short-stock`) | Staff see an inflated short-stock count and get two warnings and two notifications; stock math is right. | Agent (unassigned) | W3-17 |
| #1912 | LOW | On staging, not live | Retry keys with hidden characters are now refused. Issue can be closed once released. | Agent (unassigned) | R-13 |
| #1829 | LOW | Check first | A confirmed rate approval could be lost if the reply is dropped and the user leaves. | Agent (unassigned) | W3-51 |

---

## Invoices, billing and returns

### KI-10 — Some live functions replayed a saved result matched on the retry key alone

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · MED · Taha (to 2026-12-15) · plan W2-14.

**MED (billing remainder only) · PARTIAL · money/database · remainder deferred to after Taha's billing work (2026-12-15)**
**Live re-check 2026-11-21 (read-only, production):** of the 252 public function versions that take a retry key, none
outside quotes, invoices, payments and billing still replays a changed request. Batches 1–4e bind theirs to the
caller and request; the rest check the request themselves: the Product Master functions through
`_product_parent_replay` (caller and request fingerprint), the delivery-receipt email functions, customer, team-note,
vendor-alias, supplier-link, pricing and EPA functions by a stored fingerprint or every argument, and
`stamp_job_printed`, `reverse_application_record` and `resolve_offline_action` by their only business arguments
after their role check. The stock movers the stock-unit work touches (`complete_delivery`,
`start_and_complete_delivery`, `cancel_order`, `bulk_import_order`) are bound too. **Still open, deferred (Taha
owns quotes, bookings, invoices and billing until 2026-12-15):** `post_invoice_group` replays on the key alone
(confirmed); `auto_expire_quotes` takes no request to compare; the other quote, invoice, credit-memo, payment
and finance-charge functions (`save_quote`, `save_invoice`, `post_invoice`, `create_quote_version`,
`restore_quote_version`, `convert_quote_to_order`, `create_invoice_from_order`, `create_invoice_from_blend_ticket`,
`create_invoice_for_unbilled_delivery`, `apply_credit_memo_to_invoice`, `reverse_credit_memo_application`,
`unapply_credit_memo`, `allocate_payment`, `record_invoice_payment`, `generate_finance_charges`,
`save_field_app_split_invoice`, `revert_quote_status`) show their own request checks but were not each proven;
re-check them function by function when that work reopens. History of the batches follows.
When a user retries an action with a saved "retry key", these functions return the first call's saved answer
without checking that the retry is for the same person and record. Nothing is double-charged; a reused key with
a different target gives a false "success" on the wrong record. Fixed on `main`: batch 1 (`20261016060000`,
PR #942), batch 2 (`20261016140000`, PR #951), batch 3a (`20261019200000`, PR #954), batch 3b (`20261019235000`,
PR #967), batch 4a (`20261102180000`, PR #1288, applied 2026-11-02: `unpost_invoice`, `unpost_invoice_group`,
`close_accounting_period`, `reopen_accounting_period`, `transfer_invoice_to_job`, `save_field_app_invoice`,
`update_field_app_invoice_billing`, `consolidate_draft_invoices`, `update_blend_ticket_billing_status`,
`create_rebate_claim`, `transition_rebate_claim`). Batch 4b (`20261103130000`, PR #1299, applied live 2026-11-03, ledger `20261103013009`) binds
`price_order`, `update_order_items` and `mark_inventory_row_verified` (MED, PR #1042 follow-up 3; Mason: "batch
it"). Batch 4c (`20261110160000`, applied live 2026-11-05) binds the purchase-order, quote-copy, delivery, cycle-count
and blend-ticket writes: `submit_purchase_order`, `cancel_purchase_order`, `delete_purchase_order`,
`duplicate_quote`, `edit_delivery`, `reassign_delivery`, `batch_reschedule_deliveries`, `confirm_delivery`,
`create_delivery_with_items`, `create_followup_delivery`, `cancel_cycle_count`, `reverse_blend_ticket_approval`.
Accepted without a wrapper (reason): `void_invoice` (already binds its request); `save_purchase_order` (its bulk
path is bound; the single save is an edit of one record); `increment_customer_prepay`, `restore_cancelled_delivery`
and the `_section9_*` inner bodies (no app caller; only the database owner and service role can run them);
`apply_remaining_prepayments` and `batch_apply_all_prepayments` (always refused, disabled);
`admin_save_application_service` (admin-only edit of one setting row). Batch 4d (`20261114200000`, PR #1528, applied live 2026-11-06, ledger `20261106035950`) binds 25 records
functions and requires a key on each: `admin_update_profile`, `batch_approve_blend_tickets`,
`batch_reject_blend_tickets`, `bulk_create_label_drafts`, `commit_label_draft`, `create_label_draft`,
`create_blend_ticket`, `save_blend_ticket`, `save_blend_ticket_fields`, `dismiss_watchdog_flag`, `delete_vendor`,
`reactivate_vendor`, `save_vendor`, `link_fields_to_parent`, `unlink_field_from_parent`, `review_customer_fact`,
`supersede_customer_fact`, `save_blend_recipe`, `save_field`, `save_field_crop_history`, `save_field_geometry`,
`save_field_polygons`, `set_application_record_lots`, `set_field_boundary`, `set_field_override_acres`.
It also limits `save_blend_recipe` to an active admin or sales rep, as both app recipe screens already were.
`link_fields_to_parent`, `unlink_field_from_parent` and `save_field_polygons` also refuse a "performed by" naming someone
other than the signed-in user (the app always sends the signed-in user).
Batch 4e (`20261123110000`, applied live 2026-11-06, ledger `20261106154806`, after the app PR #1518 that sends a key
on the six keyless notification and applied-info calls was serving in production) binds 15 operations
functions and requires a key on each: `confirm_job_notification_sent`, `record_job_pre_notifications`,
`record_job_post_notifications`, `log_failed_notification`, `assign_job_applicator`, `dispatch_job_locations`,
`undispatch_job_locations`, `start_job`, `create_job_from_quote_section`, `update_field_app_applied_info`,
`create_quote_from_template`, `rollover_quote_to_season`, `save_quote_template`, and the two disabled bulk
prepayment functions `apply_remaining_prepayments` and `batch_apply_all_prepayments` (still always refused).
Exceptions: the three calls PR #1518 began keying (`confirm_job_notification_sent`, `log_failed_notification`,
`update_field_app_applied_info`) still accept a call with no key and run it exactly as before (no receipt). A browser
tab opened before PR #1518 can then still mark an email it already sent, log a failure, and save applied info after
its invoice. A key-carrying call is bound like the rest.
After 4e, only the accepted exceptions listed for batch 4c remain.

### KI-16 — Sub-cent and rounding gaps

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Agent (unassigned) · plan W3-18.

**MED/LOW · mixed · money · unassigned**
- APPLIED LIVE 2026-11-10 10:49 AM Central (`20261231100000`, ledger `20261110164910`, PR #1733; contract `docs/plans/2026-11-10-ki16-rate-unit-denominator-and-invisible-chars-CONTRACT.md`):
  a rate unit measured per something other than acres ("oz/cwt", "oz per cwt") is refused when any job line or blend
  ticket line is written (scheduling from a booking, the recipe RPC, blend ticket create/save), with save_job's rule
  and message; `baseUnitOfRate` keeps such a unit whole instead of reading it as "oz". `normalize_rate_unit` and its
  TypeScript mirrors now fold zero-width and non-breaking characters, so a pasted unit no longer blocks billing.
  (KI-16 named `_close_quote_as_applied`; the real booking path was `create_job_from_quote_section`.)
  APPLIED LIVE 2026-11-10 8:05 PM Central (`20270101000000`, ledger `20261111020528`, PR #1741; contract `docs/plans/2026-11-10-ki16-rate-unit-followups-CONTRACT.md`):
  "fl. oz" with a period now reads as fluid ounces (bills on a liquid product, still refused on a dry one);
  `save_job` folds invisible characters before its own check; tabs, line breaks and every other character
  JavaScript trims count as a space on both sides; soft-deleted tickets no longer block a product unit edit; the
  blend screen's invisible-only unit warning shows on zero-rate lines too; the prover bills real invoices.
  Accepted (Mason, 2026-11-10, Sol round 5 HIGH): the product rate-unit guard skips billed tickets, so if a ticket
  with a blank line unit is billed, its product's unit then changes to a per-X unit, and the invoice is voided,
  re-billing is refused until someone types the line's unit (may need the order unlinked first).
  Dry fluid ounces (Luna 2026-11-10 HIGH, Sol round 1 HIGH; Mason 2026-11-10 "Yes, fix here", PR #1741): a blend
  line on a dry product whose billed unit names fluid ounces in any spelling ("fl oz/ac", "fl<TAB>oz", "fluid ounces
  per acre") is refused at save (`CHEM_UNIT_FORM_MISMATCH`), as job lines already were; before, 16 fl oz/ac billed
  as 1 lb/ac. A dry product's own rate unit can never be fluid ounces, whatever its tickets' state. Live read-only
  2026-11-10: 0 rows affected. Still open, LOW: the normalizer still maps undotted "fl oz"
  to "oz", so a direct table write that skips the triggers would bill it as weight. Also LOW (Taha, PR #1741): a tab
  in a job line's stock Unit is still refused (`CHEM_UNIT_UNSUPPORTED_CHARACTER`, fails closed); folding it would
  make the non-admin cost lookup miss a stored line (Sol round 3), so it needs the lookup folded too.
  Dry fluid ounce on every other writer (Luna 2026-11-10): job lines, booking lines, a blend line's quantity unit
  and a dry product's size and stock unit could still name fluid ounces, which holds and deduction size as weight
  (16 fl oz as 1 lb). APPLIED LIVE 2026-11-11 9:14 AM Central (`20270103140000`, ledger `20261111151436`, PR #1766; contract
  `docs/plans/2026-11-10-ki16-dry-fluid-ounce-CONTRACT.md`): each is refused (`CHEM_UNIT_FORM_MISMATCH`), and every
  product must have a form (Mason 2026-11-10; a saved form cannot change, so no product turns dry under its lines;
  importing a product with a blank form is now refused). Not covered (existing): gal/pt/qt on a dry product converts
  to nothing, so billing refuses it and job completion deducts the raw number flagged for office review.
  Inherited from `20261231100000`, raised by Astra 2026-11-10, UNVERIFIED: a blend line moved
  to another ticket, or a `no_charge` ticket made billable again, is not re-checked; the guards are invoker triggers,
  so a writer who cannot see a row may get a pass; "pt per ac" passes the guard but not the normalizer (fails closed
  at billing).
- A job chemical line's per-unit COST is still rounded to whole cents when it is converted from the product's
  stock unit to the rate's unit (`reconcileChemAutofillUnits`, and `save_job`'s cost fill in `20261019230000`):
  $5/GAL is 3.90625¢/oz, saved as 4¢, so 400 oz shows $16.00 of cost against $15.625 and the job's margin is off
  by that much. The PRICE is no longer rounded (2026-10-23: left blank unless exact). Cost is not billed. LOW-MED.
- Split-acre shares are rounded to 2 decimals per customer, so a field's shares can differ from its acres by
  about 0.01. CONFIRMED, LOW, re-checked 2026-11-10 (code-read + live read-only). `derive_customer_shares_from_fields`
  (`20261023090000`) rounds each customer's acres on its own and does not give the leftover hundredth to one
  customer. One live split field was off by 0.01; the percentages still added to 100. The billed money is exact:
  the field-application split uses largest-remainder cents. No fix applied. The acre display can stay unless Mason
  wants the shares to add up to the field.
- Partial-delivery draft resize stores header cost as the sum of unrounded line extensions (main `20261215110000`
  ~L1237, staging `20270203120000` ~L640), while automatic invoice creation rounds each line (main ~L1403, staging
  ~L806): two half-cent lines give 1¢ versus 2¢. The verified effect is a draft cost-header difference; no ordinary-sale
  P&L or Monthly Summary effect is shown (they recompute cost per line; their credit-memo/header branches are unchecked).
  Proof: the same half-cent fixture through both creation paths. Found by Terra, re-verified
  2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md)). LOW.

### KI-110 — Three small invoicing findings from the October admin-only invoicing review

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Taha (to 2026-12-15) · plan W3-19.

**LOW · OPEN (CONFIRMED 2026-11-10, all three parts) · invoicing · source: [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md)**
- CONFIRMED, LOW, re-checked 2026-11-10 (code-read + live read-only). `_update_order_items_impl` locks the order
  and then clears `invoice_items.order_item_id` on draft, voided and cancelled invoices without locking the
  invoice. A rep's order-line edit can change that link after an admin's versioned post compared the invoice.
  No amount changes. Recommended fix, not applied: lock those draft invoices before clearing the link.
- CONFIRMED, LOW, re-checked 2026-11-10 (code-read + live read-only). Cancelling a quick delivery marks the order
  cancelled and then marks its open draft invoice cancelled without zeroing the money. The invoice guard allows
  that only when the total is 0 cents; otherwise it raises `ORDER_INVOICE_TERMINAL` and the whole cancel rolls
  back, for an admin or a rep. Container-confirmed 2026-11-10 about 2:20 PM Central on a fresh read-only dump of the
  live schema (`cancel_delivery`, `_cancel_delivery_replay_impl_20261015` and `guard_invoice_terminal_order`
  match live by md5): a scheduled quick delivery whose order has an open draft invoice of 2,000 cents is refused
  with `ORDER_INVOICE_TERMINAL` for an admin and for a rep, and nothing changes; the same invoice at 0 cents
  cancels the delivery, the order and the draft. Live read-only the same day: no open quick delivery has a
  non-zero draft, so nobody is stuck today. Recommended fix, not applied: zero the draft's money before
  cancelling it, the way voiding an order already does.
- CONFIRMED, LOW, re-checked 2026-11-10 (live read-only grants; policies re-read in the repo). `finance_charges`
  still grants table writes to signed-in users. Its policies are admin-only, so the row rules refuse them. This
  is clean-up debt, not a hole. Recommended fix, not applied: drop the extra table grants.

### KI-157 — Invoice PDFs print the product's current name, not the name it was sold under

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Taha (to 2026-12-15) · plan W2-15 · #2183 (related).

**MED · OPEN · money/documents · found 2026-11-13 ([Product Master review](../audits/2026-11-13-product-master-review.md) C-2) · unassigned**
`supabase/functions/_shared/pdf/invoicePdf.ts` uses `row.product?.product_name || description` (~L100, printed ~L196
and ~L1431). It also falls back to the live product's EPA number and form when the line's own is blank (~L113, ~L115).
Renaming a product in Product Master therefore changes every old posted invoice PDF and re-sent email, against the rule
that historical invoices are preserved. The quote PDF and applicator sheet also read live names (LOW). Fix: print the
line's stored name, EPA number and form; together with KI-117. The PDF code is in a shared Edge Function file, so the
fix needs an Edge deploy with Mason's approval. Repair step 3 (To-Do 0.17).

### KI-131 — Cancelled and voided invoices keep money amounts in the database

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Taha (to 2026-12-15) · plan W3-20.

**LOW (latent) · OPEN · money/invoicing · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 3 #8) · unassigned**
Delivery void cancels the draft invoice without zeroing its total (order void and cancel do zero it); invoice void zeroes
the header but leaves the lines (live: CS-2026-0179, and voided CS-2026-0058, CS-2026-0173, INV-2026-1522, INV-2026-1528).
Every report checked filters them out by status; a future query that forgets would count them. Fix: zero the total in
`_void_delivery_replay_impl_20261015`.

### KI-153 — `create_invoice_from_order` can no longer bill a product line

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Taha (to 2026-12-15) · plan W3-21.

**LOW · OPEN · invoicing · found 2026-11-11 (PR #1805, live smoke fixes) · unassigned**
Since `20261029160000_cap_order_invoices_at_delivered`, order invoices may bill only delivered goods, and
`create_invoice_from_order` refuses any order with an active delivery. Together these leave it unable to bill any
product line (delivery-first billing, by design). Fix: retire the function or document that it bills non-product
charges only.

### KI-189 — A return after a repriced invoice line credits the order price

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Taha (to 2026-12-15) · plan W2-16 · #2180.

**MED · OPEN (source-confirmed on main and staging; not reproduced) · money/returns · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 2) · unassigned (credit memos are Taha's billing area) · GitHub #2180**
Re-saving an ordinary draft invoice keeps a line's `order_item_id` and saved cost only when its unit price is unchanged
(`_save_invoice_lineage_unaware_impl_20260827`, `20261106140000` ~L306-312). The ordinary return prices the credit from
the order line (`_create_return_intent_impl_20260812`, `20261215110000` ~L2079-2081) and its cap checks the order
price (`20261021155000` ~L963-988). A fictional order line at $100 billed at $90 can credit $100 a unit, and the cost
reversal can lose its link. Discounted and taxed returns are NOT safe either: they find the billed line through the
same `order_item_id` (`20270109100200` ~L557-616), so a repriced line falls back to the ordinary path or is refused.
Split invoices are mostly protected: the regular save refuses editing a governed split invoice and refuses repricing
a Bill Split draft's product lines (`20261215110000` ~L1682-1724). Where a split line has lost its link anyway (old
data), the billed-line lookup (~L557-582) finds only the payer's other linked lines, and the return is refused
(~L2066-2081) only when no billed quantity remains. Live (audit aggregate, not re-run): 0 of 6 eligible posted lines
differ from their order price. Fix: credit from the billed line. Proof (rolled back): a price decrease and an increase,
a discounted or taxed reprice, the regular save still refusing a split reprice, a seeded split line with lost linkage (with and without another
linked billed line), the linked cost reversal, and the intended delivered-but-unbilled return path
(`20260827041100` ~L1281-1314) unchanged.

### KI-72 — A fix merged on `main` whose last steps are still pending (moved here from "closed")

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · MED · Mason decision · plan W2-17 · #885, #1114, #1147.

**MED · PARTIAL · security/money · Mason**
CRX-LIFE-001, reps creating a `field_application` invoice through the order
pipeline: fix merged (PR #885, `20261006200000`, applied live per the old record). Two proof gates remain: the 29th
live-sweep predicate (`quote-versions-rpc-owned`) was declined at its prompt, and the live smoke chains need
Mason's REAL-DATA-OK.

Purchase order copy (To-Do 0.15, PRs #1114 and #1147): DONE. The `send-email` service has handled
`purchase_order` since v20 (2026-10-27) and still does on v21 (2026-11-03 02:16 UTC); Email PO Copy on
PO-2026-0030 sent and arrived on v21. See `CURRENT_STATE.md`, Recent production deployments.

### KI-76 — Quote, season, invoice and return details (extends KI-12, KI-14, KI-18, KI-20, KI-69)

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · MED · Taha (to 2026-12-15) · plan W2-18 · #1731, #1174, #1556.

**MED/LOW · OPEN · money**
- Quote re-save can still be refused when a save both deletes or switches a saved line and adds several new lines
  for the same product (LOW).
- Split billing: a split can bill any customer named in editable order allocations, field owners or billing
  defaults (MED). Decided for field splits (Mason, 2026-11-08): only payers saved on the field's split, or on
  the job's own split; built in foundation 18.1 (`docs/plans/2026-11-08-fields-who-pays-BUILD-SHEET.md`). Any rep can read another rep's
  split-return lines and prices under `return_items_select` (LOW).
- Invoice lines could be written with no unit (from an order line or delivery line with no unit), so they could never
  get a return credit (MED): FIXED by `20270106100000` (applied live 2026-11-11, PR #1731). A new order line with no unit takes the product's
  unit; a sale line with no unit takes the order line's unit, else the product's; a delivery always completes, and
  posting a chemical-sale invoice is refused (`INVOICE_LINE_UNIT_MISSING`) while any product line, with or without an
  order line, still has no unit (Mason, 2026-11-10: no sale line posts without a unit); `create_invoice_from_order`
  refuses a no-unit line (`ORDER_LINE_UNIT_MISSING`); a quick-delivery line always records its product's unit
  (Mason, 2026-11-10). Known limit: an old line whose order and invoice units are both empty text (0 live) is filled
  with the product unit and its return is refused. Not backfilled (Mason's call): 2 open drafts have a line with
  no unit (2026-11-10): **CS-2026-0056** and **CS-2026-0070**, one customer, a `Gal` product. Once applied, posting
  either is refused until it is saved (it then takes `Gal`); a return on them stays refused, because their order
  lines also have no unit (5 such order lines, all on fulfilled orders). Also open (PR #1731 follow-ups): a line
  inserted at the same instant as a post, or an order line edited between the order-invoice check and its copy,
  races the check like every post-time check (LOW); the screen message drops the line names the database gives
  (LOW); one unposted field-application invoice has a product line with no unit (not checked by design). From Taha's review (2026-11-11): following the posting message on an old order line with no unit lets the invoice post, but the order line stays blank, so a return on it is still refused (LOW). A return can go stale after an earlier return is cancelled or rejected (cancel and recreate); a
  concurrent split-invoice void can leave a requested return unreceivable; credits apply manually; multi-price
  billing is credited at an average price (MED, partly by design).
- KI-69 detail: voiding a return credit is not enough; the voided credit memo must be permanently deleted before the
  source invoice can be hard-deleted or re-saved.
- Whole-order invoice unit prices are not capped server-side (MED). Removing a product from a
  scheduled delivery can leave its drafted invoice unpostable, and lowering a quantity leaves the draft over the
  delivery quantity until staff edit it (MED). Freezing a soft-deleted order can block cancelling or voiding its
  completed delivery (reversal needs a reviewed migration) (LOW). Draft invoice CS-2026-0055 is deliberately left
  (the other delivery was billed in Chem Man) (LOW). Integrity checks page by offset, so concurrent inserts or
  deletes can make a run miss or repeat a row (LOW, accepted).

- PR #1174 also preserves physical quick-delivery and follow-up completion while an edited draft needs correction; posting still rechecks the whole bill. Its split generator conserves each source quantity exactly, and the order-line and product caps have no fractional tolerance.

### KI-200 — Return approval: the confirmation opens underneath the return details

> **Re-checked 2026-11-22:** Merged to staging in PR #2210 · fresh deployed browser check pending · plan W2-51 · GitHub #2205 closed. [Acceptance checks](../audits/2026-11-22-staging-workflows-follow-up.md)

**MED · FIXED ON STAGING BRANCH (browser retest pending) · found 2026-11-22 · GitHub #2205**
Opening a requested return and clicking Approve shows the Approve/Reject `ConfirmModal`, but it is rendered before
the return-details `Modal` (`Returns.tsx` ~L1190 vs ~L1222), so the details window covers it and a normal click
cannot reach it. Keyboard (Enter) still works and approved exactly once, with the expected single stock and credit
events. Fix: render the confirmation above the details window. Proof: a fresh requested return approved by a normal
click, correct focus and Escape, exactly one approval, Approved after reload.

### Also open in this area (tracked as GitHub issues or parked fixes; plain-English detail in [the plan](MASTER_FIX_PLAN.md))

| ID | Sev | Status | What goes wrong | Owner | Plan |
|---|---|---|---|---|---|
| #2091 | MED | Open | A race could refund tax the ledger records as zero, misstating month-end revenue. Pattern present; race not reproduced. | Taha (to 2026-12-15) | W2-19 |
| #2082 | MED | Check first | A restricted-use line could re-save as non-restricted so the RUP sales record is skipped on posting. Setter file located; re-derivation not traced. | Taha (to 2026-12-15) | W2-46 |
| #2073 | LOW | Check first | Invoice header may show the earlier customer. Live-unchanged per the issue; not traced. | Taha (to 2026-12-15) | W3-52 |
| #2072 | LOW | Check first | During a staged apply a draft could briefly carry sales tax. Release-time concern, checkable only by a live post-apply query. | Taha (to 2026-12-15) | W3-53 |
| #2069 | LOW | Partly open | A line could be priced in a different unit than the quote. The grower-share cost read now locks the product row (FOR SHARE); other reads in the save not checked. | Taha (to 2026-12-15) | W3-22 |
| #2066 | MED | Check first | A return could be refused after the tax box changes. Detail withheld in issue; not traced. | Taha (to 2026-12-15) | W2-47 |
| #2105 | MED | Check first | A posting could use a product with no sold unit. The save path already refuses it (FIELD_APP_UNIT_UNCONVERTIBLE); posting itself not checked. | Mason (field-app billing) | W2-48 |
| #2104 | LOW | Partly open | Mostly done for the grower-share cost read; other product reads in the save not confirmed locked. | Taha (to 2026-12-15) | W3-23 |

---

## Payments and receivables

### KI-120 — Any rep can change a customer's payment terms and finance-charge settings

> **Re-checked 2026-11-21 on staging `3a9694685`:** Accepted · MED · Mason decision.

**ACCEPTED (Mason, 2026-11-19, To-Do decision 18: reps keep access; no code) · security/money · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 3 #4, sweep 2 Q1)**
The 2026-11-01 lock made price tier and credit limit admin-only; payment terms, finance-charge on/off, rate and grace
days are not covered, so a rep can move a customer to Net 90 or turn off late fees (also parent customer and default
application service). Mason chose to keep it this way (To-Do decision 18); no fix is planned. Reopen only if he
changes that decision.

### KI-20 — Shelved or disabled money features

> **Re-checked 2026-11-21 on staging `3a9694685`:** Mason decision · MED · Mason decision · plan D-02.

**MED · OPEN · money · unassigned / Mason**
- Prepay bulk-apply is hard-disabled with `PREPAY_BULK_APPLY_DISABLED` (`20260620200000`) because it could
  double-spend credits; real fix needs the shelved redesign. Per-invoice apply works.
- The earmark engine (`docs/roadmap/shelved-earmark-engine/`) is shelved for a full redesign (Mason, 2026-06-14);
  do not apply.
- Split billing, per delivery of a partly delivered order: the old "each delivery rounds on its own and loses
  cents" description was not reproduced on 2026-11-10 (code-read + live read-only). Current Bill Split
  (`20261215110000`) bills the cumulative cents through this delivery minus the cents already billed, and the
  other payers round down while the main customer takes the leftover cent. Not closed. Follow-up the same day
  on a Docker machine: `prove-allocated-line-cents.mjs` PASSES, but it proves a different bug (the August
  tier-split draw-down, against function bodies pinned on 2026-08-17), not the per-delivery Bill Split case.
  `smoke-chem-sale-bill-split-invoices.sql` has no container runner, only a live rolled-back run, which a
  read-only check may not do. Still owed: run that smoke in a container on a live schema dump.
  Negative-quantity credits and reopening a saved split set are still not supported (they fail closed). LOW.
- Auto-draft invoice does nothing when an applicator completes a job; policy is Mason's, switch is off. MED, dormant.
- Two commission design choices wait on Mason (do blend tickets create commissions; may applicators see a job's
  commission split). UNVERIFIED, LOW.

### KI-127 — Finance charge rate: the screen says "%" but the system treats it as an annual rate

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · MED · Mason decision · plan W2-20. Screen label already says "% a year"; only Mason confirming the two customers' rates remains.

**MED · PARTIAL (the screen label now says "Finance charge rate" with "% a year", PR #1872, in main; Mason still has to confirm the two customers' values) · money/AR · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 3 #3) · unassigned**
`CustomerDetail.tsx` used to label it "Finance Charge Rate (%)"; the generator and preview compute overdue x rate / 100 / 12.
Two active customers are set to 1.5; if that means 1.5% a month they would be charged one-twelfth. No finance charges
have run yet. Fix: label "Annual rate (%)" with helper text, and Mason confirms the two values (To-Do decision 17).

### KI-132 — Reminders and finance charges ignore money the customer already has on account

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Mason decision · plan W3-24.

**LOW · OPEN · money/AR · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 3 #10) · unassigned**
`get_ar_reminder_candidates` returns but does not subtract unused prepay or credit, and lacks `deleted_at IS NULL` on its
main invoice filter; the finance charge generator sums balances only. 0 overlap live. Policy is To-Do decision 21; add
the `deleted_at` filter either way.

### KI-147 — Customer payment terms are free text and anything unrecognized becomes Net 30

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-25.

**LOW · OPEN · customers/AR · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 2 #6) · unassigned**
`parse_payment_terms_days` returns 30 for "COD", "due_on_receipt" and similar; the customer screen's field is free
text while invoices use presets. Every live value parses correctly today. Fix: the same preset list plus "Custom (N
days)", and have `save_customer` refuse terms the parser would default.

### KI-75 — Retry-key detail (extends KI-10, KI-11)

> **Re-checked 2026-11-21 on staging `3a9694685`:** Check first · HIGH · Taha (to 2026-12-15) · plan W1-13. The credit-memo apply race after the lock was not re-proven in this pass.

**HIGH on money paths · OPEN · money**
`transfer_invoice_to_job` and `update_field_app_invoice_billing` are now bound (batch 4a, `20261102180000`). Still
open: the after-lock race in `apply_credit_memo_to_invoice`. Screen-side items, closed 2026-11-02 with KI-11 (same
branch): JobDetail's reset-before-call defects are fixed. DeliveryDetail (edit, reassign, confirm, create invoice)
and FieldStop (confirm) now keep a key per record or payload. Accepted with no change: the `PrepaymentManagerPanel`
split-check modal, because batch 1 (`20261016060000`) binds `create_prepay_check_splits` on the server and the
screen already resets only after a confirmed save. Also accepted: OrderDetail. `update_order_items` keeps one key
per order, and a payload change is refused with a conflict dialog that reloads the order (by design).
`price_order` already rotates its key when the payload hash changes. Cancel and split are per-order.

### KI-202 — Payment History: expanding a payment's invoice allocation fails to load

> **Re-checked 2026-11-22 on staging `17a72d0ee`:** Open · MED · Taha (to 2026-12-15) · plan W2-53 · #2207. From the [2026-11-22 staging rehearsal](../audits/2026-11-22-staging-rehearsal-issues.md).

**MED · OPEN (reproduced on staging; source-confirmed) · payments/finance (display) · found 2026-11-22 (rehearsal CRXN-04) · unassigned (Taha's billing area) · GitHub #2207**
The allocation read embeds `invoices ( invoice_number )` from `invoice_line_allocations` without naming which link to
use (`PaymentHistory.tsx` ~L134-139). The table has two links to `invoices`, so the request is ambiguous and returns
HTTP 300; the detail shows nothing. The $300.00 allocation itself was saved correctly. Fix: name the intended
relationship in the embed. Proof: the exact fixture and one using the other link load, a failed load shows an error,
and saved amounts and the customer balance are unchanged.

---

## Reports and commissions

### KI-13 — Returns never reduce already-earned commission; commission rules unbuilt

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Mason decision · plan W2-21. Clawback overlaps KI-184 (profit reports) and To-Do 8.3; whole-cent commission columns still open.

**MED · OPEN · money · Mason decision exists (2026-08-09), not built**
Commission clawback on returns has no function or migration on `main`. Also open: `commission_payments.total_amount`
is stored as dollars with decimals (checks force clean cents, but the column breaks the integer-cents rule;
MED); two money columns (`commissions_order_profit_whole_cents_chk`, `quotes_total_cost_whole_cents_chk`) can still
hold sub-cent values, adding the checks is Mason's call (LOW-MED); the old name-reuse guard trigger
`trg_guard_recipient_name_reuse` is deliberately kept until all app versions send person IDs, so renaming someone
can make old splits refuse to save (LOW-MED).

### KI-125 — Bottom Line P&L and Monthly Summary subtract commissions on every booked order but count only CRX-invoiced revenue

> **Re-checked 2026-11-21 on staging `3a9694685`:** On staging, not live · HIGH · Taha (to 2026-12-15) · plan R-09 · #2149.

**HIGH · OPEN (fixed on staging, awaiting the production release: #2149 merged to staging 2026-11-22; `20270206110000` not in the live ledger 2026-11-21, re-verified in the [2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md)) · was: FIX IN REVIEW (Claude, `20270206110000_pnl_commission_share_billed.sql`, to staging; [contract](../plans/2026-11-21-pnl-month-end-report-fixes-CONTRACT.md)) · money/reports · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 3 #1)**
Revenue counts posted/overdue/paid invoices by invoice date; commissions count every non-replaced commission by order
date, invoiced or not. Most 2026 sales were billed in Chem Man, so net profit shows a six-figure loss that is not real
(only 1 of 35 commissioned orders has a posted CRX invoice). Where: `_get_bottom_line_pnl_cost_impl_20261019` and
`get_monthly_summary` (`20261106150000_fix_delivery_one_screen.sql`). Mason decided 2026-11-10 (To-Do decision 15,
DECISION_LOG): count a commission only when its order has a CRX invoice in the period's revenue set. Refined 2026-11-13 (DECISION_LOG,
"Split by share billed"): a partly billed order counts only the share of its commission matching the share billed in
that period, so checking that an invoice exists is not enough. Fix on staging: an order's commission counts in each
period by the share of its product sales billed on CRX sale invoices (cumulative, capped at 100%); a field application's
commission counts when its field invoice is billed. A return credit does not take commission back yet (KI-184).

### KI-184 — Profit reports do not take commission back when product is returned

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Taha (to 2026-12-15) · plan W2-22 · #2149 (follow-up).

**MED · OPEN (follow-up to KI-125; Mason 2026-11-21 "ship without, log as a follow-up") · money/reports · found 2026-11-21 (#2149 Sol round 5)**
After KI-125's fix, Bottom Line P&L and Month-End Close count an order's commission by the share of it billed, but a
return credit memo does not take any of it back, so a returned sale keeps its commission cost in the reports. Mason's
rule (2026-08-09, reaffirmed 2026-11-13) is that a return takes commission back in proportion. #2149 tried it and Sol
found two problems: return credits include sales tax and reflect discounts that the sales share does not, and billing
above the booked total can absorb a return entirely. Older credit memos can also have no lines. No live credit memo
existed when this was logged. Fix: measure the returned share on the same basis as the sale (product lines before tax,
discounted the same way), against what was billed rather than the capped total. It reads credit memos, which are
invoice records: plan it with Taha (billing until 2026-12-15). Commission rows themselves are KI-13.

### KI-126 — P&L and Monthly Summary would multiply application-fee cost by acres twice

> **Re-checked 2026-11-21 on staging `3a9694685`:** On staging, not live · MED · Agent (unassigned) · plan R-11 · #2149.

**MED (latent) · OPEN (fixed on staging with KI-125 (#2149; both reports use the fee-cost case, `20270206110000` get_monthly_summary ~L207 and the P&L cost function ~L249; awaiting the production release) · money/reports · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 1 #2)**
Fee lines store cost already extended by acres, with quantity = acres; both reports compute `cost_cents x quantity`.
100 acres at $2/acre cost would show $20,000 COGS instead of $200. Latent: every live application service costs $0
today. Fix: use the `is_application_fee` case `save_invoice` already uses, plus a prover with a costed fee line.

### KI-129 — Monthly Summary and the month-close summary show $0 payments and undercount invoices

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · HIGH · Agent (unassigned) · plan W1-01 · #2149 (count part), #2195 (payments part). Invoice count fixed on staging (#2149). Payments received still totals the old payments table, counts deleted payments and misses allocation-set receipts (#2195, Sol on #2189), so a month paid through allocations can show $0 received.

**MED · PARTIAL (the close receipt's invoice count is fixed on staging with KI-125 (#2149), awaiting the production release; payments received is OPEN, a follow-up: it needs a rule for prepayment checks, which can be edited or deleted later, and a re-check at close that the figures still match what the admin reviewed) · money/reports · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 3 #6)**
Both read the legacy `payments` table (0 rows; payments now live in `allocation_sets`), so the one July 2026 customer
payment shows as $0. The close summary also counts only invoices still `posted`, missing ones since paid or overdue.
Where: `get_monthly_summary` and `_close_accounting_period_replay_impl_20261015`. Fix: sum active payment
`allocation_sets` (UNION the legacy table, as the statement does) and use posted/overdue/paid.

### KI-130 — Monthly Summary's "AR balance" is always today's AR

> **Re-checked 2026-11-21 on staging `3a9694685`:** On staging, not live · LOW · Agent (unassigned) · plan R-14 · #2149.

**LOW · OPEN (fixed on staging with KI-125: #2149, screen label only, "Current AR (today)"; awaiting the production release) · money/reports · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 3 #7)**
`get_monthly_summary.ar_balance_cents` has no date filter, so a past month shows today's receivables. The AR Aging tab
has the real as-of figure. Fix: relabel "Current AR (today)" or reuse `get_ar_aging(p_period_end)`.

### KI-133 — Profitability and Gross Sales report booked orders as "revenue" without saying so

> **Fix in review (Lane E, 2026-11-22):** the reports say "Booked Sales" with a one-line basis note. Drafts need no
> filter: the database refuses a draft order status (`orders_status_check`), so Gross Sales cannot include one.

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-26.

**LOW · OPEN · money/reports · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 1 decision conflicts) · unassigned**
Both sum confirmed and partly fulfilled order lines, so undelivered value counts as revenue and profit and credits are
not subtracted, while Bottom Line P&L uses posted invoices. The order basis is recorded intent (sales-reports build
sheet, "roadmap area 2"), but the screens don't say "booked". The two also differ on drafts (Gross Sales includes
them; none exist today). Fix: label as booked sales and align the draft filter.

### KI-154 — A commission can be paid out before the customer has paid

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Mason decision · plan W2-23.

**MED · OPEN · money/commissions · found 2026-11-11 ([business logic review](../audits/2026-11-11-business-logic-review.md) finding 2) · unassigned**
The 2026-11-09 decision (CRX Notes, "commission after discount") says commission is paid only after the customer pays.
`_create_commission_payment_intent_impl_20260809` (newest body in `20261204100000_ki18_batch1_chicago_today.sql`)
checks only that each selected commission is still `pending` and that the payout balances; it never looks at the
order's invoices or payments. Also unsettled: how partial deliveries, partial payments, corrections, cancellations and
credits move a commission (returns are KI-13). Decided 2026-11-13 (DECISION_LOG): commission counts in profit when its sale
is invoiced (by share billed, KI-125) and becomes payable only when the customer pays, a partial payment releasing the
same share. Fix later: enforce the payable rule, per sale and per paid share, in the payout function.
- **Commission basis ignores the standing discount (re-verified 2026-11-21, [2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md)).** Order commission is figured from `orders.total_profit` before the standing grower discount (`20270117130000_standing_discount_in_order_profit.sql` ~L21 says "commission after the discount is its own planned change"), while the invoice and profit reports subtract the discount. Not tracked elsewhere; latent on production while the billing switch is off. Separate from the payout gap above (payout checks pending status ~L1154-1183 and header-to-items balance ~L744-761 in `20261204100000`, but no customer-payment eligibility). To-Do 8.5 needs two distinct acceptance checks: commission is figured on profit after the standing discount, and it is released in proportion to customer payments.

### KI-135 — "Inventory Value" label: relabel as pricing-basis value (D12 item 7)

> **Fix in review (Lane E, 2026-11-22):** labels say "price-list cost"; the per-row report and CSV mark rows left out of
> the total (CSV value blank, "In Total" column); profit and margin carry the saved-pricing-cost note.

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-27.

**LOW · OPEN · inventory/reports · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 1 #3) · unassigned**
The value bug itself is fixed (closed list, item 21). What remains is D12 item 7: label the Inventory page card and the
Reports Inventory Cost total as a value at price-list cost, not a book or accounting value. The same applies to margin
and profit figures built on the saved pricing cost: label them "margin at saved pricing cost", since that cost is not
necessarily what the supplier bill said ([business logic review](../audits/2026-11-11-business-logic-review.md) finding 7).
Also (2026-11-13 [Product Master review](../audits/2026-11-13-product-master-review.md) C-10): the per-row Inventory Cost
report and its CSV (`_get_inventory_cost_report_cost_impl_20261019`, `Reports.tsx`) still list negative and $0-cost
rows, so summing the CSV reproduces the old wrong total. Fix: match the rows to the summary's exclusions, or mark them.

### Also open in this area (tracked as GitHub issues or parked fixes; plain-English detail in [the plan](MASTER_FIX_PLAN.md))

| ID | Sev | Status | What goes wrong | Owner | Plan |
|---|---|---|---|---|---|
| #2175 | MED | Open | Numbers can change between the admin's review and the click, and the close saves the new ones; the commission "reviewed" box is screen-only. | Agent (unassigned) | W2-24 |
| SOL-7 | HIGH | PR #2201 open into staging | A broken or absurd order total would distort the share-billed commission in profit reports. PR #2201 open into staging (Sol round 3 clean; round 2 also required whole cents): New migration 20270208100000 refuses order totals that are not finite or are at or above the report's usable limit (1e15). | Mason decision (un-park) | R-07 |

---

## Field applications (jobs, blend tickets, field invoices)

### KI-111 — Field-acre billing: the real boundary-file import check is still owed

> **Re-checked 2026-11-21 on staging `3a9694685`:** Check first · MED · Mason decision · plan W2-49.

**MED · STILL UNVERIFIED (boundary file re-checked 2026-11-10; the other three bullets were not) · field app · source: [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md)**
- STILL UNVERIFIED, re-checked 2026-11-10. Needs Mason: a real John Deere, FieldView or .zip boundary export
  file and a test customer. The check left open at the June field-acre billing go-live is to import that file,
  confirm it bills on the file's acres, confirm the ±10% difference flag appears, and confirm redrawing the map
  does not change the billed acres.
- Field boundary bulk import has no Skip / Replace / Import-as-new choice at preview.
- Split draft invoices created automatically when a delivery completes raise no bell notification.
- The guided map-drawing tool has no "undo last point".

### KI-117 — A re-saved split-billed field-application invoice takes its product's current EPA number

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Mason (field-app billing) · plan W3-28 · #2183 (related, KI-195).

**LOW · OPEN, parked for Mason · field-app billing / restricted-use records · found 2026-11-09 (review of #1688, carried into its replacement)**
`_save_field_app_split_invoice_impl` (latest body now `20270129171000` ~L1054, insert ~L2105; re-verified 2026-11-21, which also found the line description falls back to the product's current name ~L2113; separate from KI-157's PDF fallback when the saved EPA is blank) rebuilds invoice lines without
`epa_registration`, so `_fill_invoice_line_epa` gives each rebuilt line its product's current number. If a split
invoice is un-posted, edited and re-posted after its size's number changed, the restricted-use record uses the new
number, not the one it was sold under. Live behavior today; REG-1 step 2 does not change it. The fix is to
send each kept line's stored number in that function (a large money function re-issue), so it waits for Mason's call.
Fix it together with KI-157, where every invoice PDF reads the live product name, EPA number and form (2026-11-13
[Product Master review](../audits/2026-11-13-product-master-review.md), repair step 3).

### KI-118 — REG-1 step 2 deferrals: late restricted-use lines and small record gaps

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Mason (field-app billing) · plan W3-29.

**LOW · OPEN, named deferrals · restricted-use records · found 2026-11-10 (REG-1 step 2 contract and reviews)**
- A posted line that turns restricted use later (its registration or tick changes to Yes after posting) is listed
  in Sales to check (`now_restricted_use`) but cannot be recorded from there yet. Recording it from the list is a
  later step (contract: docs/plans/2026-11-10-reg1-step2-record-line-link-CONTRACT.md).
- A record voided by the invoice void trigger is attributed on the record (who, when, new status) but writes no
  separate `rup_sales_voided` audit row, unlike `unpost_invoice`.
- The void trigger watches status and deletion, not an `invoice_type` change (no screen changes the type of a
  posted invoice).
- The seed has no lock timeout of its own and its preview does not run the facts check; run the seed in a quiet
  window. `label_url` accepts any text. The Step 1 assign/preview stubs keep their "not set up" message.

### KI-185 — Billing a finished job uses its planned acres, not the acres the applicator recorded

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · HIGH · Mason (field-app billing) · plan W1-03 · #2176.

**HIGH · OPEN (source-confirmed on main and staging; not reproduced end to end) · field-app billing/stock · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 6) · Mason (field-app billing) · GitHub #2176**
Job completion stores the actual acres per field on the application record (`_complete_job_replay_impl_20261015`,
`20261217100000` ~L783-813; with no acres supplied it falls back to the plan) but never updates `job_fields` or `job_chemicals`. Transfer to Invoice
(`_transfer_job_to_invoice_intent_impl_20260908`, `20261120100000` ~L407-412, ~L476-484) sums the planned
`acres_to_treat` for the invoice, the payer shares and per-acre service charges; office auto-draft uses the same
transfer. Completion deducts the saved, company-supplied chemical quantities after unit conversion (~L817-869), not ones matched
to the acres applied. A job planned at 100 acres and sprayed on 80 bills 100, and deducts stock for 100 when the saved
quantities still reflect the plan. Live read-only 2026-11-21: the only
active job-linked invoice is an **unposted draft** (one payer, so whole-job scope) whose acres follow the plan and
differ from its application record by a few acres; review it before it is posted. Related: KI-186, To-Do 5.3.
Decided 2026-11-21 (decision 33): always bill the acres actually sprayed. Fix: make transfer, payer shares and stock use the same figure. Proof:
a two-grower job with an uneven shortfall across fields, through both manual Transfer and office auto-draft (~L928-949),
checking each payer's own acres and per-acre fee, the stock ledger in the inventory unit, and the PDF.

### KI-186 — A job-transfer invoice drops carrier water and prints a whole charge as the unit price

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Mason (field-app billing) · plan W2-25 · #2177.

**MED · OPEN (source-confirmed; PDF not rendered) · field-app billing/documents · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audits 6 and 7) · Mason (field-app billing) · GitHub #2177**
- Neither transfer insert copies `jobs.carrier_rate_gpa` into `invoices.diluent_rate_gpa` (`20261120100000`
  ~L524-541, ~L755-779); the PDF prints a diluent line only when that rate is set (shared renderer `supabase/functions/_shared/pdf/invoicePdf.ts`
  ~L1155; legacy `src/lib/invoicePdf.ts` ~L266). Blend and
  per-line split invoices have no hand-off either. Staff can type it on the field invoice screen afterwards. Live
  2026-11-21: the one active job-linked invoice has no rate while its job has one.
- Transfer stores each payer's whole chemical charge as quantity 1 at that price (~L585-590; single payer ~L818-822),
  and the field-invoice PDF prints the applied total beside "$unit_price unit" (shared renderer ~L1173-1190; legacy ~L311-314), so
  12 gal can print as "$120.00 Gal". Single-grower jobs too.
- The multi-owner Transfer confirmation (`JobDetail.tsx` ~L5387, counting field owners ~L1695-1704) says it creates
  ONE invoice, but when the job has more than one explicit billing-default customer the database creates an invoice
  group, one per payer (`20261120100000` ~L429-448, ~L504-545); without those defaults it can create one invoice.
Fix: copy the carrier rate in all three header writers: Transfer (above), blend (`20270129190000` ~L890-901) and
per-line split (`20270129171000` ~L1980-1999); store or print the real per-unit
price, and tie the confirmation to the server's grouping rule. Proof per included origin: stored rate, rate-times-acres
total, billed unit and unit price, unchanged charge, both grouping configurations, and the rendered customer PDF.

### KI-195 — The Chemical Application Report prints today's EPA number, not the job's saved one

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Mason (field-app billing) · plan W2-26 · #2183.

**MED · OPEN (source-confirmed) · restricted-use/regulatory records · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 1) · unassigned · GitHub #2183**
Sprayed jobs keep their EPA number in `job_product_epa` (`20261204120000` ~L143-152), including an explicit unknown,
but nothing in `src/` reads it: the Chemical Application Report reads `products.epa_registration`
(`chemicalApplicationReportFetch.ts` ~L125-135) and the WPS notice reads the catalog too (`JobDetail.tsx` ~L951-997).
The applicator sheet prints no EPA column (`applicatorSheetPdf.ts` ~L239-260). The sent proof fetches the catalog
EPA (`20260630160000` ~L170-175) but the email drops it (`proofNotification.ts` ~L335-339, ~L430-444). The snapshot stores no product name, so
the live name on the report (~L179-194) is a separate question. DECISION_LOG (~L1334-1338) promised a printout
follow-up; it was never tracked. After a catalog correction a regenerated report can disagree with the job record.
Live (audit aggregate, not re-run): the one eligible snapshot matches the catalog today. Fix: the report, WPS notice and
sent proof print the saved value, and the applicator sheet gains an EPA column showing it. Proof for each of the four:
a corrected catalog number keeps the saved one, an explicit unknown prints as unknown, and an older job marked
"not recorded" by the backfill (`20261204120000` ~L23-38, ~L326-339) prints as not recorded with no catalog fallback.
The unlocked-job case applies only to outputs reachable before completion (the sent proof needs a completed job): an
unlocked job (which still uses the catalog, `20261204120000` ~L143-153). With KI-157 and KI-117.

### KI-198 — Shared-field job billing: Transfer and per-line Split Billing price the same work differently

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · HIGH · Mason (field-app billing) · plan W1-04. Rule decided 2026-11-21 (decision 31); build still needed before Transfer or office auto-draft bills shared fields.

**HIGH if Transfer is used for real billing · OPEN (rule decided 2026-11-21, To-Do decision 31; DECISION_LOG) · field-app billing · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 7)**
Transfer to Invoice and office auto-draft take the job's saved chemical price and split the dollars by acres
(`20261120100000` ~L547-566; auto-draft `20261217100000` ~L928-949). Per-line Split Billing resolves each grower's
own eligible sent quote or tier, with manual overrides (`20270129171000` ~L1686-1755; latest sent-price helper
`20270129180000` ~L117-190). Fictional: 10 gal at the job price of $20/gal, grower A (60%) owns the job quote and grower
B (40%) has its own sent quote at $36/gal: Transfer bills $200 ($120/$80); per-line billing bills $120 + $144 = $264.
Neither is proven wrong: DECISION_LOG says a booked job and its invoices keep the booked price, "Own quote only"
covers split and blend bills, and the old transfer screens are for testing only until replaced. No customer loss is
shown. Decided 2026-11-21: Transfer and office auto-draft follow the per-grower rule (decision 31); build before field billing goes live.

### KI-32 — Scale limits: some lists and pickers are still row-capped

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · MED · Mason (field-app billing) · plan W2-27 · #1497. Only the Dispatch Board 500-job cap remains; KI-28 (which it waited on) is fixed.

**MED · PARTIAL · UI/database · Mason (Goal 4)**
Most lists now page through every row (PRs #959, #1017, #1048). The order, job and purchase-order pickers now search
the database, and cycle-count locations read every row (PR #1048). The Customers and Jobs lists now read every row,
the Jobs Applicators/Customers filters match their job-id lists on the rows read (no URL-size risk), and the order and job
pickers match a customer name in the database instead of only the first 50 matching names (2026-11-05). Crop
Programs was not capped: its programs are one settings record and its product picker searches (PR #944).
The Orders list pages in the database with the true count and total of every match (`get_orders_page`, PR #1550). Dispatch
Board still lists the newest 500 jobs but now says how many match (PRs #1537, #1538; rest waits on KI-28, issue
#1497); Call Lists say how many customers match beyond their 200 (same PRs). The PR #1048 leftovers are done: Bulk
PO/Order/Quote Import read every product and match names against all of them (PR #1441); Label Data Quality, Product
Detail vendor/maker choices and the Invoice Detail customer picker read every row (PR #1512); the Field Customer
Assignment dropdown lists an exact or starting-with name first and says "Showing 20 of N" (2026-11-06). Each was shown
in the local test copy with 1,053 products and 26 customers. The blend-ticket scanner Edge Function
(`process-blend-ticket`) now reads every active product and customer in id-ordered pages, so a scanned line can match
product 1,001 and beyond (2026-11-08; live only once the function is redeployed, which needs Mason's approval).

### KI-187 — A blend ticket's app record and its linked job's completion can each take the stock

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · HIGH · Mason (field-app billing) · plan W1-07 · #2178 (open).

**HIGH (conditional) · OPEN (source-confirmed on main and staging; not reproduced) · inventory/field app · found 2026-11-21 ([2026-11-21 audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md), audit 6) · unassigned · GitHub #2178**
"Create App Record" on a blend ticket deducts stock (`20260713060200` ~L194-198, now wrapped as
`_create_app_record_from_bt_replay_impl_20261015`) and refuses only a second record for the same ticket (~L56-61); it
never looks at the ticket's job. Job completion deducts the job's chemicals (`20261217100000` ~L817-869) with no
blend-ticket check. One spray pass recorded through both reduces on-hand twice. KI-93 covers only the ticket-to-order
route. Live (audit aggregate, not re-run): no blend tickets in production yet. Billing counterpart: #2061, #2063. Fix:
one shared check so a linked ticket and job record one application and one deduction; prove with a fictional linked
job and ticket, reading the stock ledger after each step.

### KI-177 — Changing a completed job's date can change which quote prices its invoice

> **Re-checked 2026-11-21 on staging `3a9694685`:** Accepted · MED · Mason (field-app billing) · #2047.

**MED · ACCEPTED · jobs/billing · found 2026-11-21 (Sol round 5, #2047) · Mason (field-app billing)**
Admins and reps can change a completed, not-yet-invoiced job's `job_date`. Split-invoice pricing picks the quote by that
date, so moving a June 10 job to June 13 can let a June 12 quote price it. Today's Mass Edit allows the same. Mason kept
today's rule (2026-11-21). Fix belongs with the field-application invoice rules: lock the date once a job is completed,
or price by the application record's date.

### KI-178 — Soft-deleting a dispatched job leaves its dispatch rows open

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Mason (field-app billing) · plan W3-30 · #2047.

**LOW · OPEN · jobs · found 2026-11-11 (Sol, #2047) · unassigned**
Deleting a job hides it but leaves its location dispatch rows marked `dispatched`; restoring the job shows the old
dispatch again. Same as today's direct delete. Fix: close dispatch rows on delete, as cancel already does.

### KI-180 — Reassigning a job to an admin or rep leaves the old applicator dispatched

> **Re-checked 2026-11-21 on staging `3a9694685`:** Accepted · MED · Mason (field-app billing) · #2047.

**MED · ACCEPTED · jobs/dispatch · found 2026-11-21 (Sol round 8, #2047) · unassigned (dispatch)**
Admins and sales reps can be a job's applicator (they sometimes apply, Mason 2026-11-21). The dispatch-sync trigger
only replaces dispatch rows when the new person has the applicator role, so moving an open job from applicator A to an
admin or rep leaves A's dispatch open, and A can still see and finish the job. Today's screens do the same. Fix: close
the previous applicator's open dispatch rows on any applicator change (dispatch-sync trigger).

### KI-181 — An invoice saved in the same second as a bulk job edit can let both go through

> **Re-checked 2026-11-21 on staging `3a9694685`:** Accepted · MED · Mason (field-app billing) · #2047.

**MED · ACCEPTED · jobs/invoices · found 2026-11-21 (Sol round 9, #2047) · Mason (field-app billing)**
`edit_jobs` skips billed jobs, but the generic invoice save can link an invoice to a job's blend ticket without taking
the job's lock. If it commits between the billed check and the job change, a completed job can be reassigned or
deleted just after it was billed. Needs two people on the same job in the same second. Mason accepted it (2026-11-21).
Fix: have the invoice save lock the linked job (invoice code, Taha's area).

### KI-183 — Moving a job's date across October 1 leaves last season's label on the job

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Mason (field-app billing) · plan W2-28 · #2047.

**MED · OPEN · jobs/billing · found 2026-11-21 (Sol round 10, #2047) · Mason (field-app billing)**
Changing a job's date from September 30 to October 1 (or back) keeps the job's stored season. Split billing uses that
season for the per-acre service rate and the invoice season, so it can use last season's rate. Today's Job Schedule
screen does the same. Mason accepted it (2026-11-21). Fix: set the season from the new date whenever the job date
changes (in edit_jobs and any other date writer).

### KI-171 — Grower-share rep coverage check (#2068): accepted limits and test gaps

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Mason (field-app billing) · plan W2-29 · #2068.

**MED · OPEN · field-app invoices · found 2026-11-20/21 (Sol rounds 1-2, Astra, #2068) · unassigned**
#2068 lets a sales rep save a grower-share invoice only when its per-acre price covers the included chemicals' cost.
Left open: (1) a rep's save passing or not depends on the chemicals' cost, so the outcome is not cost-blind (accepted
with Mason's 2026-11-20 decision); (2) chemicals without a catalog product are outside the check
for a rep (Mason, 2026-11-20: leave as is); (3) after a lost response, "Nothing was saved" can be wrong when the first
save committed; (4) the reverse script leaves the migration ledger saying the candidate is applied; (5) the coverage
check re-reads the invoice's approval rows on every $0 line, so a very large, often re-saved draft gets slower;
(6) a refused new invoice still uses up an invoice number; (7) prover gaps: saves run as `postgres` with a rep/admin
JWT (would not catch `authenticated` losing EXECUTE), reuse mode skips the replay and can overwrite unit conversions,
and the preflight does not check the invoice trigger is attached. Pre-existing in the field-app save (Astra):
incomplete chemical input, `save_invoice` on a field-app draft, invoice lock order, idempotency key binding,
single-to-group edit, soft-deleted group members.

### Also open in this area (tracked as GitHub issues or parked fixes; plain-English detail in [the plan](MASTER_FIX_PLAN.md))

| ID | Sev | Status | What goes wrong | Owner | Plan |
|---|---|---|---|---|---|
| #2145 | LOW | Open | Two people editing jobs on the same booking at once can have one save refused (retry works); user deactivation can lag a moment. | Mason (field-app billing) | W3-31 |
| #2196 | HIGH | Open | A sales rep may still be able to delete a completed (billable) job through a direct table path, so it could drop out of Unbilled Jobs. | Mason (field-app billing) | W1-02 |
| #2188 | LOW | Open | An old link to a deleted job shows it as Scheduled with Cancel/Start buttons (database still refuses changes). | Mason (field-app billing) | W3-32 |
| #2141 | LOW | Open | A job-made group draft could be cancelled leaving the job pointing at a cancelled invoice. Live has none today. | Mason (field-app billing) | W3-33 |
| #2064 | MED | On staging, not live | A rep can now save an included grower-share chemical only if the per-acre price covers cost; otherwise an admin is needed. Not on main yet. | Mason (field-app billing) | R-12 |
| #2063 | HIGH | Check first | A job could be billed twice (blend invoice then split field invoice). Live data not checked; code region still in the unchanged file. | Mason (field-app billing) | W1-06 |
| #2061 | HIGH | Check first | A job could be billed a second time. Issue says live-unchanged; not traced. | Mason (field-app billing) | W1-05 |
| #1933 | MED | Check first | Some units cannot convert, so an application line may refuse or misprice. | Mason (field-app billing) | W2-50 |
| #1926 | LOW | Check first | A very small application could bill as zero. | Mason (field-app billing) | W3-54 |

---

## Permissions and security

### KI-02 — Product cost and margin: server functions audited and fixed live 2026-11-02

> **Re-checked 2026-11-21 on staging `3a9694685`:** Accepted · MED · Mason decision · #980, #1089.

**MED · ACCEPTED · security/money · Mason (2026-10-21: the two residuals below) · fixes live 2026-11-02 (`20261102200000`); `admin_set_application_service_cost` retired live 2026-11-02 (`20261103090000`, ledger `20261102205903`)**
Mason decided cost and margin are admin-only. Screens and report functions were changed (migrations
`20261019010000`, `20261019230000`) and purchase-order cost is locked (`20261021140000`, `20261021141000`,
PR #980). **The column lock is live:** `20261022101000_cost_columns_admin_only` (PR #1089, applied 2026-10-25
22:34 UTC on Mason's in-chat approval, ledger `20261025223447`). Neither signed-in users (`authenticated`, admins
included) nor signed-out visitors (`anon`) can read or write a cost, profit or margin column directly on
`products`, `quotes`, `quote_items`, `quote_versions`, `orders`, `order_items`, `invoices`, `invoice_items`, `jobs`,
`job_chemicals`, `blend_ticket_products` or `commissions` (read live after the apply: 0 of 30 such columns readable
by either role; the server-only `service_role` key is unchanged); admins read cost through `get_admin_cost_fields`.
Two residuals stay accepted by Mason (2026-10-21): commission amount and rate together imply profit, and below-cost
refusals let a rep narrow a cost by trial and error. Includes the older sub-items "reps can recover
application-service cost" and "retire the old `admin_set_application_service_cost` function" (no caller left in
`src/`; dropped by `20261103090000_retire_admin_set_application_service_cost`).
**Function audit done 2026-11-02** (report: `docs/audits/2026-11-02-cost-margin-definer-function-audit.md`): every
signed-in-executable owner-rights (SECURITY DEFINER) function that names cost, reaches it through an inner helper, or
turns a cost-bearing row into JSON was traced live. Migration `20261102200000_cost_definer_leaks_closed` changes the ones
that need it so only admins get cost (real-schema proof
`scripts/smoke/prove-cost-definer-leaks-closed-real-schema.mjs`); **applied live 2026-11-02 18:39 UTC (12:39 PM Central), ledger `20261102183928`; read-only post-apply check and sweep clean**. The standing sweep
`cost-exposure-review` now flags any new or changed function that names cost, and the cost-lock proof records each
ledger-only migration once (CodeRabbit, PR #1089). Decided by Mason 2026-11-02: existing inventory notes stay as they
are; no new note gets a cost.

### KI-03 — Reps do not yet have the decided invoice and commission-split scoping

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · MED · Taha (to 2026-12-15) · plan W2-30.

**MED · OPEN · security/money · Mason decided, build unassigned**
**Field-invoice part ACCEPTED (Mason, 2026-11-21, "Drop the fix"):** any rep may edit any draft or unposted field-application invoice (`update_field_app_applied_info`, `update_field_app_invoice_billing`, `save_field_app_invoice` on an existing invoice, and direct `invoice_shares` / field-location writes); no fix is planned (`DECISION_LOG.md` 2026-11-21). Posting and the split-invoice save keep their own-name checks. The rest of this entry stays open.
Mason decided reps may see all invoices read-only but only act on their own, and that only admins may change
commission splits on jobs, quotes and orders. Neither is built: no migration widens rep invoice reads or adds
own-name checks (`INVOICE_SCOPE_DENIED`) to the full set of invoice actions any active rep can call today on any
invoice id: `unpost_invoice`, `unpost_invoice_group`, `transfer_invoice_to_job`, `consolidate_draft_invoices`,
`update_field_app_applied_info`, `update_field_app_invoice_billing`, `save_field_app_invoice` (existing invoice) and
the `invoice_shares_insert` policy (checked live 2026-10-13: no ownership test); screens must also hide Edit/Post
on other reps' invoices, and payments and prepay/credit application stay open to reps. Any rep can
still change a commission split on a job, quote or order (only the customer default is protected). Any rep can
also roll over any rep's quote.
The [2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) (sweep 3 #9) re-confirmed the bill-split share gap above as LOW (blocked once an invoice is posted);
logged here, not as a new KI.
The 2026-11-02 cost audit noted more functions in this same ownership and role-check area (not cost); the list is in
Mason's private notes until the scoping work is built. It also noted that an admin's automatic draft invoice for a job
with a below-cost line always fails, so that job is billed by hand.

### KI-07 — Other small security gaps

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Agent (unassigned) · plan W3-34 · #1698.

**MED/LOW · mixed · unassigned**
- Noticed out of scope by the [2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) (sweep 2, Couldn't verify): an applicator may be able to change a licensing
  field on their own profile that job completion reads. Not assessed (field application); detail held privately. LOW, UNVERIFIED.
- `profiles` grants `TRUNCATE`/`TRIGGER` to signed-in users (confirmed live read-only 2026-10-25 and
  2026-11-05) — revoked by `20261116100000_permission_tightening.sql` (Mason 2026-11-05; APPLIED LIVE 2026-11-06 12:28 AM Central, ledger `20261106062807`), LOW-MED.
- The same table-maintenance rights (TRUNCATE, TRIGGER, MAINTAIN) on every public table and view, `profiles` MAINTAIN included (462 grants,
  live read-only 2026-11-06) — `20261123130000_revoke_truncate_trigger_maintain.sql` APPLIED LIVE 2026-11-06 11:09 AM Central, ledger `20261106170917`; repo
  guard `browserTableMaintenanceGrants.test.ts`. Known limit: `supabase_admin`'s default privileges (platform and
  extension objects) cannot be changed by `postgres`; live sweep `browser-table-maintenance` watches for them; every app table is `postgres`-owned and the migration checks that. LOW-MED.
- Customer-document post-apply check RECORDED 2026-11-08 on the local test copy (all migrations, `20260914100700`
  included): no browser storage policy names the `customer-documents` bucket, and the Documents tab uploads and
  downloads through `customer-document-files` (served locally). Removed documents: LIVE 2026-11-09 (PR #1663;
  `20261222100000_document_restore_and_photo_uploader.sql`, ledger `20261109173810`; `customer-document-files` v6;
  Mason checked restore in the live app) — an active admin can restore one (both removal columns
  cleared, nothing else), and `customer-document-files` lets admins download a removed one; the Documents tab has an
  admin-only "Show removed documents" view with Restore. Each restore is kept in `customer_document_restores` (who
  removed it and when, who restored it), written by the database; a retried removal after a restore is refused
  instead of reporting "removed". Live API check 2026-11-09 (publishable key, `Accept-Profile: storage`): the API
  answers `PGRST106`, exposing only `public` and `graphql_public`, so the `storage` schema is not reachable. LOW.
  Deferred from #1663 (#1698), LOW each: (a) a removed document whose file was deleted can still be restored (the
  record shows, its download fails; no service-role cleanup deletes such files today); (b) the retried-removal check
  reads the document without a lock, so an admin restore at the same instant as a retried removal can still let that
  retry report "removed".
- Signed-in rep click-through of `customer-document-files` RECORDED 2026-11-08 (local test copy): a sales rep opens
  a customer document and sees no removed-documents view; after removing one, the download service answers "no
  longer available" and a restore attempt changes 0 rows. Repeat on live (v6 deployed 2026-11-09) — needs a
  sales-rep sign-in, so Mason or a rep does it — LOW.
- A staff viewer can mint a temporary photo link (Mason accepted this, see accepted list KI-60).
- 12 live SECURITY DEFINER functions set `search_path` to `public, extensions, pg_temp`, which the written rule
  (`public, pg_temp`, or an exactly empty path with fully-qualified names) does not cover: `fields_acre_authority_guard`,
  `find_overlapping_fields`, `get_field_dashboard`, `get_field_geojson`, `get_fields_geojson_by_ids`,
  `get_fields_with_geojson`, `get_job_fields_with_geojson`, `get_job_proof_data`, `save_field_geometry`,
  `save_field_polygons`, `set_field_boundary`, `set_field_override_acres` (read-only `execute_sql`, 2026-10-26 UTC; same 12 re-read
  2026-10-25 10:52 PM Central).
  They need `extensions` for PostGIS. DOCUMENTED 2026-11-05 (Mason): `docs/workflows/RLS_SECURITY_GUIDE.md`
  records the PostGIS exception; live has sixteen (these twelve plus four internal helpers). No function changed — CLOSED.

### KI-119 — Settings → Page Access hides screens but the database does not enforce it

> **Re-checked 2026-11-21 on staging `3a9694685`:** On staging, not live · HIGH · Agent (unassigned) · plan R-10.

**HIGH · REPORTS PART FIXED ON STAGING (PR #2051 merged to staging 2026-11-21, `20270201100000_page_access_locks_reports.sql`; awaiting the production release) · security · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 3 #2)**
Page Access (`denied_pages`) is checked only by the screen router. Mason decided 2026-11-19 (To-Do decision 16) that
it is a real security control: scope "actions + reports", reports now and money later. The fix makes the database
refuse Reports Library and Sales Reports data to a person with that page hidden (including the commission rows the
Reports Library shows, and the one-customer year-end summary when Customers is hidden too: Mason,
2026-11-21), and limits the four logbook reports to admins and sales reps (Mason, 2026-11-19). Contract:
[2026-11-19-ki119-page-access-lock-CONTRACT.md](../plans/2026-11-19-ki119-page-access-lock-CONTRACT.md); proof:
`scripts/smoke/prove-page-access-locks-reports-real-schema.mjs`. The invoice and payment actions are KI-169. Known
limit (Mason's scope): a person with reports hidden still sees the order and invoice rows on the screens they keep.
Also accepted (Mason, 2026-11-21, Sol round 5): the Posted Applications and Price List tabs read the same records as
the Record Book and Products pages, so they are not locked when those pages are hidden too; revisit when those pages
get their own lock. Exploit-level detail is held privately until the fix is live.

### KI-169 — Page Access does not yet lock the invoice and payment actions

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · HIGH · Taha (to 2026-12-15) · plan W1-08. Mason 2026-11-19: real lock; reports now (KI-119, on staging), money actions after 2026-12-15.

**HIGH · OPEN · security/money · split from KI-119 2026-11-19 · Taha, after 2026-12-15**
Mason decided 2026-11-19 that Page Access also locks money actions, but the Invoices and Record Payments actions wait
for Taha after 2026-12-15 (billing is his area until then). Reuse `public._require_page_access` from KI-119's
migration, adding those page keys to it.

### KI-122 — An admin password reset leaves the user's existing sign-ins open and is not audited

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Mason decision · plan W3-35. Code is merged on main; whether the two Edge Functions were redeployed (needs Mason) is not confirmed.

**LOW · PARTIAL (code merged: PR #1981, in main via release #1990; the Edge deploy needs Mason and is not confirmed) · security · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 2 #11) · Claude**
Both reset paths (`create-user` `reset_password` and `reset-user-password`) only set the new password: the account's
existing sessions stay signed in, and no record says which admin reset whose password. Deactivation, by contrast, ends
sessions. Fix: end the target's sessions after a reset and write an audit row. Read from code; not tested live. Edge
Function deploys need Mason's approval. Correction (2026-11-18): live Auth (GoTrue v2.198.0) already ends every
session on an admin password update, so only the audit half was real. Fix merged: both functions share
`_shared/passwordReset.ts`, which refuses unless the target loads, and writes the server's own `activity_feed` row
naming the admin before the password changes (no row, no reset). Redeploy of the two functions not confirmed.

### KI-149 — Crop Programs and job print defaults let reps edit but only admins can save

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Mason decision · plan W3-36.

**LOW · OPEN · settings · found 2026-11-10 ([2026-11-10 sweeps](sweeps/bug-sweeps-2026-11-10.md) sweep 2 #9) · unassigned**
`CropPrograms.tsx` shows New/Edit/Duplicate to reps but saves to `app_settings`, which only admins may write, so a rep's
work is lost on Save; `PrintOptionsDialog.tsx` "Save default" has the same mismatch. Two admins editing programs at once
overwrite each other (one settings record). Fix depends on who owns crop programs (To-Do decision 25).

### KI-182 — The Purchase Orders screen uses guessable retry codes

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Agent (unassigned) · plan W2-31 · #2047.
> **2026-11-22:** FIXED-ON-STAGING once branch `fix/ki182-po-random-retry-codes` merges: the bulk Cancel on the Purchase Orders list now sends one random code per PO (shared `useIdempotencyKey`), reused only for a retry of that PO's cancel. The PO detail page already used random codes.

**MED · OPEN · purchasing · found 2026-11-21 (Sol round 9, #2047) · unassigned**
Every app action shares one table of retry codes (idempotency keys). The PO screen builds its cancel code from the user
and order, so a staff member who knew it could use it first in any other action and block that cancel for 24 hours.
Mason accepted the #2047 finding (2026-11-21) because every existing action already allows this. Fix: give the PO
screen random retry codes, as the other screens use.

### KI-73 — More field-access holes (extends KI-01; To-Do row 11.4, plus row 11.7)

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Mason decision · plan W3-37 · #1065, #1103, #1650. Only a LOW leftover remains (retried job start/complete answered before the access check; nothing written).

**HIGH · PARTIAL · security · Mason approval to narrow permissions**
- `team_notes` admits every active profile, so the Team Board shows field roles every note; Mason decided 2026-10-23 to keep that for now (To-Do row 11.11, `DECISION_LOG.md`).
- Every active account reads every `customer_addresses` row (To-Do row 11.7). ACCEPTED AS IS by Mason, 2026-11-08: drivers
  keep the delivery address (FieldStop) even past the delivery date, and applicators keep theirs; no later change. Taken out of
  part C because tying addresses to `customers_select` would hide it from a driver on an overdue delivery (Sol).
- DEFERRED (LOW, Sol 2026-11-08, part C): `start_job` and `complete_job` return a matching idempotency result before
  the job-access check, so a former applicator replaying their own key gets back the earlier result (ids they already
  had). Nothing new is written. Fix: check access before the replay lookup.

### KI-74 — More cost exposure and prerequisites (extends KI-02)

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · MED · Mason decision · plan W2-32 · #1057.

**MED · PARTIAL · security/money · Mason**
Commission amount plus rate can reveal a rep's profit, and Quick Receive reveals which open PO line is cheaper
(MED).

### Also open in this area (tracked as GitHub issues or parked fixes; plain-English detail in [the plan](MASTER_FIX_PLAN.md))

| ID | Sev | Status | What goes wrong | Owner | Plan |
|---|---|---|---|---|---|
| #2162 | MED | Open | Drivers can still read full farm records directly, more than Mason wants them to see; planned for after step 1 is live. | Agent (unassigned) | W2-33 |

---

## Customers, data and cut-over

### KI-155 — The cut-over plan has two finish lines and no rules for opening-balance exceptions

> **Re-checked 2026-11-21 on staging `3a9694685`:** Mason decision · MED · Mason decision · plan D-03.

**MED · OPEN · launch/money · found 2026-11-11 ([business logic review](../audits/2026-11-11-business-logic-review.md) finding 6) · Mason + agents**
Newer direction: chemical-sale trials from 2026-12-15, field invoicing before February, opening balances instead of a
full Chem Man import, accounting summaries until the accountant picks the QuickBooks approach. Older plans still say
all billing moves January 1 with an automatic QuickBooks Desktop connection. The opening-balance method does not yet
say how to carry old overdue amounts and their aging, customer credits, later checks paying old invoices, returns
against Chem Man sales, work entered during the handover, and which system bills each trial sale (so it is billed
once). Fix later: one current cut-over procedure (To-Do 16.3, 16.4) that covers these, rehearsed and reconciled.

### KI-30 — Customer/vendor/product data hygiene waiting on Mason

> **Re-checked 2026-11-21 on staging `3a9694685`:** Mason decision · LOW · Mason decision · plan D-05.

**LOW-MED · UNVERIFIED · database/process · Mason / unassigned**
**Vendor-name merges and category remap are closed** (Mason 2026-10-25, recorded in PR #1100; To-Do 0.12/0.16). That read-only check found no duplicate vendor names and all 595 active products in the intended 11 categories. **Still open:** junk-row deletes and remaining live-data cleanup need Mason's decisions (they change history or delete real rows). EPA registration numbers (MED, compliance data): a read-only check on 2026-11-08 against EPA PPLS found 30 wrong numbers (9 moved by EPA to a new number, 21 belonging to another brand or not in the registry) and 8 products with no number but a registry match; on 2026-11-08 those 48 products were corrected live from EPA's registry (PR #1653). 4 numbers still need a person to read the jug label. Two `epa-lookup` limits make `LabelDataQuality` misreport some numbers: a number EPA moved returns a
lookup error instead of the new number, and a three-part distributor number returns "not found" even when
valid. CRM has no data entered; 146 of 151 active customers lack a
sales rep (live read-only count, 2026-11-08). The tool exists: an admin ticks customers on the Customers list and uses
**Assign sales rep** (PR #381), so what remains is Mason choosing each customer's rep.
WP-PM-8a (2026-11-02) found 16 of 604 live products that miss its new setup checks. They stay unchanged and keep working; the list is in Mason's private Product Master review notes.

### KI-77 — Lists, UI and CRM details (extends KI-26, KI-30, KI-32, KI-41)

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Agent (unassigned) · plan W2-34 · #381, #1663, #1698.

**MED/LOW · OPEN · UI/database**
The row-capped pickers listed here are fixed (see KI-32). Paging caveats: two identical reads can still miss
concurrent changes, load/count cost grows on large tables (the Orders list now reads one page at a time, but each page
still recomputes the season's line, invoice and delivery totals), more than 20 identical-name search results are hard to
reach, a trigram index may be needed (LOW). Commission Payments: an older refresh can report success after a newer
one fails (LOW). `SelectLocationsModal` map/list split stays 50/50 on tablets (LOW). CRM gaps: applicator-license
visibility on customer/prep-card/quote surfaces, a pre-quote pipeline, duplicate detection in the bulk customer
import, bulk import of sales reps from a file, outbound-email logging (MED). Bulk rep assignment exists on the Customers
list (PR #381); the customer form warns, without blocking, when a new or renamed customer has a similar name or the
same phone or email as one on file (2026-11-08). Offline recovery also lacks notification replay,
operation-specific conflict checks, automatic discovery of an office resolution on the device, a general
duplicate-action policy, and carries the risk of losing device-local work before reconnection (MED). Completion
evidence: photo proof tied to who uploaded the file — LIVE 2026-11-09 (`20261222100000`, ledger `20261109173810`): a signed-in user's new delivery
photo must name that user as uploader and a `delivery-photos` file that user owns (as signatures are checked), its
upload time is the server clock, and its delivery, file, uploader and time never change. Older photo rows are not
re-checked; storage-rule guarantees still do not cover dashboard or service-role tools (LOW). Not checked: a
user can attach a photo file they uploaded for one delivery to another delivery they may add photos to, so that
delivery's photo list shows it; `complete_delivery` still refuses it as proof (the evidence smoke files such rows
on purpose to prove that). LOW. Also deferred from #1663 (#1698): photo ownership is checked only when the photo row is
added, so if a photo file is deleted and someone else uploads a different file at the same path, the existing row keeps
the first uploader's name and time. LOW.

### KI-204 — Staging rehearsal: workflow and screen improvements awaiting a decision

> **Re-checked 2026-11-22 on staging `17a72d0ee`:** Backlog, not a defect · LOW · Mason decision (To-Do decisions 34 and 35). From the [2026-11-22 staging rehearsal](../audits/2026-11-22-staging-rehearsal-issues.md).

**LOW · OPEN (suggestions, not defects; some need a Mason rule) · several areas · found 2026-11-22 · Mason decision where noted**
These are workflow and clarity proposals. See the [later UX and evidence register](../audits/2026-11-22-staging-workflows-follow-up.md) and the original report's "Workflow and UX
improvement candidates" table. To-Do section 17; decisions 34 and 35.
- New Customer: point at the missing commission recipient beside the split row before Save.
- Returns: show each stage (requested, approved, received, restocked, credited) and where the credit can be used next.
- Credit and prepay: show available credit, amounts applied and remaining balance together; **Mason decision:** which
  reversals staff may do and what history must be kept.
- Prepay: the applied credit showed no source payment reference; check whether it should.
- Quick Delivery / To Ship: unchecking "create draft" at scheduling still made a $10.00 draft at completion;
  **Mason decision:** is that the rule, then word the checkbox to match; also give a clear next step for a completed,
  uninvoiced order.
- Purchasing: show ordered cost, receipt snapshot, corrected PO cost and current product cost distinctly, and the
  effect of a correction before it is applied.
- Pricing workbook: point at the invalid row when Apply is disabled; tell an already-applied replay from a bad file.
- Pricing history: label current tier, last charged and quoted amounts with their scope, date and source.
- Office exceptions and documents: an end-to-end dashboard-to-fix check by role, and one quote-to-statement trail
  that highlights differences.
- Supplier quote: show package conversion and explain when approved cost can be selected. Lot Trace: explain application-only scope and link available lot evidence.
- Delivery list: show whether the brand is confirmed or lead staff to Delivery Detail to confirm it.
- Reporting and field planning: carry the customer/date scope and distinguish planning from dispatch and downstream work.

### KI-205 — Staging rehearsal: cases not yet proven, and what blocked them

> **Re-checked 2026-11-22 on staging `17a72d0ee`:** Check first · MED · Agent (unassigned) · plan W2-54 · To-Do 16.12. From the [2026-11-22 staging rehearsal](../audits/2026-11-22-staging-rehearsal-issues.md).

**MED · UNVERIFIED (test gaps, not confirmed defects) · test coverage · found 2026-11-22 · unassigned**
The original ledger had 9 blocked and 17 partial. The later pass has 55 separately recorded cases, including
13 blocks. The [follow-up](../audits/2026-11-22-staging-workflows-follow-up.md) cleared restricted-use sale on deployed staging, ran six isolated
database actions or variants, and documented four partial results and two unavailable staff workflows.
Remaining priorities include approved finance and supplier corrections with retained history, deployed chemical
split and odd-cent return, missing-invoice recovery, quote restore, driver/offline and sales-rep roles, unit/pack
and lifecycle fixtures, month-end late correction, Crop Programs persistence and wider reporting/load proof.
Close each gap after a case proves it or it moves to its own issue. To-Do 16.12.

### Also open in this area (tracked as GitHub issues or parked fixes; plain-English detail in [the plan](MASTER_FIX_PLAN.md))

| ID | Sev | Status | What goes wrong | Owner | Plan |
|---|---|---|---|---|---|
| #2197 | MED | FIXED-ON-STAGING | Staff are told to reactivate a customer before new orders, but the screen offers no way, so it must be done outside the app. Fixed: an admin or sales rep now sees a Reactivate button (with a confirm) on an inactive customer's page. | Agent (Lane D) | W2-35 |
| #2089 | MED | Open | A customer could be deactivated while an invoice posts, leaving a balance on an inactive customer. | Taha (to 2026-12-15) | W2-36 |
| #2016 | LOW | Open | "1,200" in an unquoted CSV can save as 1 corn acre and 200 soybean acres. | Agent (unassigned) | W3-38 |

---

## Guards, tooling and release process

### KI-36 — A table lock does not serialize the OLD body of a replaced function

> **Re-checked 2026-11-21 on staging `3a9694685`:** Accepted · MED · Mason decision.

**MED (rule) · ACCEPTED as guidance (same as KI-61) · database · Mason (2026-09-03)**
See KI-61. The rule is not yet in the migration checklist (`docs/workflows`); it lives only in the archive entry.

### KI-37 — Parked migration draft with a fragile membership rule

> **Re-checked 2026-11-21 on staging `3a9694685`:** Not a-bug · LOW · Agent (unassigned).

**LOW · OPEN · database · unassigned**
Parked draft `20260813060000_require_completed_delivery_before_invoice_post` (staging folder, history row 877,
NOT APPLIED) selects functions by searching their body for the word "posted", which in one function is only in a
comment. Nothing is wrong today because it is unapplied.

### KI-40 — CRM Phase 5 (AI receptionist) preconditions

> **Re-checked 2026-11-21 on staging `3a9694685`:** Not a-bug · LOW · Agent (unassigned).

**LOW · OPEN (future work) · database · unassigned**
Five prerequisites before building an automated phone receptionist (service-callable customer summary, service
document ingestion, provenance-trigger handling, transcript purge, a citing design question). Not a live defect.

### KI-41 — Product roadmap items deliberately deferred

> **Re-checked 2026-11-21 on staging `3a9694685`:** Not a-bug · LOW · Mason decision.

**LOW · OPEN · process · unassigned**
Grower portal; OCR auto-fill of re-entry/pre-harvest intervals (held back as a compliance risk); offline-recovery
items (photo/signature persistence, idempotent email replay). The real-phone offline test is STILL UNVERIFIED
(re-checked 2026-11-10): it needs a person with a phone. KI-26 records Mason's 2026-11-06 airplane-mode pass for
one offline signed completion; that pass was not repeated in this check.

### KI-45 — Hold-latch helper-report edge cases

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Agent (unassigned) · plan W2-37 · #1084 (shipped), #1152 (merged 2026-10-28).

**MED · PARTIAL (the narrowing in PR #1152 is merged, 2026-10-28; message-origin support is still missing) · tooling-guards · unassigned**
PR #1084 fixed the four recognized helper-report frames that were falsely latching the session. A helper report in another text shape can still be mistaken for Mason's words (`.claude/hooks/prompt-source-lib.mjs`, text-shape rules only); message-origin support is still needed for a complete fix. Further narrowing shipped in PR #1152 (merged to main 2026-10-28).

### KI-46 — A review proof can be rewritten through its Windows 8.3 short name

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Mason decision · plan W2-38.

**MED · OPEN · tooling-guards/security · Mason (owner action)**
The saved "Sol review passed" file can be addressed via an old-style short name the guard does not recognise.
Turning off short names is a reversible system change that only Mason should make; the durable fix is to
authenticate proof contents. CodeRabbit's backstop was removed 2026-10-19, which raises exposure.

### KI-47 — Hook bypasses that remain

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Agent (unassigned) · plan W2-39 · #530 (partial fix).

**MED/LOW · mixed · tooling-guards · unassigned**
- Autopilot approves these destructive spellings (`.claude/hooks/autopilot-lib.mjs:214-216`; reproduced by calling
  `autopilotDecision`, re-confirmed by a reviewer): `rm -Rf`, `rm -r -f`, `rm --recursive --force`,
  `Remove-Item -Recurse`, `git clean --force -d`, `git branch -d -f` and `git commit -n`. A fix sits on branch
  `claude/autopilot-recursive-delete-alias-20260907` (18,131-command sweep) but must be rebuilt on current `main`.
  MED.
- Bare `git clean` with a config override is not covered (`bash-safety-lib.mjs:280`). LOW.
- `review-proof-guard`: the `GIT_EXTERNAL_DIFF` separate-export form and `gh` download over a protected path are
  unblocked (item 1 fixed in PR #530). Capped by Mason's 2026-09-01 decision. LOW.
- `git config core.hooksPath` is now refused by the Claude hook (#530) but the Codex side and a CI assertion are
  missing; CI still blocks anything reaching `main`. MED.
- The push guard does not treat `core.hooksPath` or shell-form `credential.helper` as dangerous
  (`codex-push-lib.mjs:1209-1217`). MED.
- `stop-verify` PROOF matching is text-based, so a fabricated PROOF line passes. LOW.
- Nine enforcement-file patterns are missing from the `.claude/settings.json` `ask` list (F3). Probably
  superseded by Mason's "fewer prompts" direction (#956, #974); needs a decision to close or cut down. LOW.

### KI-48 — Migration-apply protections and checks with known holes

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · HIGH · Mason decision · plan W1-12 · #364 (closed).

**HIGH (per older record, exposure reduced) · OPEN · tooling-guards · Mason (capped review loop)**
- Ahead-of-pending marker (parked after review round 12): the proof-folder scan in `migration-apply-lib.mjs:956-975`
  has no deadline, so a slow run past the hook limit could let an apply proceed unchecked; the marker is not bound
  to a file digest. Exposure reduced because applies go through the guarded script.
- Three apply protections exist only on closed PR #364's branch. OPEN.
- The migration-ordering check reads a local snapshot of applied migrations and cannot see applies from another
  checkout (`applied-snapshot-invalidate.mjs`); Supabase's ledger is the backstop. LOW-MED.
- The migration-drift reviewer's overload check sees only authored history, not the live catalog
  (`.claude/agents/migration-drift-reviewer.md` CHECK 2). Deferred by Mason. MED.
- Whole-body hash pins on the quote-version trust chain must be updated in the two live files together (the applied migration `20260826220000` keeps its own apply-time copy) (ACCEPTED, KI-63).

### KI-49 — Codex review tooling

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · MED · Mason decision · plan W2-40.

**HIGH (per older record), mitigated · OPEN · tooling-guards/process · wiring a hook needs Mason's approval**
Running raw `codex review <scope>` from the repo root self-recurses, kills its own process and exits 0, which can
record a false "clean" review; the wrapper `node scripts/write-codex-push-proof.mjs` avoids it, nothing blocks the
raw form. Also: the Codex `/import` feature writes corrupted `source-command-*` adapters (commit blocker fixed,
importer cannot be turned off; since 2026-10-30 the sync warning names `--archive-imported`, which moves them to a
restorable archive, and a later import can bring new copies back; deferred, not solved: an external filesystem change
during archive creation can leave an empty directory after a rejected operation. Existing file content is retained,
and the destination is fixed under shared Git storage); `sync-agent-workflows.mjs` has thirteen
recorded limitations (lexical-only containment, junction/symlink and path-case edge cases; Mason: record, don't
patch); the guard-claim ratchet misses claims inside template strings and files outside the hook folders. Codex can
show two Stop prompts on one stop (Mason's global reminder plus the project proof check); they check different
things, and removing the duplicate needs a separate change to the global hook. Codex's guard still refuses a
single-quoted search alternation near a protected file (use double quotes or separate simple reads), and a batched
double-quoted search when the command holds shell syntax that could change how quotes pair, such as `$`, `%`, `!`, a
comment or `\"`, even when harmless (the guard's scan is deliberately conservative, not a parser; the full list is in
`docs/reference/agent-guardrails.md`; drop the comment or run the reads separately). Deferred, not solved: this change
does not establish source-content integrity for every shared hook. Runtime trust status and the guard's explicit
protected-file list are separate checks; scripts outside that list do not gain its write protection.

### KI-50 — Cloud (web/mobile) sessions cannot push or back up memory

> **Re-checked 2026-11-21 on staging `3a9694685`:** Accepted · MED · Mason decision.

**MED · ACCEPTED · tooling-guards · Mason (2026-08-04: leave as is)**
A credential proxy rewrites git addresses and the guards refuse (safe failure); deliver from the cloud with GitHub
tools. `scripts/backup-claude-memory.mjs:476` refuses the same way.

### KI-51 — Supplier-pricing Phase 3C containment and time-bombs

> **Re-checked 2026-11-22 on staging `f8ee14ee8`:** Resolved for new-branch pushes · LOW · plan W2-41.

**LOW · RESOLVED (cap) · tooling-guards**
The trusted containment check is not a required check on `main` (rules: Vercel, Lint/Type/Test/Build, SQL
Migration Validation). History cap: 4,096 commits (`MAX_HISTORY_COMMITS` in
`scripts/check-supplier-pricing-phase3-private-artifacts.mjs`); `origin/main` has 4,463 and `origin/staging` 4,550.
**New-branch pushes are not affected** (checked 2026-11-22): the pre-push check scans only commits not on the
remote's advertised default branch, so a new branch cut from staging scanned 87 commits and passed. CI scans only
`base..head` for pull requests and runs on push only for `main` and `staging`, which are never created new. The cap
still refuses a new-branch push when the checkout has no local copy of `main` (not fetched) or pushes to a URL that
differs from the remote's fetch URL; that refusal now names the fix (fetch, push by remote name, push again).
Byte/candidate scan budgets (3 GiB, 100,000) need re-measuring. Maintenance watch.

### KI-52 — Tests and tooling hygiene

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Agent (unassigned) · plan W3-39 · #1062, #1143, #1110, #350 (closed).

**LOW · OPEN · tooling-guards · unassigned**
**Fixed 2026-11-08 (`claude/ki52-tooling-hygiene`):** `scripts/land-pr.mjs` now prints the pinned, immediate
`gh pr merge … --match-head-commit <head>` the merge guard accepts (no `--auto`); `scripts/fleet-status.mjs` runs
every Git command with `core.fsmonitor=false`; `src/lib/rlsContracts.test.ts` records `20260813080000` as applied
(live 2026-08-16, ledger `20260816174353`) with `quote_versions` INSERT `none`; `docs/reference/gotchas.md` has the
"gross margin means markup" note. **Still open:**
Page-render tests flake in the full suite (latest fix #1062; fixed case by case); `live-testdata-lib.mjs` read-side false positives were addressed by PR #1143 (merged 2026-10-27), which keeps executable DML guarded; new instances still need individual reproduction; the Phase 3
return-policy concurrency prover can't reach its chain (UNVERIFIED; PR #1110 repaired three different provers and does not establish this one's result); no static guard catches invoice-type leaks or
direct-URL edit-lock bypasses (MED, UI); extra live-sweep predicates (concurrency hotspot, more money identities)
not written; Gauntlet V2 Phase 2 unfinished (no staging database, E2E switched off, 44 page-render skips,
counts not re-measured).
Further small LOW notes from the 2026-10-13 branch salvage, carried from the archive and not re-checked: invoices
created through the order functions would be numbered INV- instead of CS-/MC- (latent; 0 of 12 live order
invoices affected); on the bulk order import,
Escape on the below-cost prompt also closes the Import Orders dialog while the upload continues out of sight
(`src/components/orders/BulkOrderImport.tsx`; a fix sits on closed PR #350's branch); the return-credit prover
is pre-apply and two test hardenings were not carried; GraphQL ref updates are not inspected locally (the
server-side ruleset is the boundary).
`src/types/supabase.ts` cannot be swapped wholesale for a fresh live type generation (checked 2026-10-26): the
generator drops hand-kept entries (the `invoice_postable_version` computed field on `invoices_postable`, which
`InvoiceDetail`, `Invoices`, `OfficeCockpit` and `OrderDetail` select; nullable columns on table-returning reports
such as `get_quote_versions`), so the typecheck fails, and it adds about 60 live helpers the file lacks, which
moves two `rpcContracts.test.ts` classifications. Records PRs add only the entries their migration changes, compared
against a live generation.

### KI-84 — The split-billing backfill smoke chain fails on current `main`

> **Re-checked 2026-11-22 on staging `045464a22`:** Resolved · LOW · plan W3-40 · #1110.

**LOW · RESOLVED 2026-11-22 · tooling/smoke**
`scripts/smoke/smoke-backfill-refuse-split-billing.sql` reaches `SMOKE_PASS_ROLLBACK` on a database built from the
baseline plus every migration (338 replayed, through `20270213100000`). Earlier repairs (#1523, #1524, #2057) already
completed the delivery under the `crx.delivery_completion_evidence` marker that 20261022075000 requires, used the
versioned `post_invoice_group` call and the split claim, and gave test products a form and sold unit, so the chain
itself needed no further edit. It cannot run on the catalog just before 20261006200000 (it stops on the later
split-claim rule). With 20261006200000's refusal reverted in a scratch database only (CHECK dropped, wrapper type
refusal removed) it fails first on `create_split_invoices_from_order created field_application invoices from an
order`, its CRX-LIFE-001 assertion. `prove-order-invoice-type-gate-real-schema.mjs` runs on that old catalog, so
#2234 gives it the frozen copy `scripts/smoke/fixtures/backfill-refuse-split-billing-candidate-era.sql` (the chain as of
`342135561`); `prove-quote-customer-row-version-real-schema.mjs` and four other provers already pull their
candidate-era form from git.

### KI-96 — Unused code and copied helpers make every change slower

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Agent (unassigned) · plan W3-41.

**LOW · OPEN (found 2026-11-02, Ponytail audit #17-#20) · tooling/frontend · unassigned (do last; changes no behavior)**
About 11,000 lines nothing runs: 20 one-off scripts in `scripts/smoke/`, 5 switched-off guards in `.claude/hooks/`
(never the always-kept ones in `AGENTS.md`), 3 browser-test setups and 12 committed `tmpclaude-*` files; offline
sync for eight actions the phones no longer queue (`src/lib/offlineSync.ts` ~L404-469); and two Edge Functions
nothing calls (`reset-user-password`, `setup-blend-tickets-storage`). Helpers are copied: date formatting about 78
times, money formatting in a dozen files (two print "$-5.00"), customer-notification code in both the job and
invoice pages. `src/pages/QuoteBuilder.tsx` (~6,000 lines) and the job page (~5,400) mix loading, pricing, saving,
status actions and PDF/email; moving status actions and PDF/email into their own files changes nothing for users.
Delete with a grep of every reference first; keep one copy of each helper.
**Part 1 done 2026-11-08** (`docs/changelog.d/2026-11-08-ki96-delete-unreferenced-tooling.md`): the seven
never-queued offline handlers, 8 old unreferenced proof files and the 12 `tmpclaude-*` files are gone. Still open:
the two unwired hooks (`active-area-guard.mjs`, `rls-on-new-tables.mjs`; the review-proof guard refuses shell
deletes under `.claude/hooks`), the October/November proofs nothing references, the two Edge Functions (removing
them from live is Mason's deploy action), and the helper and page-split work. All six Playwright configs are in use.
**Part 2 done 2026-11-08** (`docs/changelog.d/2026-11-08-ki96-part2-delete-unused-hooks.md`): the two unwired hooks
and one August proof are gone. The October/November proofs stay (recent work still runs them by hand), as does
`scripts/smoke/undo-paths/` (eight proofs import it). Still open: the two Edge Functions and the helper and
page-split work.

### KI-107 — Review-proof guard refuses a delete after `cd` into a worktree when any part of the command has `..` or a variable

> **Re-checked 2026-11-21 on staging `3a9694685`:** Open · LOW · Agent (unassigned) · plan W3-42 · #1536 (closed).

**LOW · OPEN (rule read on `main` 2026-11-08) · tooling-guards · source: [branch salvage](../audits/2026-11-08-abandoned-branch-salvage.md)**
`review-proof-guard.mjs` refuses `cd <worktree> && <delete or move>` when any later part of the command climbs out
(for example a harmless `ls ../wt-b`), and cannot see `S=<path>; rm -rf "$S"` as a literal path. Closed PR #1536
(branch `claude/review-proof-guard-worktree-path-7639d0`, tip `b8ae8bf6e0`, two Luna rounds) judges each delete on
its own and reads such variables: of 19 real refusals on 2026-11-05, 6 pass and 13 stay refused. Mason closed it
on 2026-11-05 because that narrowing kept leaking the same class of hole; the branch is kept for its pinned test
cases only. Workaround: run a delete or cleanup as its own command, not in one that `cd`s into a worktree.

### KI-113 — The customer-document byte-boundary prover is out of date

> **Re-checked 2026-11-22 on staging `f8ee14ee8`:** Resolved (after phase) · LOW · plan W3-43 · #1698, #1663, #635.

**LOW · RESOLVED 2026-11-22 · tooling-tests**
`scripts/smoke/prove-customer-document-bytes-server-only.mjs --phase=after` runs again on today's full migration
chain and today's unmodified `customer-document-files` function: `node scripts/local-app/doc-bytes.mjs rebuild`
(a third, separate local stack) then `node scripts/smoke/run-customer-document-bytes-proof.mjs` (30/30 checks;
`--negative-control` re-adds a browser read policy on the bucket and 4 checks fail, so the boundary is still
tested). Three assertions follow later decisions: any active rep may work any customer (20261013220000), and an
admin can still download a removed document (KI-07); a rep is still refused after removal and a driver is refused.
Still not covered: `--phase=before` (the original hole) needs the chain stopped before 20260914100700 and is kept
as historical; the function runs under host Deno, not the Edge Runtime container.

### KI-115 — Many screens send database errors to Sentry as "[object Object]"

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Agent (unassigned) · plan W3-44 · #1748, #1751, #1771, #1730, #1764.

**LOW · PARTLY FIXED · observability · source: 2026-11-10 prod spot-check (Sentry CRX-MANAGER-1W, -1S)**
About 70 files under `src/` report a caught error as `err instanceof Error ? err : new Error(String(err))`. A
Supabase error is a plain object, so Sentry receives only "[object Object]" and the real reason is lost (1W was an
expected "a size changed, build a new proposal" refusal on Group Products; 1S on the Office Cockpit finance card had no
matching database error, so it was most likely a network blip). The 2026-11-10 fix makes `src/lib/sentry.ts` title
plain error objects with their own message and drop network blips, and Group Products now sends the error's own
message. The other call sites now use the shared `toSentryError` (batch 1 #1748, billing #1751, orders, deliveries,
inventory, receiving and POs #1771, jobs, blend tickets, products and settings S3). Still open: 34 call sites in the
quote screens (QuoteBuilder, Quotes, `components/quotes`), which wait for Taha's quote UI work, and OrderDetail, which
waited for #1764 (now merged to staging, 2026-11-17). Login-token scrubbing (Luna, PR #1730) is replaced by a safe-fields-only
event (Mason, 2026-11-10, DECISION_LOG): Sentry gets the error type and title, stack file, function and line, our tags,
the user id, breadcrumb categories and path-only urls. The title is the only free text, and tokens are removed whole
before figures are blanked. Extra, other contexts, request query, headers and cookies, the serialized copy and breadcrumb
messages and data are never sent, for errors and performance samples alike (checked against a local Sentry stand-in).

### KI-164 — Stock and pricing proofs that cannot run, and a stale cost-review record

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · LOW · Agent (unassigned) · plan W3-45.

**LOW (proof) · PARTLY FIXED · tooling · found 2026-11-13 ([Product Master review](../audits/2026-11-13-product-master-review.md), Codex audit) · unassigned**
**2026-11-16 (repair step 6):**
- All four proofs below run to PASS again: the undo prover replays the whole chain, the three provers refuse only a
  later file that redefines what they rely on, and the pricing proof uses the current cost-change form.
- The 5 `cost-exposure-review` hashes were re-keyed after a live re-read. The only changed function their chains
  reach is `_enqueue_delivery_receipt`, which reads no cost.

Still open: the KI-159 database sweep and each repair step's regression test.

Several proofs did not complete on 2026-11-13, so those workflows are not certified:
- The full undo prover stops rebuilding at `20261217100000_job_access_ends_with_the_job.sql` (`JOB_ACCESS_BASELINE_DRIFT`).
- The cycle-count, tote-fill and PO close-short provers refuse newer dependent migrations before their scenarios.
- The pricing browser proof fails on an ambiguous Password locator, then on a removed Change Note field.

The live `cost-exposure-review` predicate fails on 5 changed signatures (`complete_delivery`,
`start_and_complete_delivery`, `create_invoice_from_order`, `create_split_invoices_from_order`,
`process_offline_action`). A manual check by both reviewers found no cost leak; the review hashes are stale.
Stock-vs-history is checked only in the browser integrity report and a one-off script, not by the database sweep
(KI-159). No tests cover KI-156 to KI-162. Fix: repair the fixtures alongside each repair step, refresh the review
hashes, and add each step's regression test. Repair step 6 (To-Do 0.17).

### KI-78 — Tooling and guard details (extends KI-04, KI-46, KI-47, KI-48, KI-49, KI-50, KI-65, KI-68)

> **Re-checked 2026-11-21 on staging `3a9694685`:** Partly open · MED · Agent (unassigned) · plan W2-42 · #516, #605, #364.

**MED/LOW · OPEN · tooling-guards**
- CodeRabbit label gate (#516), four items: stale requested state can survive an invalid ready event; checks can be
  stale after same-head invalidation; privileged workflow actions use mutable tags; merge guards do not bind
  approval to the recorded request marker or reviewer identity (MED; relevance lowered since CodeRabbit became
  advisory).
- PR #605 hook gaps, ACCEPTED 2026-11-02: `money-safety`, `rls-on-new-tables` and `generated-column-check`
  still read only `content || new_string`, so a MultiEdit payload would go unchecked, but the current
  Claude Code has no MultiEdit tool; non-canonical path spellings can bypass path-rule matching, `.env` aliases in
  `env-guard` included (LOW). Revisit trigger: if Claude Code regains a MultiEdit tool, reopen the 2026-11-02
  acceptance for these three content guards.
- `env-guard` service-role scan: FIXED 2026-11-08 (branch `claude/guard-port-envguard-ki107-7aecfa`). An Edit is
  judged as the whole file after the edit, comments are scanned like code, and a repo-relative or upper-case `src/`
  path counts. `*.test.ts(x)` files may quote `'service_role'` (several assert database grants) but still may not
  name the key or hold a JWT-shaped literal. Still not caught (LOW): frontend files with other extensions (`.mjs`,
  `.vue`, `.html`), a key name or role built at run time from pieces, keys not shaped like a JWT, and the `.env`
  path aliases accepted above.
- Review-proof guard: besides the 8.3 short name, an interpreter can build the path, a hard link can expose the file
  outside the state directory, and an alias/junction can be swapped after the check (MED). A separate
  `export GIT_PAGER=...` can evade it, like `GIT_EXTERNAL_DIFF` (LOW).
- The three protections missing from closed PR #364: apply-time one-shot replay enforcement, fresh project-bound
  live evidence, and event-trigger/transitive-fanout coverage (HIGH per the old record, exposure reduced).
- Ahead-of-pending marker: the parked branch's file-digest binding is not rechecked at the end, and three refusal
  tests assert only exit status, so an uncaught crash passes them (LOW).
- Actor-binding guard (accepted, KI-65): hook and live sweeps share naming blind spots; rebinding, dynamic SQL and
  temp-table paths evade checks; helper delegation is not followed; migrations written outside hooked tools bypass
  the hook.
- `sync-agent-workflows.mjs` limits (KI-49): external symlink targets can pass; external `GIT_INDEX_FILE` can be
  ignored; case/Unicode staged paths can evade checks or collide; a directory-to-file change can make repair fail;
  unowned manifest paths can be deleted; fail-closed wiring lacks regression coverage; some prune tests never reach
  the prune loop; `source-command-` is treated as provenance; invalid UTF-8 can compare equal after replacement
  decoding (MED).
- Cloud sessions also fail the commit gates (not only push and backup); the only workaround is unverified (MED, KI-50).
- `inventory.quantity_available` has no CHECK constraint, so a pre-existing NaN can propagate (MED, KI-68). The
  parked control-character migration's postflight checks can be satisfied by a commented-out clause and no longer
  inspect the cutover-trigger body (LOW, only if that branch is resumed).

### Also open in this area (tracked as GitHub issues or parked fixes; plain-English detail in [the plan](MASTER_FIX_PLAN.md))

| ID | Sev | Status | What goes wrong | Owner | Plan |
|---|---|---|---|---|---|
| #2191 | MED | Open | A squash of the main-into-staging merge would pass the gate and then break the release ancestry check, stalling a release. | Agent (unassigned) | W2-43 |
| #2192 | MED | Open | A hidden "Fixes #n" in a PR description can close an issue nobody meant to close. Taha merges .github changes. | Agent (unassigned) | W2-44 |
| #2194 | LOW | Open | If the same grants are stored in a different order the migration aborts safely and stops the release apply until re-checked. Severity lowered from MED: fails safe, no data touched. | Agent (unassigned) | W3-46 |
| #1950 | LOW | Check first | Two agents could land at once if the lock wait times out. | Agent (unassigned) | W3-55 |
| SOL-8 | BLOCKER | Resolved by removing the pass (PR #2203; closes when it merges) | The merge guard runs a helper from the working folder without first confirming it was reviewed, and that helper can reach live database credentials. Fix: the guard only runs reviewed code. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-01 |
| SOL-9 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | The merge guard's check of a PR's database changes can miss one on a very large PR, or read the file list and the files from different versions. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-02 |
| SOL-10 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | While a release is open, a hotfix's database change could go live while its app change is refused, leaving the two out of step. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-03 |
| SOL-11 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | The merge guard's 4-hour hold for Taha ends early once he comments, and does not keep honouring an explicit "hold". (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-04 |
| SOL-12 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A release-pass command naming an invalid PR number counts as approval for the open release. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-05 |
| SOL-13 | MED | Resolved by removing the pass (PR #2203; closes when it merges) | The guard's SQL comparison treats two slightly different texts (a line-ending edge case) as the same. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-06 |
| SOL-14 | MED | Resolved by removing the pass (PR #2203; closes when it merges) | A mistaken release command for a hotfix number blocks the later correct hotfix command. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-07 |
| SOL-15 | MED | Resolved by removing the pass (PR #2203; closes when it merges) | Checking many database files one by one can use up the guard's time budget and refuse a valid merge. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-08 |
| SOL-16 | MED | Resolved by removing the pass (PR #2203; closes when it merges) | A command sent with no PR number can attach to a release PR opened just after it was sent. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-09 |
| SOL-17 | MED | Resolved by removing the pass (PR #2203; closes when it merges) | A pass records only a PR number, not the repository, and the guard accepts both the old and new repository names. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-10 |
| SOL-18 | LOW | Resolved by removing the pass (PR #2203; closes when it merges) | An eleventh pass within 24 hours silently drops the oldest one early. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-11 |
| SOL-19 | LOW | Resolved by removing the pass (PR #2203; closes when it merges) | The lookup for the open release reads only the first 100 open PRs. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-12 |
| SOL-20 | LOW | Resolved by removing the pass (PR #2203; closes when it merges) | A slow GitHub answer can use up the prompt hook's whole time limit. (Sol round 2 on the local guard branch, 2026-11-22, not pushed; the release pass is on staging only.) | Agent (land #2203) | R2-13 |
| SOL-1 | BLOCKER | Resolved by removing the pass (PR #2203; closes when it merges) | The production merge gate could accept a local snapshot, not the live database record, as proof a reviewed migration was applied. Partly fixed locally (round 2 found new holes, SOL-8 to SOL-20; Mason chose to remove the pass, which was on staging only: PR #2203): The gate now compares the live ledger SQL with the PR's migration file. | Mason decision (un-park) | R-01 |
| SOL-2 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A message that only mentioned a release, or set a condition or a future time, could count as Mason's go-ahead. Partly fixed locally (round 2 found new holes, SOL-8 to SOL-20; Mason chose to remove the pass, which was on staging only: PR #2203): Only a message that is the bare command grants a pass. | Mason decision (un-park) | R-02 |
| SOL-3 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A go-ahead given for one release could cover a different release PR or another repository. Partly fixed locally (round 2 found new holes, SOL-8 to SOL-20; Mason chose to remove the pass, which was on staging only: PR #2203): The pass is pinned to the release PR open at that moment, in this repository only. | Mason decision (un-park) | R-03 |
| SOL-4 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A new approval refreshed the time limit on older approvals. Partly fixed locally (round 2 found new holes, SOL-8 to SOL-20; Mason chose to remove the pass, which was on staging only: PR #2203): Each grant keeps its own 24 hours. | Mason decision (un-park) | R-04 |
| SOL-5 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | Taha could lose his review window on a production merge. Partly fixed locally (round 2 found new holes, SOL-8 to SOL-20; Mason chose to remove the pass, which was on staging only: PR #2203): Pass-backed merges into main still wait out the hold. | Mason decision (un-park) | R-05 |
| SOL-6 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A release could be left half-applied on the live database. Partly fixed locally (round 2 found new holes, SOL-8 to SOL-20; Mason chose to remove the pass, which was on staging only: PR #2203): Pass-backed hotfixes are refused while a release PR is open. | Mason decision (un-park) | R-06 |

---

## Accepted risks (Mason decided to live with these; do not re-open without a new decision)

| ID | What | Why accepted |
|---|---|---|
| KI-17 | Blend-ticket linkage picks one order line per product: `link_blend_ticket_to_order` still takes `ORDER BY sort_order, id LIMIT 1`; automatic matching or splitting across tiers is not built | ACCEPTED limit (Mason 2026-11-05): the linkage is not used for money; the invoice side asks staff to pick (PRs #982, #995, #1020) |
| KI-60 | A permitted staff member can mint a temporary link to a private photo | Mason, option A, 2026-10-14 |
| KI-61 | A `LOCK TABLE` in a migration does not stop an already-running call of the OLD function body | Mason 2026-09-03; both instances applied with zero activity; future migrations of that shape need a quiet rollout and a concurrency proof |
| KI-62 | Live migration ledger has older entries with no file on `main` | Pre-existing drift, not new |
| KI-63 | Quote-version trust chain has live pins in two files (`quote-versions-rpc-owned.sql`, `quoteVersionWriteBoundary.test.ts`); migration `20260826220000` keeps its apply-time pin copy | Intentional friction; a live-pin change must update both live files, while the applied migration stays unchanged |
| KI-120 | Any rep can change a customer's payment terms, finance-charge settings, parent customer and default application service | Mason, 2026-11-19 (To-Do decision 18): reps keep access |
| KI-64 | All agents share Mason's admin GitHub identity; the manual merge override is fenced only by command matching | Mason declined a separate non-admin credential twice (2026-09-01) |
| KI-65 | The write-time actor-binding guard is bypassable by design limits | Capped by decision 2026-09-01; real controls are Codex review and post-apply sweeps |
| KI-66 | `review-proof-guard` denies destructive commands that spell out a worktree path | Mason "document, don't fix" 2026-08-20; narrowed 2026-11-03 (P3): only the worktree root, its `.claude`, an unreadable or `..` path, or a path-less wiper aimed at one still deny |
| KI-67 | `sync-agent-workflows --write` overwrites an unusable manifest; the `.agents/` drift sweep reads disk, not the git index | Mason 2026-09-03 |
| KI-68 | `adjust_inventory` accepts a retry key with control characters; a suspended second tab can resend a stale batch adjustment | Mason accepted 2026-09-20 / 2026-09-13; no caller can produce it; revisit if duplicate adjustments appear |
| KI-69 | Return-credit behaviours staff will see (late return credits stay in the current season; a funding invoice can't be deleted until the credit is voided) | Mason policy 2026-08-26 |
| KI-70 | Proof-file self-attestation; migration-source provenance closes the quiet path only; shell string-reconstruction bypasses; worktree awareness is a session-start snapshot; `npm --prefix/--workspace` escapes the script-body guard; Edge Functions and ~130 legacy reads exempt from check lint rules | Accepted residuals under the "honest mistakes, not malicious agent" model |
| KI-71 | Renaming/deactivating a profile named in a commission split fails closed; PWA needs two reloads after a deploy; ExcelJS tests slow on a cold cache; JobDetail save test must re-click | Deliberate / expected behaviour |
| KI-79 | A saved quote line forgets whether its acres were typed or filled in from the section's field (`save_quote` stores the acres, not the source; Quote Builder's `acres_source` lives only in the browser). Totals stay correct. After reopening, switching a section's field leaves those lines' acres as they were and shows "This section's saved lines keep their acres. Check them against the new field." Options weighed 2026-10-23: (1) keep as is, no cost; (2) store a typed/field flag on `quote_items`: a migration plus changes to `save_quote` (a money RPC) and every quote-copy path (duplicate, versions, rollover, template), which fall back to today's warning if they drop it; (3) save each line's field link and have the server recompute acres: a large `save_quote` rewrite, highest risk | Mason chose option 1, keep as is (2026-10-23, #1060 follow-up); revisit if reps report wrong acres after switching fields |
| KI-80 | A job line priced from a product's tier price is not re-checked when that tier price is later removed or the customer's tier changes; it is re-checked (`job_chemicals_price_required`, #1060) only when the line is next edited | Mason declined the re-check (2026-10-23, #1060 follow-up): rare case |
| KI-104 | Invoice email: the invoice page's Email button does not recognise a send made before 2026-11-05 under the old clock-based retry key, so it can send an unchanged invoice once more. The bulk Email on the Invoices list also checks the email log (a key that starts with the server-written `invoice:invoice:<id>:` prefix, to the same address, since the invoice last changed), so it skips those. A bulk skip does not see a bill-to correction made without changing the invoice; the invoice page's Email sends it. From then on the shared record key (invoice, its last change, the address and bill-to) stops repeats exactly | Mason, option A, 2026-11-05, narrowed by option A2 (To-Do 9.6): the email service change that would catch every old send was not approved |
| KI-106 | RUP sales register: an active admin can still add a row to `rup_sales_records` directly (the `rup_sales_insert` policy, older than KI-18). Such a row gets only the posted-invoice check; the sale-date, season and license checks run only in `generate_rup_sales_records`, which is the only path the app uses | ACCEPTED (Mason 2026-11-07): the register is low-importance; no extra guard wanted (Sol finding on PR #1579) |
| SOL-21 | Adding the #2201 order-total check briefly locks the orders table (5-second limit) | Sol round 3 on #2201; apply in the release window |
| SOL-22 | A legacy quote with an absurd stored total would fail to convert to an order | Sol round 3 on #2201; none exist |
| SOL-23 | The #2201 pre-check refuses the apply under an unusual session setting | Sol round 3 on #2201; fails safe |
| SOL-24 | Run outside one transaction, the #2201 pre-check fails with an unclear message | Sol rounds 2 and 3 on #2201; fails safe, changes nothing |

---

## Unverified items (could not confirm either way; treat as open until checked)

KI-20 (commission design choices; the per-delivery cent-loss claim was not reproduced by code read on
2026-11-10 and is not closed until the Bill Split smoke runs in a container), KI-29/KI-30 (live-data counts),
KI-41 (real-phone offline test: needs a person with a phone), KI-52 (prover, live-testdata false positives),
KI-111 (real boundary file: needs Mason). KI-16 split-acre rounding was confirmed and KI-92 and KI-112 closed on
2026-11-10; none of them is in this list.

---

## Closed in this rewrite (each with proof; full original text is in the archive)

Entries 1–6 were closed during the original rewrite; their older proof records are retained. Entry 7 was closed by the 2026-10-27 reconciliation. That reconciliation checked the live migration ledger, but did not re-run the older behavioral proofs.

1. **Staff photo buckets were publicly readable** — `20261015230000_staff_photo_storage_access.sql` and
   `20261016030000_staff_photo_buckets_private.sql`, PRs #929 and #947 (buckets read `public = false` live
   2026-10-16 per the older record).
2. **Reps could name another salesperson on invoices, orders, blend tickets and quotes** —
   `20261014210000` (PR #928), `20261015130000` (PR #933), `20261015200000` (PR #938).
3. **Free-form invoice could name any product** — `20261021050000_from_scratch_invoices_charge_lines_only`, PR #983.
4. **Split billing could not bill a field owner who is not the order's customer** — `20261021150000` and
   `20261021155000`, PR #1010 (merge `d8dd88a6d`).
5. **Order total overwritten by an unrounded sum in `_update_order_items_impl`** — fixed 2026-08-09; later bodies
   (e.g. `20260914100500:2263`) set the rounded total.
6. **`review-proof-guard` node-preload / `-pe` eval bypass (item 1 of the executor-bypass entry)** — PR #530
   (merge `26e8a40d9`); items 2–3 stay open in KI-47.

7. **KI-15, stored-profit Reports tabs** — PR #1134 merged 2026-10-27 (`cef4e3015`); `Reports.tsx` now calls `get_profitability_report` for customer, product and month groups. The PR records real-data local-app proof and paging/failure tests. Full report approval remains To-Do 10.2. Original issue and closure evidence appended to the archive.

8. **KI-85, stale sweep fingerprints on quote functions** — closed 2026-11-01 by the pin-refresh change on branch `fix/refresh-quote-sweep-pins-2026-11-01`; the 2026-11-01 live sweep adjudicated all 29 predicates `ok: true`, `complete: true`.

9. **KI-39, customer-facing PDF polish** — closed 2026-11-05: quote-PDF section notes wrap instead of overprinting (PR #1480); the year-end "Change" column shows green/red again (PR #1477). Both checked on a rendered PDF; original text appended to the archive.
10. **KI-27, an expired uncertain request locked its dialog** — closed 2026-11-05 by branch `claude/uncertain-intent-admin-clear-5591c7`: an admin-only "I checked the records — clear this" control (with a confirm) appears only once the safe retry window has passed, removes that browser's expired saved request, and is logged to Sentry. Proven on the local test app (admin clears and the form works again; a sales rep and a still-retryable request show no control) and by hook and component tests.
11. **KI-86, a direct admin turn-off skipped the warnings** — closed 2026-11-05: already fixed by `20261103100000_product_active_guard` (PR #1315, applied live 2026-11-02), whose trigger refuses any `is_active` change outside `set_product_active` with `PRODUCT_ACTIVE_RPC_REQUIRED`, so every turn-off passes the preview. Proven on the local test app: an admin's turn-off showed the "stock remains on hand" warning, and a direct admin `UPDATE` was refused.
12. **KI-87, a refused turn-off said "Product details changed"** — closed 2026-11-05: already fixed by PR #1321, which shows the database's blocker text. Proven on the local test app: a draft purchase order added after the review made Confirm show "purchase order TEST-KI87-PO" and reopen the review naming it.
13. **KI-88, Inventory loaded the whole catalog on mount** — closed 2026-11-05 by branch `claude/ki86-88-product-turnoff`: on mount the page reads only the ids of turned-off products (`select=id&is_active=eq.false`) for the Inactive label; the full catalog loads only when the Add Inventory or Create Hold picker opens. No migration. Proven on the local test app's network log (2,116 products: no catalog read until a picker opened) and by a component test.
14. **KI-05, RUP register rows for an unposted invoice** — closed 2026-11-05: `20261110140000_rup_records_require_posted_invoice` (PR #1513) applied live 2026-11-05 21:32:09 UTC (3:32 PM Central), ledger `20261105213209`. `generate_rup_sales_records` refuses an invoice that is not posted, paid or overdue (`RUP_INVOICE_NOT_POSTED`), and a trigger on `rup_sales_records` applies the same rule to a direct insert. Proven by the real-schema prover and, after the apply, the live smoke chain (`SMOKE_PASS_ROLLBACK`: a real draft invoice is refused, posting still writes one register row); live body, trigger and guard re-read after the apply.
15. **KI-89, inventory position used UTC dates** — closed 2026-11-08: already fixed by `20261204100000_ki18_batch1_chicago_today` (applied live 2026-11-06, ledger `20261107041703`), which re-emitted `_get_inventory_position_cost_impl_20261019` after WP-PM-3 with the Chicago date for season start and both hold-expiry checks. A read-only live query on 2026-11-08 found no `CURRENT_DATE` in that body or `get_inventory_position`, and the body's md5 (`6a74347a…`) is the one that migration's postflight expects. No new migration was needed.
16. **KI-90, reopen race through `set_product_active` had no automated proof** — closed 2026-11-08: `scripts/smoke/prove-product-retire-race-and-negative-stock-real-schema.mjs` replays every migration on `main` and races an order reopen against the real preview-and-confirm turn-off in both arrival orders on separate connections, with an observed row-lock wait. Reopen first: the stale preview's Confirm is refused (`PRODUCT_DEACTIVATION_BLOCKED`) and the product stays on. Turn-off first: the reopen is refused (`PRODUCT_INACTIVE`) and the order stays closed. Neither leaves an open order holding a turned-off product.
17. **KI-91, retired product with negative stock was checked by hand only** — closed 2026-11-08 by the same prover: a product at −2.5 on hand is turned off through `set_product_active` (one "stock" warning, no blocker), then stays in the inventory position report at −2.5, not flagged low, and in the admin cost report at −2.50 value; the same balance on an active product is flagged low.
18. **KI-92, accepted quote with a live order needed proof** — closed 2026-11-10 with no bug found. `scripts/smoke/prove-product-active-guard-real-schema.mjs`, temporarily extended with two cases, printed `PRODUCT_ACTIVE_GUARD_PROOF_PASS`: an accepted quote whose order is confirmed is not in the turn-off warnings, and an accepted quote whose only order is soft-deleted is. The container's `_product_active_review` matches live by md5 (`3c9f0b26…`, read-only live query the same day). The two cases were not committed (verification only). The checked-in prover no longer runs on `main` as is: it refuses because `20261204100000_ki18_batch1_chicago_today` sorts after WP-PM-3 and re-emits the inventory cost function it watches; the run skipped that file, which does not touch the quote warnings. Original text appended to the archive.
19. **KI-112, a draft return-credit prover failed just after midnight UTC** — closed 2026-11-10 with no bug found. `main`'s `scripts/smoke/verify-return-credit-real-schema.mjs` (live-dump version) passed twice on a fresh read-only dump of the live schema: at 2:15 PM Central, and at 6:05 PM Central (`main` `a1ba9e63d`, 00:05 UTC on 2026-11-11, so the UTC date was a day ahead of Central, the window where the closed PR #1319 version failed). Both printed `RETURN_CREDIT_LIVE_SCHEMA_PASS ... smoke=SMOKE_PASS_ROLLBACK residue=0`, including the fractional COGS proofs (`FRACTIONAL_COGS_DOUBLE_ROUNDING_DETECTED`, `FRACTIONAL_REPORT_HALF_CENT_DETECTED`). The old failure belonged to the abandoned baseline-replay version only. Original text appended to the archive.
20. **KI-143, vendor bills were checked against the ordered value** — closed 2026-11-11 by PR #1769, migration `20270103110000_ki143_vendor_bill_received_value_checks` (applied live 2026-11-11 8:24 AM Central, ledger `20261111142411`): a bill on a PO now needs a reason once the PO's bills go above 105% of what arrived (never more than the ordered total). Cancelled POs and a different vendor were already refused by the database. Proven by `scripts/smoke/prove-ki143-vendor-bill-received-value-real-schema.mjs`; live functions re-read after the apply.
21. **KI-135, Inventory Value subtracted negative stock and counted no-cost stock as $0** — closed 2026-11-11 by PR #1792
   (browser only, no migration): both totals come from `src/lib/inventoryValue.ts` and value only stock above zero with a
   cost, in exact whole cents; the Reports total adds the database's own rounded row values. Checked live 2026-11-11 as
   admin: the Inventory card and the Reports Inventory Cost total show the same figure, each with "19 below zero, not
   counted". The D12 item 7 relabel stays open under KI-135.
22. **KI-108, five products' stored stock did not match their transaction history** — closed 2026-11-11 by PR #1770, migration `20270103150000_ki108_stock_matches_history` (applied live 2026-11-11 9:17 AM Central, ledger `20261111151710`). Mason chose on 2026-11-10 to trust the history: Black Strap Molasses Tote 2,000 → 675, Start Right 2.0 Tote 670.19 → 140.19, 2,4D Amine Bulk 55 → 0, Start Right 2.0 2.5G 290 → 280; 2,4D Amine 2.5 Gal keeps 25 and got the missing +95 opening-stock row. Black Strap Bulk (−1,325) already matched and was not touched. Proven by `scripts/smoke/prove-ki108-stock-matches-history.mjs`; after the apply a read-only live check found every product's stored stock equal to its history and no open stock count, and the `/integrity-report` Inventory Ledger check passed (117 rows). Stock counts that overlap stock movement stay open as KI-134.
23. **KI-134, a stock count double-counted anything that moved while the count was open** — closed 2026-11-11 by PR #1775, migration `20270103170000_cycle_count_variance_vs_onhand_at_count` (applied live 2026-11-11 1:21 PM Central, ledger `20261111192101`, with Mason's in-chat approval): each saved count line is now compared with the on hand read at that save, so a receipt or delivery during an open count is no longer applied twice by Complete. Proven by `scripts/smoke/prove-cycle-count-onhand-at-count-real-schema.mjs` (`CYCLE_COUNT_ONHAND_PROOF_PASS`) and the live smoke `update_cycle_count_item` (PASS, rolled back). Mason accepted the remaining window (stock posted between looking at a shelf and saving its count; DECISION_LOG 2026-11-11); D12 procedure: post a product's receipts and deliveries before counting it.
24. **KI-142, a partly received purchase order could never be closed short** — closed 2026-11-11 by PR #1798 (database and list screens), migration `20270103180000_po_close_short` (applied live 2026-11-11 3:14 PM Central, ledger `20261111211435`, with Mason's `I approve` for its column grant), and PR #1807 (Close Short button, banner, records). A closed PO drops its unreceived remainder from on order, is final, can be billed only up to what arrived, and its line costs can be raised but never lowered (Mason, 2026-11-11). Proven by `scripts/smoke/prove-po-close-short-real-schema.mjs`; live read-only after apply: the function, three guard triggers and three columns exist, and no PO is closed. Which live POs to close is Mason's To-Do decision 23. Deferred polish: #1804.
25. **KI-99, voiding an invoice left its write-off active** — closed 2026-11-21: `20270116100000_ki99_void_reverses_write_offs` (PR #1883, shipped in release #1990) is in the live ledger (`20261121055645`), and the installed `_void_invoice_split_provenance_impl_20260719` marks active write-offs reversed (read-only check 2026-11-21; 0 write-offs live). The UTC credit-month part was already fixed live 2026-11-07. Original text appended to the archive.

26. **KI-01 — Drivers and applicators can read every customer's fields and some money totals** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): Migrations 20261023090000 (part A), 20261027 part B, 20261109052957 (part C); related lows closed per entry (KI-02 column lock, send-email escapes invoice HTML via supabase/functions/_shared/invoiceEmailGate.ts). Not re-tested live by me.
27. **KI-04 — Connected tools with no permission rule run without a prompt** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): .claude/settings.json ask rules (per entry; not re-read, low risk spot-check)
28. **KI-06 — Financial audit log can point at hard-deleted records** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): 20261115160000_financial_delete_snapshots.sql (on main and staging)
29. **KI-97 — Invoice email content is built by the app screen, not by the email service** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): supabase/functions/_shared/invoiceEmailGate.ts; send-email v22 live per entry
30. **KI-98 — Emailed invoice and purchase-order PDFs are drawn by the sender's app, not the server** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): supabase/functions/_shared/pdf/ ; send-email v23 live per entry
31. **KI-121 — The last active admin can remove their own admin role** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): 20270127130000_security_batch_ki121_ki123.sql:97-98 (BEFORE UPDATE OF is_active, role); on main too
32. **KI-123 — The signed-out role keeps read grants it does not need** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): 20270127130000_security_batch_ki121_ki123.sql:129-130 (REVOKE SELECT ON ALL TABLES / sequences FROM anon); on main too. Live apply not checked here.
33. **KI-124 — The public (anon) key is hard-coded in 5 end-to-end test files** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): tests/e2e/workflow-*.spec.ts, comprehensive-ui-workflow.spec.ts:20-21, golive/utils/supabase-helpers.ts:12-14 use process.env; no eyJ literal found in tests/; also on main
34. **KI-11 — Browser screens throw away or share their retry key (double-apply risk)** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `src/lib/pendingRetry.ts` and `src/__tests__/idempotency-reset-order.test.ts` exist on staging and main; server binding via KI-10 batches. Cosmetic follow-up not verified
35. **KI-12 — Quote "Convert to Order" can leave an accepted quote with no order** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `src/pages/QuoteBuilder.tsx:4076-4097` calls `convert_quote_to_order`; `20261029090000_quote_accepted_requires_order.sql:47` (`QUOTE_ACCEPTED_WITHOUT_ORDER`); live ledger per entry
36. **KI-14 — Transfer-created field invoices are always Net 30** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261120100000_field_invoice_due_date_follows_owner_terms.sql` on staging (live per entry, ledger `20261106145427`)
37. **KI-18 — Dates and seasons follow the UTC clock or the browser clock (fixed; last part `20261208100000`)** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261121090000`, `20261204100000`, `20261208100000`, `20261206110000` all on staging; live per entry
38. **KI-19 — Accounting-month close: edits racing a close (fixed by `20261103220000`)** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261103220000_period_check_takes_month_lock.sql:62` (`check_period_open` newest definition)
39. **KI-81 — Two invoice paths read a quote line's current price, not the price the customer was sent** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270125163000_ki81_invoices_bill_sent_quote_price.sql`, `20270129140000`, `20270129180000` are on staging AND main; all three are in the live ledger (versions `20261121060632`, `...061135`, `...061322`). Follow-ups open
40. **KI-95 — Historical AR aging fails for everyone if one customer cannot be rebuilt** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261103150000_ar_aging_flags_unrebuildable_customers.sql`, `20261104120000_balance_reports_flag_unrebuildable_customers.sql`, `20261103220000` on staging (live per entry). Small LOW over-flag accepted
41. **KI-156 — A field-application invoice books the grower-share chemical's cost in the wrong unit** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270120140000_grower_share_cost_in_sold_unit.sql` and `20270120150000_grower_share_line_saves_for_admins_and_reps.sql` on staging and main; both in live ledger (`20261121060017`, `...060044`) Closed: both migrations are in the live ledger (2026-11-21).
42. **KI-28 — Jobs assigned to a non-applicator never reach the dispatch board** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261215100000_dispatch_sync_on_applicator_qualify.sql:114` trigger `trg_sync_job_location_dispatch_on_applicator_qualify`; on main and staging
43. **KI-85 — Receiving offers warehouses that cannot ship** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261102220000_receive_po_items_active_warehouse_only.sql` (UNKNOWN_STORAGE_LOCATION); newest definer of receive_po_items and manual_inventory_add; on main and staging. Part B deferred by design.
44. **KI-93 — One blend ticket can deduct its stock twice** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261107050000_blend_tickets_application_records_only.sql`; `BLEND_TICKET_ORDERS_DISABLED` still in newest definer `20261204100000`. The app-record + job-completion route is KI-187.
45. **KI-94 — Voiding a delivery can put back more reserved stock than completion took** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261106230000_void_delivery_restores_exact_reservation.sql`, `20261106233000`; `20261107120000` is the newest `_void_delivery` definer; on main and staging
46. **KI-100 — A spray job could leave a booking with a remainder no Partial Order can take** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261107070000_job_reservation_whole_hundredths.sql`, on main and staging
47. **KI-101 — Voiding a delivery on a cancelled order reopens the order** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261107120000_void_delivery_respects_voided_and_cancelled_orders.sql`; `20261116100000_permission_tightening.sql`; both on main and staging
48. **KI-102 — Voiding an order, then one of its deliveries, puts the stock back twice** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20261107120000` (`ORDER_VOIDED_DELIVERY_LOCKED`), on main and staging
49. **KI-116 — Product Detail treats a non-product address as a load failure** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `src/components/ProductDetailRoute.tsx:6-15`, on main and staging. Entry text "FIXED in PR" is stale.
50. **KI-136 — Receiving adds the typed number whatever unit the PO line is in** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270121110000_line_unit_is_stock_unit.sql` + `20270121120000`; on main and staging. Residual: over-receive of a fully received other-unit line is refused (minor).
51. **KI-137 — Two seed-treatment products are stocked and priced per Lb at per-jug money** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270121100000_ki137_powder_keg_each_piksi_mg_labels.sql`, on main and staging
52. **KI-139 — "Reconcile negative inventory" can overwrite any row, not just negative ones** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270113100000_stock_checks_negative_onorder_chicago.sql` (reconcile refuses non-negative rows; `adjust_inventory` accepts any increase); on MAIN, so entry's "not applied live" is stale
53. **KI-141 — Retiring an inventory row ignores open purchase orders** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270113100000...sql:196` "still on order" refusal in `_retire_inventory_item_replay_impl_20261015`; on main (entry "not applied live" is stale)
54. **KI-158 — Orders and deliveries move stock without checking units** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270121110000_line_unit_is_stock_unit.sql`; on main and staging
55. **KI-159 — Cancelling a received return writes a history row both stock checks read with the wrong sign** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `src/lib/reconciliation.ts:185` `returned: 'signed'` (staging and main); `scripts/db-invariant-sweeps/predicates/stock-matches-history.sql` on both. Entry says "FIX IN REVIEW, not live": stale.
56. **KI-161 — Delivery editing does not re-check the edited line against its order line** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270126110000_inventory_cleanup_ki161_163_150.sql:100-158` (`_delivery_line_matches_order_line`, trigger `a2_delivery_line_matches_order_line`). It is live: present on origin/main; entry's "not applied live" is wrong.
57. **KI-162 — The Receiving Log filters by UTC date** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270113100000...sql:294-295` America/Chicago bounds in `get_receiving_log`; on main (entry "not applied live" stale)
58. **KI-145 — Bulk Customer Import fails for every rep and misreads some files silently** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `src/components/customers/BulkCustomerImport.tsx:302-307` (rows call `save_customer`); same on origin/main (`:360-364`). Entry header still says "FIX IN REVIEW"; stale.
59. **KI-146 — Farm groups (parent customer) can form a loop, and grandchildren are left out** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270127200000_ki146_farm_group_no_loops.sql`; present on both staging and origin/main (entry says "live with next release" but main already has the file).
60. **KI-148 — Deactivating a customer doesn't check open orders, deliveries, holds or quotes** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270128140000_customer_deactivation_checks_open_work.sql` (staging and main); follow-ups `20270129210000_customer_deactivation_open_work_followups.sql` and `20270201120000_inactive_customer_refuses_new_work.sql` are staging-only (FIXED-ON-STAGING for the "no new work" gap). Core guard live; the "inactive customer gets no new work" part (#2048) is on staging only. Reactivate button is #2197.
61. **KI-150 — Receipt reversal takes the PO locks in the opposite order from vendor bills** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270126110000_inventory_cleanup_ki161_163_150.sql:196-250` (locks stock rows in product order); on both staging and main. Entry header still says OPEN; stale.
62. **KI-35 — Live ledger vs files on `main` is checked only by noticing** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `package.json:41` (`db-drift:live`), `scripts/check-migration-drift.mjs`, `scripts/migration-drift-allowlist.json`. Not scheduled.
63. **KI-38 — Edge Function error alerting fails quiet** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `warnIfSentryMisconfigured` referenced 21 times under `supabase/functions` on both staging and main.
64. **KI-83 — The `idempotency_keys` table has no TypeScript type** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `src/types/index.ts:1856` `IdempotencyKey`, on both staging and origin/main. Entry header still says "FIX IN REVIEW"; stale.
65. **KI-166 — A quote for a product with no stock unit is priced as if sold by the each** — closed 2026-11-21 by the [master-plan re-check](MASTER_FIX_PLAN.md): `20270129171000_field_app_refuses_product_without_sold_unit.sql:40` `inventory_unit SET NOT NULL` + alnum CHECK (also on origin/main). The `COALESCE(...,'Ea')` fallback remains but is unreachable (`20270121110000:210`, `20270125110000:725`). This is the entry's own proposed fix Closed: every product now must have a stock unit (20270129171000, live).
66. **KI-82 — The open quote screen can show a stale cost for a line it just saved** — closed 2026-11-22 (triage): PR #1209 merged to `main` 2026-10-30 (`QuoteBuilder.tsx` `refreshSavedLineCosts` re-reads the saved cost after an admin save). Original text appended to the archive. Fixed parts also removed in this triage and appended to the archive: KI-16 (Quote Builder line math in exact cents, PRs #1430 and #1892), KI-73 (parts A, B, C), KI-74 (cost paths, `invoice_post_version`), KI-76 (season fallbacks, the whole-order quantity cap and the posted-invoice delivery void: PR #1174, `20261029160000`, live 2026-10-30).

Also closed inside the old file's own headings before this rewrite (no new proof needed, see archive): the
Deliveries list scheduled-delivery gap (PR #964), smoke chains rotted by the PO cost lock, the regular invoice
editor posting old amounts, the filed-season date-edit guard, the last commission-cohort migration
`20260914100900`, and the `customer-document-files` v2 redeploy.
