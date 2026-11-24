# Container unit fill (Product Master setup): tracking

**Status, 2026-11-24 (Central): APPLIED. Mason approved in chat ("yes run the fill for the 572"); 572 rows filled live at 11:40:48 AM Central (17:40:48 UTC). The 11 held rows were settled with Mason and written at 11:44:11 AM (section 4); only the [UI-TEST] row stays blank. Incomplete setup now 344.**

## 0. Before and after (live, read-only re-count)

| | Before (2026-11-24 AM) | After (2026-11-24 11:41 AM) |
|---|---|---|
| Active products with blank container unit | 584 | **12** (exactly the section 4 list) |
| Container unit different from stock unit | 0 | 0 |
| `product_change_history` rows for `container_unit` | 0 | 572, all at 17:40:48.842573 UTC, all blank -> stock unit, fingerprint of their `id|inventory_unit` = `890a42c3ff99b1140e5d1d3ca7577035` (the approved set) |
| Products page "Incomplete setup" filter (croprxsolutions.app) | 590 | **348** (matches a SQL re-count of `missingProductSetup`) |

The rest of the 348 are missing other fields (mostly EPA number, signal word, REI/PHI on pesticides), handled in other work. Who wrote it: the parent agent session ran the section 5 block (count and fingerprint check included). A second guarded run from the side session 3 seconds later found 0 rows left and stopped (`CONTAINER_UNIT_FILL_DRIFT: 0 rows`), so the fill happened exactly once. History shows no signed-in user, as expected for a raw SQL write.

What this is: 584 active products have a blank **container unit**, the most common reason the Products page shows "Incomplete setup". Mason asked (2026-11-24) to fill it with the product's own stock unit (`container_unit := inventory_unit`, same spelling). Nothing else changes: not the container size, type, stock unit, prices, stock or any order.

## 1. Live facts (read-only, 2026-11-24)

