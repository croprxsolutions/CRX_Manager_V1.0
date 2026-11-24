# Field application: exact-cents test scenarios

The money and stock rules in `SPEC.md` are pinned here as cases. **Expected results come from the business rules, not from code.** A build PR that touches billing, stock or posting turns the scenarios it covers into real tests (SQL tests against a migrated database, as the real caller, for anything the database decides) and records expected vs observed in the PR. All names, prices and acres are made up. Scenarios marked **[workflow]** have no generated numbers; their expected results are written out by hand. The February release gate is every scenario here; none is spring-only.

Every money table is produced by `scenarios-calc.py` in this folder (exact decimals, no floating point). `python -I scenarios-calc.py --check` fails if a table here differs from the calculator; run it after any edit. The calculator also pins the live `_bill_split_line_shares` quantity and tie rules with explicit customer ids (`live_split`).

## Rules the numbers follow (Mason, 2026-11-24: "billing logic and rounding matches chemical sales")

1. **Bill what actually went in the tank (Mason, 2026-11-24: "we only bill what was actually put in the blend and logged").** A load's billed amount of each product = what was put in it (the confirmed mix, adds and corrections, plus anything carried in from the rig's last load) minus what was carried out to the next load or sent to a tote. That amount is spread over the fields the load sprayed by the acres logged on each. The recipe is only the plan and the 5% check; it never sets the bill. A line **sourced from a vendor** bills $0. **Each product is priced once per job:** its total quantity × price, rounded **half up to whole cents once**; all lines add up to that once-rounded amount. Service: total sprayed acres × the job's one service rate, rounded once, **only when the job's application service bills the customer**. Quantities are kept exact for pricing; a line stores and shows 4 decimals; cents are never recomputed from the shown quantity.
2. **That job total is shared across the fields** by quantity (acres for service), fields in the spray order saved on the draft: every field except one gets its exact part **rounded down**; the field with the most (ties: earlier in spray order) gets the rest. Example: 1 gal at $10.01 over two equal fields bills $5.01 + $5.00 = $10.01. A field with one line per split in force (S7) shares its part across those lines the same way, the larger line taking the rest (ties: the earlier spray date).
3. **Each field line is shared across its payers exactly as chemical-sale split invoices are** (`_bill_split_line_shares`, live since 2026-11-09): every payer except the main customer gets their exact share **rounded down**; **the main customer (the job's grower, P1 here) gets the rest**. If the main customer has 0% of that line, the largest share gets the rest (ties: lowest customer id). Quantity is shared the same way: whole hundredths when the share allows, else 4 decimals (a negative quantity takes the 4-decimal branch, as live). A credit follows the live rule too: every other payer's share is rounded down, away from zero, and the main customer takes the rest. Every payer's cents add up to the field line exactly. Field-only difference: a share too small for 0.0001 of a unit keeps its cents with quantity 0 instead of refusing (sprayed work cannot be re-entered like a delivery).
4. **Shares are micro-percent** (100,000,000 = 100%), so thirds are 33,333,334 / 33,333,333 / 33,333,333, grower first. Each field's product shares and application shares each total exactly 100%.
5. Service uses the **application shares**; products the **product shares**. No flat fees, no fuel charge, no tax.
6. **Three amounts** per load and product, side by side: **planned** (recipe rate × acres the load sprayed), **mixed** (confirmed into the tank, plus anything carried in) and **billed** (= used: mixed minus carried out or to a tote, rule 1). The 5% check runs **per load and product**: billed more than 5% above or below planned puts the job on the review list; the job total is shown beside it. A product not in the recipe (planned 0) shows "not in recipe" instead of a percentage.

**What this means in practice (tell customers if asked):** on an even split the grower's invoice can carry up to one cent more per other payer on each line (thirds of 603.75 bill 201.27 / 201.24 / 201.24), the same as chemical-sale split invoices today. Because a load's gallons spread over every field it sprayed, correcting one field's acres moves money on the others; any invoice whose printed amount changes is marked "Corrected" (S24, S26).

**Made-up prices:** product X 41.37 per gal; product Y 23.19 per gal; service 8.75 per acre. Table amounts are cents.

**The standard job:** fields A (P1 100%), B (P1 / P2 50/50), C (P1 / P2 / P3 thirds), same product and application shares unless a scenario says otherwise. P1 is the job's grower. Planned 51 / 110 / 71 acres; sprayed 49 / 110 / 69. Rig 1, tank 3,500 gal. Load L1: 58 gal of X in 3,480 finished gallons (recipe 32 fl oz/acre, carrier 15 finished gal/acre), sprayed all three fields, ran dry (used 58 gal).

## Money scenarios

**S1 Golden case.** Billed 58 gal, everything that went in the tank (the recipe, 32 fl oz × 228 acres, would be 57) = 239,946 cents of X, exactly 58 × 41.37, spread over the fields by acres; planned 57, mixed 58, billed 58; rate check 1.75% over plan, under 5%, no review. Three unposted invoices: P1 (sections A, B, C), P2 (B, C), P3 (C).

<!-- calc:S1 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.4649 gal | 51567 | 51567 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| B | X | 27.9825 gal | 115764 | 57882 | 57882 | - |
| B | Service | 110 ac | 96250 | 48125 | 48125 | - |
| C | X | 17.5526 gal | 72615 | 24207 | 24204 | 24204 |
| C | Service | 69 ac | 60375 | 20127 | 20124 | 20124 |
| **Total** | | | **439446** | **244783** | **150335** | **44328** |

**S2 Part-acre spray.** Field C sprayed 68.7 acres. The service job total is 227.7 × 8.75 = 1,992.375, rounded once to 199,238 cents; field C's part rounds down and field B (the most acres) takes the rest, so B's service line is 1 cent more than in S1. The 58 gal of X spread over 227.7 acres.

<!-- calc:S2 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.4813 gal | 51635 | 51635 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| B | X | 28.0193 gal | 115917 | 57959 | 57958 | - |
| B | Service | 110 ac | 96251 | 48126 | 48125 | - |
| C | X | 17.4993 gal | 72394 | 24132 | 24131 | 24131 |
| C | Service | 68.7 ac | 60112 | 20038 | 20037 | 20037 |
| **Total** | | | **439184** | **244765** | **150251** | **44168** |

**S3 Different product and application shares.** Application shares: B is P1 100% / P2 0%; C is P1 / P2 50/50, P3 0%. Product shares as standard. P3 gets an invoice for product only; P2 pays no application on B.

<!-- calc:S3 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.4649 gal | 51567 | 51567 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| B | X | 27.9825 gal | 115764 | 57882 | 57882 | - |
| B | Service | 110 ac | 96250 | 96250 | 0 | - |
| C | X | 17.5526 gal | 72615 | 24207 | 24204 | 24204 |
| C | Service | 69 ac | 60375 | 30188 | 30187 | 0 |
| **Total** | | | **439446** | **302969** | **112273** | **24204** |

**S4 Mix changed between loads.** L1 (X, 32 fl oz) sprayed A. The mixer changed load L2 to Y at 24 fl oz/acre; L2 sprayed B and C. Stock: L1 mixed 12.25 gal X; L2 mixed 33.5625 gal Y (both ran dry). Each field bills the load that sprayed it.

<!-- calc:S4 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.25 gal | 50678 | 50678 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| B | Y | 20.625 gal | 47830 | 23915 | 23915 | - |
| B | Service | 110 ac | 96250 | 48125 | 48125 | - |
| C | Y | 12.9375 gal | 30001 | 10001 | 10000 | 10000 |
| C | Service | 69 ac | 60375 | 20127 | 20124 | 20124 |
| **Total** | | | **328009** | **195721** | **102164** | **30124** |

**S4b One field sprayed from two loads.** As S4, but L1 also sprayed the first 40 acres of B, and L2 the other 70, the same day: one work entry for B with two load segments. Stock: L1 mixed and used 22.25 gal X (89 acres); L2 mixed and used 26.0625 gal Y (139 acres); both ran dry. Field B bills 10 gal of X and 13.125 gal of Y. Service bills B's 110 acres once, not once per load. X totals exactly 22.25 × 41.37 and Y exactly 26.0625 × 23.19 (rounded once).

<!-- calc:S4b -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.25 gal | 50679 | 50679 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| B | X | 10 gal | 41369 | 20685 | 20684 | - |
| B | Y | 13.125 gal | 30437 | 15219 | 15218 | - |
| B | Service | 110 ac | 96250 | 48125 | 48125 | - |
| C | Y | 12.9375 gal | 30002 | 10002 | 10000 | 10000 |
| C | Service | 69 ac | 60375 | 20127 | 20124 | 20124 |
| **Total** | | | **351987** | **207712** | **114151** | **30124** |

**S5 Load over plan [workflow].** L1's recipe over the acres sprayed is 57 gal; 58 went in. The job bills 58 (rule 1). The rate check compares billed with planned per load: 5% or less passes with no office step; more than 5% puts the job on the review list with planned vs billed and the dollar difference. The office can edit a quantity with a reason; nothing is re-priced by itself.

**S6 Per-line share override.** From S1, the office sets field B's product line to P1 100%, P2 0%, with a reason. Every other line unchanged; the job total is the same.

<!-- calc:S6 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.4649 gal | 51567 | 51567 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| B | X | 27.9825 gal | 115764 | 115764 | 0 | - |
| B | Service | 110 ac | 96250 | 48125 | 48125 | - |
| C | X | 17.5526 gal | 72615 | 24207 | 24204 | 24204 |
| C | Service | 69 ac | 60375 | 20127 | 20124 | 20124 |
| **Total** | | | **439446** | **302665** | **92453** | **44328** |

**S7 Split changed mid-job.** Field B's split changes from 50/50 to P1 100% starting Wednesday. B was sprayed 60 acres Tuesday and 50 Thursday (same load). Field B's part of each job total is the same as in S1; it is shared across one line per split in force, the larger line taking the rest. A job office split (`CONTRACT-who-pays.md` FP-4) wins over both.

<!-- calc:S7 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.4649 gal | 51567 | 51567 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| B (Tue) | X | 15.2632 gal | 63144 | 31572 | 31572 | - |
| B (Tue) | Service | 60 ac | 52500 | 26250 | 26250 | - |
| B (Thu) | X | 12.7193 gal | 52620 | 52620 | - | - |
| B (Thu) | Service | 50 ac | 43750 | 43750 | - | - |
| C | X | 17.5526 gal | 72615 | 24207 | 24204 | 24204 |
| C | Service | 69 ac | 60375 | 20127 | 20124 | 20124 |
| **Total** | | | **439446** | **292968** | **102150** | **44328** |

**S8 Locked and unlocked prices [workflow].** X has a locked quote price; Y has none. Y's price rises on Wednesday; the job's first spray day (Central date of the first work entry with acres above zero) was Tuesday, when Y's price was copied onto the job's product line. Then X bills the quote price and Y bills Tuesday's price on every field. The service rate is the job customer's season rate for that service, else the service's default, copied the same day. A logged "price refresh" on the unposted invoice moves Y and the service rate to today's price and never touches X or an office-edited price. A substitute with no price drafts with that line unpriced; the payer set cannot post until the office prices it (M9).

**S9 Zero-share payer.** Field C's product and application shares are P1 / P2 50/50, P3 0%. P3 has no share anywhere else. Then no invoice is made for P3 ($0 payer: no invoice; their lines stay recorded at zero).

<!-- calc:S9 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.4649 gal | 51567 | 51567 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| B | X | 27.9825 gal | 115764 | 57882 | 57882 | - |
| B | Service | 110 ac | 96250 | 48125 | 48125 | - |
| C | X | 17.5526 gal | 72615 | 36308 | 36307 | 0 |
| C | Service | 69 ac | 60375 | 30188 | 30187 | 0 |
| **Total** | | | **439446** | **266945** | **172501** | **0** |

**S10 Vendor-sourced product [workflow].** L1 also had 10 gal of product Z whose job line is **sourced from** vendor V (a vendor the office set up for the grower, who supplied it). Then Z takes no CRX stock, prints on each payer's invoice at $0 price and $0 cost, is never re-priced by a refresh, and is left out of the 5% dollar difference. It shows line by line on the load, the spray record, the invoice and the blend report as "sourced from V". A payer whose every line is $0 gets no invoice (S9).

**S30 The extra cent [workflow].** 1 gal of X priced at 10.01 sprayed over two equal fields with the same payer. Then the job bills exactly 10.01: the first field 5.01, the second 5.00 (rule 2). It never bills 10.02. Pinned in `scenarios-calc.py`.

## Stock and batch scenarios [workflow]

**S11 Batch confirmation takes stock once.** The mixer confirms L1 (58 gal X) for a job on the batch stock path. Then X on hand drops by exactly 58 gal in one ledger row linked to L1's first revision. A double tap, a retry after a timeout, or the same confirm sent twice with the same key returns L1 and moves no more stock. The same load id sent with different amounts is refused. (A "possible duplicate load" flag for a second tablet confirming the same physical tank under a new id is spring.)

**S12 Stock short.** X shows 40 gal on hand. Then L1 still confirms, X goes to −18, the ledger row has `requires_review`, and the office sees it. When the delivery is received later, on-hand returns positive through the normal receiving path; the flag stays in the history.

**S13 Mixer substitution.** The mixer removes X from L2 and adds Y. Then L2 takes Y from stock, not X; the job's original recipe is unchanged; the next load's proposal starts from L2's mix (the latest mix for that job), not the original recipe; the job is flagged for review; a substitute with no agreed price is flagged for pricing.

**S14 Add to a load after confirming.** After L1 is confirmed (revision 1, 58 gal) and field A is sprayed, the mixer adds 3 gal X. Then revision 2 holds the full contents (61 gal) and one 3 gal stock-out row; A's work stays linked to revision 1, later fields to revision 2. A typo fix instead (58 should have been 55) is a correction: a new revision with full contents 55, one reversing row returning 3 gal, naming revision 1 as the one it corrects; each work segment keeps the revision it was sprayed from, and the spray record reads that revision's corrected amounts. Billing reads the load's final contents (rule 1), so it does not depend on which revision a field was linked to.

**S15 Carried-in leftover.** Rig 1 finishes job 1 on L1 (58 gal X in 3,480 finished gallons) with 200 finished gallons left and logs "200 carried". The next load confirmed on rig 1 (L3, job 2) records 200 gal carried in from L1 (L1 is rig 1's last confirmed load, read under the rig's lock), with L1's composition shown on the confirm screen, and proposes that much less; no stock moves for it; L1 counts the 200 gal as carried, not used. If a second load on rig 1 is confirmed before L3, only the first to confirm takes the carry; the other gets 0 carried in and a flag. Leftover nobody can use goes to a tote and is handled outside CRX. (Tracking each carry as a claim and flagging a carried mix that differs from job 2's recipe or customer is spring.)

