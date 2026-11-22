# Master fix plan — every open flaw, grouped and ordered (2026-11-21)

**What this is.** One deduplicated list of every real bug, error and business-logic flaw that the recent audits and reviews found and that is still open, grouped by business area with a fix order. [KNOWN_ISSUES.md](KNOWN_ISSUES.md) stays the canonical list (full detail and evidence); this page is the plan. Documentation only: nothing here changes code or data.

**How it was built.** Every open entry in KNOWN_ISSUES.md, the [2026-11-21 quote-to-invoice audit verification](../audits/2026-11-21-quote-to-invoice-audit-verification.md) (KI-185 to KI-199, decisions 30-33), GitHub issues #2145 and #2190-#2197, Sol's round 1 on the closed release #2189, open GitHub issues that report real bugs, and the open findings in `docs/audits/` were each re-read against the code on `origin/staging` `3a9694685` (compared with `origin/main` `00003d8a2`, which is what production runs). Read-only live-ledger lookups confirmed which fixes are live. Nothing was run against a database.

**How to read a row.** *Sev*: BLOCKER / HIGH / MED / LOW. *Status*: Open; Partly open; Check first (a credible report that code reading could not settle; prove or close it before fixing); Mason decision (needs a business call first); On staging, not live (fixed, waits for the release); Fixed locally, parked (fix exists only on a local branch). *Owner*: Taha owns quotes, bookings, the office invoice screens and billing until 2026-12-15; field-application billing and blend tickets are Mason's own work (Mason, 2026-11-22); "Mason decision" waits on his call; "Agent (unassigned)" means nobody is on it. *Order*: R = ship what is already built (release), R2 = release-pass findings resolved by removing the pass (PR #2203), W1 = HIGH, W2 = MED, W3 = LOW, D = decisions; the number is the suggested sequence inside each wave. Taha's items keep their wave but start when Taha takes them or after 2026-12-15.

## Counts (open items, by area and severity)

| Area | BLOCKER | HIGH | MED | LOW | Open total | Built, awaiting release (R) |
|---|---|---|---|---|---|---|
| Quotes and bookings |  | 1 | 3 | 6 | 10 |  |
| Orders and deliveries |  | 1 | 6 | 2 | 9 | 2 |
| Inventory, purchasing and products |  | 1 | 6 | 12 | 19 | 2 |
| Invoices, billing and returns |  |  | 9 | 8 | 17 |  |
| Payments and receivables |  | 1 | 2 | 2 | 5 |  |
| Reports and commissions |  | 1 | 4 | 2 | 7 | 4 |
| Field applications (jobs, blend tickets, field invoices) |  | 6 | 7 | 7 | 20 | 1 |
| Permissions and security |  | 1 | 4 | 4 | 9 | 1 |
| Customers, data and cut-over |  |  | 4 | 2 | 6 |  |
| Guards, tooling and release process | 1 | 5 | 13 | 12 | 31 | 6 |
| **Total** | **1** | **17** | **58** | **57** | **133** | **16** |

"Open total" counts Open, Partly open, Check first and Mason decision. Not counted: 32 accepted risks and 3 backlog entries (listed at the end), and 41 entries found already fixed (40 in the 2026-11-21 re-check, KI-82 in the 2026-11-22 triage) (dropped, listed at the end).

## Top 5 to fix first

