# Product grand plan: product setup and the product data the rest of the app reads

**Status: PLAN, 2026-10-29, reviewed by Sol the same day. NOT STARTED.** Mason, in chat, 2026-10-29: "lets work through all of these Ideas since it all goes with our grain product master work in a way and all other functions of app will use these values for rest of app to work, we need all of this setup aswell so lets fold this into a grand plan, then send it all to Sol for review and make this another phase or revalute all of this work with our product master plan we just built." Sol (`gpt-6-sol`, high, advisory, read-only) returned 56 findings, 4 of them BLOCKERs. 55 are folded in below; 1 was refuted with evidence (section 11). Nothing here authorizes building. Building starts when Mason says so.

**What this plan is.** One ordered map of all product work:
- the October Product Master packages;
- the October weight-and-ingredient refresh;
- the brand plan;
- every August product-data phase that was never scheduled.

It doesn't replace the detailed documents. It says:
- what comes in which order;
- what was merged;
- what "done" means for the packages that had no build sheet yet.

**Why one plan.** Many parts of the app read a product's setup: quotes, orders, jobs, blend tickets, loader worksheets, invoices, inventory, price sheets, the field app and the RUP register. They read its form, units, container, rates, prices, EPA number and timings, and soon its weight and ingredients. Building those readers on a weak product record repeats the work, so this plan builds the record from the bottom up.

**Source documents (all on `main`).** Where this plan and an older one disagree, this plan wins on order, merges and the rules in section 3. The older document keeps the detailed design.

| Document | Holds |
|---|---|
| `docs/plans/2026-10-28-product-master-setup-edits-BACKLOG.md` | The 43 Product Master items |
| `docs/plans/2026-10-28-product-master-BUILD-SHEET.md` | Stage 1's packages: approach, "Done when" and Sol notes for each |
| `docs/plans/2026-10-28-product-data-model-REFRESH.md` | Weight per gallon and active ingredients, refreshed (To-Do 2.9) |
| `docs/plans/2026-10-22-product-brands-step1-PLAN.md` | Brands and the delivered brand (To-Do 2.8) |
| `docs/plans/2026-08-18-product-data-model-PRD.md` | August requirements for every phase (sections 6 and 9) |
| `docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md` | August design: decisions D-A to D-AA, WP-0 to WP-5, section 4 (later phases), section 6 (43 issues) |
| `docs/plans/2026-08-18-product-data-model-MASTER-RECORD.md` | August reasoning |
| `docs/manual/DECISION_LOG.md` | Mason's settled answers (2026-08 and 2026-10-28 entries) |

**Words used below.**
- *Stage*: a group of packages with one purpose.
- *Package*: one pull request.
- *Migration*: a reviewed database change.
- *RPC*: a saved database operation the app calls.
- *Generic*: CRX's own product row, which several real brands can fill.
- *Density*: a liquid's pounds per gallon.
- *Rate*: how much product goes on an acre (or per 100 gallons, or per seed unit).
- *Harness*: a local copy of the database, built to match the live structure, used for proof.
- *Retry key* (`p_idempotency_key`): makes a repeated request return the first result instead of acting twice.
- 💲: touches pricing, cost or money.

---

## 1. The stages at a glance

| Stage | Purpose | Packages | Source | To-Do row |
|---|---|---|---|---|
| **1** | Product setup works and is checked by the database | WP-PM-1 to WP-PM-14, plus DM-0 | Build sheet | 2.10 |
| **2** | The mechanisms for weight, chemistry, EPA data and registration status | DM-2, DM-1, REG-1, DM-4, DM-1b, DM-5 | Refresh plan, August 1b and WP-5 | 2.9 |
| **3** | Brands: which real brand filled a generic | Brand PR B, the cancelled-registration warnings, step 2 | Brand plan | 2.8 |
| **4** | Rates are trustworthy: low, high and recommended values, one quoting default, clean units | RT-1 to RT-4 | August Phase 2 | 2.11 |
| **5** | Compare products by chemistry, cost and price | CMP-2 | August Phase 3 | 2.12 |
| **6** | Use guidance: crop and timing pairs, adjuvants, label link, quoting notes | USE-1 to USE-3 | August Phase 4 | 2.13 |
| **7** | Families, pack sizes and return policy | FAM-1, FAM-2, RET-1 | August Phases 5 and 0b | Later (CAN-WAIT) |
| **8** | Clean-up: retire `unit_size`, retire `ingredient_map`, the name-vs-brand check | CLN-1 to CLN-3 | August Phases 7 and 3.8, B-16 | 2.14 |
| **9** | Product images | IMG-1 | August Phase 8 | Later (CAN-WAIT) |
| **Data** | Filling the catalog: Mason's and an agent's time, not code | DATA-1 to DATA-8 | Section 7 | With each stage |

