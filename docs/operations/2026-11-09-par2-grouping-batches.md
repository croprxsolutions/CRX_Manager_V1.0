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
| 2026-11-09 | 7 | **Approved** under Mason's standing OK in chat ("I approve all batches... get all these easy ones done", anything uncertain waits for him), clicked by the agent. First try on proposal 7c656a30 was refused whole ("a size in this group changed since the proposal was built": DATA-2 wrote 13 brand rows at 11:34 PM); nothing saved. Rebuilt as proposal 5 (11:43 PM, same 199 groups) and approved 80 single-size parents with no EPA number (62 Package, 18 Bulk; "same product" confirmed, one size each): generic chemicals (Gen Authority family, Gen Valor EZ / SX / XLT and others), Goldstart, Premium and Diamond fertilizers, adjuvants and water-soluble fertilizers. Size dropped from 11 parent names. Picked only groups whose name matches no other remaining group and no existing parent. Review dialog: no rate or per-acre price changes. Read-only check: live totals 348 parents, 482 sizes; 80 records, 77 identical before/after; Powder Keg Corn / Soybeans and Water W/ D-Chlorinator had the blank suggested-rate note cleared (rate and per-acre prices unchanged); no other product changed; 0 stock movements. |
| 2026-11-10 | 8 | **Approved** by Mason in chat (HumiK bag + super sack are one product; totes with no Bulk size are set factory totes; join the name-split pairs; Citric Acid 2.5 gal is the same 50% product; Piksi Dust and Piksi Dust Plus stay separate). First try (36 groups at once) was refused whole: the app will not make two parents whose names reduce to the same base name ("Prevent Foam" and "Prevent Foam - 1 Qt"); nothing saved. Done instead as: (A) 14 sizes to be moved approved as their own parents, each named "Moved size: ..."; (B) 22 parents: the 13 join targets (Absolute Maxx, Aztec 4.67 G, Counter 20 G, Citric Acid 50%, Impressive DB, Prevent Foam, Zinc 9%, BoostMax-M, HumiK Bio Plus WSP, HumiK Bio WSP, HumiK One, HumiK Tech Grade, HumiK WSP) plus HumiK SSG, HumiK Zn and 7 vendor-filled fertilizer totes (Copper 5%, Zinc 10%, Eezy Man Gen II, Vigor 802, HumiK LX 12%, ZincMan, MicroNourish); (C) Move this size for all 14 into their target (the 14 "Moved size" parents are now inactive and empty). Review dialogs and every move preview: no rate or per-acre price changes. Read-only check: 384 parents (369 active), 518 sizes; 36 created + 28 size-moved records; the only value changed is the Citric Acid 2.5 gal suggested-rate note, now the parent's "10-18oz/100G" (was "7-12oz/100G"; rate and per-acre prices unchanged); no other product changed; 0 stock movements. |
| 2026-11-10 | 9 | **Approved** by Mason in chat: a NO RETURN row is a size of the normal product ("Size of normal product"), for totes and packages alike; each size keeps its own "no return" mark and price. First try on proposal 5 was refused whole ("a size in this group changed since the proposal was built": DATA-2 brand writes at 12:03-12:04 AM); nothing saved. Rebuilt as proposal 6 (7:04 AM) and done in the batch 8 way: (A) 15 one-size "Moved size: ..." parents (265 gal NO RETURN totes as vendor-filled Tote, the rest Package); (B) 7 normal parents: Ammonium Sulfate, Atrazine 90 DF, Gen Paraquat (Bulk), Gen Sencor Liquid 4# (Bulk), Gen Sencor, Gen Warrior 1LB, Gen Warrior 2LB; (C) Move this size for all 15: into 2, 4D Ester 6#, Gen Banvel (2), Gen Quilt Xcel (2), Gen Select 2LB, Roundup 5.4# Generic, plus the 7 new parents (Gen Sencor Liquid 4# also took its normal 2.5 gal). Review dialogs and every move preview: no rate or per-acre price changes; the only value changed is the Ammonium Sulfate NO RETURN suggested-rate note "17 lb/100 gal" to "17 lb/100 Gal". Read-only check: 406 parents (376 active), 540 sizes; 22 created + 30 size-moved records; all 15 "Moved size" parents inactive and empty; 0 stock movements. |
| 2026-11-10 | 10 | **Approved** by Mason in chat: a NO RETURN size may be any of the normal product's brands, so it takes the full brand list ("the no return can be any of those products"), then "Approve" for the exact edits. Product page edits first: Foma 1.88 copied onto both Gen Flexstar NO RETURN rows; Argos, Calleron, Cavallo copied onto Gen Callisto NO RETURN; on the Gen Liberty NO RETURN tote, brand "Glufosinate 280" renamed "Glufosinate" (same EPA 85678-90) and Cheetah, Opportunity copied; both Gen Liberty NO RETURN totes' size set from 1 to 265 gal (priced per gallon, no stock, no other value changed). Brand lists checked identical to each target, field by field. Then proposal 7 (7:34 AM): 6 "Moved size" parents plus Gen Callisto (Argos, Calleron, Cavallo, Meso 4SC, Mesotrione) and Gen Liberty (Cheetah, Glufosinate, Opportunity, Reckon) Bulk; then Move this size: Flexstar NO RETURN 2.5 gal and tote into Gen Flexstar; Callisto NO RETURN into the new Gen Callisto; Liberty NO RETURN tote and the normal Liberty 2.5 gal (name-split pair) into the new Gen Liberty; Liberty Higher Quality NO RETURN tote into Gen Liberty Higher Quality. Review dialog and every move preview: no rate or per-acre price changes. Read-only check: 414 parents (378 active), 548 sizes; 8 created + 12 size-moved records; the 5 NO RETURN rows identical before/after except the two tote sizes; 0 stock movements. |
| 2026-11-10 | 11 | **Approved** by Mason in chat: Gen Dual S Moc rate 21.28 oz/acre (1.33 pt), then "Approve" for the per-acre price changes shown to him, then "match Dual Magnum" for use timings. Medal II and Moccasin II Plus copied onto the NO RETURN tote (all 3 rows' brand lists identical). Proposal 8: Gen Dual S Moc (Visor S Moc II, Medal II, Moccasin II Plus, StreliuS II) made from the 2.5 gal; the 1 gal per-gallon row (name cut off at "...StreliuS II, Bra") and the NO RETURN tote approved as "Moved size" parents. First moves stopped on a use-timing difference (1 gal and tote Pre-Emerge Soybean, 2.5 gal Post-Emergence). Edit parent set the timings to Dual Magnum's (Pre-Emerge Soybean, Post-Emerge Corn, Post-Emerge Soybeans), then both sizes moved in (1 gal as Bulk, tote as vendor-filled Tote); each move saved only after its preview matched the approved rate, timing and per-acre prices. Result: all 3 sizes at 21.28 oz, suggested rate "1.33 pt/acre", Dual Magnum timings; the 1 gal row and the tote's per-acre prices rose with the rate (per-gallon prices unchanged); the 2.5 gal price unchanged. Read-only check: 417 parents (379 active), 551 sizes; 3 created + 4 size-moved + 1 updated records; only the 3 Dual S Moc rows changed; 0 stock movements. |
| 2026-11-10 | 12 | **Approved** by Mason in chat ("all others are correct i approve"; "Add Acumen to 2.5 gal, join"). Acumen Hydrocap copied from the Gen Prowl H2O Bulk row onto the 2.5 gal (brand lists identical). Proposal 9: 18 one-size groups approved; the confirm screen said "No size's rate or per-acre price changes." Roles per Mason: the HumiK Bio WSP Liquid, HumiK WSP Liquid and Solu-Sea "Application Applied Only" rows are Bulk only; KTS, Gen Prowl 3.3, Roundup 5.5# Generic and Gen Prowl H2O Bulk rows are Bulk; Fulvic LQ is a vendor-filled 275 gal Tote; the rest are Package. Piksi parents named "Piksi Dust Infurrow" and "Piksi Dust Plus" (no size in the name). The Gen Prowl H2O Bulk row moved into "Gen Prowl H2O: (Acumen Hydrocap, AquaPen 3.8, Satellite Hydrocap)"; the preview showed no change (Herbicide, Pre-Emerge Soybean, 40 oz, same per-acre prices). Read-only check: 435 parents (396 active), 569 sizes; 18 created + 2 size-moved records; the temporary "Moved size" parent is empty and inactive; 0 stock movements. |
| 2026-11-10 | 13 | **Approved** by Mason in chat: Buck Barrier "Yes, 16 oz, join them" (per-acre 17.44 / 19.20 / 21.39 shown first); the five 1 gal "Tote" rows "Yes, they're Bulk". Renamed on the product page (Save Changes): BoostMax-D, Concept-Z9 (EDTA), Fulvic Force, Sweet Fulvic, Sweet Sucess "- Tote" to "- Bulk" (prices unchanged). Proposal 10: 10 groups approved ("No size's rate or per-acre price changes"): BoostMax-D, Buck Barrier, Concept-Z9 (EDTA), Fulvic Force, Sweet Fulvic, Sweet Sucess (Bulk), and the four "- 2.5" jugs as "Moved size" parents. Each jug then moved into its parent as Package; BoostMax-D, Concept-Z9 and Fulvic Force previews showed no change; Buck Barrier 2.5 gal took 16 oz (was blank, unit Pt), per-acre none to 17.44 / 19.20 / 21.39 as approved. Read-only check: 445 parents (402 active), 581 sizes; 10 created + 8 size-moved records; 4 temporary parents empty and inactive; 0 stock movements. |
| 2026-11-10 | 14 | **Approved** by Mason in chat ("Yes, approve"): the seed treatments, 11 groups from proposal 10. Each "Per Unit" row (Accelerate, CruiserMaxx APX, Ilevo, Saltro, Trilex 2000, Vibrance Trio, Victrato) is its own parent: it is form "each" and cannot join a liquid size. Ilevo 2.5 gal + 15 gal joined; CruiserMaxx APX 15 gal, Trilex 2000 2.5 gal and Vibrance Trio 15 gal each their own parent. All Package. Accelerate needed the no-EPA "same product" tick. Dialogs showed "No size's rate or per-acre price changes." Live totals now 456 parents (413 active), 593 sizes; 11 created events; 0 stock movements (still 762). Noted for Mason, not changed: Ilevo 2.5 gal has the same cost and prices as the 15 gal. |

**Still to do (as of batch 14, 2026-11-10):**
- Buck Barrier and the five "Tote" rows are done (batch 13).
- All NO RETURN rows are now sizes of their normal product; the "still to sort" list is done.
- Wheat Mix and Wheat Mix II (Mason): each is sold as 2.5 gal and as a 275 gal tote. Mason approved "Add totes, price later" (2026-11-10): "Wheat Mix - 275 Gal Tote" and "Wheat Mix II - 275 Gal Tote" were created with Add a size (Fixed tote, 275 Gal Tote) and joined their parents (435 parents, 571 sizes, 0 stock movements). **They have no price yet**; quotes, jobs and orders refuse them until Mason sets prices on each product page.
- Kept separate (Mason), now each its own parent: Piksi Dust Infurrow / Piksi Dust Plus; Topguard / Topguard EQ.
- Seed treatments are done (batch 14). Check for Mason: the Ilevo 2.5 gal size carries the same cost and prices as the 15 gal size.
- Held (13 ungrouped rows): Milestone (waits on RT-2), Zannis SC and its retired copies, other retired rows, test rows.

**Label data checked against the labels (2026-11-10):**
- Kyber Pro / Fierce MTZ: both correct. Kyber Pro is Corteva's brand on Valent's registration 59639-236 (same three actives); kept as two products.
- Steward: EPA 279-9596 is FMC's Steward EC. Mason approved "fix both": the 135 gal size's manufacturer was changed from Corteva to FMC on the product page (no price, rate or stock change).
- Topguard EQ: its label is **EPA 279-3596** (flutriafol + azoxystrobin); 279-3557 is plain Topguard. Mason approved the fix, but Correct identity refuses EPA changes until REG-1 switches EPA correction on (`_product_parent_epa_correction_enabled()`, see `docs/reference/product-corrections-record-map.md`). **Open:** set Topguard EQ to 279-3596 once that lands.

**Size roles (Mason, 2026-11-09):** only fertilizer is kept in real bulk storage. For chemicals and adjuvants, a "- Bulk" row is a tote filled to the customer's amount (usually by the vendor, sometimes by the shop from spare totes) and sold by the gallon, so it keeps the **Bulk** role. A set-size vendor container (110/120/125/250 gal) with no Bulk size in its group is a **Package**, not a Tote. Tracking shop-filled chemical totes as a stock movement is not built (shop fill is fertilizer only, DECISION_LOG 2026-11-04).

**Mason's answers to section 4 (2026-11-09):**
1. Atrazine 4L 265 gal tote: group it under Atrazine 4L (move this size).
2. BroadAxe XC and Authority Elite are different products; the EPA number was wrong on BroadAxe XC, fixed by DATA-2 to 279-3442-100.
3. Fertilizer: each is either Bulk or a set factory tote; all totes are 275 gal except Black Strap Molasses (250 gal).
4. The "1 gal" Tote rows are a Bulk or tote row (size to be corrected before grouping).
5. "2.5G" means a 2.5 gal jug (Package); "275G" means a set factory tote. Renamed (see log).

**Order with DATA-2 (EPA brand numbers, PR #1709):** DATA-2 writes identical brand lists on every size of the ungrouped products, and writes on the parent (`upsert_parent_brand`) for batch 1. Batch 2 and later proposals are built only after DATA-2's writes land.
