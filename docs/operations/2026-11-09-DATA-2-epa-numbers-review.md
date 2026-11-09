# DATA-2: missing EPA numbers — Mason's review list (2026-11-09)

Grand plan section 7, DATA-2. Drafted by an agent from EPA's public registration database; nothing is written to the live app until Mason approves.

## The short version

- **137 active products** in pesticide-type categories (Herbicide, Fungicide, Insecticide, Seed Treatment, Nitrogen Stabilizer, Biological, Other) have no EPA number. **2 are test rows**, **31 are not registered pesticides** (no number exists), and **104 are generic-type rows**: "Generic X (Brand A, Brand B …)", plus 2,4-D and Accelerate rows that name no brand.
- A generic row stands for several brands, and **each brand has its own EPA number**. Mason's 2026-10-22 decision (DECISION_LOG "Generic products … the delivered brand is picked at loading") puts those numbers on the product's **brand list**, not on the generic. So this draft fills **brand lists**; the generic row itself stays blank on purpose.
- **Draft result:** 94 brand numbers found with high confidence (list A), 14 likely (list B: check the jug), and 31 rows of brands that need Mason (list C: several companies sell that name, or it is a plain chemical name like "Glufosinate").
- **Compliance gap found (fix first):** 15 generic rows are marked **not restricted-use**, but every brand on them that EPA lists is **restricted-use** (paraquat, lambda-cyhalothrin, bifenthrin, chlorpyrifos, permethrin). Sales of these rows create no restricted-use sales record today. See "Fix first".

**Confidence:** **A** = one EPA product matches the name, the active ingredient matches the generic, and it is active. **B** = matches, but a near-twin exists (another strength, or a distributor copy); check the number on the jug. **C** = needs Mason: pick the company you actually buy from.

Every number was checked against EPA's record (`ordspub.epa.gov` product search, then the registration record). The check caught three name-only traps: an "Incinerate" that is a 2,4-D product, an "Inflame" that is an insecticide, and a "Promote" that is a plant-growth product. None of those is in the draft.

## Fix first (Mason decides)

1. **Restricted-use flag is off on these generic rows (every listed brand is restricted-use per EPA):** Gen Paraquat (Bulk, Full Tote); Gen Warrior 1LB (2 rows); Gen Warrior 2LB (2 rows); Gen Capture (2.5G, Bulk); Gen Capture LFR (2.5 Gal, Bulk); Gen Capture LFR 1.75#; Gen Lorsban (2.5 Gal, Bulk); Gen Permethrin; Gen Mustang Maxx (Datsun and Cortes MAXX are both restricted-use on their labels). (Gen Baythroid XL and Gen Leverage 360 are already flagged.) Recommended: turn the flag on for these 15 rows. This is DATA-7 work and a live data change, so it needs your `approve <code>`.
2. **Two test rows are active on live:** "[UI-TEST] Acuron GT" and "1A TEST PRODUCT - FAKE PRODUCT" (both have orders and invoice lines). Not touched here; DATA-1 owns test rows.
3. **Two brand-name rows have the restricted-use flag off but are restricted-use on their EPA labels:** Leverage 360 - 1 Gal (264-1104) and Mustang Maxx - 1 Gal (279-3426). They already have numbers, so they are outside DATA-2's blank list; add them to the same restricted-use fix.
4. **LI 700 is filed as Herbicide**; it is an adjuvant (no EPA number). Category fix, not an EPA number.

## A. Ready to approve (high confidence)

