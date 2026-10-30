# Product grand plan: product setup and the product data the rest of the app reads

**Status: PLAN, 2026-10-29, reviewed by Sol the same day. Mason answered its five questions the same day, then added the setup spreadsheet, vendors, one parent record per chemical, bulk by the gallon and a label link, and dropped CFU counts (overlaps 11 to 15; second Sol review in section 11). NOT STARTED.** Mason, in chat, 2026-10-29: "lets work through all of these Ideas since it all goes with our grain product master work in a way and all other functions of app will use these values for rest of app to work, we need all of this setup aswell so lets fold this into a grand plan, then send it all to Sol for review and make this another phase or revalute all of this work with our product master plan we just built." Sol (`gpt-6-sol`, high, advisory, read-only) returned 56 findings, 4 of them BLOCKERs. 55 are folded in below; 1 was refuted with evidence (section 11). Nothing here authorizes building. Building starts when Mason says so.

**What this plan is.** One ordered map of all product work:
- the October Product Master packages;
- the October weight-and-ingredient refresh;
- the brand plan;
- every August product-data phase that was never scheduled.

**Review update 2026-10-30:** Stage 1 may be built when Mason starts it. BLK-1 is split: quantity movements first after PAR-2, and average-purchase-cost tracking after the separately reviewed and activated inventory-costing foundation. That foundation is still parked and this plan does not authorize its build or live opening. See overlap 14 and the build mission for dependencies and proof rules.

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
| **1** | Product setup works and is checked by the database; the setup spreadsheet; vendors on the product page; a label link | WP-PM-1 to WP-PM-16, plus DM-0 | Build sheet | 2.10 |
| **2** | One parent record per formulation, then the mechanisms for weight, chemistry, EPA data and registration status | PAR-1, PAR-2, BLK-1, DM-2, DM-1, REG-1, DM-4, DM-1b | Mason 2026-10-29, refresh plan, August 1b, WP-5 and Phase 5 | 2.9 |
| **3** | Brands: which real brand filled a generic | Brand PR B, the cancelled-registration warnings, step 2 | Brand plan | 2.8 |
| **4** | Rates are trustworthy: low, high and recommended values, one quoting default, clean units | RT-1 to RT-4 | August Phase 2 | 2.11 |
| **5** | Compare products by chemistry, cost and price: **the Brand vs Generic page rebuilt from scratch, last** | CMP-2 | August Phase 3; Mason 2026-10-29 | 2.12 |
| **6** | Use guidance: crop and timing pairs, adjuvants, label link, quoting notes | USE-1 to USE-3 | August Phase 4 | 2.13 |
| **7** | Suggested groupings for leftovers, and return policy | FAM-1, RET-1 | August Phases 5 and 0b | Later (CAN-WAIT) |
| **8** | Clean-up: retire `unit_size`, retire `ingredient_map` once the rebuilt page replaces it, the name-vs-brand check | CLN-1 to CLN-3 | August Phases 7 and 3.8, B-16 | 2.14 |
| **9** | Product images | IMG-1 | August Phase 8 | Later (CAN-WAIT) |
| **Data** | Filling the catalog: Mason's and an agent's time, not code | DATA-1 to DATA-12 | Section 7 | With each stage |