| Fact | Live value |
|---|---|
| Active products / blank container unit | 597 / 584 (all NULL, none empty text) |
| Rows to fill | **572** (476 Gal, 61 Lb, 16 Dry oz, 11 oz, 8 qt) |
| Fingerprint of the 572 (`md5` of `id|inventory_unit` sorted by id) | `890a42c3ff99b1140e5d1d3ca7577035` |
| Approved or draft net weights on these rows | 0 (so the net-weight trigger re-drafts nothing; it only bumps each row's pack counter) |
| Saved loader-worksheet weights on these rows | 0 |
| Rows with no package label (picker would start showing "size unit") | 0: every row already has `unit_size`, which pickers show first |

## 2. What else a filled unit touches (checked in code)

- `guard_product_setup_fields` (20261102102000) **locks a set container unit**: once filled it cannot be changed or cleared on a saved product. Undo therefore needs a reviewed migration (see section 5).
- `validate_product_units`: the unit must be valid for the product form; every stock unit already passes the same check, so the copy passes.
- `return_net_weight_to_draft` (20261207100000): bumps the pack counter; no weights exist to re-draft.
- `write_product_change_history`: one history row per product (`container_unit: blank -> unit`). A raw SQL write records no signed-in user.
- Tote fill (20261117130000) reads a tote's container unit, but only for totes stocked as Ea/Unit; none of the 572 are.
- **Nothing rounds a sale, quote or delivery to the container size**, so filling "Gal" on a 275 Gal tote does not make it whole-tote only. Whole-tote selling stays controlled only by `is_full_tote_only` (unchanged).
- Container unit is a size-level field (`SIZE_INSERT_KEYS`), not parent-owned; `guard_product_parent_values` does not read it.

## 3. Rehearsal (2026-11-24)

The staging database has 0 fillable rows (fake data), so the exact UPDATE was run on live inside a block that always rolls back. Result: `updated=572 history_rows=572 still_blank=12 unit_differs=0`, every guard accepted it, and a re-count afterwards showed 584 still blank (nothing kept).

## 4. Left out (12 rows, for Mason)

| Product | Why |
|---|---|
| Citric Acid 50% - 330G Tote | Name says 330 gal, container size is 265 |
| [UI-TEST] Acuron GT | A test row on live; not touched |
| Absolute Maxx - 270 | No container size (name says 270, unit unknown) |
| Water W/ D-Chlorinator | No container size |
| Tempo SC Ultra - 8 oz | No container size; stocked as Ea though named 8 oz |
| Accelerate Seed Treatment, CruiserMaxx APX, Ilevo Seed Treatment, Saltro, Trilex 2000, Vibrance Trio, Victrato (all "Per Unit") | No container size, so they stay "Incomplete setup" anyway; unit is not locked before the size is known |

**Settled 2026-11-24 (Mason: "citric is 330g container size but we sell it by the gallon"; "all rest are correct").** All 11 written live at 11:44:11 AM Central by another agent session, verified read-only: Citric Acid 50% - 330G Tote container size 265 -> 330, unit Gal (stock unit Gal and full-tote-only off are unchanged, so it still sells by the gallon); Absolute Maxx - 270: 270 Gal; Water W/ D-Chlorinator: 1 Gal; Tempo SC Ultra - 8 oz: 1 Ea; the 7 "Per Unit" seed treatments: 1 Unit. [UI-TEST] Acuron GT left as is. Re-count after: 1 active product with a blank container unit (the test row), 0 units that differ from the stock unit, "Incomplete setup" 344.

Also worth a look later (filled, because the unit is right): "Autumn Super 51 WDG" has container size 1 Dry oz; both "Gen Callisto ... - 1 or 2.5" rows are named for two sizes but set to 2.5 Gal.

## 5. The write and the undo

Write (one statement, refuses unless the set is exactly the approved one):

```sql
DO $fill$
DECLARE n int; fp text;
BEGIN
  SELECT count(*), md5(string_agg(id::text || '|' || inventory_unit, ',' ORDER BY id)) INTO n, fp
    FROM public.products
   WHERE is_active AND container_unit IS NULL AND NULLIF(btrim(inventory_unit), '') IS NOT NULL
     AND container_size > 0 AND product_name NOT LIKE '[UI-TEST]%' AND product_name <> 'Citric Acid 50% - 330G Tote';
  IF n <> 572 OR fp <> '890a42c3ff99b1140e5d1d3ca7577035' THEN
    RAISE EXCEPTION 'CONTAINER_UNIT_FILL_DRIFT: % rows, fingerprint %', n, fp;
  END IF;
  UPDATE public.products SET container_unit = inventory_unit
   WHERE is_active AND container_unit IS NULL AND NULLIF(btrim(inventory_unit), '') IS NOT NULL
     AND container_size > 0 AND product_name NOT LIKE '[UI-TEST]%' AND product_name <> 'Citric Acid 50% - 330G Tote';
END $fill$;
```

Undo: the setup guard refuses clearing a set unit, so undo is a reviewed migration that sets `container_unit = NULL` for exactly the products whose `product_change_history` shows `container_unit` blank -> value at this write's timestamp, run through the normal migration gates. Fixing a single wrong unit later goes the same way.

## 6. Tote and bulk rows in the fill (unit is the stock unit; only `is_full_tote_only` decides whole-tote selling)

### Full-tote-only (already flagged; unchanged)

| Product | Size | Unit | Full tote only |
|---|---|---|---|
| 2, 4D Ester 6# - NO RETURN, FULL TOTE - 265 Gal | 265 | Gal | yes |
| Atrazine 4L - NO RETURN, FULL TOTE - 265 Gal | 265 | Gal | yes |
| Gen Banvel: NO RETURN, FULL TOTE (Dicamba DMA, Disha DMA) - 265 Gal | 265 | Gal | yes |
| Gen Dual S Moc: NO RETURN, Full Tote (StreliuS II, Visor S Moc II) - 265 Gal | 265 | Gal | yes |
| Gen Flexstar: No Return, Full Tote (Forsyte 1.88, Tigris Fomesafen) - 265 Gal | 265 | Gal | yes |
| Gen Liberty: Higher Quality (NO RETURN, FULL TOTE)(Interline, Inflame) - 265 Gal | 265 | Gal | yes |
| Gen Liberty: NO RETURN, FULL TOTE (Glufosinate 280, Reckon) - 265 Gal | 265 | Gal | yes |
| Gen Paraquat: NO RETURN, FULL TOTE (Parashot 3.0, Helmquat 3SL, Paraquat 3SL) - 265 Gal | 265 | Gal | yes |
| Gen Quilt Xcel: NO RETURN, FULL TOTE (Aquila XL, Azoxyprop Xtra, Cover XL, Propaz) - 265 Gal | 265 | Gal | yes |
| Roundup 5.4# Generic NO RETURN, Full Tote (Ag Saver 5.4, Slam 5.4) - 265 Gal | 265 | Gal | yes |

### Totes, drums and big packs (not full-tote-only; still sold by the Gal / Lb)

| Product | Size | Unit | Full tote only |
|---|---|---|---|
| HumiK Bio Plus WSP - 2200 Lb Super Sack | 2200 | Lb | no |
| HumiK Bio WSP - 2200 Lb Super Sack | 2200 | Lb | no |
| HumiK One - 2,200LB Super Sack | 2200 | Lb | no |
| HumiK SSG - 2,200lb Super Sack | 2200 | Lb | no |
| HumiK Tech Grade - 2,200lb Super Sack | 2200 | Lb | no |
| HumiK WSP - 2,200lb | 2200 | Lb | no |
| HumiK Zn -2,200lb Super Sack | 2200 | Lb | no |
| Ammonium Sulfate - 51# Bag NO RETURN (Full pallets) - 2,040lb | 2040 | Lb | no |
| Impressive DB - 1000# | 1000 | Lb | no |
| Aero-Mino - 275 Gal Tote | 275 | Gal | no |
| Aero-N - 275 Gal Tote | 275 | Gal | no |
| Agro Mix - Tote | 275 | Gal | no |
| Boron 10%  - Tote | 275 | Gal | no |
| Boron 10% - 275 Gal Tote | 275 | Gal | no |
| Copper 5% Citric Chelated - 275 Gal Tote | 275 | Gal | no |
| Copper 7.5% - Tote | 275 | Gal | no |
| Copper-Count-N | 275 | Gal | no |
| Corn Mix II - Tote | 275 | Gal | no |
| Diamond 3-18-18 (100%) - Tote | 275 | Gal | no |
| Diamond 9-18-9 (100%) - Tote | 275 | Gal | no |
| Diamond First Pass Soybean (100%) - Tote | 275 | Gal | no |
| Eezy K24 - Tote | 275 | Gal | no |
| Eezy KB  - Tote | 275 | Gal | no |
| Eezy Man Gen II - 275 Gal Tote | 275 | Gal | no |
| Eezy Moly-B - Tote | 275 | Gal | no |
| Ful-Grow Gold 2X - 275 Gal Tote | 275 | Gal | no |
| Ful-Grow Max (Neutral PH 6% Fulvic) - 275 Gal Tote | 275 | Gal | no |
| Fulvic LQ | 275 | Gal | no |
| HumiK LX 12% - 275 Gal Tote | 275 | Gal | no |
| Manganese 6% - Tote | 275 | Gal | no |
| MicroNourish Fe - Tote | 275 | Gal | no |
| Nulex Zinc 15% - Tote | 275 | Gal | no |
| Premium 8-29-2 (50/50) - Tote | 275 | Gal | no |
| Super 25B - 275 Gal Tote | 275 | Gal | no |
| Sweet 'N Eezy - Tote | 275 | Gal | no |
| UltraMate B - Tote | 275 | Gal | no |
| Ultramate LQ - Tote | 275 | Gal | no |
| Ultramate ZN - Tote | 275 | Gal | no |
| Zinc 10% Citric Chelated - 275 Gal Tote | 275 | Gal | no |
| Zinc 9% - Tote | 275 | Gal | no |
| ZincMan - Tote | 275 | Gal | no |
| Stratego YLD - 270 Gal | 270 | Gal | no |
| Advance K24 - 265 Gal Tote | 265 | Gal | no |
| Kyber Pro - 265 Gal | 265 | Gal | no |
| Adastrio - 250 Gal | 250 | Gal | no |
| Black Strap Molasses Sugar - Tote | 250 | Gal | no |
| Brigade - 250 Gal | 250 | Gal | no |
| Corvus - 250 Gal | 250 | Gal | no |
| DiFlexx - 250 Gal | 250 | Gal | no |
| Duracor - 250 Gal | 250 | Gal | no |
| Enversa - 250 Gal | 250 | Gal | no |
| Everprex - 250 Gal | 250 | Gal | no |
| Forcivo - 250 Gal | 250 | Gal | no |
| Grazon Next HL - 250 Gal | 250 | Gal | no |
| Impact Core - 250 Gal | 250 | Gal | no |
| ImpactZ - 250 Gal | 250 | Gal | no |
| Prowl H2O - 250 Gal | 250 | Gal | no |
| Sinate - 250 Gal | 250 | Gal | no |
| Start Right 2.0 (AgBio) - Tote | 250 | Gal | no |
| Trivolt - 250 Gal | 250 | Gal | no |
| Vigor 802 - 250 Gal Tote | 250 | Gal | no |
| WideARmatch - 250 Gal | 250 | Gal | no |
| Steward - 135 Gal | 135 | Gal | no |
| Anthem Maxx - 125 Gal | 125 | Gal | no |
| Authority Edge - 120 Gal | 120 | Gal | no |
| Authority Supreme - 120 Gal | 120 | Gal | no |
| Ethos Elite LFR - 120 Gal | 120 | Gal | no |
| Ridgeback - 120 Gal | 120 | Gal | no |
| Xyway LFR - 120 Gal | 120 | Gal | no |
| Aproach - 110 Gal | 110 | Gal | no |
| Aproach Prima - 110 Gal | 110 | Gal | no |
| Bio-Health - Tote | 1 | Gal | no |
| Carbon RX - Tote | 1 | Gal | no |
| Concept N-25B (SRN) - Tote | 1 | Gal | no |
| Concept-B-10 - Tote | 1 | Gal | no |
| Foliar-K (0-0-24) - Tote | 1 | Gal | no |
| Residue RX - Tote | 1 | Gal | no |

### Bulk, sold per gallon (container size 1 Gal): 139 rows

2, 4D Amine 4#; 2, 4D Ester 6#; Acuron; Acuron GT; Advance K24; Agro Mix; Armezon Pro; Atrazine 4L; Authority Elite; Bicep Lite II Magnum; Black Strap Molasses Sugar; BoostMax-D; BoostMax-M; Boron 10%; Boundary 6.5 EC; BroadAxe XC; Buck Barrier; Bullseye + DRA; BW-NLockDown; Calibra; Callisto Xtra Enhanced; Carbon RX; COC 17%; COC XL; Complete; Concept N-25B (SRN); Concept-B-10; Concept-Z9 (EDTA); Degree Xtra; Delaro 325 SC; Delaro Complete; Diamond 3-18-18; Diamond 6-24-6; Diamond 9-18-9; Diamond First Pass Soybean; Diamond Season Pass Plus +MicroCarb + Powerpass; Diamond Season Pass Plus w/ Microcarb; Dual II Magnum; Dual Magnum; Eezy K; Eezy K24; Eezy KB; Enlist Duo; Enlist One; Enversa; Fearless; Fierce MTZ; Flexstar GT; Foliar-K (0-0-24); Fulvic Force; Gen Banvel; Gen Boundary; Gen Capture LFR; Gen Capture; Gen Dual R Moc; Gen Extreme; Gen Flexstar; Gen Liberty; Gen Liberty Higher Quality; Gen Lorsban; Gen Paraquat; Gen Prowl 3.3; Gen Quilt Xcel; Gen Resicore; Gen Select 2LB; Gen Sencor Liquid 4#; Gen Surestart/Tripleflex; Gen Treflan; Goldstart 6-24-6; Goldstart 7-22-5-2; Goldstart 9-18-9; Goldstart Season Pass Plus w/ Microcarb; Goldstart 3-18-18; Halex GT; Harness; Harness Max; Harness Xtra; Harness Xtra 5.6; Headline AMP; Infiltrator; Instinct NXTGEN; Keystone LA NXT; Kyro; Lexar EZ; Liberty Ultra; Liquid AMS 34%; Lumax EZ; Maverick; Miravis Neo; MSO 84; MSO XL; N Class 34%; N-Serve; NanoCote Core; NIS 90; Nulex Zinc 15%; Nutrisphere-N for UAN; Outlook; OverPass KOR 10-2-10; OverPass KOR 22-0-2; Powermax 3; Prefix; Premium 6-24-6; Premium 7-29-5; Premium 8-29-2; Premium 9-24-3; Prowl H2O; Resicore REV; Roundup 5.4# (Bucc 5 Extra); Roundup 5.4# Generic; Roundup 5.5# Generic; Sequence; Staunch II; Storen; SulfurPro Si; Super 25B; SureStart II; Surpass NXT; Surtain; Sweet Fulvic; Sweet Sucess; Take Off LS 0-0-5; Tendovo; TripleFLEX II; Trivapro; UltraMate B; Ultramate LQ; Ultramate ZN; VaporDrift DRA+VRA; Veltyma; Verdict; Volley ATZ Lite NXT; Volley ATZ NXT; Volley NXT; VRA; Warrant; Warrant Ultra; Wind Drift; Zoom (each "- Bulk", all 1 Gal, none full-tote-only).