**S16 Shared load.** L4 sprays the last field of job 1 and the first field of job 2. Then neither job's invoices are made until L4 is settled: its leftover is recorded and every job it served has closed or settled its fields. The office can settle L4 by hand with a reason (it records the leftover as best known); that settles it for both jobs. If acres are later added on job 2 from L4, job 1's draft or posted invoices are flagged ("work changed since draft"); nothing changes by itself.

**S17 Planned, mixed and billed view.** S1 shows planned 57, mixed 58, billed 58. S15's job 1 shows mixed 58, carried out 200 finished gallons (as product: 200 ÷ 3,480 of 58 gal X = 3.3333 gal X), billed 54.6667; the 3.3333 gal X shows as carried in and is billed on job 2. A shared load's used amount is split across its jobs by acres (Q11), and each job's report shows its own part, not the whole ledger row.

**S18 Jobs already running when batches switch on.** Job J1 was created before the switch, so its stock path is `at_completion`. Then confirming a load for J1 is refused ("this job takes stock at completion; finish it the old way"); completing J1 deducts exactly as today. A job created after the switch, by any route (job screen, quote, booking), takes the `batch` path; closing it takes no stock and releases its hold once. A job's stock path is set when the job is created and never changes; turning the switch off later leaves existing batch jobs working.