Stage 1 is detailed in the build sheet and Sol-reviewed. The Stage 2 packages from the refresh plan are Sol-reviewed; PAR-1, PAR-2 and BLK-1 were added on 2026-10-29 and reviewed at plan level only (Sol's second and third reviews, section 11). Stages 2 (new parts) to 9 are designed here at "approach and done when" level. Each gets a full build-sheet treatment, and its own Sol review, before it is built.

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

**Vendors and pack sizes** (read-only live check, 2026-10-29)
- `products.vendor` is one text field: the default vendor. A new purchase order pre-fills it but accepts any vendor (`NewPurchaseOrder.tsx:168`), and "Need Reordering" groups by it (`InventoryPage.tsx:1502`).
- `product_supplier_links` already links one product to many vendors, each with the vendor's item name, item number, pack and unit conversion, and an `is_preferred` flag. The database allows at most one confirmed, active preferred link per product (`uq_product_supplier_links_preferred`, `20260718225511`). Vendor costs are kept per vendor in `supplier_price_observations`. Only the Supplier Pricing page uses them; only 10 links exist live, across 10 products. 13 vendors exist.
- Each sellable size is its own product row today. 134 product names contain "Bulk" and 56 rows are totes. `product_families` (0 rows) and `products.product_family_id` (unused) exist.

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

1. **Proof is local by default.**
   - Prove database behavior in the schema-matched harness with seeded edge cases. Observe the real app against an isolated database where available; otherwise record app behavior as owed, with non-saving UI checks and component tests as supporting evidence, not a substitute for observed behavior.
   - A live check is read-only unless Mason explicitly approves the exact live test in the current conversation.
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

Folding the plans together found ten places where two plans would build the same thing twice, or where one would undo the other (overlaps 1 to 10). Mason's additions the same day are overlaps 11 to 16. Each is settled below.

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
  - **Its rate columns become read-only in WP-PM-11a**, keeping D-C. Rates move to the setup workbook's Rates tab (overlap 11), so there is one spreadsheet place for rates.
- **The setup workbook** (new in WP-PM-11a; called "detail workbook" before overlap 11) is a separate file for everything except prices, with one repeat-safe RPC per tab.
  - DM-1b later adds Ingredients and Weights tabs to *this* file, and USE-1 adds Crop Uses. Chemistry is uploaded through a proposal RPC, never live (D-Z).
  - Its Rates tab writes only through the one rate-writing function (overlap 6), and obeys the rate lock (overlap 11).
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

**Superseded in part by overlap 13 (Mason, 2026-10-29):** with one parent record per chemical, shared values are entered once on the parent and reach every size, so DM-5's copy step is no longer needed and is dropped. The nickname moves to PAR-1. WP-PM-6b's basic Duplicate stays.

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

### 11. Setting up from a spreadsheet, then locking rates (WP-PM-11a, WP-PM-10, RT-1 to RT-4; Mason, 2026-10-29; Sol round 2: 2, 4 to 9, 11, 32)
Mason: "allow rates and everything to be adjusted from spreadsheet to help our initial setup ... i can edit that sheet to lock those rates once we get done." This replaces his earlier answer to question 2 (section 10).

**One setup workbook (WP-PM-11a)**, separate from the price workbook:
- **Tabs:** Setup fields, Rates, and Vendors. DM-1b (Stage 2) adds Ingredients and Weights; USE-1 (Stage 6) adds Crop Uses, when its storage exists.
- **Uploading:** every upload shows a preview of each change, and nothing saves until it's confirmed.
- **Confirming:** confirmation is **per tab**. The result screen shows exactly which rows saved.
- **Stale rows:** a row changed by someone else since the download is refused with its name, so an old spreadsheet can't overwrite newer work.
- **Grouping:** a workbook downloaded before products were grouped into parents (PAR-2) is refused as a whole.
- **Per tab:** each tab has its own repeat-safe RPC, with a retry key and admin check, so price approval and setup changes never mix.

**Rates have three states, and the lock is about the live ones:**
- **Live:** what quotes, jobs and the field app use today.
  - **Before RT-1:** today's `products` rate fields are the live rates.
  - **After RT-4:** the approved quoting rows in `product_rates` are the live rates.
- **Draft and approved:** RT-1's `product_rates` rows before they go live.
  - Drafts stay editable in the Rates tab during Mason's review (RT-3), **even while the lock is on**, because they aren't used anywhere yet.
  - An approved row can be changed only by going back to draft and being approved again.

**The "Lock rates" switch locks the live rates:**
- **Enforced in the database, not just on screen.** Every way of writing a live rate is refused while it is on, through a check that runs on the rate columns themselves:
  - today's `products` rate columns, through any route: spreadsheet, import, list, product page, the price workbook, direct table writes, `LabelDataQuality`;
  - and, after RT-4, the live `product_rates` rows.
- **The full list of write routes** is made from the code and the database when WP-PM-11a is built, and each route is proven refused.
- **No race with an upload:** switching the lock and writing a rate take turns on the same lock record. An upload that started before the switch can't save after it.
- **Who can switch it:** any admin (Mason, 2026-10-29, question 11). Every switch records who, when and a reason. The log shows any period it was off, and every rate change made in that period.
- **Interim protection, before every route uses the one rate-writing function:** the lock is a database check on the rate columns themselves, so it already covers the product page, the list, the price workbook and direct writes in Stage 1, before RT-4 moves them all onto the rate RPC. Each route is proven refused while locked.
- **The one exception while locked** is a dedicated admin correction operation:
  - one product at a time before PAR-1; **one parent at a time after PAR-1**, showing every size it affects before it is confirmed;
  - with a required reason;
  - with the product's expected version, so a stale correction is refused;
  - with a retry key;
  - never in a batch, never as a direct table write.

  It is logged like any rate change.

  PAR-1 copy-down and PAR-2 grouping are not general exceptions to the lock. With the lock on, a change to a live rate must go through this authorized, reasoned, version-checked single-parent correction; its internal copy to the sizes is part of that same atomic operation. Grouping that would change a live rate must wait for an authorized correction or an explicitly logged unlock. No direct or ordinary parent edit can bypass the lock. Prove locked and unlocked grouping, unchanged-rate grouping, stale versions, and concurrent lock changes.

  PAR-1 extends the existing one-product correction into the one-parent operation. Adding a new size while locked may only initialize its rate from the unchanged locked parent in the same authorized, version-checked parent operation; it cannot supply a different rate. Prove that initialization, rejection of an attempted different rate, and a concurrent lock change.

**Order:**
- Setup and review happen with the lock off.
- Mason turns it on when setup is done.
- RT-3's review runs on drafts, so it is unaffected.
- RT-4 promotes approved rows to live, one parent at a time.

**Rollback copy.** The snapshot RT-4 takes of the old live rates is never written again after it is taken. Only RT-4's own internal step keeps the old columns matched to the new live rows. That step runs only inside RT-4's database operations, can't be called by the app or used for a direct write, and logs every update; the lock refuses everything else.

**After PAR-1**, house rates belong to the parent record (overlap 13), so the Rates tab and the quoting default have one row per parent, and every size uses it.
- **When sizes disagree:** if sizes entered rates separately before grouping and they disagree, PAR-2 can't group them until Mason picks one value.

### 12. One product, many vendors (WP-PM-15; Mason, 2026-10-29; Sol round 2: 22 to 26, 36)
Mason: "a lot of chemical we normally go through Wells Ag Supply but I also order from other companies ... same exact product ... I do not want multiple of same chemicals just to segregate vendors."

**Settled:** the vendor is never part of a product's identity. **New package WP-PM-15**, built on the existing `product_supplier_links` and `supplier_price_observations`:

**Product page**
- A **Vendors section** lists every vendor the product is bought from: the vendor's item name, item number, pack and last cost.
- Linking goes through the existing `upsert_product_supplier_link`, brought up to the retry-key rule (section 3, rule 4) if it isn't already.
- **Starting point (DATA-11):** today only 10 links exist, while every product's vendor text is already used for purchasing. Before the copy rule is switched on, the app proposes a link for each product from its current vendor text (all 13 names match the 13 vendors), Mason reviews any that don't resolve, and nothing loses its vendor.
- A vendor-name match is only a proposal. The existing link writer also requires supplier product name, SKU, unit and pack description; obtain each from verified purchasing records or Mason, never invent placeholders. Incomplete or ambiguous records stay proposals with their legacy text preserved. Re-audit the current writer at build time and prove missing fields cannot become confirmed links. The affected cutover remains blocked until all required legacy cases are resolved.
- **Transition gate:** WP-PM-15 includes the proposal and review mechanism itself; it does not depend on the later setup workbook. Recount current vendors, preview matched and unresolved rows, and resolve them before enabling the copy rule. Until then preserve the old text and its working edit routes. A product with no link retains any unresolved legacy text, clearly flagged for review; it must not silently become "No vendor". The reviewed data changes require the applicable current-session approval and proof; a draft may be prepared before them, but the cutover cannot ship first.
- **Deliver in compatible steps:** first ship the proposal/review tool and compatible app writers with existing vendor behavior intact, then perform the separately approved data step. Only after data verification and deployment verification may a later PR apply and enable the copy rule. Because migrations apply before their app deploy, its database change must remain compatible with the currently deployed app and stale browser clients; prove old and new writers through that interval and either safely route them or keep enforcement inactive until a separately reviewed safe activation. Never reject ordinary existing writes in the gap. If compatibility cannot be proved, park enforcement and document the deployment and rollback sequence.
- **Preferred-vendor changes are one database operation:** the first active link becomes preferred automatically; switching preferred clears the old one and sets the new one together; two changes at once can't leave zero or two preferred.

**Preferred vendor**
- **A product with any active vendor link has exactly one preferred.** The database already allows at most one.
  - WP-PM-15 adds the other half: deactivating or unlinking the preferred vendor is refused until another is chosen. A product with no links has no preferred vendor; show "No vendor" only if it also has no unresolved legacy vendor text.
- **The vendor record is authoritative, not the name.** `products.vendor` (text) becomes a read-only display copy of the preferred vendor's name, kept in step by the database:
  - when the preferred vendor changes;
  - when the vendor is renamed;
  - when the link is deactivated or removed.
- A direct edit of the text is refused.

**Writers as well as readers:** before enforcing the guard, inventory the product page, new-product flow, list editing, CSV import and every database writer. In the same rollout, route supported edits to the vendor-link operation or give an actionable refusal without losing a product import. Prove each route, including a legacy row with no link and a vendor rename; do not wait for WP-PM-10 to repair a broken importer.

**Readers to check, each with its expected behaviour:**
- the new-PO pre-fill (`NewPurchaseOrder.tsx`);
- Need Reordering grouping (`InventoryPage.tsx`);
- the receiving vendor filter (`QuickReceivePanel.tsx`);
- bulk PO import (`BulkPOImport.tsx`);
- the field app and job lines (`FieldAppChemicalEntry.tsx`, `JobDetail.tsx`).

Current suggestions follow the new preferred vendor. **Historical POs, receipts and invoices keep the vendor recorded at the time** and are never rewritten.

**Purchase orders and reordering**
- **A new purchase order** suggests the preferred vendor and its last cost, and any linked vendor can be chosen. Anyone who can make a PO can save it with a vendor that isn't linked yet; that records a link *proposal*, which an admin confirms later. The PO is never blocked.
- **The suggested cost is converted to the PO's unit** using that vendor link's pack conversion, and shows its date and source.
  - If it can't be converted (no conversion on the link), no cost is suggested rather than a wrong one.
  - "Last paid" means the latest verified received PO cost for the same vendor and product, with its receipt date and unit. Supplier offers, contracts, promotions and quotes are not silently presented as paid cost; expired or unverified offers are never auto-filled. If no qualifying paid cost or safe unit conversion exists, leave the suggestion blank for an admin to enter or confirm.
- **Need Reordering** groups by preferred vendor and shows the other vendors' last cost beside it.

**Cost visibility:** cost is admin-only **in the database**: `supplier_price_observations.cost_cents` and any cost or price field returned by `get_supplier_pricing_workspace`, `get_supplier_market_evidence` and WP-PM-15's new operations. Each is named in the package plan and tested by a non-admin's direct requests, not only the screen.

### 13. One parent record per chemical, with each size as its own row (PAR-1, PAR-2; Mason, 2026-10-29; Sol round 2: 3, 10, 12 to 21, 35, 37)
Mason: "some chemical comes in different container sizes ... dry some are 5lb some are 10lb, liquid generally is 2.5 if package but bulk size changes on totes."

**Settled:**
- **Each sellable size stays its own product row**, with the same product ID it has today, because price, SKU, stock and reorder point differ by size. Quotes, orders, invoices and inventory keep working.
- **A parent record** sits above the size rows. It is a **new table**, not the old empty `product_families` table: Stage 7's suggested groupings mean something different, and keep that table.

**A parent is one exact formulation, not just "the same chemical".** These are always separate parents:
- a different strength or formulation type;
- a different safener;
- a different label (generic registration);
- a different quality tier: `Gen Liberty` and `Gen Liberty: Higher Quality` (D-O, D-X).

**Where each value lives** (Sol: label facts follow the EPA number, not the parent):

| Level | Values | Entered |
|---|---|---|
| **Parent** (the formulation) | Category, Use Timing, active ingredients and strength, weight per gallon (liquids), formulation type and safener, house rates and the quoting default, nickname, and the list of EPA registrations it carries | Once per formulation |
| **Registration** (each EPA number: the generic's own and each brand's; REG-1) | Signal word, RUP, REI/PHI, label maximum rates, label-required adjuvants, registration status, label link | Once per EPA number (a brand's manufacturer stays on its brand row, since several brands can share a number) |
| **Size** (each product row) | SKU, container size and unit, **net weight for a dry package** (a 5-lb and a 10-lb bag differ), prices, cost, stock, reorder point, vendor links, return policy | Once per size |

**Which label facts appear on a sale or RUP record:**
- **Today:** the generic's own registration.
- **Once the delivered brand is recorded (Stage 3):** the delivered brand's registration.

Until REG-1 exists, those fields stay on the size rows as today, and PAR-1 doesn't touch them.

**How sizes see the parent's values: decided now (Sol round 3, finding 5): copy down.**
- The parent is the **only writer** of parent-level values. The database copies each change to every size row in the same step, and the copied columns on size rows become database-owned: a direct write to them is refused.
- **Why copy rather than read through:** every existing reader (the 93 rate readers, quotes, jobs, invoices, PDFs, the field app) keeps working unchanged, so PAR-1 changes no money path. Reading through would rewrite all of them at once. RT-4 changes the rate readers later anyway, on its own proof.
- **Membership is checked by the database:** a size can be added to a parent only if its form and units fit the parent's (a liquid size under a liquid parent), and changing a parent's formulation identity (strength, formulation type, safener, generic registration) is refused while it has sizes; it is a new parent instead.
- A parent has at most one designated gallon-sold Bulk row. PAR-2 identifies the applicable Bulk row for each shop-filled fixed tote before a fill is enabled; missing or ambiguous mappings are review items, never guessed. A fixed tote that is never shop-filled need not have a Bulk source.
- **And:**
  - a parent edit is **one** recorded change (who, when, old and new) with its effect on each size traceable, and all-or-nothing;
  - it uses its own version number, so it never collides with the `pricing_version` check on price edits;
  - editing a shared value on a size row is refused, naming the parent;
  - the change-history trigger (WP-PM-12a) records it once, without repeating entries or looping.
- **Permissions:** PAR-1's plan lists every grant, revoke and trigger privilege before its migration is applied. Any change to existing `products` permissions needs Mason's `I approve` (section 3, rule 2).

**Duplicate after PAR-1** asks which one you mean:
- **"Add a size"**: a new row under the same parent, sharing everything at parent and registration level;
- **"New product"**: a new parent, with the formulation fields to confirm.

**Brands** (`product_brands`, one list per size row today) move up with registrations to the parent, by a reviewed migration: brand lists that agree across a parent's sizes merge; any that disagree (different brands, EPA numbers or sourced flags) go to Mason to settle in PAR-2 before the move; each brand keeps its `row_version` and history, and the brand write permissions stay as they are. So brand PR B is built **after** PAR-1 is live (Stage 3).

**Where chemistry comes from (D-Z), decided per registration:**
- If **any** registration on a parent has a usable EPA number, the chemistry comes only through EPA proposals.
- Clearing the generic's own number doesn't make the parent eligible for spreadsheet chemistry while a brand registration remains.

**PAR-2 groups the existing ~600 rows:**
- The app builds a **fixed, versioned proposal** of groups from name, EPA number and manufacturer. These are suggestions only, since EPA data is known to be incomplete.
- **What Mason sees for each group:**
  - its members;
  - every field where they disagree;
  - the value that will result.
- **Approval:** a field where members disagree can't be approved until Mason picks the value. A group or a batch is approved as shown, and a proposal that changed since he saw it is refused.
- **What grouping never changes:**
  - product IDs;
  - units;
  - stock, or any old order, invoice or ledger row.
- **Proof:**
  - a read-only baseline of representative quotes, jobs, invoices and inventory balances is captured first;
  - the same reads are compared in the harness after grouping;
  - references and balances match, not just row counts.

**Order:** PAR-1 and PAR-2 come first in Stage 2, before weight and ingredients, so that data is typed once per formulation, not once per size. This brings forward August Phase 5's pack-size half and replaces DM-5's copy step (overlap 7).

### 14. Bulk is sold by the gallon (DM-0, PAR-2; Mason, 2026-10-29; Sol round 2: 28 to 31)
**Settled:**
- Each formulation has **one Bulk product sold by the gallon**: a size row under its parent, whatever tote it goes out in. 134 rows already have "Bulk" in their name.
- **The tote is the container, not the product.** A tote's size changing never creates a new product.
- **A fixed package sold as a unit** (for example, a 265-gal no-return tote) stays its own size row, as today.

**In PAR-2, once parents exist** (not in DM-0): the 56 tote rows and the Bulk rows are audited, read-only:
- their units, prices and stock;
- every open order, PO and job that uses them.

**Mason marks each tote row** as either a real fixed package or a duplicate of the Bulk row.
- No quantity is converted without his approval of that conversion.
- Money and inventory totals are compared before and after, in the harness.

**Delivery records the quantity per brand** (Stage 3), whatever the container. Container or lot tracking is never a prerequisite (August R-5).

**Totes are filled both ways** (Mason, 2026-10-29, question 12: "both"):
- **Arriving already filled** from the vendor: received as that tote size, like any package.
- **Filled at the shop from bulk:** a new recorded stock step, **BLK-1 "Fill a tote from bulk"** (Stage 2, after PAR-2, which links each tote size to its Bulk row):
  - it takes the tote's gallons out of the Bulk stock and adds one tote to the tote's stock, in one step;
  - it's a database operation with a retry key and a recorded who and when;
  - **a shortfall in Bulk stock** warns and goes ahead, recording the shortfall for the next stock count, as deliveries do (Mason, 2026-10-29, question 14);
  - **BLK-1b purchase cost:** after the costing foundation is active, the tote's cost is its gallons at Bulk's current average purchase cost per gallon, in whole cents, with nothing added for the tote itself; a vendor-filled tote keeps the cost it was received at (Mason, 2026-10-29, question 15). BLK-1a records no purchase cost.
  - **Quantity-first decision (Mason, 2026-10-30):** bulk chemical pricing is tote pricing; Mason deferred to the recommendation to record quantities first. Pricing is not proof of actual purchase cost. BLK-1a records linked, repeat-safe bulk-out and tote-in stock movements, without changing catalog cost, prices or historical records. It does not claim an on-hand purchase cost or cost event.
  - **Inventory-value safeguard:** today's Inventory Value uses each product's catalog cost, so a transfer can change that display if the two rows' unit costs do not correspond. Before enabling BLK-1a, show a preview of the current catalog-basis value before and after, clearly label it as a catalog estimate, flag missing or mismatched costs and never silently assert a value-preserving transfer. Prove equal, unequal and missing cost cases; do not overwrite either catalog cost to make totals match. Report actual purchase-cost tracking as not yet available.
  - **Purchase-cost follow-up (BLK-1b):** refresh and separately plan the parked `docs/plans/2026-07-16-inventory-costing-plan.md` C1–C4 foundation, its opening valuation, negative-stock handling, repack events and C3 relabel of today's "Inventory Value" tile against current schema. Obtain owner decisions on opening date and values, tote classification and purchase-recording practice before activation; the separate returns-cost issue remains its own decision. Once activated, a shop fill transfers Bulk's current average purchase cost and a vendor-filled tote retains its received purchase cost. The opening plan explicitly accounts for quantity-only fills before activation without pretending their historic cost is known. This plan does not authorize the costing project's build or live opening.
  - BLK-1a locks source and destination rows in a stable order and records linked quantity movements atomically. BLK-1b adds linked cost events in the same transaction, exact unit factors, precision and one rounding rule; move attributable cents without creating or losing value and retain confidence/provisional status.
  - undo is a linked, authorized, repeat-safe opposite operation that restores the recorded quantity and, once BLK-1b is active, the original recorded cost, subject to a conservative stock-availability guard. Stock is fungible, so do not claim to identify a particular sold tote without actual tracking; the package design must prove when reversal is safe, including intervening receipts, deliveries and concurrent fills. If safety cannot be demonstrated, refuse and route for review.
  - full-capacity fills are the specified operation; partial fills are not represented as a full tote. Confirm the actual partial-fill workflow before extending the feature. Define authorized warehouse roles during the package design and prove unauthorized calls write nothing.

  *Done when (in the harness):*
  - filling a 265-gal tote from a Bulk stock of 1,000 gal leaves 735 gal and one more tote, and a repeat with the same retry key returns the first result and changes nothing;
  - two simultaneous identical fills using the same retry key record one movement pair and both return the same result;
  - two simultaneous 265-gal fills from 300 gal serialize: both record once, the first leaves 35 gal and the second warns and records a 230-gal shortfall; no movement is lost or duplicated;
  - a fill from 200 gal for a 265-gal tote warns, goes ahead, and records the 65-gal shortfall for the next count;
  - BLK-1a displays the before/after catalog-basis estimate and flags mismatched or missing costs; neither product's catalog cost changes and actual purchase cost is identified as unavailable;
  - BLK-1b cost events transfer Bulk's moving-average purchase cost in exact attributable cents, preserving confidence; vendor receipts retain their actual purchase cost. The separately reviewed costing design states factors and one rounding point. For the portion drawn below zero, use the last valid average provisionally or mark it unresolved if none exists; never silently use zero;
  - a safe undo restores recorded counts and, after BLK-1b, cents exactly; an unsafe or ambiguous undo and an unauthorized fill write nothing. Prove concurrent fill, retry, reversal and intervening stock movement.

**No tote deposits or container charges** (Mason, 2026-10-29, question 13: "no they dont"), so nothing is stored for them. Return policy stays on the sellable size, never on the parent.

### 15. A label link on every product (WP-PM-16, REG-1, USE-2; Mason, 2026-10-29)
Mason: "add a link to the label online of every product to easily review the label once get the epa number in."

**Today:** the EPA lookup already finds a product's latest label PDF (`supabase/functions/epa-lookup/logic.ts`, `latestLabelPdfUrl`). But the product page shows that link only right after a lookup is run (`ProductDetail.tsx:1146`), and it is never saved.

**Settled:**
- **WP-PM-16 (Stage 1, early, screen only):**
  - Every product with an EPA number gets a label button on the product page, and each brand row gets one for its own EPA number.
  - In Stage 1 the button is called **"Search EPA labels"**: it opens EPA's public label search for that number, which may list several label versions. It needs nothing stored; the exact address format is confirmed at build time. Once REG-1 saves the exact label PDF, the button becomes **"View label"** and opens that PDF.
  - A product with no EPA number shows "Add an EPA number to see the label".
  - After a lookup, the latest label PDF also opens directly, as today.
- **REG-1 (Stage 2)** then saves the latest label PDF link and its date for each EPA number, so "View label" opens the PDF itself. USE-2 reads it from there.
- **Done when (WP-PM-16):**
  - On three real products with EPA numbers and one brand row, "Search EPA labels" opens EPA's page for that exact number.
  - Numbers written differently (with spaces, leading zeros, or a distributor suffix such as 524-475-12345) open the right search; a badly formatted number shows the hint instead of a broken link.
  - If EPA's site is down, the product page still loads and the link simply fails on EPA's side.
  - A product without a number shows the hint.
  - Nothing is written to the database.

### 16. Categories: a pick list with "Seed" (WP-PM-8; Mason, 2026-10-29, question 10)
**Settled:**
- A category options table, admin-write only, seeded with today's 11 categories (all clean, checked live 2026-10-29) plus **"Seed"**.
- `products.category` must match an active option, trimmed and case-matched, enforced in the database. Existing rows already match.
- Changing a category and clearing timings that no longer apply is **one database step**: a direct category write that would leave Use Timing on a category that doesn't allow it is refused (Mason, 2026-10-28: timings only on Herbicide and Foliar Fertilizer).
- Manufacturer stays free text with the near-match warning; Vendor becomes the preferred vendor's copy (overlap 12).

## 5. Stage 1: Product Master

The build sheet's packages, in its section 4 order, with these changes from section 4 above. They are copied into the build sheet in the same change as this plan:

| Order | Package | Change |
|---|---|---|
| 1 | WP-PM-1 Dropdowns | none |
| 2 | **WP-PM-14 RUP "known incomplete" notice** (new, small, no database change) | overlap 10 |
| 3 | **WP-PM-16 "Search EPA labels" link** (new, small, no database change) | overlap 15 |
| 4 | WP-PM-2 💲 Pricing page | none |
| 5 | WP-PM-4 💲 Sales sheet and list | none |
| 6 | WP-PM-12a Change history | none |
| 7 | WP-PM-3 Turning products off | none |
| 8 | WP-PM-8 Setup checks | rate help text stays true after RT-1 (overlap 4) |
| 9 | WP-PM-9 Forms, units, containers | no aliases; conversion row, form and container rule per new spelling, tested first (overlap 3) |
| 10 | **DM-0 Data hygiene** (moved here) | overlap 9; Mason's SKU and exact-duplicate step, including the same size split by vendor (overlap 12); tote and Bulk decisions wait for PAR-2 (overlap 14) |
| 11 | WP-PM-5 Use Timing | option codes, timing codes, optional crop (overlap 1) |
| 12 | WP-PM-6a 💲 Unit audit | per-row approval by Mason; history preserved; lists the remaining `unit_size` readers (overlap 2) |
| 13 | WP-PM-6b 💲 New-product flow and basic Duplicate | no chemistry copy (DM-5 dropped); after PAR-1, Duplicate becomes "Add a size" or "New product" (overlaps 7, 13) |
| 14 | WP-PM-7 💲 One cost path and the tier-order warning | none |
| 15a–b | **WP-PM-15 💲 Vendors on the product page** (new) | proposal/compatible-writer PR, then separately gated enforcement PR; overlap 12 |
| 16 | WP-PM-11a **Setup workbook** | one file with Setup, Rates and Vendors tabs; the "Lock rates" switch; price workbook rate columns become read-only; merges after DM-0's data step (overlaps 5, 9, 11) |
| 17 | WP-PM-10 Bulk import | one rate-writing function; obeys the rate lock; merges after DM-0's data step (overlaps 6, 9, 11) |
| 18 | WP-PM-11b List editing | none |
| 19 | WP-PM-12b Corrections | none |
| 20 | WP-PM-13 Reorder display | none |

The overnight loop (`docs/plans/2026-10-28-product-master-loop-MISSION.md`) runs Stage 1 only, in this order: 21 queue entries, including both halves of WP-PM-15. DM-0's data step parks for Mason.

## 6. Stages 2 to 9

### Stage 2: parent records, then weight, chemistry, EPA data (To-Do 2.9). Mason's order: weight before chemistry.
Stage 2 builds the **mechanisms** and fills the records that apply (Sol 52). Catalog coverage is tracked in section 7. From PAR-1 on, formulation values (weight per gallon, ingredients, house rates) live on the parent, label facts live on each EPA registration (REG-1), and size values stay on each row (overlap 13's table).

**PAR-1 · Parent record per formulation, plus nickname** (overlap 13; August PRD 1.15)
- **Done when (in the harness):**
  - A liquid parent with a 2.5-gal jug, a fixed 265-gal tote and a Bulk size: changing its category or Use Timing changes all three sizes in one recorded change. A house-rate correction updates all three only through the rate-lock rules in overlap 11.
  - A dry parent with a 5-lb and a 10-lb bag: each keeps its own net weight.
  - Editing a parent-level value on one size row is refused, naming the parent.
  - A size's own price, SKU and stock change without touching its siblings, and a price edit's `pricing_version` check is unaffected by a parent edit made at the same time.
  - Two people editing the same parent: the second, stale edit is refused.
  - The change history shows one entry per parent edit, with each size's effect traceable.
  - "Add a size" and "New product" each create what they say.
  - Typing "Generic Callisto" finds the product on Products and in the quote picker.
  - A non-admin edit and a direct table write are refused, and a repeated request with the same retry key writes once.

**PAR-2 · Grouping existing products into parents** (overlap 13; DATA-9)
- **Done when (in the harness, against a copy of the live structure and data):**
  - The app proposes groups, and nothing is grouped until Mason approves a group or batch as shown.
  - `Gen Liberty` and `Gen Liberty: Higher Quality`, and a safened and an unsafened product, are never proposed as one group.
  - A group whose sizes disagree on a parent-level value (for example, two different house rates or Use Timings) can't be approved until Mason picks the value.
  - Label facts (REI/PHI, signal word, RUP, label maxima) are **not** merged by PAR-2: each size keeps its own until REG-1 reconciles them per EPA number.
  - A proposal that changed after Mason saw it is refused.
  - The read-only baseline (representative quotes, jobs, invoices and inventory balances) matches after grouping, references and balances included.
  - Every product ID still exists and still resolves on old records.
  - Each shop-filled fixed tote has exactly one reviewed, compatible Bulk source; no parent has two designated Bulk rows. Missing and ambiguous mappings remain unavailable for fill until resolved.

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
  - **Precision is stated:** weight per gallon is stored to 4 decimal places, and cost per pound of active is computed exactly and rounded once, to the cent, at the end; one liquid and one dry example are hand-checked.
  - A product with no weight is refused by name, never guessed.
  - A non-admin save and a direct table write are refused.
  - A stale edit is refused.

**DM-1 · Active ingredients** (refresh plan; August WP-1, D-A, D-AA; Sol 28, 29, 32)
- **Required outputs:**
  - ingredient rows with strength and basis;
  - mode-of-action rows;
  - full fertilizer analysis, with oxide vs elemental kept apart and convertible;
  - biologicals store no CFU count (Mason, 2026-10-29: it isn't on the registered label); any other registered active a biological carries is stored like any ingredient, and only the CFU figure is skipped;
  - "unknown" concentration kept apart from zero;
  - formulation type and safener.
- **D-A's three rules:**
  - strength stays on the specific chemical form;
  - a conversion fraction applies only to its matching basis;
  - a blank fraction forbids a numeric conversion.
- Fast entry and an admin cost per lb of active (CMP-1).
- **From DM-1 on, the old Brand vs Generic page is read-only** (its writes to `ingredient_map` are turned off), so there is never a second, unsynchronised ingredient list while the new data is entered. It stays readable until it is rebuilt at the very end (Stage 5, CMP-2).
- The D-AA identity rules: CAS is the identity; merges are queued for Mason, never automatic.
- Same permission, audit and concurrency proofs as DM-2.
- **Done when:**
  - Two products with the same active show comparable lb of active per gallon and cost per lb, hand-checked on two real labels.
  - A salt, an acid-equivalent, an oxide/elemental and an isomer case each convert or refuse as D-A says.
  - A biological saves with no CFU figure.

**REG-1 · Registration status per EPA number** (overlap 8)
- **Moving the label facts:** signal word, RUP, REI/PHI and label maxima move from size rows to registrations by a reviewed migration. Every reader and writer is listed first, including `LabelReview`, `LabelDataQuality`, the label drafts queue, quotes, jobs, the field app and the RUP register, with a compatibility period in which the old fields are kept matched, and a rollback plan.
- **Reconciling:** sizes that share one EPA number but disagree on a label fact go to Mason to pick the value; different EPA numbers stay separate registrations.
- **Done when:**
  - Two brands of one generic show separate statuses.
  - A cancelled registration shows the product banner and the quote-add warning, and the sale still goes through.
  - A corrected number leaves an old delivery's printed number unchanged.

**DM-4 · EPA auto-fill** (backlog 38; August WP-4, D-I, D-L; Sol 33)
- EPA lookups land as proposals; nothing writes until an admin commits.
- **D-L:** Mason's typed chemistry stays live when EPA disagrees. The EPA value is stored beside it as a flagged difference, never overwriting it.
- **Per registration:** each distinct EPA number on a parent (the generic's and each brand's) is looked up, proposed and reviewed on its own, and a failed lookup is reported for that number.
- **Done when:**
  - A product with a usable EPA number gets a proposal, and so does each brand registration.
  - A failed lookup is listed by number, and nothing is written for it.
  - Committing writes it.
  - A product with typed chemistry that disagrees keeps its value and shows the difference.

**DM-1b · Ingredients and Weights tabs on the setup workbook** (August 1b, D-D, D-E, D-Y, D-Z; overlap 5)
- **Weights tab:** weight per gallon per parent (liquids) and net weight per size (dry), each with its source; it uses DM-2's write RPC, version check and trust order, with the same preview and per-tab confirmation.
- **When a real EPA number's lookup fails** (DM-4), chemistry can still be entered as a reviewed manual proposal that keeps the EPA number; nobody has to clear a valid number to enter it.
- **Eligibility is per registration** (overlap 13): a parent with any usable EPA number gets chemistry from EPA proposals or the reviewed manual path, never a plain workbook upload.
- **Done when:**
  - Halex GT takes 3 rows on the Ingredients tab.
  - A Weights-tab upload of 20 liquids and 5 dry bags saves after the preview, each with its source; a missing source is refused.
  - An upload lands as proposals, each value citing its source document.
  - An absent row changes nothing, and a `__delete` row proposes a delete.
  - A stale child edit is refused.
  - A product with a usable EPA number has its workbook chemistry refused by name.
  - A repeated upload with the same retry key writes once.

**DM-5 · dropped (2026-10-29).** Parent records (PAR-1) replace copying between sizes; the nickname moved to PAR-1 (overlaps 7, 13).

### Stage 3: brands (To-Do 2.8, its own plan)
Brand step 1 is partly live: the `product_brands` list and the Brands section. Next is **brand PR B**: pick the delivered brand, print its EPA number, and keep RUP records per brand. **PAR-1 moves brands up to the parent (overlap 13), so PR B is built after PAR-1 is live** (its migration applied and its brand move done), designed and reviewed against that structure, and not at the same time as a package editing `ProductDetail.tsx`.

**Carried forward from August WP-3 (Sol 6)** into PR B's acceptance:
- a brand must be picked at delivery when the product has brands (picking it at receiving is step 2, with the same rules);
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
  - **zero or one** per-acre quoting default per **parent**, enforced in PostgreSQL (before PAR-1 exists, RT-1 isn't built, so the key is always the parent);
  - a non-acre default is refused;
  - a rate with no unit, an unknown unit, or a unit that doesn't fit its basis is refused, because the conversion helper today silently treats an unknown unit as factor 1;
  - low ≤ recommended ≤ high;
  - **a house rate above the applicable registration's label maximum warns, never blocks** (Mason, 2026-10-29: "over label rate needs to warn not block"): saving it needs the warning acknowledged with a recorded reason, and every place the rate is used (quote line, job, applicator sheet, field app) shows an "above label rate" warning; where the maximum is unknown or the units can't be compared, the row is flagged "label maximum not checked";
  - **the allowed units for each basis are listed, with their conversion factors and rounding**: per acre (volume or weight), per 100 gallons (volume, or weight such as 17 lb/100 gal), per unit, per cwt of seed and per seed unit; each is proven with a hand-worked example.
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
- Each draft row is approved or corrected by Mason, with who and when recorded, and its source text kept (`suggested_rate`). Mason reviews in the setup workbook's Rates tab (overlap 11): download, correct, upload, confirm the preview. Drafts stay editable while the live-rate lock is on.
- An unapproved row can't be promoted.
- **Done when:**
  - Every row has a recorded decision, including all 37 per-100-gal rows.
  - **Every parent** has an explicit outcome before promotion: its approved default, "no per-acre default" (so quotes auto-fill blank), or "needs label data" (held back). A parent with no imported rate, an unknown unit or several candidate defaults can't be promoted until Mason decides.
  - Representative quote, application and seed-treatment products show the expected quantities in the harness.

**RT-4 · Cut-over** (2.3, 2.4b, 2.9, 2.9a, D-F; overlap 6)
- **Before it starts:** the "Lock rates" switch is on (overlap 11).
- **The key:** the quoting default and the cut-over are per **parent** (PAR-1), so all sizes of a formulation switch together; no size is left on old rates while a sibling is on new ones.
- **How the 93 readers see new rates (decided before any pilot):** they keep reading the old `products` rate columns. When a parent is switched, RT-4's internal step (overlap 11) fills those columns on all its sizes from the parent's approved default, in the same database step. Readers therefore change nothing, and this is proven for quotes, jobs, the field app and PDFs before the pilot.
- **The flag:** a read switch, `product_rate_source_mode`, per parent for a pilot first.
- **Rollback:** the old values are copied once into a snapshot that is never written again. Switching a parent back to `legacy` puts the snapshot values back into its sizes' columns, through the same internal step.
- **After the pilot is watched:**
  - the remaining parents switch the same way;
  - direct app writes are revoked (Mason-gated);
  - every writer moves to the rate RPC;
  - the field app's invented `'oz'` is removed.
- **Done when:**
  - A pilot product reads its approved rate.
  - Flipping it back restores the exact old reading, and a correction made after cut-over doesn't change the snapshot.
  - A product with only a per-unit rate auto-fills blank on a quote.
  - A direct column write fails.
  - Every writer listed in the re-audit is proven.

**Per-crop rates** stay parked (August). RT-1 leaves room for an optional crop column.

### Stage 5: comparison (August Phase 3; Sol 27, 35)
- **CMP-1** (admin cost per lb of active) ships with DM-1.
- **CMP-2 · The full tool, as a complete rebuild of the Brand vs Generic page.** Mason, 2026-10-29: "the old brand vs generic page will get completely re done once all of this work is finished." Build it after the other planned product features and RT-4; CLN-2 necessarily follows it to retire the old table. Optional stages stay subject to Mason's scheduling choice; do not silently waive his last-feature decision if any remain unfinished. It reads only the new data (parents, registrations, ingredients, weights, approved rates), never `ingredient_map`. It covers:
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
- The pairs belong to the **parent** (Use Timing is a parent value, overlap 13), so every size shows the same pairs.
- It adds the setup workbook's **Crop Uses** tab, now that its storage exists.
- **Done when:**
  - Two sizes of one parent show the same pairs; editing one size's pairs is refused, naming the parent.
  - A product with pre-emerge on corn and post-emerge on soybeans keeps both pairs after save and reload.
  - Old timings migrate with counts matching.
  - A detail-workbook export and re-import keeps the pairs.
  - A category change clears them after a confirm (Mason, 2026-10-28).

**USE-2 · Label link and adjuvants**
- The label link exists from Stage 1 (WP-PM-16); REG-1 saves the PDF link per EPA number.
- Each **registration** (REG-1) records a label-required or recommended adjuvant, with its type, since it comes from the label. Before a brand is chosen, the quote uses the generic's own registration; once the delivered brand is known, its registration.
- **Behaviour (Mason, 2026-10-29):** warn when quoting, never block.
- **Done when:**
  - The label opens from the product page.
  - A product that requires COC shows the warning on a new quote line.
  - A label change reaches new quotes only.

**USE-3 · Quoting notes fill** (B-19)
- **Done when:**
  - A mass fill previews which products' quote notes change, and changes nothing until confirmed.
  - After an approved batch, a new quote line uses the new note.
  - Existing quotes keep theirs.

### Stage 7: suggested groupings and returns (Mason: return policy "Later"; Sol 35 to 39)
Pack sizes and parent records moved to Stage 2 (PAR-1, PAR-2; overlap 13). What remains here:

**FAM-1 · Suggested groupings for ungrouped products**
- For products PAR-2 left ungrouped, groupings are suggested from DM-1's specific ingredient rows and strength, plus the shared parent EPA registration.
- Each family is *proposed*, and only approved ones are written.
- **Excluded or flagged:**
  - products with no ingredients are left out;
  - differences in salt/ester form, formulation, safener, built-in surfactant and the premium tier are flagged;
  - drift (members with different density or ingredients) is flagged.
- The existing `product_families` columns are kept until a surveyed, Mason-approved change says otherwise.
- **Done when:**
  - The app proposes families, and nothing is written until approved.
  - A bulk row and a 2.5-gal row with different densities are flagged, not averaged.

**FAM-2 · moved:** a new size is added under its parent record in PAR-1.

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

**CLN-2 · Retire `ingredient_map`** (after CMP-2's rebuilt page replaces the old one)
- Starts from a current survey of its rows and links, and an export of its rows.
- Updates the RLS contract test, generated types and the schema registry.
- Dropping the table is destructive (section 3, rule 6).
- **Done when:**
  - The replacement is verified.
  - The rebuilt page is the only Brand vs Generic page, and nothing references the old table.

**CLN-3 · Name-vs-brand check** (B-16)
- **Done when:** a report lists every product name whose brands in brackets disagree with its brand rows, and changes nothing.

### Stage 9: product images (August Phase 8, last; Sol 46, 48)
- **IMG-1:** images copied into CRX storage, never hot-linked.
- **Staff only for now** (Mason, 2026-10-29): private storage, not on customer-facing sheets.
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
| DATA-7 | RUP flags | count known wrong | EPA data and review. WP-PM-14's notice comes off only when every pesticide product with an EPA number has a reviewed RUP flag (a coverage count of 100%) and Mason has spot-checked the register against EPA | With DM-4 |
| DATA-8 | Return policies, reorder points, margin floors | about 581 unknown policies; 0 of 595 reorder points | Mason | Later; reorder points and floors are already To-Do 0.2 and 0.8 |
| DATA-9 | Grouping sizes under parent records | about 600 rows; the app proposes groups | Mason approves each group | PAR-2 |
| DATA-10 | **Exact duplicates** (the same product and size split by vendor): keep, or merge into one row | from DM-0's list | Mason, in DM-0's review list. Each merge: both product IDs are kept; the merged row is turned off and points to the kept row; its open lines, vendor links and price history are mapped to the kept row; stock moves by recorded, reversible adjustments; old records still show what they showed; quote, invoice and inventory totals are compared before and after, to the cent | DM-0 (Stage 1) |
| DATA-12 | Tote and Bulk rows: a real fixed package, or a duplicate of Bulk | 56 tote rows | Mason, in PAR-2's review | PAR-2 (Stage 2) |
| DATA-11 | Vendor links for each product | 10 links existed at the prior survey; recount | Proposal and review in WP-PM-15; Mason resolves exceptions | Before the WP-PM-15 copy-rule cutover; the later workbook maintains links |

**Type shared values once:** house rates, chemistry and weight per gallon are best entered after PAR-2, on the parent (once per formulation), and label facts once per EPA registration (REG-1), never once per size. Setup and clean-up of size rows (DATA-1, DATA-10, DATA-11) can start in Stage 1.

**Order of entry (D-Y):** a ranked worklist from real orders and deliveries, refreshed when entry starts (Sol 54). Top sellers come first; the long tail is tracked after.

## 8. Full order across stages

1. **Stage 1** in section 5's order (21 queue entries, including both halves of WP-PM-15). Data: DATA-1 and DATA-10 (DM-0's review list), then DATA-11; rates in the setup workbook only if Mason wants them before parents exist (PAR-2 then asks him to settle any sizes that disagree).
2. **Stage 2:** PAR-1 → PAR-2, then BLK-1a may record quantities and DM-2 → DM-1 → REG-1 → DM-4 → DM-1b proceed independently. BLK-1b follows the separately reviewed and activated costing foundation. Data: DATA-9, then DATA-2, then DATA-4 and DATA-5 from the D-Y worklist.
3. **Stage 3:** brand PR B after PAR-1 is live, then beside the rest of Stage 2, with care over shared files; the warnings after REG-1.
4. **Stage 4:** RT-1 and RT-2 in either order, each on its own evidence. Then RT-3 (Mason's review), then RT-4.
5. **Stage 5:** CMP-2 follows the other planned product features; CLN-2 follows CMP-2. Resolve the scheduling of optional stages before claiming the last-feature condition is met.
6. **Stage 6:** USE-1 (after WP-PM-5), then USE-2 (after REG-1), then USE-3.
7. **Stage 8:** CLN-3 after brand PR B; CLN-1 after Stages 2 and 4; CLN-2 right after CMP-2.
8. **Stages 7 and 9** when Mason says so.
9. **The rate lock** goes on when Mason finishes setup, and before RT-4.

## 9. To-Do list changes made with this plan

- New row **2.10** (Stage 1, Product Master).
- **2.9** (Stage 2) gains PAR-1, PAR-2, REG-1 and DM-1b (DM-5 dropped).
- **2.8** (Stage 3) gains the carried-forward brand requirements, and points to REG-1 for the warnings.
- New rows **2.11** (rates), **2.12** (comparison), **2.13** (use guidance) and **2.14** (clean-up).
- Stages 7 and 9 are added to the "Later features" list.

Ranked per Mason's answer to question 1 (2026-10-29).

## 10. Questions for Mason (genuine business calls)

**Already settled, not reopened (Sol 47):**
- weight before chemistry, and Stage 2 after the before-delivery work unless the pilot needs weight-based blending (2026-10-28);
- an agent drafts catalog data and Mason reviews (D-Z);
- per-crop rates stay parked;
- an incomplete product is flagged, not blocked, so it can be priced straight away (2026-10-28).

**Answered by Mason, 2026-10-29** ("1. yes, 2. yes , 3. warn, 4. staff only for now, 5. yes"; DECISION_LOG 2026-10-29). Each as recommended:
1. **Ranking:** Stage 1 (Product Master) and Stage 4 (rates) rank **SHOULD**, beside Stage 2. Stages 5, 6 and 8 rank SHOULD after those. Stages 7 and 9 are CAN-WAIT.
2. **Rate editing in the price workbook:** **yes**, it stops. *Revised the same day:* rates move to the setup workbook's Rates tab and stay editable there until Mason turns on the rate lock (overlap 11).
3. **Required adjuvants (USE-2):** **warn**, never block.
4. **Product images (IMG-1):** **staff only** for now, in private storage.
5. **Return-policy batch (RET-1), later:** **yes**, Mason approves the exact list before any batch applies.

**Answered by Mason, 2026-10-29, second set** ("1. yes, 2. yes, 3. yes, 4. yes"; DECISION_LOG 2026-10-29):
6. **Setup by spreadsheet, then lock:** yes (overlap 11).
7. **One product, many vendors, one preferred:** yes (overlap 12).
8. **One parent record per chemical, sizes as their own rows, moved early:** yes (overlap 13).
9. **Bulk sold by the gallon, whatever the tote:** yes (overlap 14).

**Answered by Mason, 2026-10-29, third set** ("10. yes to both, 11. admin, 12. both, 13. no they dont"; DECISION_LOG 2026-10-29):
10. **Categories.** Today there are 11 (Herbicide, Fungicide, Insecticide, Liquid Fertilizer, Foliar Fertilizer, Adjuvant, Seed Treatment, Dry Water Soluble Fertilizer, Other, Biological, Nitrogen Stabilizer). The box takes any typed text. Recommend: add a **"Seed"** category beside the new seed form, and lock categories to an admin-maintained list (like the Use Timing options). **Answer: yes to both.** WP-PM-8 adds the "Seed" category and turns the category box into a pick list from an admin-maintained options table, enforced in the database (existing categories kept as they are).
11. **Who can turn the rate lock off** (overlap 11)? Recommended only Mason's own account. **Answer: any admin**, with who, when and a reason recorded each time.
12. **Fixed totes and bulk stock** (overlap 14): are fixed-size totes filled at your shop from your bulk supply, or do they arrive already filled from the vendor? **Answer: both.** Vendor-filled totes are received as packages; shop-filled totes use BLK-1 (overlap 14).
13. **Tote deposits and returns** (overlap 14): do any totes carry a deposit or a charge, and come back to you or the vendor? **Answer: no.** No deposit or container charge is stored.

**Answered by Mason, 2026-10-29, fourth set ("Yes, as recommended"):**
14. **Filling a tote when the system shows too little Bulk** (BLK-1): warn and allow, recording the shortfall for the next stock count (like deliveries), or refuse the fill? Recommend **warn and allow**, because a stock count can be wrong while the tank really has the product. **Answer: warn and allow.**
15. **What a shop-filled tote costs** (BLK-1): its gallons at Bulk's current average cost per gallon, with nothing added for the tote itself? Recommend **yes**. A vendor-filled tote keeps the cost it was received at. **Answer: yes.**

**Over-label rates (Mason, 2026-10-29: "over label rate needs to warn not block"):** a house rate above the label's maximum warns with a recorded reason and is flagged wherever it's used; it is never refused (RT-1).

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

### Second review (2026-10-29): Mason's additions, overlaps 11 to 14

**Reviewer and run:** `gpt-6-sol`, high, advisory, read-only. It was given the diff of the additions, the full updated plan and the build sheet's sections 2a to 4. Exit 0; the tail canary was echoed; one verdict line. **38 findings: 3 BLOCKER, 25 HIGH, 9 MED, 1 LOW. All 38 accepted**, none refuted. Mason's two later changes (no CFU count; a label link, overlap 15) were added after this run, are small, and are recorded in the decision log.

| Findings | Where it landed |
|---|---|
| 1 (BLOCKER) | DATA-10 moved to DM-0's review list; the setup workbook's Vendors tab only links vendors (DATA-11) |
| 2 (BLOCKER), 4 to 9, 11, 32 | Overlap 11: three rate states, the lock on live rates only, database enforcement, race, unlock rule (question 11), correction operation, immutable snapshot, per-tab confirmation and stale-row refusal |
| 3 (BLOCKER), 15, 21 | Overlap 13's table: label facts per EPA registration, net weight per size, D-Z per registration |
| 10 | RT-4 keyed per parent |
| 12 to 14 | Overlap 13: read-through vs copy decided in PAR-1's review against stated rules |
| 16 | A new parent table; `product_families` left for Stage 7 |
| 17, 18, 35, 37 | Overlap 13 (exact formulation identity) and PAR-2's proposal and baseline proof |
| 19 | Duplicate becomes "Add a size" or "New product" |
| 20 | Stage 3: PR B after PAR-1's design |
| 22 to 26, 36 | Overlap 12 |
| 27 | DATA-10: approved merges with mapping and recorded stock adjustment |
| 28 to 31 | Overlap 14; questions 12 and 13 |
| 33, 34 | Overlap 11 and 12 (retry keys, permissions); section 3 rules 2 to 4 apply to every new operation |
| 38 | Section 1 and the Stage 1 table wording |

### Third review (2026-10-29): the whole final plan

**Reviewer and run:** `gpt-6-sol`, high, advisory, read-only. It was given the full grand plan, the full build sheet, the mission's work queue, To-Do rows 2.8 to 2.14, the 2026-10-29 decision-log entries and the refresh plan. Exit 0; the tail canary was echoed; one verdict line. **51 findings: 4 BLOCKER, 31 HIGH, 15 MED, 1 LOW. All 51 accepted**, none refuted. Finding 1 was about the build sheet's old "Brainstorm for Sol" headings, which read as instructions to a reviewer; they are relabelled as questions already answered.

| Findings | Where it landed |
|---|---|
| 1, 17, 43, 45 | Build sheet wording (relabelled questions; WP-PM-1, WP-PM-8, section 3, WP-PM-11a) |
| 2, 8 | PAR-2 leaves label facts alone; REG-1 moves and reconciles them with a reader inventory |
| 3 | RT-1: a rate above the label maximum is checked, then warns (Mason chose warn over refuse) |
| 4, 12 | RT-4: readers keep the old columns, filled by RT-4's internal step; rollback through the same step |
| 5, 6 | Overlap 13: copy-down decided; database membership checks |
| 7, 9 | Overlap 13 brands migration; Stage 3 after PAR-1 is live |
| 10, 11, 13 | RT-1 per parent; the locked correction per parent; interim lock protection |
| 14 | Stage 1 order: the setup workbook and lock before bulk import |
| 15, 18 to 20 | Overlap 12 (cost fields named, starting links, preferred operations, PO link proposals) |
| 16, 37 | New overlap 16 (categories) |
| 21, 22 | DM-0 does exact duplicates only (DATA-10 rules); totes move to PAR-2 (DATA-12) |
| 23 to 25 | BLK-1; questions 14 and 15 |
| 26, 27, 28, 29 | Crop Uses tab to USE-1; Weights tab in DM-1b; manual proposal path; DM-4 per registration |
| 30, 49 | WP-PM-16 is "Search EPA labels" until REG-1; more test cases |
| 31, 32, 33 | Brand manufacturer on the brand row; adjuvants per registration; USE-1 per parent |
| 34 | DM-1 makes the old Brand vs Generic page read-only |
| 35 | Build sheet WP-PM-6b: every price-required path proven |
| 36 | DM-1: only the CFU figure is skipped |
| 38 | Build sheet WP-PM-8: rows affected by each new check listed with a correction path |
| 39, 40, 41 | RT-1 unit matrix; RT-3 per-parent outcome; DM-2 precision |
| 42 | DATA-7: measurable removal of the RUP notice |
| 44, 46, 47, 48 | Mission, To-Do 2.8 and 2.9, decision log |
| 50 | Section 1 review status |
| 51 | Overlap 13's table |