Stage 1 and the Stage 2 designs are already detailed and Sol-reviewed. Stages 4 to 9 are designed here at "approach and done when" level. Each gets a full build-sheet treatment, and its own Sol review, before it is built.

---

## 2. Code facts behind this plan

From a read-only check of `main` on 2026-10-29. Re-check each at build time.

**What exists today**
- **None of the August later phases is built.** There is no storage for `product_rates`, ingredients, density, adjuvants, crop uses, images or nicknames, and no `product_rate_source_mode` flag.
- **Built since August:**
  - `product_brands` and `upsert_product_brand` (live 2026-10-23);
  - the price-sheet warnings and approval (live 2026-10-27);
  - `products` limited by column for reads. `src/lib/costFields.ts:34` lists the columns the app may read, and a test enforces it.

**Rates**
- Columns: `products.rate_per_acre`, `rate_unit`, `suggested_rate` (text), `max_label_rate` and `max_label_rate_unit`.
- `rate_per_acre` is read in 93 files under `src/`, 42 of them outside tests and generated types.
- The field app still invents `'oz'` when a product has no unit (`FieldAppChemicalEntry.tsx:334`).
- Rate-unit parsing problems are KNOWN_ISSUES KI-16.
- **Rate writers today:**
  - the product page;
  - the CSV importer, a direct insert at `BulkProductImport.tsx:229`, whose `unit` column maps to both `unit_size` and `rate_unit`;
  - **the existing price workbook, whose rate columns are editable** (`productPricingWorkbook.ts:64-81`).

  So August's decision D-C ("workbook rate columns are read-only") is already broken. The list's inline edit no longer writes rates (`Products.tsx:84`).

**`unit_size`**
- 63 non-test files read it.
- Job billing uses it as the billed unit (`JobDetail.tsx:3742`, 3798-3824).
- The latest quote-save body still falls back to it (`20261027040000_quote_sent_price_lock.sql`).
- `inventory_unit` can still be blank.

**Label data fields**
- These exist already: `max_label_rate`, `rei_hours`, `phi_days`, `signal_word` and `is_rup`.
- So do the `product_label_drafts` queue, `LabelReview` and `LabelDataQuality`. `LabelDataQuality` writes `epa_registration` and `signal_word` directly.
- DATA-6 and DATA-7 fill these fields; they need no new storage.

**Families**
- A `product_families` table exists, with 0 rows and free-text `active_ingredient` and `formulation`.
- So do `products.product_family_id` and `packaging_variant`.
- `set_product_phase3_metadata` has no caller in the app.
- `sourcing_tier` exists nowhere, and D-X forbids adding it to `products`.

**Notes**
- The three note boxes are already labelled (`ProductDetail.tsx:1388-1423`).
- A new quote line auto-fills `quoting_notes`, falling back to `notes` (`src/lib/quoteNotes.ts`).

**Old comparison page**
- `BrandVsGeneric.tsx` reads `ingredient_map`, and can insert, update and delete in it. Sales reps can open it.
- Cost is loaded and shown for admins only (`withAdminCosts`, `isAdmin`). The database also refuses cost reads for non-admins.

**Returns**
- `return_policy` has four values: 21 products are `no_return`, 2 are `returnable`, and the rest are `unknown`.
- The return guard is active. There is no editor.

**Images**
- There is no product image storage.
- The photo buckets that would be the pattern were made private on 2026-10-16.

**Not re-counted live**
- Every August count: 604 products, 573 rates, 444 notes, 581 policies, 37 per-100-gallon rows and `ingredient_map` rows. Recount at build time, read-only.

---

## 3. Rules for every package in this plan

Every package in Stages 2 to 9 inherits all 11 rules in build sheet section 1 (`2026-10-28-product-master-BUILD-SHEET.md`). It also follows these (Sol findings 49 to 51):

1. **Proof never writes live data.**
   - Every "Done when" is shown in the harness with seeded edge cases, or in the local app against it.
   - A live check is read-only.
   - A rolled-back live smoke check, or a test on a named live product, needs Mason's OK in that conversation.
   - Tests are supporting evidence, never the only proof.
2. **Each package's own plan lists its exact permissions before any migration is applied.** That means:
   - every new grant and revoke;
   - for new `products` columns, `SELECT` and `REFERENCES` for `authenticated`, plus the `PRODUCT_COLUMNS` entry;
   - every policy change.

   Grants or revokes on existing `products` columns, and policy changes on existing tables, need Mason's `I approve`.
3. **Each new table** has Row Level Security and its policies in the same migration, following the `product_brands` lock-down:
   - no direct writes;
   - reads limited to active users;
   - writes only through admin-checked RPCs.
4. **Each mutating RPC:**
   - takes and enforces `p_idempotency_key`, using the current replay pattern (refresh plan §4 item 3);
   - checks authorization before the replay lookup;
   - if `SECURITY DEFINER`, sets `search_path = public, pg_temp`.

   The proof includes an unauthorized call that writes nothing.