**S19 Blend ticket and batch, either order.** For a batch-path job, a blend ticket recorded before or after a load takes no stock. For an old-path job, KI-187 stays open until its own fix (production has no blend tickets).

**S35 Job with no mixer-tablet load [workflow].** A Terragator job with a dry product. Whoever loaded it (or the office) enters the load on the same load screen: product amounts, no water, leftover "none". Then stock leaves at that load, acres are logged as usual, the leftover check passes, and the job bills by rule 1 like any other.

## Lifecycle and correction scenarios [workflow]

**S20 Leftover acres closed.** Field C planned 71, sprayed 69. The office closes the last 2 acres. Then C bills 69 and the job can move to invoices. "Missing", "recorded 0 acres" and "closed" are different states; nothing ever falls back to planned acres.

**S21 Cancel.** A job with no acres logged and no confirmed load can be cancelled. A job with acres cannot (the office closes remaining acres instead). A job with a confirmed load but no acres (rained out after mixing) is not cancelled: the office ends it with nothing billed, the stock movement stays, the load's leftover can still be recorded as carried or to a tote; a note is optional (M4).

**S22 All-or-nothing posting.** The office posts S1's three invoices; one fails (another user just changed it). Then none are posted, and the office sees which one failed and why.

**S23 Two editors.** Two office users edit S1's set at once, one changing P2's invoice and one a share that touches P1 and P2. Then the second save is refused with "someone else changed this; reload", and nothing is half-saved. A post sent from the older screen is refused the same way.

