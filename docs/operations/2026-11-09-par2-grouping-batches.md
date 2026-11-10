# PAR-2 grouping batches (DATA-9 / DATA-12): tracking

**Status, 2026-11-09 (Central): grouping switch ON (PR #1712, ledger `20261110023059`); batches 1, 2 and 3 APPROVED live by Mason (115 parents, 231 sizes); 42 "2.5G/265G/275G" names renamed to "2.5 Gal/265 Gal/275 Gal Tote". DATA-2 brand writes done; proposal 3 built. Fertilizer tote sizes, duplicate totes and the disagreement groups wait on Mason.**

What this is: CRX Manager keeps each container size of a chemical as its own product row (a 2.5 gal jug and a Bulk row of the same chemical are two rows). PAR-2 puts those rows under one **parent** per chemical, so shared values (rate, Use Timing, later weight and ingredients) are typed once. Grouping never changes a product ID, price, cost, stock, unit or any old order or invoice. Plan: `docs/plans/2026-10-29-product-GRAND-PLAN.md` overlaps 13 and 14, PAR-2, DATA-9 and DATA-12; build sheet `docs/plans/2026-11-04-product-stage2-BUILD-SHEET.md` section 5.

## 1. Live state (read-only check, 2026-11-09)

| Fact | Live value |
|---|---|
| Product rows | 604 (596 active) |
| Parents | 0 |
| Grouping proposals built | 0 |
| Grouping switch (`_product_parent_grouping_open()`) | **OFF** (`SELECT false`) |
| Rate lock | off (since 2026-11-05) |

**Blocker:** the Group products screen (Admin, PR #1602) can build, hold and reject, but every **Approve** is refused while the switch is off. PR #1602 left turning it on as a separate owner decision. Taha's four "fix before the switch is turned on" items from PR #1555 were settled by `20261201110000_product_parent_review_fixes` (live): strength numbers kept in base names, a size move refuses differing brand lists, a group matching an existing parent is held, and a re-proposed rejection names the earlier one. Live has 0 parents and 0 parent brands, so no brand rows need settling first. Turning the switch on is one small reviewed migration (Sol list: database), with the 4-hour Taha hold before it is applied.

## 2. What the app would propose today (read-only dry run)

The build logic of `build_product_parent_proposal` (as in `20261201110000`) was run read-only on live, with its private helpers copied inline, because the live-data guard refuses calls to them.

| Result | Groups | Rows |
|---|---|---|
| Proposed, 2 or more sizes | 117 | 235 |
| Proposed, one size only (gets its own parent) | 333 | 333 |
| Held for review (names end in "2.5G" or "275G", read as a strength like "4G") | 35 | 36 |

Ranking uses how many invoice and order lines name each row (all time). Sales history is thin, so most groups past number 27 have no sales yet and are in name order.

## 3. Batch 1: 36 groups, 72 rows (for Mason's approval)

Every group below has sizes that **agree** on rate, rate unit, Use Timing, category and manufacturer, and no size has brands yet, so approving changes **no rate and no price**. "No EPA" groups need the screen's "same product" box ticked (the app asks for it when there is no EPA number to match on).

| # | Parent (suggested name) | Sizes | EPA | Note |
|---|---|---|---|---|
| 1 | COC XL | 2.5 gal + Bulk | none | |
| 2 | Gen Select 2LB (Ceridian 2EC, Clethodim 2EC, Volunteer) | 2.5 gal + Bulk | none | App suggests "Gen Select : (…)"; rename to the name shown here |
| 3 | NIS 90 | 2.5 gal + Bulk | none | |
| 4 | Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) | Bulk + 2.5 gal | none | |
| 5 | Trivapro | Bulk + 2.5 gal | 100-1613 | |
| 6 | 2, 4D Ester 6# | Bulk + 2.5 gal | none | |
| 7 | Anthem Maxx | 2.5 gal + 125 gal | 279-3468 | 125 gal stays its own fixed package |
| 8 | Complete | 2.5 gal + Bulk | none | |
| 9 | Sequence | Bulk + 2.5 gal | 100-1185 | |
| 10 | 2, 4D Amine 4# | 2.5 gal + Bulk | none | |
| 11 | Enlist One | Bulk + 2.5 gal | 62719-695 | |
| 12 | Gen Banvel: (Dicamba DMA, Disha DMA) | 2.5 gal + Bulk | none | |
| 13 | Gen Quilt Xcel: (Aquila XL, Azoxyprop Xtra, Cover XL, Propaz) | 2.5 gal + Bulk | none | |
| 14 | MSO XL | 2.5 gal + Bulk | none | |
| 15 | Wind Drift | 2.5 gal + Bulk | none | |
| 16 | COC 17% | Bulk + 2.5 gal | none | |
| 17 | Gen Capture LFR: (Batallion LFC, Seguro) | 2.5 gal + Bulk | none | |
| 18 | Gen Liberty: Higher Quality (Interline, Inflame) | Bulk + 2.5 gal | none | Stays separate from plain Gen Liberty (D-O) |
| 19 | Miravis Neo | 2.5 gal + Bulk | 100-1605 | |
| 20 | MSO 84 | Bulk + 2.5 gal | none | |
| 21 | Veltyma | 2.5 gal + Bulk | 7969-409 | |
| 22 | Warrant | Bulk + 2.5 gal | 524-591 | |
| 23 | Acuron | 2.5 gal + Bulk | 100-1466 | |
| 24 | Acuron GT | 2.5 gal + Bulk | 100-1675 | |
| 25 | Adastrio | 2.5 gal + 250 gal | 279-3642 | 250 gal stays its own fixed package |
| 26 | Aproach | 2.5 gal + 110 gal | 352-840 | 110 gal stays its own fixed package |
| 27 | Aproach Prima | 110 gal + 2.5 gal | 352-883 | 110 gal stays its own fixed package |
| 28 | Armezon Pro | 2.5 gal + Bulk | 7969-372 | |
| 29 | Authority Edge | 2.5 gal + 120 gal | 279-9643 | 120 gal stays its own fixed package |
| 30 | Authority Supreme | 120 gal + 2.5 gal | 279-3601 | 120 gal stays its own fixed package |
| 31 | Bicep Lite II Magnum | 2.5 gal + Bulk | 100-827 | |
| 32 | Boundary 6.5 EC | Bulk + 2.5 gal | 100-1162 | |
| 33 | Brigade | 250 gal + 1 gal | 279-3069 | 250 gal stays its own fixed package |
| 34 | Bullseye + DRA | Bulk + 2.5 gal | none | |
| 35 | BW-NLockDown | 2.5 gal + Bulk | none | |
| 36 | Callisto Xtra Enhanced | Bulk + 2.5 gal | 100-1359 | |

## 4. Needs Mason (kept out of batch 1)

1. **Atrazine 4L (EPA 352-314):** the app proposes "2.5 gal + Bulk" as one group, but "Atrazine 4L - NO RETURN, FULL TOTE - 265G" has the same EPA number and lands in its own group because of its long name. Recommended: approve the 2-size group, reject the tote's own group, then move the 265G tote under the parent (Move this size, on the product page).
2. **BroadAxe XC and Authority Elite share EPA 279-3442** (Syngenta and FMC labels). One parent with two names, or two parents?
3. **Fertilizer tote rows (DATA-12):** Ultramate LQ, Nulex Zinc 15%, Premium 8-29-2 (50/50), Black Strap Molasses Sugar, Agro Mix, plus later Diamond 3-18-18 / 9-18-9 / First Pass Soybean, Eezy K24 / KB, UltraMate B, Ultramate ZN. Each tote row (275 or 265 gal) counts its stock in **gallons**, like the Bulk row, and two show odd stock (Ultramate LQ tote below zero; Black Strap Molasses tote holds stock while its Bulk row is below zero). For each: is the tote a real fixed package, or a duplicate of Bulk? If a package: filled at the shop from Bulk, or arrives filled from the vendor?
4. **Tote rows sized "1 gal":** Carbon RX, Concept N-25B (SRN), Concept-B-10, Foliar-K (0-0-24). A 1-gallon "Tote" looks like a duplicate of the Bulk row.
5. **35 held rows named "- 2.5G" or "- 275G"** (Aero-N, Copper 7.5%, Manganese 6%, Super 25B, Sweet 'N Eezy and others). The app reads "2.5G" like a granular strength ("4G"), so it never groups them. Renaming them to "2.5 Gal" / "275 Gal" (a separate, approved live change) lets the next build group them.
6. **Same EPA number, split by name (single-size groups):** Absolute Maxx / Absolute Maxx - 270; Atrazine 90 DF - 25# / 25# - NO RETURN; Aztec 4.67 G 50# / SB; Counter 20 G 40# / SB; Topguard / Topguard EQ; and the seed treatments CruiserMaxx APX, Ilevo, Trilex 2000, Vibrance Trio with their "Per Unit" rows. Same product in another size, or truly different?
7. **Later batches with disagreements** (the screen makes Mason pick one value): Dual Magnum (rate), Enversa (Use Timing), Fierce MTZ and Kyber Pro (rate, and they share EPA 59639-236), Maverick (rate), Steward (rate and manufacturer), Zannis SC (retired; rate, inactive size).

## 5. Queue after batch 1

- **Batch 2:** the other 2-or-more-size groups not listed in section 4 (about 65, ranks 46 to 117 of the dry run: Corvus, Delaro 325 SC, Delaro Complete, DiFlexx, Dual II Magnum, Duracor, Ethos Elite LFR, Everprex, Flexstar GT, Forcivo, Gen Boundary, Gen Dual R Moc, Gen Flexstar, Gen Lorsban, Gen Treflan, Grazon Next HL, Halex GT, Headline AMP, Impact Core, ImpactZ, Infiltrator, Instinct NXTGEN, Kyro, Liberty Ultra, Liquid AMS 34%, Milestone, N Class 34%, Nutrisphere-N for UAN, Obvious Plus, Outlook, Powermax 3, Prefix, Prowl H2O (3 sizes), Resicore REV, Ridgeback, Roundup 5.4# (Bucc 5 Extra), Sinate, Staunch II, Storen, Stratego YLD, SulfurPro Si, SureStart II, Surtain, Take Off LS 0-0-5, Tendovo, Trivolt, VaporDrift DRA+VRA, Verdict, Volley ATZ Lite NXT, Volley ATZ NXT, Volley NXT, VRA, WideARmatch, Xyway LFR, Zoom; plus the Ilevo pair once item 6 is answered).
- **Batch 3:** the section 4 items, as Mason answers them.
- **Batches 4+:** the 333 single-size rows (each becomes its own parent), in groups of about 40.

## 6. How to apply a batch (once the switch is on)

Mason, on croprxsolutions.app, signed in as admin:
1. **Products** → the **Group Products** tab → build a new proposal.
2. For each group in the batch: check the sizes match the table, fix the name if the table says so, tick "I confirm these sizes are the same product" when there is no EPA number, then **Approve this group** → **Approve as shown**.
3. For every group not in this batch: leave it as is (it stays proposed for the next batch).

An agent then checks read-only that each approved group has a parent, every member product still has the same ID, price, cost, stock and unit, and that no other product changed.

**Build after RT-2a (PR #1706) is applied**, or rebuild after it: RT-2a renames unit spellings (Oz→oz, Qt→qt) on 20 products, and approval refuses a group whose sizes changed after the build.

## 7. Progress log

| Date | Batch | State |
|---|---|---|
| 2026-11-09 | 1 | Drafted (36 groups). Waiting on Mason: turn on grouping, then approve. |
| 2026-11-09 | 1 | **Approved** about 9:57 PM Central, proposal 88c57e35 (built 9:38 PM): 36 parents, 72 sizes (29 Bulk, 43 Package). Read-only check: for all 72 sizes the approval record has identical before/after rate, per-acre tier prices, EPA and category; 0 stock movements; no brand rows. |
| 2026-11-09 | 2 | **Approved** by Mason on screen, proposal 697a26a3 (built 10:07 PM): 55 parents, 111 sizes. Live totals now 91 parents, 183 sizes. Read-only check: all 183 logged sizes have identical before/after values; 0 stock movements. Left out: the 7 disagreement groups (section 4 item 7), BroadAxe XC, Ilevo, Milestone (RT-2a), and 14 fertilizer Bulk + Tote pairs. |
| 2026-11-09 | renames | Mason approved: 42 product names changed in the app (product page, Save Changes) from "2.5G / 265G / 275G" to "2.5 Gal / 265 Gal / 275 Gal Tote" (plus a missing bracket on one Gen Dual S Moc row). Read-only check: a fingerprint of every other products column was identical before and after, no other product name changed, 0 stock movements. Old invoices and orders keep their saved names. |
| 2026-11-09 | 3 | **Approved** by Mason in chat ("Approve"), clicked by the agent; proposal 457d814f (built 10:26 PM, after DATA-2's brand writes): 24 parents, 48 sizes (14 Bulk, 22 Tote vendor-filled, 12 Package). Groups: BroadAxe XC, Gen Capture, 10 jug + factory tote pairs, 12 fertilizer Bulk + 275 gal tote pairs. Read-only check: 47 of 48 sizes identical before/after; Aero-N 2.5 Gal suggested-rate note changed "1-2PT" to "1-2Pt" (rate and per-acre prices unchanged); 0 stock movements. Held: tote rows sized 1 or 265 gal, duplicate Boron/Manganese totes, Residue RX, the 6 rate/timing disagreements, Ilevo, Milestone, Zannis, the Atrazine 4L tote. |
| 2026-11-09 | tote sizes | Mason approved (product page): Vigor 802 tote set to 250 gal (and renamed "250 Gal Tote"), HumiK LX 12% tote set to 275 gal, Black Strap Molasses Sugar tote set to 250 gal. Advance K24 tote stays 265 gal. |
| 2026-11-09 | duplicate tote | Mason approved: "Manganese 6% - 275 Gal Tote" **deactivated** (duplicate of "Manganese 6% - Tote", which stays active). It is still listed as an inactive size under the Manganese 6% parent. |
| 2026-11-09 | zero prices refused | Setting a zero price on Copper 5%, Zinc 10% and Enversa 250 was refused by the below-cost guard. Mason: leave them on sale; he reprices them himself. |
| 2026-11-09 | timings, size | Mason approved (product page): Use Timing set on Dual Magnum (pre soybean, post corn, post soybean), Maverick (pre corn, post corn), Enversa (pre and post, corn and soybean). "Residue RX - 2.5 Gal" container size corrected from 1 to 2.5. |
| 2026-11-09 | 4 | **Approved** by Mason in chat, proposal 7c656a30 (built 11:01 PM): 59 parents, 77 sizes. Mason's rate picks: Dual Magnum 21.28 oz (1.33 pt), Fierce MTZ 18 oz, Kyber Pro 18 oz, Maverick 18 oz, Steward 9 oz. Boron 10%: all three rows (different vendors) under one parent. Bulk + tote roles: Carbon RX, Concept N-25B, Concept-B-10, Foliar-K (Tote = Package, Bulk = Bulk); Bio-Health, Residue RX (2.5 Gal = Package, Tote = Bulk). Read-only check: 67 of 77 sizes identical before/after; the 10 that changed are the sizes whose rate Mason picked (rate, per-acre prices and pricing version moved together); 0 stock movements. Live totals now 174 parents, 308 sizes. |
| 2026-11-09 | move | Mason approved: "Atrazine 4L - NO RETURN, FULL TOTE - 265 Gal" moved under the Atrazine 4L parent as a fixed tote (Move this size). Two size-moved records; 0 stock movements. |
| 2026-11-09 | 5 | **Approved** by Mason in chat ("Approve"), clicked by the agent; proposal 7c656a30: 43 single-size parents (9 Bulk, 34 Package), Aztec HC SB through Panoflex, all with an EPA number and no flags. Size dropped from 7 parent names (Aztec HC SB, Capture LFR, Fierce XLT, Force 10G HL SB, Force 6.5G, Index At Plant, NovaGraz). Review dialog: no rate or per-acre price changes. Read-only check: live totals 217 parents, 351 sizes; 43 records, 41 identical before/after; Imazuron Herbicide and Palisade EC had an empty suggested-rate note stored as blank, now empty (pricing version bumped, rate and per-acre prices unchanged); only those 43 products touched; 0 stock movements. |
| 2026-11-09 | 6 | **Approved** by Mason in chat ("Approve"), clicked by the agent; proposal 7c656a30: 51 single-size parents (3 Bulk, 48 Package), PastureGard HL through Zorina; with batch 5 this covers every remaining group that has an EPA number and no flags, except Milestone, Zannis SC and the Saltro / Victrato per-unit rows. Size dropped from 7 parent names (PastureGard HL, Smart Choice 15G HC Smartbox, Sonic, Spike 20P, Surveil, Valor SX, Valor XLT). Warrant Ultra kept apart from the Warrant parent (different EPA number). Review dialog: no rate or per-acre price changes. Read-only check: live totals 268 parents, 402 sizes; 51 records, 49 identical before/after; Pinzola EC and Treaty Extra had the same blank suggested-rate note cleared (pricing version bumped, rate and per-acre prices unchanged); the only products changed in the window are the batch 5 and 6 sizes plus the earlier Atrazine tote move; 0 stock movements. Data to review later (unchanged by grouping): Tempo SC Ultra has no container size and counts "each"; Pinzola EC, Tordon RTU and Treaty Extra have no rate. |

**Still to do (as of batch 6):** about 200 single-size groups (none left with an EPA number and no flags) (each becomes its own parent), in batches of about 40; about 20 pairs split only by name, to approve as single sizes and then join with Move this size (Buck Barrier, BoostMax-D, BoostMax-M, Zinc 9%, Fulvic Force, Concept-Z9, Citric Acid, Absolute Maxx, Prevent Foam, Atrazine 90 DF, Gen Liberty, Gen Sencor Liquid, Gen Prowl H2O, HumiK, Piksi Dust Plus, Impressive DB, and the CruiserMaxx / Trilex / Vibrance per-unit rows). **Held:** Ilevo (per-unit row), Milestone (waits on RT-2, PR #1706), Zannis (retired).

**Open questions for Mason (label data):** Kyber Pro and Fierce MTZ both carry EPA 59639-236 (one is wrong); Steward's 135 gal size says Corteva while the 2.5 gal says FMC (EPA 279 is FMC); Topguard and Topguard EQ both carry 279-3557.

**Size roles (Mason, 2026-11-09):** only fertilizer is kept in real bulk storage. For chemicals and adjuvants, a "- Bulk" row is a tote filled to the customer's amount (usually by the vendor, sometimes by the shop from spare totes) and sold by the gallon, so it keeps the **Bulk** role. A set-size vendor container (110/120/125/250 gal) with no Bulk size in its group is a **Package**, not a Tote. Tracking shop-filled chemical totes as a stock movement is not built (shop fill is fertilizer only, DECISION_LOG 2026-11-04).

**Mason's answers to section 4 (2026-11-09):**
1. Atrazine 4L 265 gal tote: group it under Atrazine 4L (move this size).
2. BroadAxe XC and Authority Elite are different products; the EPA number was wrong on BroadAxe XC, fixed by DATA-2 to 279-3442-100.
3. Fertilizer: each is either Bulk or a set factory tote; all totes are 275 gal except Black Strap Molasses (250 gal).
4. The "1 gal" Tote rows are a Bulk or tote row (size to be corrected before grouping).
5. "2.5G" means a 2.5 gal jug (Package); "275G" means a set factory tote. Renamed (see log).

**Order with DATA-2 (EPA brand numbers, PR #1709):** DATA-2 writes identical brand lists on every size of the ungrouped products, and writes on the parent (`upsert_parent_brand`) for batch 1. Batch 2 and later proposals are built only after DATA-2's writes land.