5. **Money stays in exact whole cents.** Every new calculation states its unit factors and rounding.
6. **Anything that deletes data**, such as dropping a column or table or clearing values, needs:
   - a fresh survey of the rows and links it touches;
   - a recovery path;
   - Mason's explicit OK for that exact change at the time.

---

## 4. Re-evaluation: where the August phases and the October packages overlap

Folding the plans together found ten places where two plans would build the same thing twice, or where one would undo the other. Each is settled below.

### 1. Use Timing vs crop and timing pairs (WP-PM-5, USE-1; Sol 7, 8, 40)
"Post-Emerge Corn" is a crop and a timing written as one label.

**Settled:**
- WP-PM-5's options table gets three things per option:
  - a stable **code**;
  - a **timing code**, so that "Post-Emerge" and "Post-Emergence" both mean `post_emergence`;
  - an optional **crop**.
- WP-PM-5 ships Mason's multi-select of labels as he asked.
- USE-1 later adds the real product-to-pair rows (product, crop, timing), migrated from each product's chosen options. A timing-only option means "any crop".

### 2. The Unit field vs retiring `unit_size` (WP-PM-6a, CLN-1; Sol 9, 10, 43)
August said `unit_size` was dead weight. Sol's BLOCKER (build sheet finding 20) found that job and crop-program money math uses it as the billed unit.

**Settled:**
- WP-PM-6a's audit decides the one canonical priced unit.
- **Mason approves each row where the units disagree.** Old billed units and amounts never change.
- CLN-1 may start only after Stages 2 and 4 have landed, and only from a fresh list of every code, workbook and database reader and writer. August's "dead code" reasoning is withdrawn.

### 3. New forms and units vs unit-spelling clean-up (WP-PM-9, RT-2; Sol 11 to 13)
The live `validate_product_units` check matches unit spellings exactly, including capitals.

**Settled:**
- WP-PM-9 adds no aliases. Every new spelling gets its exact conversion row, allowed form and container rule, added and tested before any product uses it.
- RT-2 is its own package with its own money risk, not a step of RT-1:
  - it remaps product spellings first and deletes aliases second;
  - it never changes a conversion factor in the same change;
  - it checks that the exact-match check and the five functions that join `unit_conversions` work at every intermediate step, with a stated recovery path.

### 4. Rate help and checks vs the rate rebuild (WP-PM-8, RT-1)
**Settled:**
- WP-PM-8's checks (rate ≥ 0) protect data now and carry over as RT-1's checks.
- Its help text is worded so it stays true after RT-1.

### 5. Workbooks: price, detail and chemistry proposals (WP-PM-11a, DM-1b; Sol 15 to 19)
**Settled: there are two files with separate operations.**
- **The price workbook** (exists today) stays the price file, through its own price RPC and approvals.
  - **Its rate columns become read-only in WP-PM-11a**, keeping D-C. Rates are then edited only on the product page and through import, until RT-4.
  - This removes a way to edit rates in bulk (question 2).
- **The detail workbook** (new in WP-PM-11a) is a separate file for setup fields, with its own repeat-safe detail RPC.
  - DM-1b later adds Ingredients and Crop Uses tabs to *this* file. They are uploaded through a proposal RPC, never live (D-Z).
  - It never has writable rate columns.
- The previews can share screen code; the operations never mix price approval with detail changes.

**DM-1b also carries August's workbook rules:**
- **D-D:** an absent row means "ignore"; deleting needs an explicit `__delete` marker.
- **D-E:** a per-product data version is checked on child-row edits, so a stale ingredient edit is refused.
- **D-Z split:** a product with a usable EPA number (not blank after trimming) gets chemistry only through EPA proposals, and the workbook refuses its chemistry with a named error. If that number fails the lookup, DM-4 reports it. Clearing the number makes the product workbook-eligible.

### 6. Rate writers vs rates (WP-PM-10, RT-1, RT-4; Sol 14)
**Settled:**
- WP-PM-10 removes the importer's ambiguous `unit` column and writes rates through one function.
- RT-4 re-audits **every** rate writer at that time: page, Add Product, import, workbooks, `LabelDataQuality`, and any found then. All are moved onto the rate RPC, and each is proven after direct writes are revoked.

### 7. Duplicate vs copy-from-sibling vs families (WP-PM-6b, DM-5, FAM-1; Sol 2, 34)
**Settled:** DM-5 is **not** folded into WP-PM-6b any more.
- **WP-PM-6b (Stage 1)** ships the basic Duplicate: setup and compliance fields, a review screen, prices and size-specific fields cleared.
- **DM-5 (Stage 2, after DM-1, DM-2 and brands)** copies ingredients, density and brands from a sibling in one all-or-nothing step. It:
  - checks the expected version of both products;
  - is admin-only and audited;
  - requires a retry key.

  Its sibling rule: same formulation, same safener and same manufacturer, never `sourcing_tier` (D-X).
