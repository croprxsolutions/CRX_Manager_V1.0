# Field application: exact-cents test scenarios

The money and stock rules in `SPEC.md` are pinned here as cases. **Expected results come from the business rules, not from code.** A build PR that touches billing, stock or posting turns the scenarios it covers into real tests (SQL tests against a migrated database, as the real caller, for anything the database decides) and records expected vs observed in the PR. All names, prices and acres are made up. Scenarios marked **[workflow]** have no generated numbers; their expected results are written out by hand.

Every money table is produced by `scenarios-calc.py` in this folder (exact decimals, no floating point). `python -I scenarios-calc.py --check` fails if a table here differs from the calculator; run it after any edit.

## Rules the numbers follow

1. **Each field line is priced on its own.** A product's quantity on a field is the sum, over the loads that sprayed that field, of that load's rate (fl oz/acre) × the acres that load sprayed there ÷ 128. Service and fuel are the field's sprayed acres × rate. Each field line is quantity × price, rounded **half up to whole cents once**. Quantities are kept exact; they are shown to 4 decimals only. *(Pricing per field means correcting one field never moves another field's cents, so an untouched payer's invoice never changes. This replaces an earlier "price per load, then spread" rule and FP-5a's "1 gallon at 10.01 over two equal fields bills 10.01 in total": per field that is 5.01 + 5.01.)*
2. **Split by share, closest to exact.** Each payer gets their exact share rounded down; leftover cents go one at a time to the payers with the largest remainder, ties to the bigger share, then the field's payer rank (the grower it was added under first). A 0% payer never gets a cent. Every payer's cents add up to the field line exactly. A credit (negative amount) is split the same way on its absolute value. This is the largest-remainder method the existing engine uses; the tie-break order is new and must be stored (payer rank). *(Refines Sol 69 "leftover cent to the biggest share": MORNING-QUESTIONS M1. With the literal rule, an equal three-way split of 603.75 bills 201.26 / 201.25 / 201.24.)*
3. **Shares are micro-percent** (100,000,000 = 100%), so thirds are 33,333,334 / 33,333,333 / 33,333,333, grower first. Each field's product shares and application shares each total exactly 100%.
4. **"Bill actual used"** replaces one load's rate by its actual gallons × 128 ÷ the acres that load sprayed, for every field it sprayed; then rule 1.
5. Service and fuel use the **application shares**; products the **product shares**. No flat fees, no tax.
6. **Three different gallon figures** are kept apart: **mixed** (confirmed into the tank; what left stock), **used** (mixed minus what was left aboard or carried out), and **billed** (rule 1). The review screen shows all three.

**Made-up prices:** product X 41.37 per gal; product Y 23.19 per gal; service 8.75 per acre; fuel 0.65 per acre. Table amounts are cents.

**The standard job:** fields A (P1 100%), B (P1 / P2 50/50), C (P1 / P2 / P3 thirds), same product and application shares unless a scenario says otherwise. Planned 51 / 110 / 71 acres; sprayed 49 / 110 / 69. Load L1: 58 gal of X mixed at a recipe of 32 fl oz/acre, sprayed all three fields, ran dry (used 58 gal).

## Money scenarios

**S1 Golden case.** Billed 57 gal (32 fl oz × 228 acres); mixed 58, used 58; rate check 1.75% over, under 5%, no review. Three draft invoices: P1 (sections A, B, C), P2 (B, C), P3 (C).

<!-- calc:S1 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.25 gal | 50678 | 50678 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| A | Fuel | 49 ac | 3185 | 3185 | - | - |
| B | X | 27.5 gal | 113768 | 56884 | 56884 | - |
| B | Service | 1.1E+2 ac | 96250 | 48125 | 48125 | - |
| B | Fuel | 1.1E+2 ac | 7150 | 3575 | 3575 | - |
| C | X | 17.25 gal | 71363 | 23788 | 23788 | 23787 |
| C | Service | 69 ac | 60375 | 20125 | 20125 | 20125 |
| C | Fuel | 69 ac | 4485 | 1495 | 1495 | 1495 |
| **Total** | | | **450129** | **250730** | **153992** | **45407** |

**S2 Part-acre spray.** Field C sprayed 68.7 acres.

