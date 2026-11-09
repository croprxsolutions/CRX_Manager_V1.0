# Product Master Stage 4: RT-2 build sheet (unit spellings)

**Status (2026-11-09):** this is a plan only. No code and no migration have been written. It was written against `main` (`44ff56ec0`) and the live database, using read-only SQL only (latest live migration `20261222100000_document_restore_and_photo_uploader`, applied live on 2026-11-09 per `supabase_migrations.schema_migrations`; this repo's migration stamps run ahead of the calendar by convention, so a stamp orders files and is not an apply date). For building, this sheet replaces the RT-2 outline in `docs/plans/2026-10-29-product-GRAND-PLAN.md` Stage 4. Where the two differ, this sheet wins, and section 2 lists each difference. A reference like "overlap 3" points to the grand plan's section 4.

**What RT-2 is.** The same unit is spelled two ways in `unit_conversions` (`oz`/`Oz`, `qt`/`Qt`, `Lb`/`LB`). RT-2 picks one spelling for each, moves every product to it, and then deletes the other row. It is August To-Do items 2.7, 2.7a, 2.7b and 2.8 (PRD `2026-08-18-product-data-model-PRD.md` lines 354-357; master record A-4, B-12, C-26, T-13).

**Why it is careful.** `unit_conversions` turns every rate and stock unit into ounces, and quotes, jobs and per-acre prices are priced from it. Two things can go wrong:
- **Product editing breaks.** The live trigger `validate_product_units` matches a product's stock and container units against `unit_conversions.unit` **exactly, capitals included**. Delete a spelling a product still uses, and every later save of that product fails.
- **A price moves.** If a deleted spelling were looked up and not found, several functions fall back to factor 1 and price it as one ounce.

So the order is fixed (remap first, delete second), no conversion factor changes, and every step is proven in the harness with its recovery path run once.

**Words used here.**
- **Spelling:** the exact text in a unit column, capitals included (`Qt` and `qt` are two spellings).
- **Alias row:** a `unit_conversions` row whose spelling means the same unit as another row (same factor, same type).
- **Remap:** changing a product's unit column from the losing spelling to the winning one.
- **Lower-match:** a lookup that compares `lower(unit)`, so `Qt` and `qt` find each other. Every price lookup in the database and in `src/lib/quoteCalc.ts` is a lower-match; only `validate_product_units` and the `product_form_units` foreign key match exactly.

---

## 1. Facts this plan is built on (checked 2026-11-09)

### 1.1 `unit_conversions` today (14 rows)

| Spelling | factor_oz | type | note in the row |
|---|---|---|---|
| `fl oz` | 1 | liquid | 1 fluid ounce |
| `oz` | 1 | liquid | alias for fl oz |
| `Oz` | 1 | liquid | capitalized alias |
| `Pt` | 16 | liquid | |
| `qt` | 32 | liquid | lowercase, alias for Qt |
| `Qt` | 32 | liquid | |
| `Gal` | 128 | liquid | |
| `Dry oz` | 1 | dry | |
| `Lb` | 16 | dry | |
| `LB` | 16 | dry | capitalized alias |
| `g` | 0.03527396 | dry | |
| `MG` | 0.00003527396 | dry | |
| `Ea` | 1 | both | each / unit |
| `Unit` | 1 | both | alias for Ea |

- Constraints: `UNIQUE (unit)` (exact), a type CHECK. **No** uniqueness on `lower(unit)`, which is how the case duplicates got in.
- Triggers: `unit_conversions_rate_lock` and `…_no_truncate` (`guard_unit_conversions_rate_lock`) refuse **any** insert, update, delete or truncate while the rate lock is on. The lock is **off** today (`product_rate_lock.is_locked = false`).
- Foreign key into it: `product_form_units.unit` → `unit_conversions(unit)`. `product_form_units` rows: seed `Lb`, seed `Unit`, each `Ea`, each `Unit`.
- App access: authenticated users can select; insert has a policy, update is admin-only, there is no delete policy. The app never deletes a unit.

### 1.2 Spellings in use, by column (all rows, active or not)

**Product columns (what RT-2 remaps):**

| Column | Counts |
|---|---|
| `products.inventory_unit` | Gal 492, Lb 65, Dry oz 17, **Oz 11**, **Qt 8**, Unit 7, MG 3, Ea 1 |
| `products.unit_size` | identical to `inventory_unit` on every row (the WP-PM-6a back-fill) |
| `products.rate_unit` | oz 489, Dry oz 76, **qt 18**, Unit 7, MG 3, Lb 2, Gal 1, Ea 1, Pt 1, **LB 1**, null 3, blank 2 |
| `products.container_unit` | null 588, Gal 9, MG 3, Ea 2, Dry oz 1, Lb 1 |
| `products.max_label_rate_unit` | null on all 604 |
| `product_parents.rate_unit` | no rows (0 parents) |
| `product_form_units.unit` | Unit 2, Lb 1, Ea 1 |

**Every product on an affected or nearby spelling (48 listed below; 38 sit on a two-way spelling: 11 + 8 + 18 + 1):**
- `Oz` stock (11, all liquid, active): Armezon 32 oz, Drive XLR8 64 oz, Endura 104 oz, Evito 128 oz, Impact 128 oz, Nurizma 64 Oz, Panoflex 20 oz, Sefina 140 oz, Status 125 oz, Steadfast Q 60 oz, Trivence 200 Oz. Rate unit `oz`. None on any quote, order or job; no stock rows.
- `Qt` stock (8, all liquid, active): AIM 2EC, Cadet, Effect-GC, Elevore, Make Foam, Milestone, Prevent Foam, Tordon RTU (each "1 Qt"). Rate unit `oz`. None on any quote, order or job; no stock rows.
- `qt` rate (18 liquid, 17 active, stock `Gal`): Bio-Health ×2, BoostMax-D ×2, BoostMax-M ×2, Carbon RX ×2, Concept N-25B ×2, Concept-B-10 ×2, Concept-Z9 ×2, Foliar-K ×2, MicroNourish Tote, MicroNourish Tote (retired). Only MicroNourish Tote is used: 1 quote line, 4 order lines.
- `LB` rate (1): Imazuron Herbicide (dry, stock `Lb`, rate 10). Not on any quote, order or job.
- `Unit` (7, each form, all "Per Unit" **seed treatments**: Accelerate, CruiserMaxx APX, Ilevo, Saltro, Trilex 2000, Vibrance Trio, Victrato). Stock, unit size and rate unit all `Unit`.
- `Ea` (1 each product: Tempo SC Ultra 8 oz; plus container unit `Ea` on Powder Keg Corn and Soybeans).
- No affected product has a net-weight value (draft or approved), and none is in a parent group.

**Transaction and history columns (never changed by RT-2):** quote lines use `oz` 22, `Lb` 3, `Dry oz` 2, `qt` 1. Order lines use `oz`, `Lb`; invoice lines `pt/ac`, `acre`; job lines `oz`, `Pt`, `Gal`, `32`, `pt/ac`; delivery, PO and receiving lines also hold `Qt`, `LB`, `EA`, `ea`, `Gall`, `Gallon `. These are saved history. "Old billed units and amounts never change" (grand plan, overlap 2), so RT-2 leaves them as they are; every database reader of them is a lower-match (1.3), so they keep pricing the same.

**Quotes:** 7 quotes (draft 1, sent 1, accepted 2, expired 1, cancelled 2) with 28 lines in total.

### 1.3 Every database function that reads `unit_conversions` (14, not 5)

The August list named five. Live now has fourteen (`pg_proc` bodies containing `unit_conversions`, read 2026-11-09).

| Function | How it looks a unit up | After RT-2 |
|---|---|---|
| `validate_product_units` (BEFORE trigger on `products`) | **Exact** `unit = NEW.inventory_unit` and `= NEW.container_unit` (liquid/dry), else `product_form_units` exact (seed/each) | Must find every product's spelling: hence remap first |
| `product_price_per_acre` (and `recalc_product_price_per_acre`, which calls it) | Lower-match, `LIMIT 1`, falls back to 1 | Same factor; one row instead of two |
| `_save_quote_below_cost_impl_20260810` | `LEFT JOIN … ON LOWER(unit) = LOWER(qi.rate_unit)` and the stock unit, falls back to 1 | Today `oz` and `qt` match two rows each, so the line's row is duplicated; the `UPDATE … FROM` then picks one of two identical copies. Totals are right today only because each pair has equal factors. After RT-2 the join returns one row |
| `apply_product_pricing_change_set` | Lower-match, plus type check | Same |
| `preview_product_cost_basis_changes` | Lower-match, plus type check | Same |
| `_save_job_cost_step2_impl` | Folds case and punctuation before matching | Same |
| `_product_rate_unit_ok` (used by `guard_product_rate_lock` and the parent rate writers) | Lower-match; requires every matching row to agree on a finite factor | Same, now one row |
| `_unit_factor_oz` | Lower-match, all matches must agree | Same |
| `_weight_unit_factors` | Groups by `lower(btrim(unit))` | Same |
| `_size_cost_per_base` | Lower-match | Same |
| `_tote_fill_liquid_oz` | Lower-match, liquid only | Same |
| `fill_tote_from_bulk` | Takes `LOCK TABLE unit_conversions IN SHARE MODE` | A delete waits for it; no change |
| `set_product_rate_lock` | Refuses to lock if two spellings of one unit disagree | Fewer rows to compare |
| `guard_unit_conversions_rate_lock` | Trigger on the table itself | Refuses the alias delete while the lock is on |

**Conclusion:** deleting a spelling whose lower form survives (`Oz` when `oz` stays, `Qt` when `qt` stays, `LB` when `Lb` stays) changes no lower-match result. Only the exact matches care, and the remap fixes those first.

### 1.4 Product guards a remap runs into

A remap is an `UPDATE products`, so every product trigger fires (25 today). The ones that react to unit columns:

| Trigger | What it does to a remap | Handling (section 4) |
|---|---|---|
| `trg_validate_product_setup_fields` (`guard_product_setup_fields`) | **Refuses any change** to a saved product's `inventory_unit` or `container_unit`: "it waits for the reviewed unit change". No bypass exists | RT-2 is that reviewed change. The migration disables this one trigger for its own update and re-enables it in the same transaction (4.B) |
| `trg_keep_product_unit` | Refuses changing `unit_size` away from `inventory_unit` | Both columns move together |
| `trigger_guard_product_cost_basis_unit_change` | Compares `lower(...)` of the stock unit | Case-only change: does not fire |
| `trigger_return_net_weight_to_draft` | Any exact change of stock/unit size counts as a pack change: an approved net weight goes back to draft, pack version +1 | No affected product has a net weight; preflight proves it stays 0 |
| `trigger_zzz_guard_product_rate_lock` | Refuses a rate-unit change while locked; checks the new unit with `_product_rate_unit_ok` | Preflight requires the lock off |
| `trigger_zz_guard_product_parent_values` | Refuses a member size's own rate-unit change | Preflight requires no remapped product in a parent group (0 today) |
| `trigger_z_guard_and_version_product_pricing` | A rate-unit change bumps `pricing_version` | Expected for Imazuron only; per-acre prices are unchanged |
| `trigger_zz_write_product_change_history` | Writes old/new of each unit column | Wanted: it is the audit trail of the remap |

### 1.5 The app and other readers

- **Dropdowns read the live table.** `src/lib/units.ts` (`unitOptionsForForm`, `rateUnitOptionsForProduct`) builds every unit dropdown from `unit_conversions`; it is loaded by `ProductDetail`, `QuoteBuilder`, `JobDetail`, `CropPrograms`, `FieldAppChemicalEntry`, `FieldAppSplitInvoiceEditor`, `BlendRecipes`, `BlendTicketDetail`, `ManualTicketCreate`, `LabelReview` and `BulkQuoteImport`. Deleting an alias simply removes a duplicate option. No screen code changes.
- **Price math in the browser** (`src/lib/quoteCalc.ts:77` `getConversionFactor`) is a lower-match.
- **Hard-coded spellings:** `FORM_UNIT_RULES` (`src/lib/units.ts:24`) mirrors `product_form_units` (`Lb`, `Unit`, `Ea`: all kept). `blendMathValidator.ts:129` maps `fl oz`→`oz` and `unit`→`ea` (all kept). The field app's default `'oz'` (`FieldAppChemicalEntry.tsx:340-341`) is the winning spelling. Nothing in `src/` compares to `Oz`, `Qt` or `LB` exactly.
- **Workbooks:** the pricing workbook and the setup workbook compare a row's exported `inventory_unit` / `rate_unit` snapshot **exactly** with today's value. A workbook downloaded before an RT-2 apply refuses the remapped products' rows as stale (the safe direction). Download a fresh one after each apply.
- **Edge Functions:** only `_shared/pdf/invoicePdf.ts` prints a unit, as text. No change.
- **FarmRx** (separate repo and database): no reader of these tables.
- **Harness fixtures** that insert products with `Oz`, `Qt` or `LB`: `prove-job-invoice-lines-keep-job-unit`, `prove-product-chemistry`, `prove-product-forms-seed-each`, `prove-product-rate-lock`, `prove-product-setup-workbook`, `prove-product-unit-backfill`, `prove-product-weights`, `prove-tote-fill` (all `scripts/smoke/…-real-schema.mjs`). After step 2 those spellings no longer exist, so each must be checked and, where it uses one as a product unit, changed to the winner in the step-2 PR.

---

## 2. Where the grand plan / August plan is wrong or silent against current code

| Plan says | Current code / this sheet |
|---|---|
| Five functions join `unit_conversions` (2.7b) | **Fourteen** (1.3). All but `validate_product_units` lower-match. Every one is checked at every step. |
| Consolidate `Unit`/`Ea` (2.7) | **Not the same unit in this catalog.** The 7 `Unit` products are "Per Unit" seed treatments, where a unit is a **seed unit** (rate text `1.18 oz/unit`); `Ea` means "each" (Tempo SC Ultra bottle, Powder Keg container). RT-1 also keeps "per seed unit" and "per each" as separate bases. Recommended: keep both rows (question 2). |
| August counts (`unit_size` had `LB` 1 and 8 blanks; `rate_unit` oz 493) | Now `unit_size` equals `inventory_unit` on every row (WP-PM-6a back-fill), `rate_unit` oz 489, qt 18. |
| Silent on the setup guard | `guard_product_setup_fields` (added after August) refuses every stock or container unit change. RT-2 must pass it deliberately (4.B). |
| Silent on the rate lock | Both steps need the lock **off**: the remap changes one rate unit, and the alias delete is a `unit_conversions` change the lock refuses. |
| Silent on the case-duplicate cause | `unit_conversions` has no `lower(unit)` uniqueness. Step 2 adds it, so a case duplicate can never come back (a hard guard, not a rule). |
| "Every product with an affected unit still saves" | Kept. Also: the 8 `Qt` products, 11 `Oz` products and Imazuron are proven to save **after** both steps, through the local test app, as an ordinary admin. |
| KI-113 (from RT-1) assigns "liquid `oz` on a dry product" to RT-2 | Two products (Autumn Super 51 WDG, Cimarron Plus 10 oz): dry, stock `Dry oz`, rate unit `oz`. `oz` and `Dry oz` both have factor 1, so moving them to `Dry oz` changes no price. This is a meaning change, not a spelling one, so it needs Mason's per-row yes (question 3). |
| B-12: `Ea`/`Unit` stored as an ounce (factor 1, type both) | Not changed: RT-2 never changes a factor. Still flagged for RT-3/RT-4. |

---

## 3. The spelling map

**Recommended winners (question 1):** `oz`, `qt`, `Lb`. Deleted alias rows: `Oz`, `Qt`, `LB`.

Why these: they are the spellings most rows already use, so the fewest product rows move (20, against 30 if `Qt` won), and only **one** rate unit changes (Imazuron); every other move is a stock unit, which has no pricing version, no parent value and no rate-lock check. `oz` is also what the field app defaults to and what RT-1's unit table maps from.

| Losing spelling | Winner | Column(s) | Products moved |
|---|---|---|---|
| `Oz` | `oz` | `inventory_unit` + `unit_size` | 11 |
| `Qt` | `qt` | `inventory_unit` + `unit_size` | 8 |
| `LB` | `Lb` | `rate_unit` | 1 |
| *(question 3)* `oz` on a dry product | `Dry oz` | `rate_unit` | 2 (only with Mason's yes) |

**Kept as they are:** `fl oz`, `Pt`, `Gal`, `Dry oz`, `g`, `MG`, `Ea`, `Unit` (question 2), and every factor. After step 2, `unit_conversions` has 11 rows.

What changes on paper: the 11 `Oz` and 8 `Qt` products show `oz` / `qt` as their stock unit on new quotes, orders, invoices and pick lists (old documents keep their saved spelling). Numbers do not change.

---

## 4. Step 1 · RT-2a: remap product spellings (database PR 1)

One migration, `<stamp>_unit_spellings_remap.sql` (stamp claimed in the notes folder at build time; RT-1 holds `20261223100000`).

### 4.A Preflight (refuses and changes nothing if any check fails)
- **First**, `LOCK TABLE public.products, public.product_parents, public.product_form_units IN SHARE ROW EXCLUSIVE MODE`, then `LOCK TABLE public.unit_conversions IN SHARE MODE` (products first, the same order as step 2; with the repo's usual `lock_timeout`). The second lock stops any unit row or factor changing while step 1 runs. This waits for any product save already in flight to commit and blocks new ones until the migration commits, so no save can add an `Oz`, `Qt` or `LB` product between the check below and the remap.
- The 14 `unit_conversions` rows exactly as in 1.1 (spelling, factor, type).
- `product_rate_lock.is_locked = false`.
- The products to move are exactly the listed ids (pinned in the migration by id **and** current spelling): 11 with `inventory_unit = unit_size = 'Oz'`, 8 with `'Qt'`, 1 with `rate_unit = 'LB'` (and the 2 dry `oz` rows if question 3 is yes). Any other product found with `Oz`, `Qt` or `LB` in any product unit column refuses (it would be left behind).
- None of them is a `product_parent_members` row; none has a `product_size_net_weight_values` row.
- Record, inside the transaction, the md5 of every product's money fields only, `(id, rate_per_acre, tier1/2/3_price, tier1/2/3_price_per_acre, current_cost)` (no unit column, so an approved unit change can never fail it), a copy of every product's four unit columns, and of the 14 function bodies in 1.3.

### 4.B The remap
- `ALTER TABLE products DISABLE TRIGGER trg_validate_product_setup_fields;` then one `UPDATE` per map row by pinned id, then `ENABLE TRIGGER`, all in the migration's single transaction. Every other trigger runs normally, so `validate_product_units` checks each new spelling, the rate-unit row goes through the rate-lock and pricing guards, and the history trigger records each change. No guard function is edited, so no permanent bypass exists afterwards. (Disabling a trigger takes a table lock until commit, so no other session sees the gap.)
- No migration in this repo has disabled a trigger before. The alternative is a permanent exception inside `guard_product_setup_fields` (allow a case-only change when a transaction-local flag is set and `current_user = 'postgres'`). The sheet prefers the one-statement disable because it leaves no new code path behind; reviewers may choose the flag instead, and the harness (U13) proves either way that the guard still refuses ordinary changes afterwards.
- The history trigger records the actor as `auth.uid()`, which is null inside a migration; KI-30's data migration (`20261214100000`) wrote product rows the same way. The ledger record names the migration as the actor.

### 4.C Postflight
- The setup trigger is enabled again (`pg_trigger.tgenabled = 'O'`).
- No product unit column holds `Oz`, `Qt` or `LB`.
- Every product's `inventory_unit` and `container_unit` exact-matches a `unit_conversions` row of its form (or `product_form_units` for seed/each): the `validate_product_units` rule, checked for all 604 rows.
- The price md5 from 4.A is unchanged (`pricing_version` is not in it; Imazuron's and, with question 3, the two dry products' versions bump).
- Unit columns: compared with the 4.A copy, exactly the pinned ids changed, each from its pinned old spelling to its pinned new one (the section 3 map, including the two `oz`→`Dry oz` rows if Mason approved them), and no other product's unit column changed.
- The 14 function bodies are unchanged.
- `unit_conversions` is **exactly** the 14 rows of 1.1 (id, spelling, factor, type, note): no factor moved and the aliases are still there, so both old and new spellings work.

### 4.D Recovery for step 1
A reverse script (kept beside the harness, not in `supabase/migrations/`) puts each pinned id back to its old spelling with the same trigger handling. The harness runs it once (section 6). If it were ever needed live, it would be copied into a new migration and go through the normal gates.

---

## 5. Step 2 · RT-2b: delete the alias rows (database PR 2)

One migration, `<stamp>_unit_spellings_delete_aliases.sql`. **It deletes rows, so it is destructive: Mason's explicit approval is required for the live apply.** It is built and proven only after step 1 is live and the live check in section 7 has passed.

### 5.A Preflight
- **First**, `LOCK TABLE public.products, public.product_parents, public.product_form_units IN SHARE MODE`, **then** `LOCK TABLE public.unit_conversions IN ACCESS EXCLUSIVE MODE` (with `lock_timeout`). Product tables come first so the migration never holds the units table while waiting on a product save that is about to read it (that order could deadlock); by the time it asks for the units table, every product save has finished and no new one can start. A product save checks its unit against `unit_conversions` in a trigger, not a foreign key, so without these locks an uncommitted save could validate `Oz` against the alias, the delete could run and pass postflight, and the save could then commit pointing at a deleted unit. With them, every in-flight save commits before the checks read, and no save runs until the delete has committed (after which `validate_product_units` refuses the old spelling).
- If a product was given `Oz`, `Qt` or `LB` between step 1 and step 2 (the dropdowns still offer them until step 2), the check below refuses and that product is remapped first, through a small follow-up to step 1 with Mason's yes.
- Step 1's migration is in the live ledger.
- `product_rate_lock.is_locked = false`.
- No product unit column, no `product_parents.rate_unit` and no `product_form_units.unit` holds `Oz`, `Qt` or `LB`.
- The 3 rows to delete exist with their pinned id, spelling, factor, type and note (values in 1.1), and each has a surviving row with the same `lower(unit)`, factor and type.
- Same md5 records as 4.A.

### 5.B The change
- `DELETE FROM unit_conversions WHERE id IN (<3 pinned ids>)`.
- `ALTER TABLE unit_conversions ADD CONSTRAINT unit_conversions_unit_trimmed CHECK (unit = btrim(unit) AND unit <> '')` and `CREATE UNIQUE INDEX unit_conversions_unit_lower_key ON unit_conversions (lower(unit));`. Together they refuse a case or space duplicate (`QT`, `oz `), matching how `_weight_unit_factors` folds spellings (`lower(btrim(unit))`). All 14 live rows are already trimmed. This blocks spelling duplicates only; a differently worded alias (`fl oz` beside `oz`) is still possible and stays WP-PM-9's review rule.
- **Rate units spelled exactly (Luna round 3):** `validate_product_units` checks only `inventory_unit` and `container_unit` exactly, and rate units are lower-matched, so after the delete a new product could still save `rate_unit = 'LB'`. Step 2 therefore adds one small new trigger, `trg_product_rate_unit_spelling` (function `_product_rate_unit_spelling`, `SET search_path = public, pg_temp`, no grants), `BEFORE INSERT OR UPDATE OF rate_unit` on `products` and `product_parents`: when the new `rate_unit` is non-blank and differs from the old value, it must equal a `unit_conversions.unit` exactly, else `PRODUCT_RATE_UNIT_SPELLING: <unit> is not a listed unit spelling`. Null and blank (5 live rows) and untouched rows pass, so no saved product is refused. It does not touch `validate_product_units` (PR #1688's md5 pin holds). Recovery (5.D) drops it first.
- **If RT-1 is already live** (`to_regclass('public.product_rate_units') IS NOT NULL`): remove `Oz`, `Qt`, `LB` from `product_rate_units.legacy_spellings` in the same transaction (RT-1 sheet 3.2 asks for exactly this).
- Fixture updates in the harness files listed in 1.5.

### 5.C Postflight
- 11 rows; each `lower(unit)` once.
- For every distinct spelling in **every** unit column in 1.2 (products, parents, form units, and all transaction and history columns), the lower-match finds the same factor as before step 2 (one row, never zero where there was one before). This proves no saved line, old or new, changes price.
- The `validate_product_units` rule holds for all 604 products (as 4.C).
- The price md5 and the 14 function bodies are unchanged.
- If RT-1 is live: RT-1's own postflight rule holds again (every legacy spelling exists in `unit_conversions` with the same factor; every `products.rate_unit` maps to exactly one RT-1 unit).

### 5.D Recovery for step 2
A reverse script re-inserts the 3 rows with their original id, spelling, factor, type and note, drops the new rate-unit trigger and the lower index first, and (if RT-1 is live) puts the spellings back into `legacy_spellings`. The harness runs it once.

---

## 6. Done when (harness cases)

Harness: `scripts/smoke/prove-unit-spellings-real-schema.mjs`, against a real-schema container with every migration applied. Fixtures copy the shape (units, forms, rates, prices) of every product listed in 1.2 (48: the 38 duplicate-spelling rows, the 2 dry `oz` rows, the 7 `Unit`, the 1 `Ea`, and the 2 Powder Keg products with an `Ea` container unit) and of the 7 live quotes, without customer names. Quotes are saved through the real `save_quote` RPC as an admin.

The harness walks five states: **S0** baseline → **S1** after step 1 → **S2** after step 2 → **S1r** after step 2's recovery → **S0r** after step 1's recovery. At **every** state it runs U1 to U6.

| # | Check (every state) | Expect |
|---|---|---|
| U1 | **Quotes to the cent:** re-save each fixture quote (the 7 live shapes plus one line for every affected product at each tier) | Every line's `total_units_needed`, `price_per_acre`, `total_price`, `profit` and each quote's total equal S0's to the cent |
| U2 | **The exact-match check:** an ordinary admin update (change `internal_notes`) on every fixture product, and an insert of a new product in each surviving spelling | All succeed. At S2, an insert with stock unit `Oz` or `Qt` (or container unit `LB`) is refused by `validate_product_units`, and an insert or rate change to `rate_unit` `Oz`, `Qt` or `LB` on a product or parent is refused by `trg_product_rate_unit_spelling`; an unchanged old row and a null or blank rate unit still save |
| U3 | **All 14 functions:** call each (directly, or through its RPC/trigger) with every spelling found in 1.2, including history spellings (`Qt`, `LB`, `qt`, `EA`, `Gall`, `pt/ac`) | Same results as S0: same factor, same per-acre price, same refusal or acceptance |
| U4 | **One row per unit:** count the lower-match rows for each spelling | S0/S1/S1r/S0r: `oz`, `qt`, `Lb` find 2; S2: every spelling finds at most 1 |
| U5 | **Per-acre prices:** md5 of every fixture product's price columns | Equal to S0 |
| U6 | **Function bodies:** md5 of the 14 bodies | Equal to S0 |

Step-specific cases:

| # | Case | Expect |
|---|---|---|
| U7 | Step 1 with the rate lock on | Refused at preflight; nothing changed |
| U8 | Step 1 with a stray `Oz` product not in the pinned list | Refused at preflight |
| U9 | Step 1 with a remapped product put in a parent group | Refused at preflight |
| U10 | Step 2 before step 1 (aliases deleted while products still use them) | Refused at preflight. Then, as `postgres` only, delete `Qt` directly to show what the order prevents: saving a `Qt` product now fails (`inventory_unit "Qt" is not valid`) |
| U10b | **Race:** session A updates a product to `Oz` and holds its transaction open; session B starts step 2 | B waits on the lock; when A commits, B's preflight sees the `Oz` product and refuses. Same test for step 1 with a new `Qt` product |
| U11 | Step 2 with the lock on | Refused (preflight, and `guard_unit_conversions_rate_lock` as backstop) |
| U12 | After step 2, insert `unit_conversions` rows `QT` and `oz ` | `QT` refused by the lower-case unique index; `oz ` refused by the trimmed CHECK |
| U12b | Step 1 while a second session tries to change `oz`'s factor | The factor change waits for step 1 and then runs; step 1's postflight (run before commit) saw the exact 14 rows. Step 2 with a product save in flight: no deadlock, the save finishes first |
| U13 | Setup trigger after step 1 | Enabled; a stock-unit change on a saved product is still refused |
| U14 | Both orders with RT-1 (run once with RT-1's migration applied first, once with it absent) | Step 2 updates `legacy_spellings` only when the table exists; RT-1's postflight rule holds at S2 |
| U15 | Recovery: S1r and S0r | Data exactly as S1 and S0 (row-by-row compare of `products` unit columns and `unit_conversions`) |

**Grand plan "Done when" mapping:** "a fixed set of real quotes totals the same to the cent" is U1 in the harness plus the live check below; "every product with an affected unit still saves" is U2 plus the local-app check below; "each step is checked in the harness, with the recovery path run once" is the five states and U15.

---

## 7. Live checks (after each apply, read-only)

- **Quotes:** for each of the 7 live quotes, recompute every line with the database's own pricing (the `save_quote` per-line formula in a read-only `SELECT` against the live tables, and `product_price_per_acre` per product and tier), and compare with the values saved before the apply. Saved lines are not rewritten by RT-2, so they must also be byte-identical.
- **Prices:** the price md5 from 4.A equals the value taken just before the apply.
- **Spellings:** the 1.2 counts move exactly as section 3 says, and nothing else.
- **Saves in the local test app** (`scripts/local-app`, never production): after each step, open and save each of the 20 remapped products plus one product in every surviving spelling, as an admin, in the browser pane; each save succeeds and shows the same per-acre price as before.
- **One live screen** each for a quote with MicroNourish Tote (the only affected product on a quote): it shows the same quantities and totals as a screenshot taken before the apply.

---

## 8. PR split, Sol and gates

| # | PR or step | Files | Sol? | Gates |
|---|---|---|---|---|
| 1 | **This sheet** (docs only) | this file | No | Green checks; open 4 hours before merge |
| 2 | **RT-2a DB** (remap) | migration, `docs/reference/migrations.d` ledger record, changelog note, harness and its recovery scripts, `docs/manual/KNOWN_ISSUES.md` (KI-113 line updated if question 3 is yes) | **Yes** (a migration) | Luna until clean, Sol before the PR opens, 4-hour hold, live apply **before** merge with Mason's `approve <code>` in the RT-2 session (it changes live product data), then the section 7 checks |
| 3 | **RT-2b DB** (delete aliases) | migration, ledger, changelog, harness additions, the fixture files in 1.5 | **Yes** | As PR 2, and **destructive**: Mason's explicit approval for the apply. Built after PR 2 is live and checked |

No screen PR: dropdowns read the live table (1.5). No `src/types/index.ts` change (no new column or table). The schema registry needs no refresh (no new status value; the index is recorded by the next routine regen).

---

## 9. RT-1 and other overlap (checked 2026-11-09)

**RT-1** (branch `claude/rt1-product-rates-db`, migration `20261223100000_product_rates_draft.sql`, at Sol round 1, PR not open):
- RT-1 **pins all 14 `unit_conversions` rows** in its preflight (`PRODUCT_RATES_BASELINE_DRIFT`) and its postflight requires every spelling in `product_rate_units.legacy_spellings` (`fl oz`/`oz`/`Oz`, `qt`/`Qt`, `Lb`/`LB`, `Ea`/`Unit`, …) to exist in `unit_conversions`.
- **RT-1 first, then RT-2 (expected):** RT-1 applies cleanly. RT-2's step 1 changes no unit row. RT-2's step 2 removes the three spellings from `legacy_spellings` in its own transaction (5.B) and re-proves RT-1's rule (5.C, U14).
- **RT-2 step 2 first:** RT-1's preflight would refuse. RT-1's migration must then pin the 11-row set and drop the three spellings from its seed arrays before its apply. Step 1 alone does not affect RT-1.
- **Files:** RT-2 edits none of RT-1's files. Both add a ledger record and a changelog note under their own names; both may touch `docs/manual/KNOWN_ISSUES.md` (KI-113 is RT-1's entry), so whichever merges second rebases that one line.

**REG-1 step 2** (#1688, open): its harness pins the md5 of `validate_product_units` for history replay. RT-2 does **not** edit `validate_product_units` (it disables a different trigger for one statement), so that pin holds.

**Taha's open PRs** (#1534, #1576, #1587, #1677): none touches `unit_conversions`, the 14 functions, the product guards or `src/lib/units.ts`. No overlap. (RT-2 does not touch billing.)

**PAR-2 grouping** (Mason-gated, not run): if it runs before step 1 and puts Imazuron in a group, step 1's preflight refuses (U9) and that one rate unit is respelled through the parent rate path instead (`correct_parent_rates`), with Mason's yes. Running step 1 before grouping avoids this.

**Rate lock:** both steps need it off. If Mason turns it on before RT-2 lands, he unlocks it (with a reason) for each apply and locks it again after; `set_product_rate_lock` checks nothing RT-2 changes.

**Order:**
1. This sheet merges.
2. RT-2a built, harness, Luna, Sol, PR, 4-hour hold.
3. Mason approves the RT-2a apply; apply; section 7 checks.
4. Merge RT-2a.
5. RT-2b built, harness, Luna, Sol, PR, 4-hour hold.
6. Mason approves the RT-2b apply (destructive); apply; section 7 checks.
7. Merge RT-2b.

---

## 10. Steps that need Mason

1. **Answer the three questions below** before building (they decide which rows move).
2. **Approve the RT-2a apply** (changes 20 or 22 live product rows; prices unchanged).
3. **Approve the RT-2b apply** (deletes 3 `unit_conversions` rows: destructive, recoverable by the 5.D script through a new migration).
4. **Keep the rate lock off** for both applies, or unlock it for each.
5. After each apply, **download fresh pricing and setup workbooks** (old downloads refuse the remapped products' rows).

---

## 11. Questions for Mason

**Answered (Mason, 2026-11-09): "Yes, all three".** `oz`, `qt` and `Lb` stay and `Oz`, `Qt`, `LB` go; `Unit` and `Ea` stay separate; Autumn Super 51 WDG and Cimarron Plus 10 oz move to `Dry oz` in step 1 (22 products in step 1).

1. **Which spelling stays for each pair?** Recommended: `oz`, `qt` and `Lb` stay; `Oz`, `Qt` and `LB` go. This moves 20 products (11 "oz" stock units, 8 "qt" stock units, 1 rate unit). The only visible change: those products show "oz" or "qt" instead of "Oz" or "Qt" on new paperwork. The alternative, keeping capital `Qt`, moves 30 products and changes 18 rate units instead of 8 stock units.
2. **Are "Unit" and "Ea" the same thing?** The August plan merged them. In today's catalog, "Unit" is used only by 7 seed treatments sold per **seed unit** (a bag of seed), and "Ea" means **each** (a bottle). Recommended: keep both; RT-2 does not touch them. The alternative (merge into one) would make "per seed unit" and "per each" read the same on paperwork and in RT-1's rates.
3. **Two dry products have a liquid-ounce rate unit.** Autumn Super 51 WDG and Cimarron Plus 10 oz are dry, stocked in dry ounces, but their rate unit is `oz` (a liquid ounce). Recommended: change both to `Dry oz` in step 1. Their price per acre does not change (both units count as 1 ounce today), and neither is on any quote or order. The alternative is leaving them for RT-3's rate review.

---

## 12. Review record

**Luna round 1** (gpt-6-luna xhigh, head `16e3aab9c`): 2 findings.
- HIGH: an uncommitted product save could validate an alias spelling while step 2 deletes it (units are checked by a trigger, not a foreign key). Fixed: both steps lock `products`, `product_parents` and `product_form_units` (and step 2 `unit_conversions`) before their preflight; race case U10b added (4.A, 5.A, section 6).
- MED: the "latest live migration" stamp is later than the check date. Refuted: this repo's stamps run ahead of the calendar by convention; `20261222100000` is in the live ledger (applied 2026-11-09), as RT-1's sheet also records. Note added to the status line.

**Luna round 2** (head `4a47bac68`): no BLOCKER or HIGH; 3 MED, all fixed in one fix-only commit (no rerun needed under ship.md).
- Step 2's lock order (units table before products) could deadlock with a product save: fixed, product tables first (5.A, U12b).
- Step 1 did not lock `unit_conversions`, and its postflight did not compare the rows: fixed, `SHARE` lock and an exact 14-row compare (4.A, 4.C).
- The lower-case index missed space variants that `_weight_unit_factors` folds together: fixed, a trimmed CHECK beside the index; the sheet now says it blocks spelling duplicates only (5.B, U12).

**Codex GitHub App, PR #1703:** 1 P2 finding, fixed.
- The 4.A price checksum included `lower(rate_unit)`, so an approved `oz`→`Dry oz` change (question 3) would fail postflight and roll back. Fixed: the checksum covers money fields only, and unit changes are checked separately against the pinned map (4.A, 4.C).

**Luna round 3** (head `4b7de7270`): no BLOCKER or HIGH; 1 MED, 1 LOW, both fixed in one fix-only commit.
- MED: U2 expected `validate_product_units` to refuse a `LB` rate unit, but that trigger checks only stock and container units; rate units are lower-matched, so `LB` could come back as a rate unit after step 2. Fixed: step 2 adds `trg_product_rate_unit_spelling` (exact spelling for a new or changed rate unit on products and parents; old, null and blank rows pass), U2 tests it, and recovery drops it (5.B, 5.D, section 6).
- LOW: the "41 products" count did not match the listed groups. Fixed: 48 listed (38 on a two-way spelling + 2 dry `oz` + 7 `Unit` + 1 `Ea` + 2 Powder Keg), and the fixture scope names them (1.2, section 6).