- DM-5 also carries the searchable **nickname** (August PRD 1.15; Sol 56): stored with its permissions, and searched on Products and in the QuoteBuilder picker.
- FAM-1 derives families; it adds no copy path.

### 8. EPA registration status and the label link (REG-1, USE-2, Stage 3; Sol 5, 20 to 22)
A generic has several EPA numbers, one per brand row.

**Settled:**
- **REG-1** creates one small per-registration table, one row per normalized EPA number, holding:
  - registration status;
  - the cancelled flag;
  - label URL and accepted date;
  - source and checked date.
- Brand rows and the generic's own `epa_registration` point to it, so duplicate brand rows can't disagree.
- The product page lists every registration the product carries, each with its status.
- It is filled by DM-4's EPA lookup, through review.

**Warnings (D-T and D-W: warn loudly, never block)** read REG-1 and appear in three places:
- a banner on the product;
- a warning when the product is added to a quote;
- a warning at the delivery brand pick.

They ship after REG-1, not in brand PR B. Delivery and application records keep a snapshot of the EPA number written at the time, so correcting a brand's number never rewrites history.

### 9. Data clean-up vs bulk tools (DM-0; Sol 1, 55)
**Settled:** DM-0 moves into Stage 1, right after WP-PM-9 and before bulk import (WP-PM-10) and the detail upload (WP-PM-11a). Bulk tools need each product to have one identity.

DM-0 covers:
- every product gets a form;
- the EPA format check (with WP-PM-8);
- the 13 blank SKUs, which **Mason types**: no generated placeholders (D-R);
- the duplicate `9768NR` SKU, re-SKUed, not merged (August 0.1a);
- the three duplicate-name groups;
- the test row;
- all without hard deletes, so old references still resolve.

The code can be built in order. **WP-PM-10 and WP-PM-11a merge only once Mason's DM-0 data step is done.**

### 10. RUP report reliability (Sol 53)
The RUP count is known wrong ("there are a lot more").

**Settled:** a small Stage 1 package, **WP-PM-14**, marks the RUP register and RUP counts as "known incomplete until the RUP flags are reviewed" wherever they are shown, until DATA-7 is done.

---

## 5. Stage 1: Product Master

The build sheet's packages, in its section 4 order, with these changes from section 4 above. They are copied into the build sheet in the same change as this plan:

| Order | Package | Change |
|---|---|---|
| 1 | WP-PM-1 Dropdowns | none |
| 2 | **WP-PM-14 RUP "known incomplete" notice** (new, small, no database change) | overlap 10 |
| 3 | WP-PM-2 💲 Pricing page | none |
| 4 | WP-PM-4 💲 Sales sheet and list | none |
| 5 | WP-PM-12a Change history | none |
| 6 | WP-PM-3 Turning products off | none |
| 7 | WP-PM-8 Setup checks | rate help text stays true after RT-1 (overlap 4) |
| 8 | WP-PM-9 Forms, units, containers | no aliases; conversion row, form and container rule per new spelling, tested first (overlap 3) |
| 9 | **DM-0 Data hygiene** (moved here) | overlap 9; Mason's SKU and duplicate step |
| 10 | WP-PM-5 Use Timing | option codes, timing codes, optional crop (overlap 1) |
| 11 | WP-PM-6a 💲 Unit audit | per-row approval by Mason; history preserved; lists the remaining `unit_size` readers (overlap 2) |
| 12 | WP-PM-6b 💲 New-product flow and basic Duplicate | the chemistry copy moves to DM-5 (overlap 7) |
| 13 | WP-PM-7 💲 One cost path and the tier-order warning | none |
| 14 | WP-PM-10 Bulk import | one rate-writing function; merges after DM-0's data step (overlaps 6, 9) |
| 15 | WP-PM-11a Detail workbook | a separate file and RPC; price workbook rate columns become read-only; merges after DM-0's data step (overlaps 5, 9) |
| 16 | WP-PM-11b List editing | none |
| 17 | WP-PM-12b Corrections | none |
| 18 | WP-PM-13 Reorder display | none |

The overnight loop (`docs/plans/2026-10-28-product-master-loop-MISSION.md`) runs Stage 1 only, in this order. DM-0's data step parks for Mason.

## 6. Stages 2 to 9

### Stage 2: weight, chemistry, EPA data (To-Do 2.9). Mason's order: weight first.
Stage 2 builds the **mechanisms** and fills the records that apply (Sol 52). Catalog coverage is tracked in section 7.