Grouped by the generic row, busiest first. RUP = restricted-use, read from the front panel of the latest EPA-accepted label for every row (EPA's database flag said "No" for Cryptonyx 360 and Cortes MAXX, but both labels say restricted-use; the label wins). Each brand goes on every size of that generic (2.5 Gal, Bulk, No Return, Tote) that lists it.

| Generic row | Brand | EPA No. | RUP |
|---|---|---|---|
| Gen Liberty | Opportunity | 83529-82 | No |
| Gen Liberty (incl. Full Tote) | Reckon | 88685-2-84237 | No |
| Roundup 5.4# (Bucc 5 Extra) | Buccaneer 5 Extra | 55467-15 | No |
| Gen Select 2LB | Ceridian 2EC | 91234-154 | No |
| Gen Callisto | Calleron | 93365-2-84237 | No |
| Gen Callisto | Cavallo | 91234-75 | No |
| Gen Callisto High Quality | Explorer | 100-1131 | No |
| Gen Callisto High Quality | Incinerate (the mesotrione one) | 100-1131-1381 | No |
| Generic Stinger | Bite | 83529-74 | No |
| Generic Stinger | CleanSlate | 228-491 | No |
| Generic Stinger | Spur | 42750-89 | No |
| Generic Stinger | Stigmata | 91234-60 | No |
| Gen Baythroid XL | Cryptoid XL | 91234-295 | **Yes** |
| Gen Valor EZ | Zaltus SC | 91234-203 | No |
| Gen Paraquat | Para-Shot 3.0 ("Parashot 3.0") | 83529-27 | **Yes** |
| Gen Paraquat | Helmquat 3SL | 74530-48 | **Yes** |
| Gen Leverage 360 | Cryptonyx 360 | 91234-292 | **Yes** |
| Gen Sencor Liquid 4# | Me-Try-Buzin 4L | 19713-706 | No |
| Gen Sencor Liquid 4# | Metricor 4F | 70506-68 | No |
| Gen Sencor Liquid 4# | Rancor 4F | 91234-73 | No |
| Gen Dual S Moc | Moccasin II Plus | 70506-333 | No |
| Gen Dual S Moc (incl. Full Tote) | StreliuS II | 91234-50 | No |
| Gen Warrior 1LB | Labamba | 83529-138 | **Yes** |
| Gen Warrior 1LB | Serpent (1 EC) | 91234-55 | **Yes** |
| Gen Warrior 2LB | Kendo 22.8 CS | 74530-54 | **Yes** |
| Gen Warrior 2LB | Serpent VenomCap | 91234-249 | **Yes** |
| Gen Warrior 2LB | Province II | 100-1295-55467 | **Yes** |
| Gen Quilt Xcel | Cover XL | 42750-289 | No |
| Gen Quilt Xcel | Propaz | 83529-49 | No |
| Gen Valor SX | Zaltus SX | 91234-180 | No |
| Gen Valor SX | Varsity | 89167-45-89391 | No |
| Gen Valor SX | Panther | 71368-102 | No |
| Gen Sencor (dry) | Metriclude | 1381-197 | No |
| Gen Sencor (dry) | Tricor DF | 70506-103 | No |
| Gen Authority | Aquesta 4F | 91234-32 | No |
| Gen Authority | Blanket 4F | 82534-5-55467 | No |
| Gen Banvel | Disha DMA | 83529-110 | No |
| Gen Capture | Batallion | 91234-104 | **Yes** |
| Gen Capture | Bifen 2 Ag Gold | 83222-1 | **Yes** |
| Gen Capture LFR | Batallion LFC | 91234-177 | **Yes** |
| Gen Capture LFR | Seguro | 83529-79 | **Yes** |
| Gen Capture LFR 1.75# | Bifender FC | 89118-2 | **Yes** |
| Roundup 5.5# Generic | Honcho K6 | 105211-92 | No |
| Roundup 5.5# Generic | Mad Dog K6 | 34704-1111 | No |
| Roundup 5.5# Generic | Envy K-Six | 89167-58-89391 | No |
| Gen Liberty Higher Quality | Interline | 70506-310 | No |
| Gen Liberty Higher Quality | Inflame (the 280 SL glufosinate) | 91234-82 | No |
| Gen Assure II | Quiz | 74530-79 | No |
| Gen Authority Assist | Sulfen IMAZ | 87290-67 | No |
| Gen Authority Assist | Zone Assist | 74530-80 | No |
| Gen Authority First | Aquesta FR | 91234-41 | No |
| Gen Authority MTZ | Aquesta MTZ | 91234-49 | No |
| Gen Blazer | Derecho | 91234-108 | No |
| Gen Blazer | Player | 83529-90 | No |
| Gen Boundary | Ledger | 100-1162-55467 | No |
| Gen Boundary | MetalliS MTZ | 91234-185 | No |
| Gen Cobra | Mamba | 91234-169 | No |
| Gen Dual R Moc | Me-Too-Lachlor II | 19713-549 | No |
| Gen Dual R Moc | Metalica | 83529-57 | No |
| Gen Dual R Moc | Stalwart C | 60063-22 | No |
| Gen Extreme | Praxis Plus | 83529-47 | No |
| Gen First Rate | Ankur | 83529-98 | No |
| Gen First Rate | Cloran DF | 87290-87 | No |
| Gen Flexstar | Foma 1.88 | 19713-659 | No |
| Gen Flexstar | Forsyte 1.88 | 91234-165 | No |
| Gen Flexstar | Tigris Fomesafen | 92647-18 | No |
| Gen Gaucho 4# Foliar | Midash Forte | 83529-6 | No |
| Gen Gaucho 5# ST | Senator 600 | 228-522 | No |
| Gen Gaucho 5# ST | Sharda Imida 5SC | 83529-14 | No |
| Gen Lorsban | Pilot 4E | 93182-7 | **Yes** |
| Gen Lorsban | Warhawk | 34704-857 | **Yes** |
| Gen Mustang Maxx | Cortes MAXX | 91234-259 | **Yes** |
| Gen Mustang Maxx | Datsun | 83529-234 | **Yes** |
| Gen Permit | Promote (the halosulfuron one) | 91234-31 | No |
| Gen Proline 480 SC | Provixo 480 SC ("Prvixo") | 91234-345 | No |
| Gen Prosaro 421 | Prozare SC | 91234-346 | No |
| Gen Prosaro 421 | Ellora | 83529-156 | No |
| Gen Prowl 3.3 | Stealth | 34704-868 | No |
| Gen Prowl H2O | AquaPen 3.8 | 19713-698 | No |
| Gen Prowl H2O | Satellite Hydrocap | 70506-230 | No |
| Gen Pursuit | Praxis | 83529-50 | No |
| Gen Pursuit | Pemex | 91234-168 | No |
| Gen Quadris | Gold Rush | 89168-41-91395 | No |
| Gen Raptor | Octivio | 91234-88 | No |
| Gen Resicore | Orador | 91234-324 | No |
| Gen Steward EC | Sedaire EC | 91234-320 | No |
| Gen Stratego YLD | Straza YLD | 91234-351 | No |
| Gen Surestart/Tripleflex | TrueSet II | 91234-220 | No |
| Gen Tebuconazole | Felcura 3.6F | 91234-134 | No |
| Gen Tilt | Fitness | 34704-1031 | No |
| Gen Treflan | Trust | 1381-261 | No |
| Gen Valor XLT | Flu-Rimuron | 85678-48 | No |
| Mec-Amine-D/Hammerdown | Mec Amine-D | 34704-239 | No |
| Mec-Amine-D/Hammerdown | Hammerdown | 89442-22 | No |
| Gen Basagran | Bashazon | 83529-32 | No |

## B. Likely (check the number printed on the jug)

| Generic row | Brand | Draft EPA No. | RUP | Why not A |
|---|---|---|---|---|
| Roundup 5.4# Generic | Ag Saver 5.4 | 83772-15 | No | EPA name is "AgSaver Glyphosate 5.4 Plus" |
| Gen Accent Q | Primero | 83100-8 | No | a distributor copy 83100-8-83979 also exists |
| Gen Authority MTZ | Sulfen MTZ | 92647-9 | No | only Tigris sells that name; confirm supplier |
| Gen Buctril | Brox | 42750-48 | No | "Brox 2EC"; Brox-M is a different product |
| Gen Buctril | Maestro | 71368-29 | No | "Maestro 2EC"; other Maestros exist |
| Gen Capture | Tundra | 1381-196 | **Yes** | "Tundra EC"; a Tundra LFC also exists |
| Gen Dual S Moc | Medal II | 100-818 | No | "Medal II EC"; Medal II EC AT is 100-817 |
| Gen First Rate | FrontRunner | 91234-84 | No | FrontRunner 4 SC (91234-271) is a liquid twin |
| Gen Headline SC | Hurricane | 83529-284 | No | Hurricane is an EC, Headline SC is an SC |
| Gen Liberty | Cheetah | 71368-112 | No | Cheetah Max and Cheetah Pro are different |
| Gen Permethrin | Permastar AG | 71532-15 | **Yes** | distributor copies -73006 and -91026 exist |
| Gen Sencor (dry) | Metrixx | 83529-81 | No | Metrixx 75DF; plain Metrixx (83529-44) is 70% |
| Gen Treflan | Triflurex | 66222-46 | No | "Triflurex HFP" |
| Gen Valor EZ | Flumioxazin 44SC | 85678-53 | No | GCS copy 85678-53-94730 also exists |
| Gen Warrior 1LB | Ravage | 89168-16-89391 | **Yes** | the 1-lb Ravage; "Ravage 2.0" is a 2-lb product |

## C. Needs Mason (tell me the company or read the jug)

| Generic row | Brand on the row | What EPA shows |
|---|---|---|
| Gen Liberty | Glufosinate; Glufosinate 280 (Full Tote) | about 28 companies sell "Glufosinate 280" |
| Roundup 5.4# Generic | Slam 5.4 | Slam 54 Extra 80967-5-93033 (MEY) or Slam 5 Extra 103636-1 (Apex) |
| Gen Select 2LB | Clethodim 2EC; Volunteer | Volunteer has 5 registrations, all distributor copies |
| Gen Callisto | Argos; Meso 4SC; Mesotrione | Meso 4SC: Albaugh 89442-33, Andersons 89442-33-9198, Crop Protect Direct 101458-3 |
| Gen Authority First | Sulfen First | Farmers First 94730-30-92115 or Tigris 92647-8 |
| Gen Authority | Sulfentrazone 4SC | 4 companies |
| Gen Banvel | Dicamba DMA | many companies |
| Gen Basagran | Bentazon | many companies |
| Gen Blazer | Acifluorifen | many companies |
| Gen Boundary | Presidual | 1381-272 (WinField) or 100-1162-1381 |
| Gen Capture | Bifenthrin 2E | many companies |
| Gen Cobra | Boa | not found at EPA by that name |
| Gen Dual S Moc | Visor S Moc II; the brand cut off at "Bra…" | Visor: Atticus copy 91234-50-89391 or Axion 89167-42-89391 |
| Gen Force 3G | Fence 3G | not found at EPA by that name |
| Gen Gaucho 4# Foliar | Imidacloprid 4F | 6 companies |
| Gen Harmony SG | Harass | not found at EPA by that name |
| Gen Lorsban | Chlorpyrifos 4E | many companies |
| Gen Paraquat | Paraquat 3SL | many companies |
| Gen Permethrin | Permethrin 3.2 | many companies |
| Gen Prowl 3.3 | Acumen; Pin-Dee 3.3 | Acumen: UPL 70506-318-55467 or Drexel 19713-668-55467; Pin-Dee: 19713-590 or 19713-668 |
| Gen Prowl H2O (Bulk) | Acumen Microcap | closest is "Acumen Hydrocap" 70506-230-55467 |
| Gen Pursuit | Imazethapyr | many companies |
| Gen Quadris | Azoxy 2SC; Acadia 2SC | Acadia: Atticus 91234-74 or Tigris 92647-2 |
| Gen Quilt Xcel | Aquila XL; Azoxyprop Xtra | Aquila: Tigris 92647-1 or Atticus 91234-76; "Xtra" not found |
| Gen Sencor (dry) | Metribuzin; Rancor 4F | Rancor 4F is a liquid listed on a dry row; Rancor 75 DF is 91234-57 |
| Gen Tebuconazole | Tebucon 3.6F; Teb 3.6SC | 5 and 3 companies |
| Gen Tilt | PPZ 41.8; Slant; Sharshild PPZ | Slant 91234-25 or Slant EC 91234-221; Sharshild not found |
| Gen Treflan | Trifluralin | many companies |
| Gen Valor SX | Flumioxazin 51% | many companies |
| Gen Warrior 1LB | Lambda Cy | many companies |
| 2,4-D Amine 4# (2 rows), 2,4-D Ester 6# (3 rows) | no brand named | which brand do you buy? |
| Accelerate Seed Treatment | no maker named | two EPA products carry "Accelerate" |

## D. No EPA number (not a registered pesticide; leave blank)

EPA's database has no registration under these names. They are biologicals, biostimulants, nutrients or nitrogen additives sold without a pesticide registration. Mason: say if any of them carries an "EPA Reg. No." on its label.

Start Right 2.0 (2 rows), BoostMax-D (2), BoostMax-M (2), Residue RX (2), Bio-Reverse, Bio-Health (2, filed as Fungicide), Buck Barrier (2), BW-NLockDown (2), More Than Manure, NanoCote Core, Nutrisphere-N for UAN (2), NanoSeed, Powder Keg Corn and Soybeans (EPA's "Powder Keg" is an unrelated fire-ant dust), GroPack A.I., HumiK (6 rows), Water W/ D-Chlorinator, LI 700 (adjuvant).

## How approved numbers go in

- **Path:** the app's own brand list on each product page (Products → the generic → Brands → Add brand), which saves through `upsert_product_brand`. Each brand row gets name, EPA number, maker, restricted-use and signal word from EPA, and "currently sourced" on.
- **REG-1 (PR #1688) does not move where numbers live.** Its one-time seed reads `products`, `product_brands` and `product_parent_brands` numbers. Brand rows added before the seed are picked up by it; added after, the brand screen will ask for the label facts. Do not add brands while the seed is being previewed and run (its fingerprint would change and it would refuse).
- **Live write needs Mason's `approve <code>` typed in the DATA-2 session.** Then verify read-only that each brand row exists with the right number.

## Status (update as work moves)

| Item | State |
|---|---|
| Recount (2026-11-09) | done: 137 rows (104 generic-type, 31 not registered, 2 test) |
| Draft A / B / C / D | done (this doc) |
| Mason's review | waiting |
| Restricted-use flags on 15 generic rows | waiting on Mason |
| Approved brand rows written to live | not started |
| Read-only verification on live | not started |
| C items answered by Mason | not started |

Also noticed, not DATA-2: some numbers already on products may have moved at EPA (for example 524-475 Roundup Ultra now points to 105211-77). A re-check of existing numbers is a separate task.