<!-- calc:S2 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.25 gal | 50678 | 50678 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| A | Fuel | 49 ac | 3185 | 3185 | - | - |
| B | X | 27.5 gal | 113768 | 56884 | 56884 | - |
| B | Service | 1.1E+2 ac | 96250 | 48125 | 48125 | - |
| B | Fuel | 1.1E+2 ac | 7150 | 3575 | 3575 | - |
| C | X | 17.175 gal | 71053 | 23685 | 23684 | 23684 |
| C | Service | 68.7 ac | 60113 | 20038 | 20038 | 20037 |
| C | Fuel | 68.7 ac | 4466 | 1489 | 1489 | 1488 |
| **Total** | | | **449538** | **250534** | **153795** | **45209** |

**S3 Different product and application shares.** Application shares: B is P1 100% / P2 0%; C is P1 / P2 50/50, P3 0%. Product shares as standard. P3 gets an invoice for product only; P2 pays no application on B.

<!-- calc:S3 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.25 gal | 50678 | 50678 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| A | Fuel | 49 ac | 3185 | 3185 | - | - |
| B | X | 27.5 gal | 113768 | 56884 | 56884 | - |
| B | Service | 1.1E+2 ac | 96250 | 96250 | 0 | - |
| B | Fuel | 1.1E+2 ac | 7150 | 7150 | 0 | - |
| C | X | 17.25 gal | 71363 | 23788 | 23788 | 23787 |
| C | Service | 69 ac | 60375 | 30188 | 30187 | 0 |
| C | Fuel | 69 ac | 4485 | 2243 | 2242 | 0 |
| **Total** | | | **450129** | **313241** | **113101** | **23787** |

**S4 Mix changed between loads.** L1 (X, 32 fl oz) sprayed A. The mixer changed load L2 to Y at 24 fl oz/acre; L2 sprayed B and C. Stock: L1 mixed 12.25 gal X; L2 mixed 33.5625 gal Y (both ran dry). Field A is never re-priced.

<!-- calc:S4 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.25 gal | 50678 | 50678 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| A | Fuel | 49 ac | 3185 | 3185 | - | - |
| B | Y | 20.625 gal | 47829 | 23915 | 23914 | - |
| B | Service | 1.1E+2 ac | 96250 | 48125 | 48125 | - |
| B | Fuel | 1.1E+2 ac | 7150 | 3575 | 3575 | - |
| C | Y | 12.9375 gal | 30002 | 10001 | 10001 | 10000 |
| C | Service | 69 ac | 60375 | 20125 | 20125 | 20125 |
| C | Fuel | 69 ac | 4485 | 1495 | 1495 | 1495 |
| **Total** | | | **342829** | **203974** | **107235** | **31620** |

**S4b One field sprayed from two loads.** As S4, but L1 also sprayed the first 40 acres of B, and L2 the other 70. Stock: L1 mixed and used 22.25 gal X (89 acres); L2 mixed and used 26.0625 gal Y (139 acres); both ran dry. Field B bills 10 gal of X and 13.125 gal of Y. Service and fuel bill B's 110 acres once, not once per load.

<!-- calc:S4b -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.25 gal | 50678 | 50678 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| A | Fuel | 49 ac | 3185 | 3185 | - | - |
| B | X | 1E+1 gal | 41370 | 20685 | 20685 | - |
| B | Y | 13.125 gal | 30437 | 15219 | 15218 | - |
| B | Service | 1.1E+2 ac | 96250 | 48125 | 48125 | - |
| B | Fuel | 1.1E+2 ac | 7150 | 3575 | 3575 | - |
| C | Y | 12.9375 gal | 30002 | 10001 | 10001 | 10000 |
| C | Service | 69 ac | 60375 | 20125 | 20125 | 20125 |
| C | Fuel | 69 ac | 4485 | 1495 | 1495 | 1495 |
| **Total** | | | **366807** | **215963** | **119224** | **31620** |

**S5 Bill actual used.** L1 was really 61.5 gal mixed and used (ran dry), 7.9% over the recipe, so the job is on the review list and the office picks "bill actual used" for L1. Products only (service and fuel as S1). Field lines total 254,425 cents, one cent under 61.5 × 41.37, because each field is priced on its own (rule 1).

<!-- calc:S5 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 13.2171 gal | 54679 | 54679 | - | - |
| B | X | 29.6711 gal | 122749 | 61375 | 61374 | - |
| C | X | 18.6118 gal | 76997 | 25666 | 25666 | 25665 |
| **Total** | | | **254425** | **141720** | **87040** | **25665** |

**S6 Per-line share override.** From S1, the office sets field B's product line to P1 100%, P2 0%, with a reason. Every other line unchanged; the job total is the same.