**DM-2 · Weight per gallon and dry net weight** (refresh plan; August WP-2, D-B, D-M; Sol 30 to 32)
- **Scope:**
  - Liquids store lb/gal. Specific gravity is converted on save with the pinned constant `WATER_LB_PER_GAL = 8.345404`, keeping the entered value and unit.
  - Dry packages store net weight, reconciled with `container_size`, `container_unit` and the canonical unit from WP-PM-6a, so two pack weights can't disagree.
  - **Trust order:** a value measured by Mason, then the safety data sheet, then the label, then the supplier. Every weight shown names the source it used.
  - The weight shows on the loader worksheet and blend ticket.
  - It fixes the blend checker that adds gallons to pounds (C-39).
  - Writes are admin-only, through a named RPC with a retry key and a version check. Every active user can read. Each change is audited with who made it, taken from the database session.
- **Done when:**
  - A test blend with three liquids and one dry product shows each weight and the total, matching a hand calculation.
  - A specific-gravity entry saves as the right lb/gal.
  - A product with no weight is refused by name, never guessed.
  - A non-admin save and a direct table write are refused.
  - A stale edit is refused.

**DM-1 · Active ingredients** (refresh plan; August WP-1, D-A, D-AA; Sol 28, 29, 32)
- **Required outputs:**
  - ingredient rows with strength and basis;
  - mode-of-action rows;
  - full fertilizer analysis, with oxide vs elemental kept apart and convertible;
  - biological CFU units;
  - "unknown" concentration kept apart from zero;
  - formulation type and safener.
- **D-A's three rules:**
  - strength stays on the specific chemical form;
  - a conversion fraction applies only to its matching basis;
  - a blank fraction forbids a numeric conversion.
- Fast entry and an admin cost per lb of active (CMP-1).
- The D-AA identity rules: CAS is the identity; merges are queued for Mason, never automatic.
- Same permission, audit and concurrency proofs as DM-2.
- **Done when:**
  - Two products with the same active show comparable lb of active per gallon and cost per lb, hand-checked on two real labels.
  - A salt, an acid-equivalent, an oxide/elemental and an isomer case each convert or refuse as D-A says.
  - A biological saves a CFU figure.

**REG-1 · Registration status per EPA number** (overlap 8)
- **Done when:**
  - Two brands of one generic show separate statuses.
  - A cancelled registration shows the product banner and the quote-add warning, and the sale still goes through.
  - A corrected number leaves an old delivery's printed number unchanged.

**DM-4 · EPA auto-fill** (backlog 38; August WP-4, D-I, D-L; Sol 33)
- EPA lookups land as proposals; nothing writes until an admin commits.
- **D-L:** Mason's typed chemistry stays live when EPA disagrees. The EPA value is stored beside it as a flagged difference, never overwriting it.
- **Done when:**
  - A product with a usable EPA number gets a proposal.
  - Committing writes it.
  - A product with typed chemistry that disagrees keeps its value and shows the difference.

**DM-1b · Chemistry tabs on the detail workbook** (August 1b, D-D, D-E, D-Y, D-Z; overlap 5)
- **Done when:**
  - Halex GT takes 3 rows on the Ingredients tab.
  - An upload lands as proposals, each value citing its source document.
  - An absent row changes nothing, and a `__delete` row proposes a delete.
  - A stale child edit is refused.
  - A product with a usable EPA number has its workbook chemistry refused by name.
  - A repeated upload with the same retry key writes once.

**DM-5 · Copy from a sibling, plus nickname** (overlap 7)
- **Done when:**
  - A copy from a matching sibling moves ingredients, density and brands in one step.
  - A copy to a sibling with a different formulation or safener is refused.
  - A stale version on either product refuses the whole copy.
  - Typing "Generic Callisto" finds the product on Products and in the quote picker.

### Stage 3: brands (To-Do 2.8, its own plan)
Brand step 1 is partly live: the `product_brands` list and the Brands section. Next is **brand PR B**: pick the delivered brand, print its EPA number, and keep RUP records per brand. It can run beside Stage 2, but not at the same time as a package editing `ProductDetail.tsx`.

**Carried forward from August WP-3 (Sol 6)** into PR B's acceptance:
- a brand must be picked at receiving and delivery when the product has brands;
- an unlisted brand can be typed in, and never blocks receiving (D-K);
- a split load records a quantity per brand;
- nothing depends on lot or tote numbers;
- delivery and invoice lines keep a snapshot of the brand name and EPA number.

**The cancelled-registration warnings** come after REG-1 (overlap 8). **Step 2** (stock and cost by brand) stays later.

### Stage 4: rates (August Phase 2). Highest risk: wrong rates put wrong quantities on customer documents.
**The old rate columns stay exactly as they are, and stay the ones every screen reads, until Mason has approved the new values and a pilot has been watched (Sol 3, 4).**

