# Field application: exact-cents test scenarios

The money and stock rules in `SPEC.md` are pinned here as cases. **Expected results come from the business rules, not from code.** A build PR that touches billing, stock or posting turns the scenarios it covers into real tests (SQL tests against a migrated database, as the real caller, for anything the database decides) and records expected vs observed in the PR. All names, prices and acres are made up. Scenarios marked **[workflow]** have no generated numbers; their expected results are written out by hand. **[SPRING]** scenarios are kept for the spring build and are not tested in February.

Every money table is produced by `scenarios-calc.py` in this folder (exact decimals, no floating point). `python -I scenarios-calc.py --check` fails if a table here differs from the calculator; run it after any edit.

## Rules the numbers follow (Mason, 2026-11-24: "billing logic and rounding matches chemical sales")

1. **Bill what actually went in the tank (Mason, 2026-11-24: "we only bill what was actually put in the blend and logged").** A load's billed gallons of each product = what was put in it (the confirmed mix, adds and corrections, plus anything carried in from the rig's last load) minus what was carried out to the next load or sent to a tote. Those gallons are spread over the fields the load sprayed by the acres logged on each. The recipe is only the plan and the 5% check; it never sets the bill. **Each product is priced once per job:** its total quantity × price, rounded **half up to whole cents once**; all lines add up to that once-rounded amount. Service: total sprayed acres × rate, rounded once, **only when the job's application service bills the customer** (a custom applicator's or an unbilled service's acres are logged but not billed). Quantities are kept exact; they are shown to 4 decimals only.
2. **That job total is shared across the fields** by quantity (acres for service), the chemical-sale way: every field except one gets its exact part **rounded down**; the field with the most (ties: the earlier field in spray order) gets the rest. Example: 1 gal at $10.01 over two equal fields bills $5.01 + $5.00 = $10.01. A field with one line per split in force (S7) shares its part across those lines the same way, the larger line taking the rest.
3. **Each field line is shared across its payers exactly as chemical-sale split invoices are** (`_bill_split_line_shares`, live since 2026-11-09): every payer except the main customer gets their exact share **rounded down**; **the main customer (the job's grower, P1 here) gets the rest**. If the main customer has 0% of that line, the largest share gets the rest (ties: lowest customer id; payer order stands in for it here). Quantity is shared the same way at hundredths (4 decimals for a share under 0.01). A credit (negative amount) follows the live rule too: every other payer's share is rounded down, away from zero, and the main customer takes the rest (−1 cent at 50/50: the other payer −1, the main customer 0). Every payer's cents add up to the field line exactly.
4. **Shares are micro-percent** (100,000,000 = 100%), so thirds are 33,333,334 / 33,333,333 / 33,333,333, grower first. Each field's product shares and application shares each total exactly 100%.
5. Service uses the **application shares**; products the **product shares**. No flat fees, **no fuel charge** (Mason, 2026-11-24), no tax.
6. **Three gallon figures** are shown side by side: **planned** (recipe × acres), **mixed** (confirmed into the tank; what left stock, plus anything carried in) and **billed** (= used: mixed minus leftover carried out or to a tote, rule 1). The review screen shows all three; only a gap over 5% between planned and billed puts the job on the review list.

**What this means in practice (tell customers if asked):** on an even split the grower's invoice can carry up to one cent more per other payer on each line (thirds of 603.75 bill 201.27 / 201.24 / 201.24), the same as chemical-sale split invoices today. Because a product is priced once for the whole job, correcting one field can move a cent on another field; any invoice whose printed amount changes is marked "Corrected" (S24).

**Made-up prices:** product X 41.37 per gal; product Y 23.19 per gal; service 8.75 per acre. Table amounts are cents.

**The standard job:** fields A (P1 100%), B (P1 / P2 50/50), C (P1 / P2 / P3 thirds), same product and application shares unless a scenario says otherwise. P1 is the job's grower. Planned 51 / 110 / 71 acres; sprayed 49 / 110 / 69. Load L1: 58 gal of X mixed at a recipe of 32 fl oz/acre, sprayed all three fields, ran dry (used 58 gal).

## Money scenarios

**S1 Golden case.** Billed 58 gal, everything that went in the tank (the recipe, 32 fl oz × 228 acres, would be 57) = 239,946 cents of X, exactly 58 × 41.37, spread over the fields by acres; mixed 58, billed 58; rate check 1.75% over plan, under 5%, no review. Three unposted invoices: P1 (sections A, B, C), P2 (B, C), P3 (C).

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

**S4b One field sprayed from two loads.** As S4, but L1 also sprayed the first 40 acres of B, and L2 the other 70. Stock: L1 mixed and used 22.25 gal X (89 acres); L2 mixed and used 26.0625 gal Y (139 acres); both ran dry. Field B bills 10 gal of X and 13.125 gal of Y. Service bills B's 110 acres once, not once per load. X totals exactly 22.25 × 41.37 and Y exactly 26.0625 × 23.19 (rounded once).

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

**S5 Load over plan [workflow].** L1's recipe over the acres sprayed is 57 gal; 58 went in. Then the job bills 58 (rule 1). The rate check compares billed with planned: under 5% passes with no office step; over 5% puts the job on the review list with planned vs billed and the dollar difference. The office can edit a quantity with a reason; nothing is re-priced by itself.

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

**S7 Split changed mid-job [workflow].** Field B's split changes from 50/50 to P1 100% starting Wednesday. B was sprayed 60 acres Tuesday and 50 Thursday. Then the Tuesday work bills 50/50 and the Thursday work 100% P1: field B gets one line per split in force, each line's money worked out by rules 1–3. A job office split (`CONTRACT-who-pays.md`) wins over both.

**S8 Locked and unlocked prices [workflow].** X has a locked quote price; Y has none. Y's price rises on Wednesday; the job's first spray day (Central date of the first work entry with acres above zero) was Tuesday. Then X bills the quote price and Y bills Tuesday's price on every field. A logged "price refresh" on the unposted invoice updates Y and never touches X. A substitute with no price is flagged for the office to price; the payer set cannot post until it has one (M9).

**S9 Zero-share payer.** Field C's product and application shares are P1 / P2 50/50, P3 0%. P3 has no share anywhere else. Then no invoice is made for P3 (no zero-dollar invoices).

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

**S10 Grower-supplied product [workflow].** L1 also had 10 gal of product Z marked "customer's own / already paid" by P1. Then Z leaves no company stock, prints on P1's invoice at zero price and zero cost, is never re-priced by a refresh, and is left out of the 5% check. It is not received into company stock and nothing is deducted; it still shows on the load's mix, the spray record and the season blend report as "customer's own" (Mason, 2026-11-24). If every line for a payer is zero, rule S9 applies.

**S30 The extra cent [workflow].** 1 gal of X priced at 10.01 sprayed over two equal fields with the same payer. Then the job bills exactly 10.01: the first field 5.01, the second 5.00 (rule 2). It never bills 10.02. Pinned in `scenarios-calc.py`.

## Stock and batch scenarios [workflow]

**S11 Batch confirmation takes stock once.** The mixer confirms L1 (58 gal X) for a job on the batch stock path. Then X on hand drops by exactly 58 gal in one ledger row linked to L1's first revision. A double tap, a retry after a timeout, or the same confirm sent twice with the same key returns L1 and moves no more stock. (A "possible duplicate load" flag for a second tablet confirming the same physical load is [SPRING].)

**S12 Stock short.** X shows 40 gal on hand. Then L1 still confirms, X goes to −18, the ledger row has `requires_review`, and the office sees it. When the delivery is received later, on-hand returns positive through the normal receiving path; the flag stays in the history.

**S13 Mixer substitution.** The mixer removes X from L2 and adds Y. Then L2 takes Y from stock, not X; the job's original recipe is unchanged; the next load's proposal starts from L2's mix (the latest mix for that job), not the original recipe; the job is flagged for review; a substitute with no agreed price is flagged for pricing.

**S14 Add to a load after confirming.** After L1 is confirmed and field A is sprayed, the mixer adds 3 gal X to the tank. Then a new revision of L1 is saved with a 3 gal stock-out row; field A's work stays linked to the first revision; later fields link to the second. A typo fix (58 should have been 55) is a correction instead: a new revision with a reversing row returning 3 gal, and all of L1's work links to the corrected revision.

**S15 Carried-in leftover.** Rig 1 (job 1 here is not the standard job; fewer acres were sprayed) finishes job 1 with 200 finished gallons left and logs it on L1. The next load proposed for rig 1 (L3, job 2) shows 200 gal carried in and proposes that much less; no stock moves for it; L1 counts the 200 gal as carried, not used. Leftover nobody can use goes to a tote and is handled outside CRX. (Tracking each carry as a claim that can be used once, and flagging a carried mix that differs from job 2's recipe or customer, is [SPRING].)

**S16 Shared load.** L4 sprays the last field of job 1 and the first field of job 2. Then neither job's invoices are made until L4 is settled: every field it sprayed has acres or is closed, and its leftover is recorded (ran dry, or gallons carried to the next load or a tote). The office can settle it by hand with a reason [Sol 6].

**S17 Planned, mixed and billed view.** S1 shows planned 57, mixed 58, billed 58. S15's job 1 (its L1 started as 58 gal X in 3,480 finished gallons) shows mixed 58, carried out 200 finished gallons (as product: 200 ÷ 3,480 of 58 gal X = 3.3333 gal X), billed 54.6667; the 3.3333 gal X is billed on the job whose load it is carried into, and shows there as carried in. A load more than 5% off plan puts the job on the review list with planned vs billed and the dollar difference; the office can edit quantities with a reason.

**S18 Jobs already running when batches switch on.** Job J1 was created before the switch, so its stock path is "at completion". Then confirming a batch for J1 is refused with "this job takes stock at completion; finish it the old way"; completing J1 deducts exactly as today. A job created after the switch takes the batch path; completing it takes no stock. A job's stock path is set when the job is created and never changes.

**S19 Blend ticket and batch, either order.** For a batch-path job, a blend ticket recorded before or after a batch confirmation takes no stock. For an old-path job, KI-187 stays open until its own fix (production has no blend tickets).

## Lifecycle and correction scenarios [workflow]

**S20 Leftover acres closed.** Field C planned 71, sprayed 69. The office closes the last 2 acres. Then C bills 69 and the job can move to invoices. "Missing", "recorded 0 acres" and "closed" are different states; nothing ever falls back to planned acres.

**S21 Cancel.** A job with no acres logged and no confirmed load can be cancelled. A job with acres cannot (the office closes remaining acres instead). A job with a confirmed load but no acres (rained out after mixing) is not cancelled: the office ends it with nothing billed, the stock movement stays, and the load's contents are carried to the next load or a tote; a note is optional (M4).

**S22 All-or-nothing posting.** The office posts S1's three invoices; one fails (another user just changed it). Then none are posted, and the office sees which one failed and why.

**S23 Two editors.** Two office users edit S1's set at once, one changing P2's invoice and one a share that touches P1 and P2. Then the second save is refused with "someone else changed this; reload", and nothing is half-saved.

**S24 Unpost and repost.** S1 is posted; no payment, prepay, credit or write-off on any of the three; month open. The office corrects field B from 110 to 100 acres and closes the other 10. The 58 gal that went in now spreads over 218 acres (planned 54.5 gal, so the job goes on the review list at 6.42% over; the office keeps it, with a note). Then the whole set unposts and reposts with the amounts below; each invoice whose printed amount changed (P1 and P2 here) is marked "Corrected"; P3's is unchanged in every cent this time, but because each product is priced once per job, a correction on one field can move a cent on another field, and then that invoice is marked "Corrected" too. The original posted version stays readable.

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

**S25 Credit and rebill.** As S24, but P2 has paid. Then the set cannot be unposted; P1 and P2 each get a credit for their original invoice and a new invoice (S24's amounts); P3 is untouched because its dollars did not change (M3); each new invoice links to the one it replaces.

**S26 Spray record corrected after posting.** The office corrects field A's acres on a posted job. Then every posted invoice whose amount the correction would change is flagged: P1's (field A) and, because each product is priced once per job and a load's gallons spread over all its fields by acres, any other payer whose lines move; nothing changes by itself.

**S27 Duplicate entry.** The applicator logged field A, 49 acres, Tuesday on the phone; the office then types the paper ticket for the same field and day. Then CRX warns "possible duplicate"; the office removes it or keeps it (a real second pass; a note is optional); acres are never doubled silently. A kept second pass bills its own service acres (M8). A retry of the same save never creates a second entry.

**S28 Invoice date backfill.** The office posts on December 5 with the invoice date set to November 22. Then the invoice is dated November 22; each payer's due date follows that payer's terms from November 22; if November is closed, the date is refused with the existing month-close message; each field section shows its spray dates.

**S29 Hand-typed overlap.** A hand-typed invoice (no job) for field A, the same spray day and product X, warns (a note is optional), whether it was typed before or after the job's unposted invoice. Billing the same job's work a second time is refused.

**S31 Billing switch-on date.** CRX field billing starts only when the whole field app is built and live (Mason, 2026-11-24); no job is half sprayed across the date. Jobs sprayed before it are billed in Chem Man and marked so (whole job). Then a job whose first spray day is before the switch-on date can never be drafted in CRX; the date is absolute, with no exception; anything missed is typed as a normal invoice by hand.

**S32 Custom applicator.** The standard job, but its application service is a custom applicator (an outside company that bills the grower for the application itself). L1 had 58 gal X and 42.75 gal Y. Then the invoices carry the products only, no service line; acres are still logged per field and day, and the job shows on that applicator's season acres report (S34).

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

**S33 Unbilled work on the company's own fields [workflow].** A side-dress bar job on the company's own fields; its application service is set to "not billed" and the product is customer's own. Then no invoice is made (every line is zero, S9), the job still closes, and its acres and products appear on the season acres and blend reports.

**S34 Season acres report [workflow].** For a season and one application service or custom applicator, the office lists every work entry: date, grower, field, acres, the products in the tank, and whether it was billed by CRX; with totals per applicator and per grower; printable and exportable. This is what the office sends a custom applicator to bill from, or pays them from. The blend report lists every load's mix, customer's own product included.