<!-- calc:S6 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.25 gal | 50678 | 50678 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| A | Fuel | 49 ac | 3185 | 3185 | - | - |
| B | X | 27.5 gal | 113768 | 113768 | 0 | - |
| B | Service | 1.1E+2 ac | 96250 | 48125 | 48125 | - |
| B | Fuel | 1.1E+2 ac | 7150 | 3575 | 3575 | - |
| C | X | 17.25 gal | 71363 | 23788 | 23788 | 23787 |
| C | Service | 69 ac | 60375 | 20125 | 20125 | 20125 |
| C | Fuel | 69 ac | 4485 | 1495 | 1495 | 1495 |
| **Total** | | | **450129** | **307614** | **97108** | **45407** |

**S7 Split changed mid-job [workflow].** Field B's split changes from 50/50 to P1 100% starting Wednesday. B was sprayed 60 acres Tuesday and 50 Thursday. Then the Tuesday work bills 50/50 and the Thursday work 100% P1: field B gets one line per split in force, each priced on its own acres. A job office override (FP-4) wins over both, as in the build sheet.

**S8 Locked and unlocked prices [workflow].** X has a locked quote price; Y has none. Y's price rises on Wednesday; the job's first spray day (Central date of the first work entry with acres above zero) was Tuesday. Then X bills the quote price and Y bills Tuesday's price on every field. A logged "price refresh" on the draft updates Y and never touches X. A substitute with no price on that day is flagged for the office to price; the draft cannot post until it has one.

**S9 Zero-share payer.** Field C's product and application shares are P1 / P2 50/50, P3 0%. P3 has no share anywhere else. Then no invoice is made for P3 (no zero-dollar invoices).

<!-- calc:S9 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.25 gal | 50678 | 50678 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| A | Fuel | 49 ac | 3185 | 3185 | - | - |
| B | X | 27.5 gal | 113768 | 56884 | 56884 | - |
| B | Service | 1.1E+2 ac | 96250 | 48125 | 48125 | - |
| B | Fuel | 1.1E+2 ac | 7150 | 3575 | 3575 | - |
| C | X | 17.25 gal | 71363 | 35682 | 35681 | 0 |
| C | Service | 69 ac | 60375 | 30188 | 30187 | 0 |
| C | Fuel | 69 ac | 4485 | 2243 | 2242 | 0 |
| **Total** | | | **450129** | **273435** | **176694** | **0** |

**S10 Grower-supplied product [workflow].** L1 also had 10 gal of product Z marked "customer's own / already paid" by P1. Then Z leaves no company stock, prints on P1's invoice at zero price and zero cost, is never re-priced by a refresh, and is left out of the 5% check. If every line for a payer is zero, rule S9 applies.

## Stock and batch scenarios [workflow]

**S11 Batch confirmation takes stock once.** The mixer confirms L1 (58 gal X) for a job on the batch stock path. Then X on hand drops by exactly 58 gal in one ledger row linked to L1's first revision. A double tap, a retry after a timeout, or the same confirm sent twice with the same key returns L1 and moves no more stock. A second tablet confirming the same physical load under a new load id creates a second load, which is flagged "possible duplicate load" (same rig, same jobs, within 30 minutes) for the office; nothing is blocked.

**S12 Stock short.** X shows 40 gal on hand. Then L1 still confirms, X goes to −18, the ledger row has `requires_review`, and the office sees it. When the delivery is received later, on-hand returns positive through the normal receiving path; the flag stays in the history.

**S13 Mixer substitution.** The mixer removes X from L2 and adds Y. Then L2 takes Y from stock, not X; the job's original recipe is unchanged; the next load's proposal starts from L2's mix (the latest mix for that job), not the original recipe; the job is flagged for review; a substitute with no agreed price is flagged for pricing.

**S14 Add to a load after confirming.** After L1 is confirmed and field A is sprayed, the mixer adds 3 gal X to the tank. Then a new revision of L1 is saved with a +3 gal stock row; field A's work stays linked to the first revision; later fields link to the second. A typo fix (58 should have been 55) is a correction instead: a new revision with a +3 gal reversing row, and all of L1's work links to the corrected revision.

**S15 Carried-in leftover.** Rig 1 finishes job 1 with 200 finished gallons left and logs it (a carry-out on L1). The next batch for rig 1, L3 for job 2, claims that carry-out. Then L3 shows 200 gal carried in and proposes that much less; no stock moves for it; L1 counts 200 gal as moved, not used; the carry-out can be claimed once (a second batch trying to claim it gets "already carried into L3"). If the carried-in mix's products differ from job 2's recipe, or the carried product was customer-supplied by a different customer, the job is flagged for the office; nothing is blocked.