**RT-1 · The `product_rates` table, filled as an unapproved draft** (2.1 to 2.4, D-G; Sol 23 to 25)
- **What a rate row holds:**
  - a basis: per acre, per 100 gal (volume or weight), per unit, per cwt of seed, or per seed unit;
  - a source: label or house standard;
  - low, high and recommended values, and a unit.
- **Database rules:**
  - **zero or one** per-acre quoting default per product;
  - a non-acre default is refused;
  - a rate with no unit, an unknown unit, or a unit that doesn't fit its basis is refused, because the conversion helper today silently treats an unknown unit as factor 1;
  - low ≤ recommended ≤ high;
  - a house recommendation above a known label maximum is refused, or needs a recorded reason.
- RT-1 derives draft rows from today's values but **changes no reader and no old column**.
- **Done when:**
  - MSO XL holds two draft rates (label 2 qt/100 gal; house 9.6 oz/acre).
  - A second default, a non-acre default, a rate with a blank or unknown unit, and an inverted range are each refused.
  - Every quote, job and field-app screen shows exactly what it showed before.

**RT-2 · Unit spellings** (2.7, 2.7a, 2.7b, 2.8; overlap 3)
- **Done when:**
  - A fixed set of real quotes totals the same to the cent before and after.
  - Every product with an affected unit still saves in the local app.
  - Each step is checked in the harness, with the recovery path run once.

**RT-3 · Mason's rate review** (2.6, 2.10; Sol 26)
- Each draft row is approved or corrected by Mason, with who and when recorded, and its source text kept (`suggested_rate`).
- An unapproved row can't be promoted.
- **Done when:**
  - Every row has a recorded decision, including all 37 per-100-gal rows.
  - Representative quote, application and seed-treatment products show the expected quantities in the harness.

**RT-4 · Cut-over** (2.3, 2.4b, 2.9, 2.9a, D-F; overlap 6)
- **The flag:** a read switch, `product_rate_source_mode`, per product for a pilot first.
- **Rollback:** the old values are preserved as a frozen copy, so `legacy` mode reads them, not a mirror of the new values.
- **After the pilot is watched:**
  - the old columns become a trigger-kept copy of the approved default;
  - direct app writes are revoked (Mason-gated);
  - every writer moves to the rate RPC;
  - the field app's invented `'oz'` is removed.
- **Done when:**
  - A pilot product reads its approved rate.
  - Flipping it back restores the exact old reading.
  - A product with only a per-unit rate auto-fills blank on a quote.
  - A direct column write fails.
  - Every writer listed in the re-audit is proven.

**Per-crop rates** stay parked (August). RT-1 leaves room for an optional crop column.

### Stage 5: comparison (August Phase 3; Sol 27, 35)
- **CMP-1** (admin cost per lb of active) ships with DM-1.
- **CMP-2 · The full tool** comes **after RT-4** (Mason, August: comparison after the rate clean-up). It covers:
  - search by active ingredient through the canonical ingredient;
  - a mode-of-action filter;
  - build-from-generics cost;
  - customer price with a tier selector;
  - per-acre figures from approved quoting defaults;
  - money in whole cents.

  **Equivalence warnings, never silent substitution:**
  - salt and ester forms ("we pretty much only use ester");
  - formulation, safener and built-in surfactant;
  - the premium-quality difference (D-O), shown from the product's own data, with no new tier column (D-X);
  - adjuvant cost stated as excluded, with the bias against the premium product noted (D-P);
  - RUP never shown as verified.
- **Done when:**
  - Halex GT at 4 pt reproduces Mason's sheet exactly: 33.44 oz generic Roundup, 3.34 oz generic Callisto, 1.09 pt generic Dual.
  - The Resicore REV case reports its missing ingredient.
  - Switching the tier changes the price column and not the cost column.
  - An ester-to-amine swap and a safened-vs-unsafened pair each show a warning.

### Stage 6: use guidance (August Phase 4; Sol 40 to 42)
**USE-1 · Crop and timing pairs** (overlap 1)
- **Done when:**
  - A product with pre-emerge on corn and post-emerge on soybeans keeps both pairs after save and reload.
  - Old timings migrate with counts matching.
  - A detail-workbook export and re-import keeps the pairs.
  - A category change clears them after a confirm (Mason, 2026-10-28).

**USE-2 · Label link and adjuvants**
- The label comes from REG-1.
- Each product has a required or recommended adjuvant, with its type.
- **Behaviour is question 3.** Recommendation: warn when quoting, never block.
- **Done when:**
  - The label opens from the product page.
  - A product that requires COC shows the warning on a new quote line.
  - A label change reaches new quotes only.

**USE-3 · Quoting notes fill** (B-19)
- **Done when:**
  - A mass fill previews which products' quote notes change, and changes nothing until confirmed.
  - After an approved batch, a new quote line uses the new note.
  - Existing quotes keep theirs.