1. **Land the release-pass removal and #2201, then ship the release (R).** Sol round 1 on release #2189 found 7 BLOCKER/HIGH problems (SOL-1 to SOL-7). SOL-7 is fixed in PR #2201 (into staging; Sol round 3 clean). For SOL-1 to SOL-6, Sol round 2 on the patch found 13 more problems (SOL-8 to SOL-20), so Mason chose to remove the staging-only release pass instead: PR #2203 (issue #2202) resolves all 19. Until the release ships, the staging-only fixes (KI-199, KI-125, KI-126, KI-130, KI-119, KI-170, #2064 and more) cannot reach production.
2. **Month-End close shows $0 payments received (KI-129 / #2195, HIGH).** The close receipt totals the old payments table, counts deleted payments and misses payments recorded through allocation sets, so the month's cash figure is wrong. Fix with one agreed rule for prepayment checks and prove a month with an allocation-only receipt.
3. **A completed job can still be deleted by a rep outside the new job screens (#2196, HIGH).** The rule lives only in the new job function; enforce it in the database for every path so billable work can't drop out of Unbilled Jobs.
4. **Field billing must bill what was actually sprayed, at the right price (KI-185 HIGH, KI-198 HIGH, KI-186 MED).** Rules are decided (decisions 31 and 33); build them before Transfer or office auto-draft bills real work. Mason's own work (field billing).
5. **Prove or close the two job double-billing reports (#2061, #2063, HIGH, check first).** Each claims a job can be billed twice through blend-ticket and split-billing paths; settle them with a database test, then fix together with the blend-ticket stock double-deduction (KI-187) before the first live blend ticket.

Next after these: KI-169 (Page Access locks for invoice and payment actions; Mason scheduled the money part after 2026-12-15), KI-190 (Partial Order uses reviewed terms), KI-167/KI-168 (old-unit leftovers), KI-75 (credit-memo apply race) and KI-73 (field-access leftovers).

## Step R — ship what is already built

**Parked Sol fixes (release #2189, round 1).** Fixed locally, parked by Mason 2026-11-21, not pushed, no PR, not applied anywhere: findings 1-6 on local branch `claude/release-pass-sol-fixes` (commit `a4d409269`), finding 7 on local branch `claude/orders-total-price-finite` (commit `4b89cf605`, migration `20270208100000`). Both are local-only folders on Mason's PC; do not delete them. Findings 1-6 affect the release-pass guard, which is on staging only (not on main). Finding 7's affected P&L migration `20270206110000` is also staging-only. To resume: run Sol on each branch, open PRs into staging, wait Taha's 4-hour hold, merge, re-open the release, and Mason sends the release command again.

**Update 2026-11-22 (un-park rounds).** Finding 7 is now PR #2201 into staging: Sol round 2 found a HIGH (part-cent order totals skewed the commission split), fixed in `d6c087a0d` by requiring whole cents; round 3 was clean; 4 LOWs were accepted (SOL-21 to SOL-24). Findings 1-6: Sol round 2 on the local guard branch (not pushed) found 13 new problems, SOL-8 to SOL-20, listed under Guards below. The branch stopped at the review-round cap; Mason chose to remove the release pass (it was on staging only), in PR #2203 (issue #2202), which resolves SOL-1 to SOL-6 and SOL-8 to SOL-20.

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| R-01 | SOL-1 | BLOCKER | Resolved by removing the pass (PR #2203; closes when it merges) | The production merge gate could accept a local snapshot, not the live database record, as proof a reviewed migration was applied. Partly fixed locally; round 2 found new holes (SOL-8 to SOL-20); the release pass is on staging only: The gate now compares the live ledger SQL with the PR's migration file. | Sol round 1, release #2189 |  | Agent (land #2203) |
| R-02 | SOL-2 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A message that only mentioned a release, or set a condition or a future time, could count as Mason's go-ahead. Partly fixed locally; round 2 found new holes (SOL-8 to SOL-20); the release pass is on staging only: Only a message that is the bare command grants a pass. | Sol round 1, release #2189 |  | Agent (land #2203) |
| R-03 | SOL-3 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A go-ahead given for one release could cover a different release PR or another repository. Partly fixed locally; round 2 found new holes (SOL-8 to SOL-20); the release pass is on staging only: The pass is pinned to the release PR open at that moment, in this repository only. | Sol round 1, release #2189 |  | Agent (land #2203) |
| R-04 | SOL-4 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A new approval refreshed the time limit on older approvals. Partly fixed locally; round 2 found new holes (SOL-8 to SOL-20); the release pass is on staging only: Each grant keeps its own 24 hours. | Sol round 1, release #2189 |  | Agent (land #2203) |
| R-05 | SOL-5 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | Taha could lose his review window on a production merge. Partly fixed locally; round 2 found new holes (SOL-8 to SOL-20); the release pass is on staging only: Pass-backed merges into main still wait out the hold. | Sol round 1, release #2189 |  | Agent (land #2203) |
| R-06 | SOL-6 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A release could be left half-applied on the live database. Partly fixed locally; round 2 found new holes (SOL-8 to SOL-20); the release pass is on staging only: Pass-backed hotfixes are refused while a release PR is open. | Sol round 1, release #2189 |  | Agent (land #2203) |
| R-07 | SOL-7 | HIGH | PR #2201 open into staging | A broken or absurd order total would distort the share-billed commission in profit reports. PR #2201 open into staging (round 2 also required whole cents; round 3 clean): New migration 20270208100000 refuses order totals that are not finite or are at or above the report's usable limit (1e15). | Sol round 1, release #2189 |  | Agent (land #2201) |

**Fixed on staging, waiting for the production release.**

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| R-08 | KI-199 | HIGH | On staging, not live | Fixes for overstated partial deliveries and wrong-grower field drafts are not yet live. | KNOWN_ISSUES (2026-11-21 audit) | #2045, #2142, #2171, #2164 | Mason (field-app billing) |
| R-09 | KI-125 | HIGH | On staging, not live | Profit reports showed a fake large loss because commission was counted on sales billed elsewhere. | KNOWN_ISSUES | #2149 | Taha (to 2026-12-15) |
| R-10 | KI-119 | HIGH | On staging, not live | A person with Reports hidden can still pull report data from the database; the reports lock closes that (not yet live). Invoice/payment locks are KI-169. | KNOWN_ISSUES |  | Agent (unassigned) |
| R-11 | KI-126 | MED | On staging, not live | If an acre-priced service ever gets a cost, cost of goods would be wildly overstated. | KNOWN_ISSUES | #2149 | Agent (unassigned) |
| R-12 | #2064 | MED | On staging, not live | A rep can now save an included grower-share chemical only if the per-acre price covers cost; otherwise an admin is needed. Not on main yet. | GitHub issue | #2064 | Agent (unassigned) |
| R-13 | #1912 | LOW | On staging, not live | Retry keys with hidden characters are now refused. Issue can be closed once released. | GitHub issue | #1912 | Agent (unassigned) |
| R-14 | KI-130 | LOW | On staging, not live | Past months showed today's receivables under a misleading label; now labelled "Current AR (today)". | KNOWN_ISSUES | #2149 | Agent (unassigned) |
| R-15 | KI-170 | LOW | On staging, not live | Rarely, a product page showed the wrong preferred vendor name until reload; the page now re-reads the whole product after any vendor change (#2185). | KNOWN_ISSUES | #2185 | Agent (unassigned) |
| R-16 | #2018 | LOW | On staging, not live | Drivers saw an empty Available deliveries card; the card now loads open deliveries through get_available_deliveries_for_driver (#2165). Issue closed. | GitHub issue | #2018, #2165 | Agent (unassigned) |

## Open items by area

### Quotes and bookings (10)

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| W1-09 | KI-190 | HIGH | Open | Two reps drawing from one booking can order at quantities/prices neither saw. | KNOWN_ISSUES (2026-11-21 audit) | #2181 | Taha (to 2026-12-15) |
| W2-01 | KI-192 | MED | Open | The remaining-dollars card on a booking can be off when lines have different prices (display only) | KNOWN_ISSUES (2026-11-21 audit) |  | Taha (to 2026-12-15) |
| W2-02 | KI-193 | MED | Open | A copied quote can go to a grower at the old price. | KNOWN_ISSUES (2026-11-21 audit) | #2182 | Taha (to 2026-12-15) |
| W2-03 | #2075 | MED | Open | A quote written before but sent after the job date can set an earlier job's price. | GitHub issue | #2075 | Taha (to 2026-12-15) |
| W3-02 | KI-194 | LOW | Open | Rep may see "Sent" or a generic error when the email failed; re-downloaded PDFs show a new date. | KNOWN_ISSUES (2026-11-21 audit) |  | Taha (to 2026-12-15) |
| W3-03 | KI-105 | LOW | Partly open | A quote can be priced at a tier other than the customer's; a screen warning exists but the database does not refuse it for reps. Screen warning is merged; only the database refusal is missing. | KNOWN_ISSUES |  | Taha (to 2026-12-15) |
| W3-04 | KI-140 | LOW | Partly open | Unknown-unit fallback is fixed; a dry product rated in liquid ounces can still price wrongly. | KNOWN_ISSUES |  | Taha (to 2026-12-15) |
| W3-47 | #2129 | LOW | Check first | One old saved retry record is oddly keyed; effect is cosmetic or a failed replay. Depends on a live data row. | GitHub issue | #2129 | Taha (to 2026-12-15) |
| W3-48 | #2071 | LOW | Check first | A quote sent mid-save could price some lines of one invoice and not others. | GitHub issue | #2071 | Taha (to 2026-12-15) |
| W3-49 | #1970 | LOW | Check first | Sections already refuse repeated keys (SECTION_ID_INVALID); items not confirmed. | GitHub issue | #1970 | Taha (to 2026-12-15) |

### Orders and deliveries (9)

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| W1-10 | KI-167 | HIGH | Open | Office must hand-fix a line's unit before it can be re-delivered; no amounts change. | KNOWN_ISSUES | #1896 | Taha (to 2026-12-15) |
| W2-04 | KI-128 | MED | Open | Voiding an order can leave its invoice alive in receivables, reminders and finance charges. | KNOWN_ISSUES |  | Taha (to 2026-12-15) |
| W2-05 | KI-191 | MED | Open | Booking orders vanish from salesperson-filtered sales reports. | KNOWN_ISSUES (2026-11-21 audit) |  | Taha (to 2026-12-15) |
| W2-06 | KI-25 | MED | Partly open | A delivery receipt that fails to send is queued and sent by a worker, but the office cannot mark one "handled", so handled ones stay on the check list and a customer may get a second copy. | KNOWN_ISSUES |  | Agent (unassigned) |
| W2-07 | KI-188 | MED | Open | A remainder stays "scheduled" after its follow-up delivery is cancelled or voided, so the pending queue no longer shows product still owed. | KNOWN_ISSUES (2026-11-21 audit) | #2179 (open) | Agent (unassigned) |
| W2-45 | #2097 | MED | Check first | Stock held for a grower could release early. The expiry job does skip quotes with quantity_drawn > 0, so the described gap was not reproduced. | GitHub issue | #2097 | Taha (to 2026-12-15) |
| W3-05 | KI-152 | LOW | Open | No database rule stops a completion from reopening a cancelled order, but the app cannot reach it today. | KNOWN_ISSUES |  | Agent (unassigned) |
| W3-50 | #1960 | LOW | Check first | An old retried save may not get section ids back. | GitHub issue | #1960 | Taha (to 2026-12-15) |
| D-01 | #2065 | MED | Mason decision | Closing short releases holds and purchasing demand; needs Mason's rule (booking's rep or admin only). Guard currently blocks reps only when a live job exists. | GitHub issue | #2065 | Mason decision |

### Inventory, purchasing and products (19)

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| W1-11 | KI-168 | HIGH | Open | That purchase cannot be used as an actual-cost basis; nothing reads it yet (costing parked). | KNOWN_ISSUES | #1896 | Agent (unassigned) |
| W2-08 | KI-114 | MED | Open | Some products store the wrong rate unit (e.g. milligrams vs grams, per-seed rate stored per acre), so a quote could price or deduct wrongly if switched on. Mason answered the label question 2026-11-21 (18 grams per acre); the remaining work is the data fix. | KNOWN_ISSUES | #1958 | Agent (unassigned) |
| W2-09 | KI-160 | MED | Partly open | Duplicate open counts are now blocked; creating a count is still several separate requests, so a failed create can leave an empty open count that blocks that warehouse. | KNOWN_ISSUES |  | Agent (unassigned) |
| W2-10 | KI-144 | MED | Open | A vendor rename does not carry to old purchase orders, so vendor reports and bill checks can miss some orders. | KNOWN_ISSUES |  | Agent (unassigned) |
| W2-11 | KI-165 | MED | Open | A count started before a unit change could record stock in the wrong unit; not reachable today. | KNOWN_ISSUES | #1896 | Agent (unassigned) |
| W2-12 | #2190 | MED | Open | Two deliveries completing at the same moment on the same products can make one fail and need a retry; nothing is saved wrongly. | Sol round 1, release #2189 (GitHub) | #2190 | Agent (unassigned) |
| W2-13 | #2193 | MED | Fixed (staging PR) | If applied before the EPA batch, the one-time load commits with some ingredients missing their groups and never fills them later. | Sol round 1, release #2189 (GitHub) | #2193 | Agent (Lane D) |
| W3-07 | KI-100 | LOW | Open | An editor can type rate changes that get thrown away when another admin locks rates meanwhile. | KNOWN_ISSUES |  | Agent (unassigned) |
| W3-08 | KI-103 | LOW | Open | A file with an unknown extra column looks fine in preview, then the whole save is refused (nothing written) | KNOWN_ISSUES |  | Agent (unassigned) |
| W3-09 | KI-109 | LOW | Open | Stale "previewed" price-change sets pile up; a completed job can still be edited; a few small UI/label gaps. | KNOWN_ISSUES |  | Agent (unassigned) |
| W3-10 | KI-138 | LOW | Open | A few products have a saved margin that does not match their prices; a recalculation could reprice one. | KNOWN_ISSUES |  | Mason decision |
| W3-11 | KI-163 | LOW | Partly open | Items 1 and 2 fixed; reservation/return history rows are still linked to their source only by note text (3); item 4 is not a defect. | KNOWN_ISSUES |  | Agent (unassigned) |
| W3-12 | KI-151 | LOW | Open | A cost correction is compared to the ordered total, not to what actually arrived, so a bill check can differ from the receipt rule. | KNOWN_ISSUES |  | Agent (unassigned) |
| W3-14 | KI-196 | LOW | Open | The same chemical can be found by different words on different screens and be grouped or labelled differently. | KNOWN_ISSUES (2026-11-21 audit) |  | Agent (unassigned) |
| W3-15 | KI-197 | LOW | Open | A second admin on a stale screen can silently replace a newer cost correction; one label may point at the wrong PO. | KNOWN_ISSUES (2026-11-21 audit) |  | Agent (unassigned) |
| W3-16 | #2172 | LOW | Open | A very large batch (about 3,000 approvals) could make Confirm silently send nothing. Not reachable today (hundreds of rates). | GitHub issue | #2172 | Agent (unassigned) |
| W3-17 | #2135 | LOW | Open | Staff see an inflated short-stock count and get two warnings and two notifications; stock math is right. | GitHub issue | #2135 | Agent (unassigned) |
| W3-51 | #1829 | LOW | Check first | A confirmed rate approval could be lost if the reply is dropped and the user leaves. | GitHub issue | #1829 | Agent (unassigned) |
| D-04 | KI-29 | LOW | Mason decision | Several stuck deliveries, negative stock rows, flagged products and odd PO lines need Mason's yes/no before anyone changes real records. | KNOWN_ISSUES |  | Mason decision |

### Invoices, billing and returns (17)

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| W2-14 | KI-10 | MED | Partly open | A retried invoice-group post with a reused key can show a false "success" on the wrong record; nothing is charged twice. | KNOWN_ISSUES |  | Taha (to 2026-12-15) |
| W2-15 | KI-157 | MED | Open | Renaming a product changes how old invoices print and re-send, though old invoices should stay as sold. | KNOWN_ISSUES | #2183 (related) | Taha (to 2026-12-15) |
| W2-16 | KI-189 | MED | Open | A return could credit more than the customer paid per unit. | KNOWN_ISSUES (2026-11-21 audit) | #2180 | Taha (to 2026-12-15) |
| W2-17 | KI-72 | MED | Partly open | Fix is live (reps cannot build a field-app invoice through order functions). Remaining: two proof steps only (a declined live-sweep predicate; smoke chains needing Mason's REAL-DATA-OK). PO email copy sub-item is DONE. | KNOWN_ISSUES | #885, #1114, #1147 | Mason decision |
| W2-18 | KI-76 | MED | Partly open | FIXED: unit-less invoice lines (`20270106100000`), customer summary season (`20261204110000`), Transfer Net 30 (#1556). Still open: quote re-save refusal with many same-product lines; field-app split commission stamps UTC date; reps read others' split-return prices; return can go stale after cancel/recreate; whole-order invoice quantity/price not capped server-side; voiding a delivery with a posted invoice leaves the invoice active; 2 unit-less drafts left on purpose; paging can miss rows. | KNOWN_ISSUES | #1731, #1174, #1556 | Taha (to 2026-12-15) |
| W2-19 | #2091 | MED | Open | A race could refund tax the ledger records as zero, misstating month-end revenue. Pattern present; race not reproduced. | GitHub issue | #2091 | Taha (to 2026-12-15) |
| W2-46 | #2082 | MED | Check first | A restricted-use line could re-save as non-restricted so the RUP sales record is skipped on posting. Setter file located; re-derivation not traced. | GitHub issue | #2082 | Taha (to 2026-12-15) |
| W2-47 | #2066 | MED | Check first | A return could be refused after the tax box changes. Detail withheld in issue; not traced. | GitHub issue | #2066 | Taha (to 2026-12-15) |
| W2-48 | #2105 | MED | Check first | A posting could use a product with no sold unit. The save path already refuses it (FIELD_APP_UNIT_UNCONVERTIBLE); posting itself not checked. | GitHub issue | #2105 | Mason (field-app billing) |
| W3-18 | KI-16 | LOW | Partly open | Unit and fluid-ounce guards are live. Left: job-line cost rounds to whole cents on unit conversion, split-acre shares can be 0.01 off, quote line math is in dollars, draft cost header differs by 1 cent on half-cent lines. | KNOWN_ISSUES |  | Agent (unassigned) |
| W3-19 | KI-110 | LOW | Open | A quick-delivery cancel is refused if its draft invoice has money; order-line edits can race an invoice post; extra table grants on finance charges (rows still blocked by policy) | KNOWN_ISSUES |  | Taha (to 2026-12-15) |
| W3-20 | KI-131 | LOW | Open | Voided delivery invoices keep a dollar total; safe today only because every report filters by status. | KNOWN_ISSUES |  | Taha (to 2026-12-15) |
| W3-21 | KI-153 | LOW | Open | A dead-end function that cannot bill goods; harmless but confusing. | KNOWN_ISSUES |  | Taha (to 2026-12-15) |
| W3-22 | #2069 | LOW | Partly open | A line could be priced in a different unit than the quote. The grower-share cost read now locks the product row (FOR SHARE); other reads in the save not checked. | GitHub issue | #2069 | Taha (to 2026-12-15) |
| W3-23 | #2104 | LOW | Partly open | Mostly done for the grower-share cost read; other product reads in the save not confirmed locked. | GitHub issue | #2104 | Taha (to 2026-12-15) |
| W3-52 | #2073 | LOW | Check first | Invoice header may show the earlier customer. Live-unchanged per the issue; not traced. | GitHub issue | #2073 | Taha (to 2026-12-15) |
| W3-53 | #2072 | LOW | Check first | During a staged apply a draft could briefly carry sales tax. Release-time concern, checkable only by a live post-apply query. | GitHub issue | #2072 | Taha (to 2026-12-15) |

### Payments and receivables (5)

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| W1-13 | KI-75 | HIGH | Check first | Applying a credit memo to an invoice could race with another action after the lock; other sub-items already bound or accepted. The credit-memo apply race after the lock was not re-proven in this pass. | KNOWN_ISSUES |  | Taha (to 2026-12-15) |
| W2-20 | KI-127 | MED | Partly open | Mason still has to confirm whether the two customers set to "1.5" mean 1.5% a year (as the system charges) or a month; if a month, they are under-charged. The screen label already says "% a year". | KNOWN_ISSUES |  | Mason decision |
| W3-24 | KI-132 | LOW | Open | Customers with unused credit can still get a reminder or finance charge. | KNOWN_ISSUES |  | Mason decision |
| W3-25 | KI-147 | LOW | Open | A customer typed as "COD" is silently treated as Net 30 for due dates. | KNOWN_ISSUES |  | Agent (unassigned) |
| D-02 | KI-20 | MED | Mason decision | Bulk prepay apply is switched off, earmark engine shelved, auto-draft invoice off; waiting on Mason's design calls. | KNOWN_ISSUES |  | Mason decision |

### Reports and commissions (7)

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| W1-01 | KI-129 | HIGH | Partly open | The month-end close receipt shows payments received from the old payments table: it counts deleted payments and misses payments recorded through allocation sets, so a month can show $0 received. The invoice-count half is fixed on staging (#2149). | KNOWN_ISSUES | #2149 (count part), #2195 (payments part) | Agent (unassigned) |
| W2-21 | KI-13 | MED | Open | A returned product still leaves the rep's commission in place; some commission money columns can still hold half-cents. Clawback overlaps KI-184 (profit reports) and To-Do 8.3; whole-cent commission columns still open. | KNOWN_ISSUES |  | Mason decision |
| W2-22 | KI-184 | MED | Open | A returned sale keeps its commission cost in profit reports, so profit looks too low. | KNOWN_ISSUES | #2149 (follow-up) | Taha (to 2026-12-15) |
| W2-23 | KI-154 | MED | Open | A salesperson could be paid commission on a sale the customer has not paid for; basis also ignores the standing discount. | KNOWN_ISSUES |  | Mason decision |
| W2-24 | #2175 | MED | Open | Numbers can change between the admin's review and the click, and the close saves the new ones; the commission "reviewed" box is screen-only. | GitHub issue | #2175 | Agent (unassigned) |
| W3-26 | KI-133 | LOW | Open | Reports count undelivered orders as revenue without saying "booked"; people may misread profit. | KNOWN_ISSUES |  | Agent (unassigned) |
| W3-27 | KI-135 | LOW | Open | The Inventory value total is labelled as if it were an accounting value, but it is priced at price-list cost. | KNOWN_ISSUES |  | Agent (unassigned) |

### Field applications (jobs, blend tickets, field invoices) (20)

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| W1-02 | #2196 | HIGH | Open | A sales rep may still be able to delete a completed (billable) job through a direct table path, so it could drop out of Unbilled Jobs. | Sol round 1, release #2189 (GitHub) | #2196 | Mason (field-app billing) |
| W1-03 | KI-185 | HIGH | Open | A job sprayed on 80 acres but planned at 100 bills (and deducts stock for) 100. | KNOWN_ISSUES (2026-11-21 audit) | #2176 | Mason (field-app billing) |
| W1-04 | KI-198 | HIGH | Open | The same shared-field job can bill different totals depending on which billing screen is used. Rule decided 2026-11-21 (decision 31); build it before Transfer or office auto-draft bills shared fields. | KNOWN_ISSUES (2026-11-21 audit) |  | Mason (field-app billing) |
| W1-05 | #2061 | HIGH | Check first | A job could be billed a second time. Issue says live-unchanged; not traced. | GitHub issue | #2061 | Mason (field-app billing) |
| W1-06 | #2063 | HIGH | Check first | A job could be billed twice (blend invoice then split field invoice). Live data not checked; code region still in the unchanged file. | GitHub issue | #2063 | Mason (field-app billing) |
| W1-07 | KI-187 | HIGH | Open | One spray recorded through both a blend ticket and its job could deduct stock twice; no blend tickets in production yet. | KNOWN_ISSUES (2026-11-21 audit) | #2178 (open) | Mason (field-app billing) |
| W2-25 | KI-186 | MED | Open | Field invoices can omit the carrier-water line and show a wrong per-unit price. | KNOWN_ISSUES (2026-11-21 audit) | #2177 | Mason (field-app billing) |
| W2-26 | KI-195 | MED | Open | An application record could show an EPA number different from what was sprayed after a catalog edit. | KNOWN_ISSUES (2026-11-21 audit) | #2183 | Mason (field-app billing) |
| W2-27 | KI-32 | MED | Partly open | The Dispatch Board still shows only the newest 500 jobs (it says how many match); every other list now reads all rows. | KNOWN_ISSUES | #1497 | Mason (field-app billing) |
| W2-28 | KI-183 | MED | Open | A job moved across Oct 1 can bill at the previous season's per-acre rate. | KNOWN_ISSUES | #2047 | Mason (field-app billing) |
| W2-29 | KI-171 | MED | Open | Rep saves depend on chemical cost; a refused invoice burns a number; proof scripts have gaps. | KNOWN_ISSUES | #2068 | Mason (field-app billing) |
| W2-49 | KI-111 | MED | Check first | Nobody has proven that a real John Deere/FieldView file bills on the file's acres; small import/UX gaps remain. | KNOWN_ISSUES |  | Mason decision |
| W2-50 | #1933 | MED | Check first | Some units cannot convert, so an application line may refuse or misprice. | GitHub issue | #1933 | Mason (field-app billing) |
| W3-28 | KI-117 | LOW | Open | A re-posted split invoice can record the product's current EPA number, not the one it was sold under. | KNOWN_ISSUES | #2183 (related, KI-195) | Mason (field-app billing) |
| W3-29 | KI-118 | LOW | Open | A line that becomes restricted-use after posting can be listed but not recorded from there; small audit/record gaps. | KNOWN_ISSUES |  | Mason (field-app billing) |
| W3-30 | KI-178 | LOW | Open | A deleted-then-restored job shows an old "dispatched" status. | KNOWN_ISSUES | #2047 | Mason (field-app billing) |
| W3-31 | #2145 | LOW | Open | Two people editing jobs on the same booking at once can have one save refused (retry works); user deactivation can lag a moment. | #2047 review (GitHub) | #2145 | Mason (field-app billing) |
| W3-32 | #2188 | LOW | Open | An old link to a deleted job shows it as Scheduled with Cancel/Start buttons (database still refuses changes). | GitHub issue | #2188 | Mason (field-app billing) |
| W3-33 | #2141 | LOW | Open | A job-made group draft could be cancelled leaving the job pointing at a cancelled invoice. Live has none today. | GitHub issue | #2141 | Mason (field-app billing) |
| W3-54 | #1926 | LOW | Check first | A very small application could bill as zero. | GitHub issue | #1926 | Mason (field-app billing) |

### Permissions and security (9)

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| W1-08 | KI-169 | HIGH | Open | Hiding Invoices or Record Payments for a person still leaves those actions reachable in the database. Mason 2026-11-19: real lock; reports now (KI-119, on staging), money actions after 2026-12-15. | KNOWN_ISSUES |  | Taha (to 2026-12-15) |
| W2-30 | KI-03 | MED | Partly open | Any rep can still unpost, move or consolidate another rep's invoices and change commission splits; the field-invoice part is accepted, the rest is unbuilt. | KNOWN_ISSUES |  | Taha (to 2026-12-15) |
| W2-31 | KI-182 | MED | Open | Purchase Orders screen retry codes are predictable; they should be random like the other screens' codes. | KNOWN_ISSUES | #2047 | Agent (unassigned) |
| W2-32 | KI-74 | MED | Partly open | Cost columns locked and safe posting view in place. Remaining: commission amount plus rate can reveal a rep's profit; Quick Receive shows which open PO line is cheaper. | KNOWN_ISSUES | #1057 | Mason decision |
| W2-33 | #2162 | MED | Open | Drivers can still read full farm records directly, more than Mason wants them to see; planned for after step 1 is live. | GitHub issue | #2162 | Agent (unassigned) |
| W3-34 | KI-07 | LOW | Partly open | Most small permission leftovers are revoked; an applicator-profile licensing field is unchecked and two document-restore edge cases are deferred. | KNOWN_ISSUES | #1698 | Agent (unassigned) |
| W3-35 | KI-122 | LOW | Partly open | Admin password resets now write an audit row in code merged on main, but whether the two Edge Functions were redeployed (needs Mason) is not confirmed. | KNOWN_ISSUES |  | Mason decision |
| W3-36 | KI-149 | LOW | Open | A rep's crop program or print-default changes are lost on Save with no explanation. | KNOWN_ISSUES |  | Mason decision |
| W3-37 | KI-73 | LOW | Partly open | Most driver and applicator read holes are closed live. One small leftover: a retried job start or complete is answered before the access check runs (nothing new is written); fix by checking access first. Team notes and customer addresses visible to all roles were accepted. | KNOWN_ISSUES | #1065, #1103, #1650 | Mason decision |

### Customers, data and cut-over (6)

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| W2-34 | KI-77 | MED | Open | Remaining: list paging can miss concurrent changes; CRM gaps (no pre-quote pipeline, no duplicate detection in bulk import, no bulk rep import, no email logging); offline-recovery gaps; delivery-photo ownership edge cases. Fixed: customer-form duplicate warning; delivery-photo uploader check (`20261222100000`) | KNOWN_ISSUES | #381, #1663, #1698 | Agent (unassigned) |
| W2-35 | #2197 | MED | Open | Staff are told to reactivate a customer before new orders, but the screen offers no way, so it must be done outside the app. | Sol round 1, release #2189 (GitHub) | #2197 | Agent (unassigned) |
| W2-36 | #2089 | MED | Open | A customer could be deactivated while an invoice posts, leaving a balance on an inactive customer. | GitHub issue | #2089 | Taha (to 2026-12-15) |
| W3-38 | #2016 | LOW | Open | "1,200" in an unquoted CSV can save as 1 corn acre and 200 soybean acres. | GitHub issue | #2016 | Agent (unassigned) |
| D-03 | KI-155 | MED | Mason decision | Handover from the old billing system lacks one written procedure, so old balances/credits could be mishandled. | KNOWN_ISSUES |  | Mason decision |
| D-05 | KI-30 | LOW | Mason decision | Wrong/missing label numbers, customers with no sales rep and some junk rows need Mason's choices before cleanup. | KNOWN_ISSUES |  | Mason decision |

### Guards, tooling and release process (31)

| Order | ID | Sev | Status | What goes wrong (plain English) | Source | GitHub | Owner |
|---|---|---|---|---|---|---|---|
| W1-12 | KI-48 | HIGH | Open | Some protections around applying live database changes have known gaps; the live migration ledger is the backstop. | KNOWN_ISSUES | #364 (closed) | Mason decision |
| R2-01 | SOL-8 | BLOCKER | Resolved by removing the pass (PR #2203; closes when it merges) | The merge guard runs a helper from the working folder without first confirming it was reviewed, and that helper can reach live database credentials. Fix: the guard only runs reviewed code. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-02 | SOL-9 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | The merge guard's check of a PR's database changes can miss one on a very large PR, or read the file list and the files from different versions. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-03 | SOL-10 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | While a release is open, a hotfix's database change could go live while its app change is refused, leaving the two out of step. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-04 | SOL-11 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | The merge guard's 4-hour hold for Taha ends early once he comments, and does not keep honouring an explicit "hold". | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-05 | SOL-12 | HIGH | Resolved by removing the pass (PR #2203; closes when it merges) | A release-pass command naming an invalid PR number counts as approval for the open release. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-06 | SOL-13 | MED | Resolved by removing the pass (PR #2203; closes when it merges) | The guard's SQL comparison treats two slightly different texts (a line-ending edge case) as the same. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-07 | SOL-14 | MED | Resolved by removing the pass (PR #2203; closes when it merges) | A mistaken release command for a hotfix number blocks the later correct hotfix command. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-08 | SOL-15 | MED | Resolved by removing the pass (PR #2203; closes when it merges) | Checking many database files one by one can use up the guard's time budget and refuse a valid merge. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-09 | SOL-16 | MED | Resolved by removing the pass (PR #2203; closes when it merges) | A command sent with no PR number can attach to a release PR opened just after it was sent. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-10 | SOL-17 | MED | Resolved by removing the pass (PR #2203; closes when it merges) | A pass records only a PR number, not the repository, and the guard accepts both the old and new repository names. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-11 | SOL-18 | LOW | Resolved by removing the pass (PR #2203; closes when it merges) | An eleventh pass within 24 hours silently drops the oldest one early. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-12 | SOL-19 | LOW | Resolved by removing the pass (PR #2203; closes when it merges) | The lookup for the open release reads only the first 100 open PRs. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| R2-13 | SOL-20 | LOW | Resolved by removing the pass (PR #2203; closes when it merges) | A slow GitHub answer can use up the prompt hook's whole time limit. | Sol round 2, guard branch (2026-11-22) |  | Agent (land #2203) |
| W2-37 | KI-45 | MED | Partly open | An agent's own report in an odd text shape can be mistaken for Mason typing "hold", pausing work wrongly. | KNOWN_ISSUES | #1084 (shipped), #1152 (merged 2026-10-28) | Agent (unassigned) |
| W2-38 | KI-46 | MED | Open | One Windows-specific path to a saved review proof is not covered by the proof check; the check should cover it. | KNOWN_ISSUES |  | Mason decision |
| W2-39 | KI-47 | MED | Open | A few risky command shapes are still auto-approved for agents instead of being stopped. | KNOWN_ISSUES | #530 (partial fix) | Agent (unassigned) |
| W2-40 | KI-49 | MED | Open | A review run outside the standard wrapper can record a misleading result; the wrapper is the safe path. | KNOWN_ISSUES |  | Mason decision |
| W2-41 | KI-51 | MED | Open | Once history passes the cap, every new branch push is blocked by the containment check. The containment check caps history at 4,096 commits and main already has more; check whether new-branch pushes are affected. | KNOWN_ISSUES |  | Agent (unassigned) |
| W2-42 | KI-78 | MED | Partly open | Many guard gaps remain (CodeRabbit gate, review-proof guard, #364 protections, sync-agent-workflows limits, cloud-session commit gates). FIXED: env-guard service-role scan. ACCEPTED: PR #605 hook gaps. Wording issue: entry says `quantity_available` has no CHECK, but a `>= 0` check exists. | KNOWN_ISSUES | #516, #605, #364 | Agent (unassigned) |
| W2-43 | #2191 | MED | Open | A squash of the main-into-staging merge would pass the gate and then break the release ancestry check, stalling a release. | Sol round 1, release #2189 (GitHub) | #2191 | Agent (unassigned) |
| W2-44 | #2192 | MED | Open | A hidden "Fixes #n" in a PR description can close an issue nobody meant to close. Taha merges .github changes. | Sol round 1, release #2189 (GitHub) | #2192 | Agent (unassigned) |
| W3-39 | KI-52 | LOW | Partly open | Flaky page tests, a few unwritten safety sweeps and small leftovers (e.g. Escape in the bulk-import prompt). | KNOWN_ISSUES | #1062, #1143, #1110, #350 (closed) | Agent (unassigned) |
| W3-40 | KI-84 | LOW | Open | A safety test script is broken; the protection it proves is still live. No customer impact. | KNOWN_ISSUES | #1110 | Agent (unassigned) |
| W3-41 | KI-96 | LOW | Partly open | Dead code and copy-pasted helpers make every change slower and riskier; no behavior bug. | KNOWN_ISSUES |  | Agent (unassigned) |
| W3-42 | KI-107 | LOW | Open | Agents get blocked on harmless cleanup commands; workaround is to run the delete alone. | KNOWN_ISSUES | #1536 (closed) | Agent (unassigned) |
| W3-43 | KI-113 | LOW | Open | An old safety proof for private customer files no longer runs; live bucket was checked private by hand. | KNOWN_ISSUES | #1698, #1663, #635 | Agent (unassigned) |
| W3-44 | KI-115 | LOW | Partly open | Some error reports lose the real reason, so production problems are harder to diagnose. | KNOWN_ISSUES | #1748, #1751, #1771, #1730, #1764 | Agent (unassigned) |
| W3-45 | KI-164 | LOW | Partly open | Some stock/pricing safety proofs were broken; repaired 2026-11-16; database sweep and regression tests still to do. | KNOWN_ISSUES |  | Agent (unassigned) |
| W3-46 | #2194 | LOW | Open | If the same grants are stored in a different order the migration aborts safely and stops the release apply until re-checked. Severity lowered from MED: fails safe, no data touched. | Sol round 1, release #2189 (GitHub) | #2194 | Agent (unassigned) |
| W3-55 | #1950 | LOW | Check first | Two agents could land at once if the lock wait times out. | GitHub issue | #1950 | Agent (unassigned) |

## Accepted risks (Mason decided to live with these; not in the counts)

- **Quotes and bookings:** KI-79 (Saved quote line forgets whether acres were typed or from field)
- **Orders and deliveries:** KI-26 (Delivery completion-evidence leftovers); KI-176 (Cancelling part of large booking rebuilds holds per job); KI-179 (Two cancels on one booking at once can make one fail)
- **Inventory, purchasing and products:** KI-68 (adjust_inventory accepts control-character retry key; stale tab can resend a batch adjustment)
- **Invoices, billing and returns:** KI-69 (Return-credit behaviours staff will see (late credits stay in current season; funding invoice blocked until credit voided)); KI-104 (Invoice page Email button can resend an invoice sent before 2026-11-05)
- **Payments and receivables:** KI-120 (Any rep can change customer payment terms/finance-charge settings)
- **Reports and commissions:** KI-106 (RUP register: admin can insert a row directly); SOL-21 (Adding the #2201 order-total check briefly locks the orders table (5-second limit)); SOL-22 (A legacy quote with an absurd stored total would fail to convert to an order); SOL-23 (The #2201 pre-check refuses the apply under an unusual session setting); SOL-24 (Run outside one transaction, the #2201 pre-check fails with an unclear message)
- **Field applications (jobs, blend tickets, field invoices):** KI-177 (Changing completed job's date can change which quote prices invoice); KI-180 (Reassigning job to admin/rep leaves old applicator dispatched); KI-181 (Invoice save and bulk job edit in same second can both go through); KI-17 (Blend ticket linkage picks one order line per product); KI-80 (Job line priced from a tier price not re-checked when tier later changes); #2163 (Refused field-app save can mention a draft the rep did not create)
- **Permissions and security:** KI-02 (Product cost and margin admin-only); KI-60 (Staff can mint temporary link to a private photo)
- **Guards, tooling and release process:** KI-36 (Table lock does not serialize OLD function body); KI-50 (Cloud sessions cannot push or back up memory); KI-61 (LOCK TABLE in migration does not stop an in-flight old function call); KI-62 (Live migration ledger has entries with no file on main); KI-63 (Quote-version trust chain has live pins in two files); KI-64 (All agents share Mason's admin GitHub identity); KI-65 (Write-time actor-binding guard bypassable by design limits); KI-66 (review-proof-guard denies destructive commands that spell out a worktree path); KI-67 (sync-agent-workflows --write overwrites an unusable manifest); KI-70 (Proof-file self-attestation and other guard residuals); KI-71 (Commission-split rename fails closed; PWA needs two reloads; slow ExcelJS tests; JobDetail save test re-click)

## Backlog, not defects

KI-37 (Parked migration draft with fragile membership rule); KI-40 (CRM Phase 5 AI receptionist preconditions); KI-41 (Product roadmap items deliberately deferred).

## Dropped as already fixed in this re-check

These were still listed as open (or "in review") but are fixed in code that is live or on staging; each moved to the closed list in KNOWN_ISSUES.md with its evidence: KI-01 (Drivers/applicators could read all customer fields and money totals); KI-04 (Connector tools with no permission rule ran without a prompt); KI-06 (Audit log could point at hard-deleted records); KI-97 (Invoice email content built by app screen); KI-98 (Emailed PDFs drawn by sender's app); KI-121 (Last active admin could remove own admin role); KI-123 (Signed-out role keeps unneeded read grants); KI-124 (Public key hard-coded in 5 e2e test files); KI-11 (Screens drop/share retry key (double-apply risk)); KI-12 (Convert to Order could leave accepted quote with no order); KI-14 (Transfer-created field invoices always Net 30); KI-18 (Dates/seasons follow UTC or browser clock); KI-19 (Month close racing edits); KI-81 (Two invoice paths bill the quote's current price, not the sent price); KI-95 (Historical AR aging fails if one customer unrebuildable); KI-156 (Grower-share chemical cost booked in the wrong unit); KI-28 (Jobs for a non-applicator never reach dispatch board); KI-85 (Receiving offers warehouses that cannot ship); KI-93 (One blend ticket can deduct stock twice (ticket-to-order route)); KI-94 (Void delivery puts back more reserved stock than completion took); KI-100b (Spray job leaves booking remainder no Partial Order can take); KI-101 (Voiding a delivery on a cancelled order reopens the order (+ admin status grant)); KI-102 (Voiding an order then its delivery restores stock twice); KI-116 (Product Detail treats a non-product address as a load failure); KI-136 (Receiving adds typed number regardless of PO line unit); KI-137 (Two seed-treatment products stocked per Lb at per-jug money); KI-139 ("Reconcile negative inventory" can overwrite any row); KI-141 (Retiring an inventory row ignores open POs); KI-158 (Orders and deliveries move stock without unit checks); KI-159 (Cancelling a received return writes history row both stock checks misread); KI-161 (Delivery editing does not re-check line against order line); KI-162 (Receiving Log filters by UTC date); KI-145 (Bulk Customer Import fails for reps, misreads files); KI-146 (Farm groups can loop; grandchildren left out); KI-148 (Deactivating a customer ignores open work); KI-150 (Receipt reversal vs vendor bill lock order; completions lock stock in no order); KI-35 (Live ledger vs files on main checked only by noticing); KI-38 (Edge Function error alerting fails quiet); KI-83 (`idempotency_keys` has no TypeScript type); KI-166 (Quote for product with no stock unit priced as "each").

KI-82 (open quote screen showed a stale cost after Save): PR #1209, merged to `main` 2026-10-30 (triage 2026-11-22).

KI-100 was used for two different entries; the inventory one ("a spray job could leave a booking with a remainder no Partial Order can take") is the one closed here, and the product-page lock entry keeps KI-100.

## Duplicates merged

- #2195 (month-end payments received) is the payments half of KI-129; tracked once, as KI-129.
- KI-13's commission clawback overlaps KI-184 (profit reports) and To-Do 8.3; kept as separate rows because they need separate fixes (payout adjustment vs report).
- The "Unverified items" list in KNOWN_ISSUES.md names entries (KI-20, KI-29, KI-30, KI-41, KI-52, KI-111) that each have their own row here.

## Limits of this re-check

- Verdicts come from reading the code on staging; no fix was run against a database. Race-condition reports (many "release #1990 follow-up" issues) cannot be proven by reading and are marked "Check first".
- Bundled entries (KI-16, KI-47, KI-48, KI-49, KI-75, KI-76, KI-77, KI-78, KI-109, KI-110) were spot-checked, not re-proven item by item.
- Live data items (KI-29, KI-30, KI-138, the S8 office check in To-Do 15.1) were not re-measured.
- About 44 other open GitHub issues were judged follow-up polish, tooling or roadmap rather than defects and are not listed here; they stay on GitHub.