**S16 Shared load.** L4 sprays the last field of job 1 and the first field of job 2. Then neither job's drafts are made until L4 is settled: every field it sprayed has acres or is closed, and its leftover is recorded (ran dry, gallons carried out, or gallons to a tote). The office can settle it by hand with a reason [Sol 6].

**S17 Stock, used and billed view.** S1 shows mixed 58, used 58, billed 57, "mixed but not billed" 1 gal. S5 after "bill actual used" shows mixed 61.5, used 61.5, billed 61.5, difference 0. S15's job 1 shows mixed 58, carried out 200 finished gallons (as product: 200 ÷ 3,480 of L1's 58 gal X = 3.3333 gal X), used 54.6667.

**S18 Jobs already running when batches switch on.** Job J1 was created before the switch, so its stock path is "at completion". Then confirming a batch for J1 is refused with "this job takes stock at completion; finish it the old way"; completing J1 deducts exactly as today. A job created after the switch takes the batch path; completing it takes no stock. A job's stock path never changes after its first stock movement.

**S19 Blend ticket and batch, either order.** For a batch-path job, a blend ticket recorded before or after a batch confirmation takes no stock. For an old-path job, KI-187 stays open until its own fix (production has no blend tickets).

## Lifecycle and correction scenarios [workflow]

**S20 Leftover acres closed.** Field C planned 71, sprayed 69. The office closes the last 2 acres. Then C bills 69 and the job can move to drafts. "Missing", "recorded 0 acres" and "closed" are different states; nothing ever falls back to planned acres.

**S21 Cancel.** A job with no acres logged and no confirmed batch can be cancelled. A job with acres cannot (the office closes remaining acres instead). A job with a confirmed batch but no acres (rained out after mixing) is not cancelled: the office ends it with nothing billed, the stock movement stays, and the load's contents are carried to the next job or a tote; a note is optional (Mason, M4).

**S22 All-or-nothing posting.** The office posts S1's three drafts; one fails (another user just changed it). Then none are posted, and the office sees which one failed and why.

**S23 Two editors.** Two office users edit S1's set at once, one changing P2's draft and one a share that touches P1 and P2. Then the second save is refused with "someone else changed this; reload", and nothing is half-saved.

**S24 Unpost and repost.** S1 is posted; no payment, prepay, credit or write-off on any of the three; month open. The office corrects field B from 110 to 100 acres and closes the other 10. Then the whole set unposts and reposts; P1 and P2 change as below; P3's invoice is unchanged in every cent; each invoice whose content changed is marked "Corrected"; the original posted version stays readable.

<!-- calc:S24 -->
| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| A | X | 12.25 gal | 50678 | 50678 | - | - |
| A | Service | 49 ac | 42875 | 42875 | - | - |
| A | Fuel | 49 ac | 3185 | 3185 | - | - |
| B | X | 25 gal | 103425 | 51713 | 51712 | - |
| B | Service | 1E+2 ac | 87500 | 43750 | 43750 | - |
| B | Fuel | 1E+2 ac | 6500 | 3250 | 3250 | - |
| C | X | 17.25 gal | 71363 | 23788 | 23788 | 23787 |
| C | Service | 69 ac | 60375 | 20125 | 20125 | 20125 |
| C | Fuel | 69 ac | 4485 | 1495 | 1495 | 1495 |
| **Total** | | | **430386** | **240859** | **144120** | **45407** |

**S25 Credit and rebill.** As S24, but P2 has paid. Then the set cannot be unposted; P1 and P2 each get a credit for their original invoice and a new invoice (S24's amounts); P3 is untouched; each new invoice links to the one it replaces.

**S26 Spray record corrected after posting.** The office corrects field A's acres on a posted job. Then the posted invoices with a field A section (P1's) are flagged; nothing changes by itself; other payers are not flagged.

**S27 Duplicate entry.** The applicator logged field A, 49 acres, Tuesday on the phone; the office then types the paper ticket for the same field and day. Then CRX warns "possible duplicate"; the office removes it or keeps it (a real second pass; a note is optional, Mason's flags-not-steps rule); acres are never doubled silently. A kept second pass bills its own service and fuel acres (Mason, M8). A retry of the same save never creates a second entry.

**S28 Invoice date backfill.** The office posts on December 5 with the invoice date set to November 22. Then the invoice is dated November 22; each payer's due date follows that payer's terms from November 22; if November is closed, the date is refused with the existing month-close message; each field section shows its spray dates.

**S29 Hand-typed overlap.** A hand-typed invoice (no job) for field A, the same spray day and product X, warns (a note is optional), whether it was typed before or after the job's draft. Billing the same job's work a second time is refused.