### Stage 7: families, pack sizes and returns (Mason: return policy "Later"; Sol 35 to 39)
**FAM-1 · Families**
- Families are derived from DM-1's specific ingredient rows and strength, plus the shared parent EPA registration.
- Each family is *proposed*, and only approved ones are written.
- **Excluded or flagged:**
  - products with no ingredients are left out;
  - differences in salt/ester form, formulation, safener, built-in surfactant and the premium tier are flagged;
  - drift (members with different density or ingredients) is flagged.
- The existing `product_families` columns are kept until a surveyed, Mason-approved change says otherwise.
- **Done when:**
  - The app proposes families, and nothing is written until approved.
  - A bulk row and a 2.5-gal row with different densities are flagged, not averaged.

**FAM-2 · Pack sizes join their family**
- **Done when:**
  - A new size made with Duplicate is *proposed* for the family, and joins only on approval.
  - A mismatched sibling is refused.

**RET-1 · Return-policy editor**
- Four values: returnable, no return, not applicable, unknown.
- **Before any batch is applied, Mason reviews the exact proposed list and approves that set.** Setting "no return" starts blocking real returns.
- **Done when (in the harness):**
  - Each value is tested through create, approve, receive and credit.
  - `unknown` still allows returns, and `no_return` blocks them through the delegated guards.
  - A batch applies fully or not at all.
- Not scheduled until Mason says so.

### Stage 8: clean-up (Sol 43, 44)
**CLN-1 · Retire `unit_size`** (after Stages 2 and 4; overlap 2)
- A fresh reference audit covers code, workbooks, stored functions and generated types.
- `inventory_unit` becomes required in the same migration, after a check for blanks.
- Dropping the column is destructive (section 3, rule 6).
- **Done when:**
  - Nothing reads `unit_size`.
  - Quote, job and crop-program totals match to the cent on a test set that includes mismatched units, open lines and old records.

**CLN-2 · Retire `ingredient_map` and the old Brand vs Generic page** (after CMP-2)
- Starts from a current survey of its rows and links, and an export of its rows.
- Updates the RLS contract test, generated types and the schema registry.
- Dropping the table is destructive (section 3, rule 6).
- **Done when:**
  - The replacement is verified.
  - The page is gone, and nothing references the table.

**CLN-3 · Name-vs-brand check** (B-16)
- **Done when:** a report lists every product name whose brands in brackets disagree with its brand rows, and changes nothing.

### Stage 9: product images (August Phase 8, last; Sol 46, 48)
- **IMG-1:** images copied into CRX storage, never hot-linked.
- **Who can see them is question 4.**
- **Done when:**
  - The storage policy is enforced in the database.
  - Uploads are admin-only.
  - Each role's view and upload are proven, refused where they should be.

---

## 7. The data work: the catalog has to be filled, not just the screens built

Every package's "done" is the *mechanism*. The app becomes useful only when the catalog is filled. This is the work no code does:

| # | Data | Rough size (August counts; recount first) | Who | When |
|---|---|---|---|---|
| DATA-1 | Forms, SKUs, duplicates, test row | 11 blank forms, 13 blank SKUs, 1 duplicate SKU, 3 duplicate-name groups, 1 test row | Mason types SKUs and approves each class | DM-0 (Stage 1) |
| DATA-2 | Missing EPA numbers on real pesticides | about 123 products | An agent drafts from labels; Mason reviews | Before DM-4 |
| DATA-3 | Rate review | about 573 rates, including 37 per-100-gal | Mason | RT-3 |
| DATA-4 | Densities and dry net weights | every liquid; one safety-sheet lookup each | An agent drafts into the workbook (D-Z); Mason reviews | After DM-2 and DM-1b |
| DATA-5 | Active ingredients | about 287 from the EPA lookup; the rest by workbook | EPA proposals, agent drafts, Mason review | DM-4, DM-1b |
| DATA-6 | Label REI/PHI and max label rate | most products | EPA label drafts, reviewed | With DM-4 |
| DATA-7 | RUP flags | count known wrong | EPA data and review; then WP-PM-14's notice comes off | With DM-4 |
| DATA-8 | Return policies, reorder points, margin floors | about 581 unknown policies; 0 of 595 reorder points | Mason | Later; reorder points and floors are already To-Do 0.2 and 0.8 |

**Order of entry (D-Y):** a ranked worklist from real orders and deliveries, refreshed when entry starts (Sol 54). Top sellers come first; the long tail is tracked after.

## 8. Full order across stages