**S24 Unpost and repost.** S1 is posted; no payment, prepay, credit or write-off on any of the three; month open. The office corrects field B from 110 to 100 acres and closes the other 10. The 58 gal that went in now spreads over 218 acres (planned 54.5 gal: 6.42% over, so the job goes on the review list; the office keeps it, with a note). Then the whole set unposts and reposts with the amounts below; each invoice whose printed amount changed is marked "Corrected" (all three here: P3's field C gets more of the 58 gal). The original posted version stays readable.

<!-- calc:S24 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 13.0367 gal | 53932 | 53932 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| B | X | 26.6055 gal | 110068 | 55034 | 55034 | - |
| B | Service | 100 ac | 87500 | 43750 | 43750 | - |
| C | X | 18.3578 gal | 75946 | 25316 | 25315 | 25315 |
| C | Service | 69 ac | 60375 | 20127 | 20124 | 20124 |
| **Total** | | | **430696** | **241034** | **144223** | **45439** |

**S25 Credit and rebill.** As S24 (same review flag, kept with a note), but P2 has paid. Then the set cannot be unposted. Each payer whose dollars changed (all three here) gets a credit for what is left on their original invoice and a new invoice (S24's amounts), linked to the one it replaces; P2's payment stays with P2 and is applied to P2's new invoice, as chemical sales do today. A payer whose dollars did not change is untouched (M3).

**S26 Spray record corrected after posting.** The office corrects field A from 49 to 110 acres on a posted job. Then every posted invoice whose amount would change is flagged; nothing changes by itself. Here that is all three payers, because the 58 gal spread over every field by acres (and A now ties B, so A, earlier in spray order, takes X's leftover cent). The amounts the correction would bill:

<!-- calc:S26 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 22.0761 gal | 91330 | 91330 | - | - |
| A | Service | 110 ac | 96250 | 96250 | - | - |
| B | X | 22.0761 gal | 91328 | 45664 | 45664 | - |
| B | Service | 110 ac | 96250 | 48125 | 48125 | - |
| C | X | 13.8478 gal | 57288 | 19098 | 19095 | 19095 |
| C | Service | 69 ac | 60375 | 20127 | 20124 | 20124 |
| **Total** | | | **492821** | **320594** | **133008** | **39219** |

**S27 Duplicate entry.** The applicator logged field A, 49 acres, Tuesday on the phone; the office then types the paper ticket for the same job, field and day. Then CRX warns "possible duplicate"; the office removes it or keeps it (a real second pass; a note is optional); acres are never doubled silently. A kept second pass bills its own service acres (M8). A retry of the same save never creates a second entry.

**S28 Invoice date backfill.** The office posts on December 5 with the invoice date set to November 22. Then the invoice is dated November 22; each payer's due date follows that payer's terms on the posting day, from November 22; if November is closed, the date is refused with the existing month-close message; each field section shows its spray dates. Date, season, terms, due date and rep are fixed at posting.

**S29 Hand-typed overlap.** A hand-typed invoice (no job) naming field A, application date Tuesday and product X warns (a note is optional), whether it was typed before or after the job's unposted invoice. A hand-typed invoice with no field or date is not compared. Billing the same job's work a second time is refused.

**S31 Billing switch-on date.** Mason sets the date once the whole field app is live (`app_settings` `field_billing_start_date`); no job is half sprayed across it. Then a job whose first spray day is before the date can never be drafted in CRX (it was billed in Chem Man); the date is absolute, with no exception; anything missed is typed as a normal invoice by hand. With no date set, every job-sourced field draft is refused in production.

**S32 Custom applicator.** The standard job, but its application service is a custom applicator (an outside company that bills the grower for the application itself). L1 had 58 gal X and 42.75 gal Y. Then the invoices carry the products only, no service line; acres are still logged per field and day, and the job shows on that service's season acres report (S34).

<!-- calc:S32 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.4649 gal | 51567 | 51567 | - | - |
| A | Y | 9.1875 gal | 21305 | 21305 | - | - |
| B | X | 27.9825 gal | 115764 | 57882 | 57882 | - |
| B | Y | 20.625 gal | 47831 | 23916 | 23915 | - |
| C | X | 17.5526 gal | 72615 | 24207 | 24204 | 24204 |
| C | Y | 12.9375 gal | 30001 | 10001 | 10000 | 10000 |
| **Total** | | | **339083** | **188878** | **116001** | **34204** |

**S33 Work on the owner's own farm [workflow].** A side-dress bar job for the owner's farm company (a normal customer). Its application service is "not billed". Product from CRX stock bills the farm like any customer; a line sourced from a vendor bills $0. If every line is $0, no invoice is made (S9); the job still closes and its acres and products appear on the season acres and blend reports.

**S34 Season acres and blend reports [workflow].** *Season acres:* the office picks a season (`jobs.season`) and an application service (or all); the report lists every work entry: date, grower, field, acres, products in the tank, and "billed by CRX" yes/no (from the service's flag on the job; whether an invoice exists is proved in slice 3); totals per service and per grower; printable and CSV. Office roles only; no cost column. Cancelled jobs and closed (unsprayed) acres are left out. Example row: `2027-04-12 · Grower 1 · Field A · 49.00 ac · X 12.4649 gal · Custom applicator V · billed: no`. It is the report the office sends a custom applicator; paying the applicator stays a normal vendor bill. *Blend report:* season and date range; one row per load and product: date, rig, job, grower, product, amount, sourced from (CRX stock or the vendor). Example row: `2027-04-12 · Rig 1 · J-1001 · Grower 1 · Z · 10 gal · sourced from vendor V`. (Not the blend-ticket screen.)

## First real multi-payer job: hand-check list (D12)

Before posting the first real multi-payer set in production, the office and Mason compare, for each payer: every line's field, quantity, price, share and cents against the job's loads and acres (rule 1–3); the invoice total against the sum of its lines; the PDF (only their fields, "Shared with", field total and your share, customer note, no internal note); that payer's statement and aging after posting. Any difference stops the posting switch for everyone until fixed.