1. **Stage 1** in section 5's order (19 packages, including DM-0).
2. **Stage 2:** DM-2 → DM-1 → REG-1 → DM-4 → DM-1b → DM-5. Data: DATA-2, then DATA-4 and DATA-5 from the D-Y worklist.
3. **Stage 3:** brand PR B beside Stage 2, with care over shared files; the warnings after REG-1.
4. **Stage 4:** RT-1 and RT-2 in either order, each on its own evidence. Then RT-3 (Mason's review), then RT-4.
5. **Stage 5:** CMP-2 after RT-4.
6. **Stage 6:** USE-1 (after WP-PM-5), then USE-2 (after REG-1), then USE-3.
7. **Stage 8:** CLN-3 after brand PR B; CLN-1 after Stages 2 and 4; CLN-2 after CMP-2.
8. **Stages 7 and 9** when Mason says so.

## 9. To-Do list changes made with this plan

- New row **2.10** (Stage 1, Product Master).
- **2.9** (Stage 2) gains REG-1, DM-1b and DM-5.
- **2.8** (Stage 3) gains the carried-forward brand requirements, and points to REG-1 for the warnings.
- New rows **2.11** (rates), **2.12** (comparison), **2.13** (use guidance) and **2.14** (clean-up).
- Stages 7 and 9 are added to the "Later features" list.

All new rows are ranked "SHOULD, proposed", until Mason answers question 1.

## 10. Questions for Mason (genuine business calls)

**Already settled, not reopened (Sol 47):**
- weight before chemistry, and Stage 2 after the before-delivery work unless the pilot needs weight-based blending (2026-10-28);
- an agent drafts catalog data and Mason reviews (D-Z);
- per-crop rates stay parked;
- an incomplete product is flagged, not blocked, so it can be priced straight away (2026-10-28).

**Open:**
1. **Ranking.** Recommend that Stage 1 (Product Master) and Stage 4 (rates) rank **SHOULD**, beside Stage 2, because both feed quoting. Stages 5, 6 and 8 rank SHOULD after those. Stages 7 and 9 are CAN-WAIT.
2. **Rate editing in the price workbook.** From WP-PM-11a until the new rate system is live (RT-4), rates could be changed only on the product page and through import, not in the price spreadsheet. Recommend **yes**: it keeps rate changes in one controlled place while they're being rebuilt.
3. **Required adjuvants (USE-2).** When a product needs an adjuvant (for example, COC) and the quote doesn't include one, should the app warn or block? Recommend **warn**.
4. **Product images (IMG-1).** Staff only, or also on customer-facing sheets (which needs public images)? Recommend **staff only** for now.
5. **Return-policy batch (RET-1), later.** When it is built, you approve the exact list of products and policies before any is applied. Recommend **yes**. Nothing is needed now.

## 11. Sol review record (2026-10-29)

**Reviewer:** `gpt-6-sol`, high effort, advisory, read-only. It was given this plan's draft, the build sheet, the refresh plan, and extracts of the August PRD (sections 6 and 9) and build plan (decisions, WP-5, section 4, the coverage matrix and the D-Y/D-Z amendment).

**Run checks:** exit 0; the tail canary was echoed; one verdict line. Result: **56 findings: 4 BLOCKER, 34 HIGH, 17 MED, 1 LOW.** The August decisions it cited (D-B, D-L, D-M, D-O, D-P, D-R, D-T, D-W, PRD 1.15) were spot-checked against the build plan and PRD, and match.

**Disposition:**
- **55 accepted**, and folded in where the table shows.
- **1 refuted:** finding 45 said sales reps may see cost on the old Brand vs Generic page. `BrandVsGeneric.tsx` loads cost only for admins (`withAdminCosts`), shows it only under `isAdmin`, and the database refuses cost reads for non-admins. So nothing is exposed. The page's direct writes to `ingredient_map` are retired with CLN-2.

| Findings | Where it landed |
|---|---|
| 1, 55 | Overlap 9; DM-0 moved into Stage 1 |
| 2, 34, 56 | Overlap 7; DM-5 restored as its own package, with nickname |
| 3, 4, 23 to 26 | Stage 4 (RT-1, RT-3, RT-4) |
| 5, 20 to 22 | Overlap 8; REG-1 |
| 6 | Stage 3, carried-forward requirements |
| 7, 8, 40 | Overlap 1; USE-1 |
| 9, 10, 43 | Overlap 2; CLN-1 |
| 11 to 13 | Overlap 3; RT-2 |
| 14 | Overlap 6 |
| 15 to 19 | Overlap 5; DM-1b; question 2 |
| 27, 35 | Stage 5 |
| 28, 29, 31 | DM-1, DM-2 |
| 30, 32 | DM-2, DM-1 |
| 33 | DM-4 |
| 36 to 39 | Stage 7 |
| 41 | USE-2; question 3 |
| 42 | USE-3 |
| 44 | CLN-2 |
| 45 | **Refuted** (above) |
| 46, 48 | Stage 9; question 4 |
| 47 | Section 10, the settled list |
| 49 to 51 | Section 3 |
| 52 | Stage 2 wording |
| 53 | Overlap 10; WP-PM-14 |
| 54 | Section 7 |
