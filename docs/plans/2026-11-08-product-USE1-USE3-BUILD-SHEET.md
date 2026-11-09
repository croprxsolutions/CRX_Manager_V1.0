# Product Master Stage 6: USE-1 and USE-3 build sheet (crop and timing pairs; quoting notes fill)

**Status (2026-11-08):** a plan only. No code and no migration have been written. It was written against `main` (`4504e3e6a`) and the live database, using read-only SQL only. For building, this sheet replaces the USE-1 and USE-3 outlines in `docs/plans/2026-10-29-product-GRAND-PLAN.md` Stage 6. Where the two differ, this sheet wins on *how*, and section 2 lists each difference; the grand plan still wins on order and on Mason's settled decisions. A reference like "overlap 1" points to the grand plan's section 4. Nothing here authorizes building; each package starts when Mason says so.

**USE-2 is not in this sheet.** USE-2 (label link and adjuvants) stores label-required adjuvants per EPA registration, so it builds on REG-1. REG-1's next step waits on Taha's PR #1524. USE-2 gets its own sheet once REG-1 is live. Nothing in USE-1 or USE-3 depends on USE-2, or blocks it.

**What the two packages do, in one line each.**
- **USE-1:** lets a product say "pre-emerge on corn" and "post-emerge on soybeans" as separate crop-and-timing choices, and lets an admin add a new pair (for example "Post-Emerge Wheat") without a code change.
- **USE-3:** lets Mason fill the customer-facing "quoting notes" for many products at once from the setup spreadsheet, and shows, before saving, exactly what a new quote line will show before and after.

**Words used here.**
- **Pair:** one crop with one timing, such as corn + pre-emergence, within one product category (a Herbicide timing and a Foliar Fertilizer timing are different things even with the same crop). "Any crop" is allowed.
- **Option:** one row of `product_use_timing_options`. Each option already has a label ("Pre-Emerge Corn"), a timing code (`pre_emergence`) and an optional crop (`corn`). **An option is a pair** (section 3.1).
- **Parent / size:** as in the Stage 2 sheet. A parent is one formulation; each size is a product row. Use timings belong to the parent and are copied down to every size by the database (PAR-1).
- **Quoting note:** `products.quoting_notes`, the text that auto-fills into a new quote line's notes.
- **Description:** `products.notes`, the product's general notes. Today it is the fallback when the quoting note is blank.
- **Setup workbook:** the spreadsheet download/upload on the Products page (WP-PM-11a-2), separate from the price workbook.

---

## 1. Facts this plan is built on (checked 2026-11-08)

**Live data (counts only; no product rows in this repo):**

| Fact | Value |
|---|---|
| Products (all / active) | 604 / 596 |
| Products with any use timing | 317, every one with exactly **one** option (0 with two or more) |
| …by option code | `post_emergence` 91, `pre_emerge_soybean` 84, `pre_emerge_corn` 57, `foliar` 53, `range_pasture_turf` 25, `volunteer_corn` 7 |
| …by category | Herbicide and Foliar Fertilizer only |
| Products whose legacy `use_timing` text is set | 317 (matches the list, as the sync trigger keeps them equal) |
| `product_use_timing_options` | 9 rows, all active; no admin screen or RPC writes them (migration only) |
| Parents / members | 0 / 0 (PAR-1 and PAR-2 database parts are live; no group approved yet) |
| Parents with use timings | 0 |
| `quoting_notes` filled | **0** of 604 |
| `notes` (description) filled | 444 |
| `internal_notes` filled | 443 |
| Active products whose new quote line today auto-fills from the **description** (quoting note blank, description set) | **442** |
| A crop table or crop-use table | none. The only fixed crop list in the database is the `customers.crops` CHECK: `corn`, `soybeans`, `wheat`, `milo`, `cotton`, `alfalfa`, `pasture_hay`, `other` |
| Latest live migration | `20261215110000_chem_sale_bill_split_invoices` (this repo's migration stamps run ahead of the calendar by convention; it is live per `supabase_migrations.schema_migrations`, ledger version `20261109032913`) |
| `20261202110000_product_size_notes_in_one_step` (notes saved with "New product" in one step) | **not applied** (local candidate) |

**Where Use Timing lives today (code):**

| Thing | Where | What it does |
|---|---|---|
| Options table | `20261103210000_product_use_timings.sql` | `code` (PK), `label` (unique, no `;`), `timing_code`, `crop` (nullable, free text), `category` (CHECK Herbicide or Foliar Fertilizer), `sort_order`, `is_active`. RLS on; SELECT for active profiles; no write grant to any app role. |
| The 9 options | same file | `pre_emerge` (any crop, pre), `pre_emerge_corn` (corn, pre), `pre_emerge_soybean` (soybeans, pre), `post_emergence` (any, post), `post_emerge_corn` (corn, post), `post_emerge_soybeans` (soybeans, post), `volunteer_corn` (corn, `volunteer_corn`), `range_pasture_turf` (any, `range_pasture_turf`), `foliar` (any, `foliar`; Foliar Fertilizer). |
| Size storage | `products.use_timings text[]` (codes) and `products.use_timing text` (labels joined by `; `) | `sync_product_use_timings()` (trigger `trg_sync_product_use_timings`) keeps the two equal, refuses unknown codes, refuses a code whose option belongs to another category, refuses timings on any category but Herbicide and Foliar Fertilizer, and lets a product keep an option that was later turned off. |
| Parent storage | `product_parents.use_timings text[]` (`20261108120000_product_parents.sql:122`) | Written only by `create_product_with_parent` and `update_product_parent` (which checks each code with `_product_parent_timings`), and copied to every size by `_copy_parent_to_size` under a pass. |
| Grouped-size guard | `guard_product_parent_timings()` (trigger `trg_b_guard_product_parent_timings`) and `guard_product_parent_values()` | Refuse a change to a grouped size's timings without a parent pass, naming the parent. An ungrouped size (all 604 today) is edited directly. |
| Category change | `update_product_parent` raises `PRODUCT_PARENT_TIMINGS_MUST_CLEAR`; the screens confirm first (`ProductParentPanel.tsx:146`, `ProductDetail.tsx:2398` "Clear use timings?", `Products.tsx:739`) | Already meets "a category change clears them after a confirm". |
| Screen | `src/lib/productUseTimings.ts` (`listProductUseTimingOptions`, `visibleProductUseTimingOptions`), the multi-select on `ProductDetail.tsx` and `ProductParentPanel.tsx` | Shows active options for the product's category, plus any turned-off option it still holds. |
| Other readers | change history (`write_product_change_history`), price workbook (`use_timing_snapshot`), parent proposals (`productParentProposals.ts`), bulk import (`bulkProductImportSafety.ts`, legacy `use_timing` text), setup workbook | All read codes or labels. No quote, job, invoice, PDF or field-app screen reads use timings. |

**How parent records work after PAR-1 (relevant parts):**
- A parent owns category, use timings and rates; the database copies them to each size in the same step. A direct write to a grouped size's copied value is refused, naming the parent.
- `update_product_parent(p_parent_id, p_expected_parent_version, p_changes, p_reason, p_idempotency_key)` takes `name`, `nickname`, `category`, `use_timings`; needs a reason; refuses a stale `parent_version`; writes one parent event and copies to each size.
- Quoting notes and descriptions are **size** values, not parent values. `_insert_parent_size` takes them on create only once `20261202110000` is applied; until then the screen saves them in a second call.

**How quote notes are stored and read:**
- `src/lib/quoteNotes.ts` `preferredQuoteNotes(product)` returns the trimmed quoting note, else the trimmed description, else blank.
- `QuoteBuilder.tsx:1985` (`assignProduct`) copies that text into the line's `notes` when a product is put on a line. The line's notes are then the line's own (`quote_items.notes`), editable per quote; a "Reset" button (`QuoteBuilder.tsx:5581-5584`) puts the product's current text back.
- So an existing quote never changes when a product's notes change; only new lines and a manual "Reset" pick up the new text. `quotePdf.ts` prints the line's own notes.

**What the setup workbook does today (WP-PM-11a-2, live since 2026-11-05):**
- `get_product_setup_workbook` exports one row per size; `src/lib/productSetupWorkbook.ts` writes three visible tabs (`Setup`, `Rates`, `Parent Rates`) and a hidden manifest. Format `crx-product-setup-v2`; a v1 file is refused whole.
- The **Setup** tab's editable fields include `use_timings` (labels, `;`-separated), `notes`, `internal_notes` and **`quoting_notes`**. For a grouped size, `category`, `use_timings` and `epa_registration` are locked (`PARENT_OWNED_SETUP_FIELDS`), because the parent owns them. **There is no parent-level tab for timings**, so once products are grouped, timings cannot be filled from the spreadsheet.
- Upload: `parseSetupWorkbook` refuses added or removed rows and changed headers; `buildSetupPreview` lists each changed field with before and after, refuses rows changed since the download (by `setup_fingerprint`), and nothing saves until the tab is confirmed. Save: `apply_product_setup` (admin, retry key, at most 2000 rows, all in one transaction).
- Two other writers also change notes: the **price workbook** (`quoting_notes`, `internal_notes`, through its approved change sets; `PricingChangePreviewModal.tsx`) and **bulk import** (WP-PM-10; `notes` and legacy `use_timing` text).

---

## 2. Where the grand plan's outline is wrong or silent against current code

| Grand plan says | Current code / this sheet |
|---|---|
| USE-1 "adds the real product-to-pair rows (product, crop, timing), migrated from each product's chosen options" | **Each option already is a pair** (`timing_code` + optional `crop`), and a product can hold several options. A separate pair table would be a second copy of the same fact, needing its own copy-down, guards, history and workbook column. So USE-1 keeps the option codes as the storage and adds what is missing: a fixed crop list, one option per pair (no duplicates), and an admin way to add a pair (section 3). |
| "Old timings migrate with counts matching" | Nothing needs to move, because storage does not change. The proof becomes: the 317 products and their per-code counts (section 1) are identical before and after the migration, and every stored code resolves to exactly one (crop, timing) pair (postflight, section 4.F). |
| "It adds the setup workbook's Crop Uses tab" | The Setup tab already carries `use_timings` for **ungrouped** sizes. What is missing is the **grouped** case: a parent-level **Crop Uses** tab, one row per parent, saving through `update_product_parent` (section 5). |
| "Two sizes of one parent show the same pairs; editing one size's pairs is refused, naming the parent" | Already true since PAR-1 (`guard_product_parent_timings`). USE-1 re-proves it with the new options. |
| "A category change clears them after a confirm" | Already true (section 1). Re-proved, not rebuilt. |
| USE-3 "A mass fill previews which products' quote notes change" | The setup workbook **already** fills `quoting_notes` in bulk with a per-row preview, stale-row refusal and a confirm. What it does not show is the **customer-visible** effect: 442 active products auto-fill their *description* today, so a new quoting note replaces different text, and editing a description alone also changes new quote lines. USE-3 is a screen change that shows the real before and after (section 6). No migration. |
| USE-3 silent on who writes the notes | The notes themselves are catalog data (a DATA step), drafted and reviewed privately, then uploaded through the setup workbook. Mason decides the content source (question 3). |

---

## 3. USE-1 design

### 3.1 The model: an option is a pair

Keep `products.use_timings` and `product_parents.use_timings` exactly as they are. Make the pair explicit and safe on the options table:
- **A crop list.** New table `product_crop_options` (code, label, sort order, active). Each option's `crop` must be one of its codes, or blank for "any crop".
- **One active option per pair.** A unique rule on (category, timing code, crop) among **active** options, with blank crop counted as a value, so "Pre-Emerge" + corn cannot be offered twice under two labels. A turned-off option does not count, so a wrong label can be retired and replaced. The 9 live options already satisfy it.
- **An admin can add a pair** and turn one off, through two RPCs. A product keeps a turned-off option it already has (the existing trigger rule); it just stops appearing in the picker.
- **No renaming.** Each size stores the joined labels in `use_timing`, written at save time, so renaming an option would leave every existing product showing the old label. To fix a wrong label, turn it off and add a new one. (Rename is out of scope; if Mason later wants it, it is its own package that rewrites the joined text.)

Why this is the smallest complete design: the copy-down, the grouped-size guard, change history, the parent proposals, the workbook column, the category-clear rule and the picker all already work on option codes. USE-1 adds two small tables' worth of rules, two admin RPCs and one parent trigger, and changes one existing function by one rule (3.4: sizes inherit a retired option their parent already holds).

### 3.2 Tables

**`product_crop_options`** (new)
- `code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$')`.
- `label text NOT NULL` (trimmed, non-empty, ≤ 60 characters), unique on `lower(label)`.
- `sort_order integer NOT NULL`, `is_active boolean NOT NULL DEFAULT true`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()` (any later migration that changes a crop row sets it).
- Seed (question 1): `corn` Corn, `soybeans` Soybeans, `wheat` Wheat, `milo` Milo, `cotton` Cotton, `alfalfa` Alfalfa, `pasture_hay` Pasture/Hay, plus `range_pasture_turf` Range/Pasture/Turf (a use site, not a field crop; question 2). The first seven are the codes the `customers.crops` list already uses (without `other`), so a later "products for this grower's crops" view needs no translation for them. `range_pasture_turf` is deliberately a use site with no customer crop code; such a view would also show Range/Pasture/Turf products to a `pasture_hay` grower (a rule for that later view, noted here). `corn` and `soybeans` cover every crop the live options use today.
- New crops are added by a small migration (rare). No crop-writing RPC in USE-1.

**`product_use_timing_options`** (existing; constraints and two columns added, nothing dropped)
- `ADD CONSTRAINT product_use_timing_options_crop_fkey FOREIGN KEY (crop) REFERENCES product_crop_options(code)`.
- `CREATE UNIQUE INDEX product_use_timing_options_active_pair_key ON product_use_timing_options (category, timing_code, crop) NULLS NOT DISTINCT WHERE is_active` (live is Postgres 17).
- `ADD CONSTRAINT product_use_timing_options_timing_code_check CHECK (timing_code ~ '^[a-z][a-z0-9_]*$')` (all 9 live codes pass).
- `ADD COLUMN created_by uuid NULL`, `ADD COLUMN updated_by uuid NULL`, `ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()`, `ADD COLUMN option_version bigint NOT NULL DEFAULT 1`. With the existing `created_at` (default `now()`), each admin add records who and when, and each turn-off or turn-on records who and when and moves `option_version`. The 9 seeded rows keep null `created_by`.
- **Two options re-filed (question 2), only as Mason answers:** Volunteer Corn's `crop` set to null ("Any crop"), and Range/Pasture/Turf's `crop` set to `range_pasture_turf`, so it is not shown as "Any crop". Products store the code, not the crop, and both labels stay, so no product row changes (the postflight md5s prove it). Any option Mason says to keep is left as it is.
- **No grant, revoke or policy change** on this existing table (so no Mason permission approval is needed for it).

### 3.3 RPCs (both new, both mutating)

Both follow the Stage 2 sheet §3 rules 2 and 3: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, owner `postgres`; admin check with `_product_parent_require_admin()` **before** the replay lookup; `p_idempotency_key text DEFAULT NULL` required (NULL refused) through `_product_parent_replay(key, scope, fingerprint)` and `save_idempotency`; `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`, then `GRANT EXECUTE … TO authenticated`. Both take `pg_advisory_xact_lock(hashtext('crx_use_timing_options'))` so two admins cannot add the same pair at once.

**`add_use_timing_option(p_category text, p_timing_code text, p_crop text, p_label text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`**
1. Admin, key, replay (scope `add_use_timing_option`; fingerprint covers every argument trimmed).
2. Category must be `Herbicide` or `Foliar Fertilizer` (the existing CHECK; Mason, 2026-10-28) — `USE_TIMING_CATEGORY`.
3. Timing code matches the code pattern — `USE_TIMING_CODE_INVALID`. A new timing code is allowed (for example `burndown`); the label is what people see.
4. Crop null, or an **active** `product_crop_options` code — `USE_TIMING_CROP_UNKNOWN`.
5. Label trimmed, 1–60 characters, starting with an ASCII letter A–Z or a–z (the code is built from ASCII letters and digits only, so it always matches the code pattern), no `;` — `USE_TIMING_LABEL_INVALID`; not already used, ignoring case — `USE_TIMING_LABEL_TAKEN`; and not equal, ignoring case, to any existing option **code** — `USE_TIMING_LABEL_IS_CODE` (the workbook accepts a label or a code in one cell, so a label `post_emergence` on a wheat pair would read back as the existing `post_emergence` option).
6. No **active** option already has this pair — `USE_TIMING_PAIR_EXISTS`, naming its label. A turned-off option with the same pair is allowed, so a misspelled label is fixed by turning it off and adding the corrected one.
7. Code: a slug of the label (`lower`, non-letters to `_`, trimmed of `_`), with `_2`, `_3` added if taken by another option's code **or** equal, ignoring case, to another option's label (so labels and codes never overlap in either direction; the preflight checks the 9 live options already satisfy this). Sort order: the category's current largest plus 10.
8. Insert with `created_by`; return `{code, label, timing_code, crop, category, sort_order}`.

**`set_use_timing_option_active(p_code text, p_is_active boolean, p_expected_option_version bigint, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`**
1. Admin, key, replay (scope `set_use_timing_option_active`; fingerprint covers `p_code`, `p_is_active` and `p_expected_option_version`, so the same key with a different request is refused).
2. `p_code`, `p_is_active` and `p_expected_option_version` are all required (not null) — `USE_TIMING_INVALID`. Option must exist — `USE_TIMING_NOT_FOUND`. Locked `FOR UPDATE`; `option_version` must equal `p_expected_option_version` — `USE_TIMING_STALE` (so an earlier click that arrives late cannot undo a later one). Same value already — `USE_TIMING_NO_CHANGE`.
3. Turning **off**: allowed even while products hold it (they keep it). The result reports how many sizes and parents still hold it, so the screen can say so.
4. Turning **on** a pair whose crop is now inactive — `USE_TIMING_CROP_UNKNOWN`; turning on a pair another active option already has — `USE_TIMING_PAIR_EXISTS`, naming it.
5. Update `is_active`, `updated_by`, `updated_at = now()`, `option_version + 1`; return the row (with its new version) and the holder counts.

No change to `_product_parent_timings`, `update_product_parent`, the guards, or any reader: they already read the options table at run time, so a new option works everywhere at once. The one change to `sync_product_use_timings` is 3.4.

### 3.4 A retired option a parent already holds

**The gap (Codex review, PR #1684):** `sync_product_use_timings` refuses an inactive code a size did not already hold. Two parent functions give a size its parent's timings starting from a size that does not hold them: `add_product_size` (the new size starts empty) and `move_product_size` (the size joins another parent). Both write the `product_parent_members` row first, then call `_copy_parent_to_size`. If the parent keeps a retired option, the copy is refused and the whole add or move rolls back, although the parent legitimately keeps that choice.

**The rule:** a size inherits what its parent holds; a parent never newly takes a retired option.
- **Size side:** re-emit `sync_product_use_timings` (`CREATE OR REPLACE`, same signature, owner, `search_path` and trigger) with one added allowance: an inactive code the size did not hold is accepted only when (a) a `product_parent_copy_passes` row exists for this size in this transaction (`txid_current()`), and (b) the size's parent in `product_parent_members` already holds that code in `product_parents.use_timings`. Every other line of the function stays byte-for-byte as in `20261103210000`. A direct size edit, the setup workbook, bulk import and the product page have no copy pass, so they are still refused.
- **Parent side:** a new trigger `trg_guard_product_parent_retired_timings`, `BEFORE INSERT OR UPDATE OF use_timings ON product_parents`, function `guard_product_parent_retired_timings()` (plain, not `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`). It refuses any inactive code not in `OLD.use_timings` (on insert, any inactive code) with `PRODUCT_PARENT_TIMING_RETIRED`, naming the label. Before USE-1 this protection came for free from the size trigger (the parent's copy-down was refused); now that the size trigger trusts the parent, the parent needs its own check.
- **One pair once per row:** both the re-emitted size trigger and the new parent trigger also refuse a timing list that holds two options with the same (category, timing code, crop) pair, active or retired — `USE_TIMING_PAIR_TWICE`, naming both labels. This covers every write path (picker, setup workbook, Crop Uses tab, bulk import, parent edit), not only the picker. Live today every product holds at most one timing, so no row fails it (the preflight checks this on `products` and `product_parents`).
- **Result:** adding a size to, or moving a size into, a parent that holds a retired option succeeds and the size holds it (shown "(retired)"); creating a parent with a retired option, or adding one to an existing parent, is refused; a parent edit that keeps a retired option it already holds still saves.

---

## 4. USE-1 DB · The database PR

**File:** `supabase/migrations/<stamp>_product_crop_use_pairs.sql`. The stamp is chosen at build. It must sort after `20261215110000` (latest live) and after any stamp claimed in `docs/changelog.d/` or the sibling notes folder.

### 4.A Preflight (refuse to run unless all hold)
- Inside one transaction (the temp-table pattern of `20261103210000`).
- `product_crop_options` does not exist; no function named `add_use_timing_option` or `set_use_timing_option_active` exists with **any** argument list (`pg_proc` by name, so no overload can be created); none of the three new rules exists (`product_use_timing_options_crop_fkey`, `product_use_timing_options_active_pair_key`, `product_use_timing_options_timing_code_check`).
- The 9 options have exactly the codes, labels, timing codes, crops and categories in section 1.
- No option label equals, ignoring case, any option code other than its own (3.3).
- No row of `products` or `product_parents` holds two options with the same (category, timing code, crop) pair (3.4).
- Every `crop` on the options is null or one of the seeded crop codes; every `timing_code` matches the code pattern.
- `_product_parent_require_admin`, `_product_parent_replay`, `save_idempotency` exist.
- Capture into a temp table: per-code counts of `products.use_timings` and `product_parents.use_timings`, the count of products with any timing, and an md5 of `(id, use_timings, use_timing, pricing_version)` for every product.
- Capture the md5 of `pg_get_functiondef` for `_product_parent_timings`, `update_product_parent`, `guard_product_parent_timings`, `guard_product_parent_values`, `add_product_size`, `move_product_size`, `_copy_parent_to_size`.
- `sync_product_use_timings`'s `pg_get_functiondef` md5 equals the value recorded at build time from the live `20261103210000` body (refuse if it drifted, so the re-emit cannot overwrite an unknown version); `guard_product_parent_retired_timings` and its trigger do not exist.

### 4.B Body
Section 3.2's table and constraints, section 3.3's two functions, section 3.4's re-emitted `sync_product_use_timings` and new parent trigger. RLS on `product_crop_options` with one policy `product_crop_options_select` FOR SELECT TO authenticated USING `(SELECT public.is_active_profile())`; `REVOKE ALL ON TABLE … FROM PUBLIC, anon, authenticated, service_role, metabase_ro`; `GRANT SELECT … TO authenticated`. No write grant on either table to any app role.

### 4.C What the migration does not touch
- No `products` or `product_parents` column, grant or row; no `products` trigger is added or dropped (the one new trigger is on `product_parents`, 3.4).
- None of the seven functions named in 4.A; `sync_product_use_timings` changes only by the 3.4 allowance.
- No option row is added or turned off. The only option changes are the crops of Volunteer Corn and Range/Pasture/Turf, and only as Mason answers question 2. The only new rows are the 8 crop options.

### 4.D Rollback (its own reviewed migration)
Re-emit `sync_product_use_timings` from its `20261103210000` body and drop the parent trigger and its function; then drop the two RPCs, then the three new rules named in 4.A (the crop foreign key first), then the four new option columns, then `product_crop_options`. If question 2 re-filed Volunteer Corn or Range/Pasture/Turf, set each crop back (`corn`, null) before dropping the crop table. No product data to restore, because none changed. A size that inherited a retired option keeps it after rollback (the old trigger lets a row keep a code it holds). If an admin has added options by then, the rollback keeps them (they are ordinary option rows) and says so.

### 4.E Lock and timing
`SET LOCAL lock_timeout = '5s'`. The `ALTER TABLE` takes a short lock on the 9-row options table; product saves read it, so apply outside busy hours (no fixed window needed; the lock lasts milliseconds).

### 4.F Postflight (inside the migration)
- **Counts match:** per-code counts, the 317 total and every product's md5 equal the preflight capture (this is the "old timings migrate with counts matching" proof).
- Every option code in use resolves to exactly one (category, timing code, crop) pair.
- RLS on, one policy, exact grants on `product_crop_options` (read from `has_table_privilege`, as `20261103210000` does), and no new privilege on `product_use_timing_options`.
- Both functions owned by `postgres`, `SECURITY DEFINER`, `search_path = public, pg_temp`, `EXECUTE` only for `authenticated` (not `PUBLIC`, `anon`, `service_role`).
- The seven function md5s equal the preflight capture; `sync_product_use_timings` now differs from its captured md5, keeps owner, `search_path` and its trigger, and contains the copy-pass allowance; the parent trigger exists, is `BEFORE INSERT OR UPDATE OF use_timings`, and its function has no `EXECUTE` for `PUBLIC`, `anon`, `authenticated` or `service_role`.

### 4.G Files (the Stage 2 sheet §3 rule 9 checklist)
- the migration;
- `docs/changelog.d/<date>-use1-crop-use-pairs.md` and `docs/reference/migrations.d/<stamp>_product_crop_use_pairs.md`;
- `scripts/smoke/prove-product-crop-use-pairs-real-schema.mjs` (cases in section 7);
- `docs/reference/rpc-functions.md` entries for the two RPCs;
- `src/types/index.ts` (`CropOption`; `UseTimingOption` gains nothing it needs) and regenerated `src/types/supabase.ts`;
- after apply: schema registry refresh, live function snapshot entries, `npm run db-sweeps:live` (and the sweep allowlist if it flags the two new `SECURITY DEFINER` functions).

### 4.H Risks

| Risk | Handling |
|---|---|
| A new option silently changes existing products | It cannot: options are only added or turned off; storage and readers are untouched (postflight md5s). |
| Two labels for one pair ("Pre-Emerge Corn" and "Corn Pre") | The unique pair rule; `USE_TIMING_PAIR_EXISTS` names the existing label. |
| A crop typed two ways (`soybean` vs `soybeans`) | Crop must be a `product_crop_options` code (foreign key). |
| The picker grows long | The screen groups options by crop (section 5); turned-off options hide. |
| Fungicides or insecticides need crop uses later | Out of scope: Mason's rule is timings only on Herbicide and Foliar Fertilizer (2026-10-28). Widening it is a category-CHECK change in its own package. |
| A parent keeps a retired option, so "Add a size" or a move into it fails | 3.4: a size inherits a retired code only during a parent copy and only if its parent holds it; a parent cannot newly take one (case 9). |
| The re-emit of `sync_product_use_timings` drifts from live | Preflight refuses unless its md5 equals the recorded live body; the re-emit changes one condition. |
| `volunteer_corn` (crop corn) shows under **Corn**, and `range_pasture_turf` (no crop) shows under **Any crop**, in the grouped picker | Question 2. The recommended answer re-files both in this migration (two option rows, no product rows). |

---

## 5. USE-1 Screens · The screen PR

Lands after the database PR is applied (`docs/workflows/DATABASE_CHANGE_CHECKLIST.md`, migration-plus-callers split).

**Files:**
- `src/lib/productUseTimings.ts`: `listProductCropOptions()`, `addUseTimingOption(...)`, `setUseTimingOptionActive(...)`, each through `src/lib/db.ts` with `assertRpcResult()` and a retry key per intent (the existing `getCreateKeyFor` pattern).
- `src/pages/ProductDetail.tsx` and `src/components/products/ProductParentPanel.tsx`: the existing multi-select shows options **grouped by crop** ("Any crop", "Corn", "Soybeans", …) with the timing label in each group. Admins get an **"Add a crop and timing"** link under the picker: a small modal (category fixed to the product's, timing chosen from existing timing codes or typed new, crop from the crop list or "Any crop", label pre-filled as "<Timing> <Crop>", editable). A turned-off option a product still holds shows with "(retired)", as today. The picker does not offer an active option whose (crop, timing) pair the product already holds through a retired one; instead the retired one shows a "Switch to <new label>" button that swaps the code in one save, so a product never shows the same pair twice. The add modal disables its submit and close buttons while its request is in flight, uses one retry key per request (a new key whenever any field changes, so an edited retry is a new request, not a mismatched replay); if a reply times out, the form stays locked, reloads the option list and shows whether the add saved before the admin can edit again; it ignores a reply that arrives after the form it belongs to was closed.
- A **"Manage crop and timing choices"** list for admins (the same modal file) to turn a choice off or back on, showing how many products hold it. `ConfirmModal` before turning one off. The button is disabled while its request is in flight, sends the version it was loaded with, and reloads the list after every answer (a `USE_TIMING_STALE` refusal says "someone else just changed this; refreshed").
- `src/lib/productSetupWorkbook.ts` and `src/components/products/ProductSetupWorkbookModal.tsx`: a fourth visible tab, **Crop Uses**, one row per parent: `parent_id`, `parent_version` (hidden), `parent_name`, `category` (read-only), `sizes` (read-only), `use_timings` (editable labels, `;`-separated, the same format as the Setup tab). On upload, each row's labels are turned into option codes with the same parser the Setup tab uses (`parseSetupValue('use_timings', …)`, matching labels ignoring case). The parser is changed to resolve **label first, then code** (today `parseSetupValue` takes the first option matching either, `productSetupWorkbook.ts:500`), as a second guard on both tabs; an unknown label, or one the parent's category does not take, makes that row invalid in the preview, as on the Setup tab. Saving calls `update_product_parent` once per changed row, one at a time, with `{use_timings: [<codes>]}`, the reason `"Setup workbook: crop uses"`, the downloaded `parent_version` and a per-row retry key derived from the upload. The format version moves to `crx-product-setup-v3`; a v2 file is refused whole (the existing old-version rule), because it has no Crop Uses tab.
  - **Why per row and not one batch RPC:** `update_product_parent` already does the lock, stale check, copy-down and event. A batch RPC would need a new private helper re-emitted from that live function, a larger and riskier change for a non-money field. The cost: if row 40 of 100 is refused (stale), rows 1–39 have saved. The result screen lists exactly which rows saved and which were refused and why, as the grand plan requires ("the result screen shows exactly which rows saved"), and a re-upload skips saved rows because they no longer differ.
  - **One save at a time.** While a Crop Uses save runs, the modal cannot be closed and no other upload or tab save can start; every result is tagged with its upload's ID and only that upload's result screen shows it. If the page is reloaded mid-save, each row already sent is saved or refused by the database on its own; re-uploading the same file skips rows that already match and refuses stale ones by name.
  - The tab is empty until PAR-2 grouping runs (0 parents today). Ungrouped sizes keep using the Setup tab's `use_timings` column, unchanged.
- Tests: component tests for the grouped picker, the add modal (refusals shown in plain words), turning off; `productSetupWorkbook.test.ts` cases for the Crop Uses tab round trip, a v2 file refused, a stale parent row refused by name, a category that does not take timings refused before upload; an **unchanged round trip** of a product holding an option whose label looks like another option's code reads back the same codes and proposes no change.

**Sol:** `ProductDetail.tsx` and `Products.tsx`-area screens are on the Sol list, so this PR needs Sol (section 8).

---

## 6. USE-3 · Quoting notes fill (one screen PR, no migration)

### 6.1 The gap
Filling quoting notes from the setup workbook works today. What the preview does not say is what a **customer** will see. For 442 active products the new quote line shows the **description** today, so:
- adding a quoting note **replaces** the description on new quote lines (not "blank to text", as the preview reads now);
- clearing a quoting note makes new lines fall back to the description;
- editing a **description** on a product with no quoting note changes new quote lines too, and the preview does not flag it.

### 6.2 The change
- `src/lib/quoteNotes.ts`: no change to `preferredQuoteNotes`; it stays the one rule for "what a new quote line shows".
- `src/lib/productSetupWorkbook.ts` `buildSetupPreview`: for every row where `quoting_notes` or `notes` changes, compute `preferredQuoteNotes(before)` and `preferredQuoteNotes(after)`. When they differ, add one display line **"New quote lines show"** with before and after, and mark the row **customer-visible**. When they are the same (for example a description edit on a product that has a quoting note), add nothing.
- `src/components/products/ProductSetupWorkbookModal.tsx`: a count at the top of the Setup tab's preview — "N products change what new quote lines show. Existing quotes keep their notes." — and a filter to list only those rows. The confirm button's text names the count. Nothing else in the save path changes (`apply_product_setup`, its retry key, stale refusal and 2000-row limit are reused).
- `src/components/products/PricingChangePreviewModal.tsx` (the price workbook's preview, the second writer of `quoting_notes`): the same "New quote lines show" line, from the same helper, so either spreadsheet tells the truth.
- `src/pages/ProductDetail.tsx` (the one-product editor): when the description changes on a product whose quoting note is blank, or the quoting note changes, a one-line hint under the field says "New quote lines will show: <text>" before saving. The build lists every other editor of `notes` or `quoting_notes` with a fresh search and gives each the same hint or names why it needs none.
- Bulk import (WP-PM-10) writes `notes` only on **new** products, which have no existing quotes; no change there.

**Why no database change:** the save path already has the admin check, retry key, stale-row refusal and one-transaction save; quote lines already copy the note when the line is made, so existing quotes cannot change. The missing piece is honest wording in the two spreadsheet previews and the product page.

### 6.3 Filling the notes (the data step, not code)
This is catalog work under the grand plan's data rules, after Mason answers question 3:
1. An agent drafts the quoting note for each product into a review spreadsheet in its own session scratchpad and sends it to Mason as a file. The agent never writes to Mason's private vault (read-only from this repo); if Mason wants a copy there, he files it himself. Never into this repo or a PR; the repo carries counts only.
2. Mason reviews and approves a batch.
3. The approved batch is pasted into a fresh setup workbook download's `quoting_notes` column and uploaded. The preview's changed-row count (rows whose `quoting_notes` changes) must equal the batch size; its customer-visible count may be smaller (a note equal to the description changes nothing a customer sees), and the agent's batch file lists those rows; then Mason (or an admin, with Mason's go for that batch) confirms the Setup tab.
4. The repo records only the batch count and date in `docs/manual/CURRENT_STATE.md`.

Writing live catalog rows is a Mason-gated data step (Stage 2 sheet §3 rule 11): each batch needs his go at the time.

### 6.4 Files and gates
- `src/lib/productSetupWorkbook.ts`, `src/components/products/ProductSetupWorkbookModal.tsx`, `src/components/products/PricingChangePreviewModal.tsx`, `src/pages/ProductDetail.tsx`, their tests (`productSetupWorkbook.test.ts`, `PricingChangePreviewModal.test.tsx`), and `src/lib/quoteNotes.test.ts` if a case is added.
- `PricingChangePreviewModal.tsx` (money word "Pricing") and `ProductDetail.tsx` are on the Sol list, so the PR needs Sol (section 8).

### 6.5 Risks

| Risk | Handling |
|---|---|
| A batch changes what customers see on hundreds of new quote lines | The preview count and "New quote lines show" lines; Mason approves each batch; existing quotes never change. |
| Someone presses "Reset" on an old quote line after a fill | That is the button's purpose (it pulls the current text); the line's own note is kept until then. |
| The description and quoting note drift apart | Expected: after a fill, the description becomes internal-facing text, and the quoting note is the customer text. The preview flags any description edit that still reaches quotes. |
| Notes per size versus per parent | Kept per size, as today (the grand plan's overlap 13 table lists notes on neither the parent nor the registration). The workbook makes filling all sizes of one formulation a copy-down in the spreadsheet. Moving notes to the parent is not needed for USE-3; if wanted later, it is its own package. |
| A note over 5000 characters | Refused by `apply_product_setup`'s existing check. |

---

## 7. Done when

**USE-1, in the harness (`prove-product-crop-use-pairs-real-schema.mjs`, against the schema-matched copy):**
1. **Counts match:** before and after the migration, 317 products hold timings with the same per-code counts as section 1, every product's `use_timings`, `use_timing` and `pricing_version` unchanged (postflight, re-run by the script).
2. An admin adds "Post-Emerge Wheat" (Herbicide, `post_emergence`, `wheat`); a non-admin and a direct table insert are refused and write nothing; a repeat with the same key returns the first result and writes once; the same key with a different label is refused.
3. Adding a second label for an existing active pair is refused, naming the existing label; after that option is turned off, the corrected label is accepted, and turning the old one back on is refused while the new one is active; a crop not on the list is refused; a label with `;` or not starting with an ASCII letter is refused.
4. A product with "Pre-Emerge Corn" and "Post-Emerge Soybeans" keeps both after save and reload (ungrouped size, then a grouped parent).
5. Two sizes of one parent show the same pairs after a parent edit; editing one size's timings directly is refused, naming the parent.
6. A category change on a parent with timings is refused until timings are cleared; the screen's confirm then clears them on every size in one event.
7. Turning an option off: it disappears from the picker; a product holding it keeps it and can still save other fields; assigning it to a product that does not hold it is refused on **every** write path (product page, setup workbook, bulk import, a parent edit — the parent's copy-down hits the same size trigger and the whole parent edit is refused); turning it back on works; the result reports holder counts.
8. A setup workbook export and re-import with no edits saves nothing; a Crop Uses row edit saves through `update_product_parent` with one parent event and one copy per size; a stale parent row is refused by name while other rows save, and the result lists both.
9. **Retired option held by a parent:** a parent with two sizes holds an option; turn the option off. Then: `add_product_size` succeeds and the new size holds it; `move_product_size` of a size from another parent into this one succeeds and the size holds it; a parent edit that changes the name or adds another active option keeps it and saves; `create_product_with_parent` with it, and `update_product_parent` adding it to a different parent, are refused `PRODUCT_PARENT_TIMING_RETIRED` and write nothing; a direct size edit, a setup workbook row and a bulk import adding it to an ungrouped size are still refused.

**USE-1, observed in the app against the private test copy (`scripts/local-app/`):** add a pair from the product page as an admin; pick it on a product; see it grouped under its crop; download and re-upload the setup workbook with a Crop Uses edit. A flow the test copy cannot run is recorded as owed, not passed.

**USE-3, in the app against the private test copy:**
1. Upload a setup workbook that adds quoting notes to three products (one with a description, one without, one grouped size) and edits one description on a product with no quoting note: the preview shows four customer-visible rows with the right before and after text, the count says 4, and nothing is saved until confirmed.
2. After confirming, a **new** quote line for each product shows the new text.
3. An **existing** saved quote with those products still shows its old notes, and its PDF prints them; "Reset" on one of its lines pulls the new text.
4. A description edit on a product that has a quoting note shows no "New quote lines show" line.
5. The price workbook preview shows the same line for a `quoting_notes` change.
6. On the product page, editing the description of a product with no quoting note shows the "New quote lines will show" hint before saving.

---

## 8. PR split, order and gates

| PR | Contents | Sol | Lands |
|---|---|---|---|
| **USE-1 DB** | Section 4 | Yes (`supabase/`) | Luna until clean → Sol on the exact head → apply live before merge through the migration-apply proof gate (routine grants on new objects only; non-destructive) → merge |
| **USE-1 Screens** | Section 5 | Yes (`ProductDetail.tsx`) | After USE-1 DB is applied. Luna → Sol → green checks |
| **USE-3 Screens** | Section 6 | Yes (`ProductDetail.tsx`, `PricingChangePreviewModal.tsx`) | Independent of USE-1; may land first. Luna → Sol → green checks |
| **USE-3 data** | Section 6.3 | — | After USE-3 Screens; each batch with Mason's go |

Every PR stays open at least 4 hours before merge (Taha, 2026-11-08). None of these touch the files of Taha's open PRs; re-check `gh pr list --author TahaKhanAbdalli` at build time.

**Order against other work (checked 2026-11-08):**
- USE-1 follows WP-PM-5 (done). It does not need PAR-2 grouping to land; the Crop Uses tab simply stays empty until parents exist.
- USE-1 Screens and Brand PR B and the RT-1/RT-3 screens may all edit `ProductDetail.tsx` and the setup workbook files; build them one at a time on current `main`, never in parallel on those files.
- USE-3 touches the setup workbook files too; same rule.
- USE-2 waits for REG-1 (Taha's #1524).

---

## 9. Questions for Mason

**NEEDS MASON - DECISION REQUIRED (1 of 3): which crops can a product be marked for?**
The app needs a fixed crop list so "soybean" and "soybeans" can't both appear. **Recommend:** start with the same list your customer records already use: Corn, Soybeans, Wheat, Milo, Cotton, Alfalfa, Pasture/Hay, plus Range/Pasture/Turf (see question 2) and "any crop". Adding one later is a small change. Reply "yes" or name the crops to add or drop.

**NEEDS MASON - DECISION REQUIRED (2 of 3): where should two old choices be filed?**
- **Volunteer Corn** (7 products) is stored as crop **corn**, so the new picker would list it under Corn, as if it were used on corn. Volunteer corn is usually killed in another crop, such as soybeans. **Recommend:** list it under "Any crop".
- **Range/Pasture/Turf** (25 products) has no crop, so the new picker would list it under "Any crop", which reads broader than the label. **Recommend:** its own "Range/Pasture/Turf" group.

The products keep their choice and its name either way; only the group it is filed under changes. Reply "yes to both", or say which to keep as it is.

**NEEDS MASON - DECISION REQUIRED (3 of 3): what goes into the customer quote notes?**
Today no product has a quote note, so 442 products put their general description onto every new quote line. **Recommend:** an agent drafts a short customer-facing note for each product from its description and label, you approve them in batches in your private notes, and each approved batch is uploaded from the setup spreadsheet. Products without an approved note keep showing their description, as today. Existing quotes never change. Reply "yes" or say what the notes should contain.

**Settled here, not asked:** who can add or turn off a crop and timing choice (admins, matching the category rule); notes stay per size; no option renaming.

---

## 10. Review record

**Luna round 1** (gpt-6-luna xhigh, head `580b7abbe`): 5 findings (3 MED, 2 LOW), no BLOCKER or HIGH.
- MED Volunteer Corn would show under Corn while the sheet recommended "any crop": fixed; the recommendation now moves its crop to "Any crop" in the USE-1 migration, products untouched (3.2, 4.C, 4.H, question 2).
- MED turn-off then quick turn-on could land out of order: fixed with `option_version` and a stale refusal, plus a disabled button while in flight (3.2, 3.3, section 5).
- MED no time recorded for an added option: refuted; `product_use_timing_options` already has `created_at timestamptz NOT NULL DEFAULT now()` (`20261103210000`); the sheet now says so (3.2).
- LOW crop options have no `updated_at`: refuted; crop rows change only by migration, which the migration history and git record. No app writer exists.
- LOW a label like `123` would make an invalid code: fixed, the label must start with a letter (3.3 step 5).

**Luna round 2** (gpt-6-luna xhigh, head `a13c1d8e0`): 7 findings (2 HIGH, 4 MED, 1 LOW).
- HIGH "latest live migration" dated after the sheet: refuted; this repo's stamps run ahead of the calendar by convention, and `20261215110000` is live (ledger version `20261109032913`). Note added in section 1.
- HIGH Crop Uses tab holds labels but `update_product_parent` takes codes: fixed; labels are parsed to codes with the Setup tab's parser, unknown labels invalid in the preview (section 5).
- MED a retired wrong label could not be replaced (pair unique even when inactive): fixed; the pair rule now covers active options only, and turning an old one back on is refused while a duplicate is active (3.1, 3.2, 3.3, case 3).
- MED preflight and rollback named two of three new rules: fixed; all three named, rollback order given (4.A, 4.D).
- MED overlapping Crop Uses saves: fixed; one save at a time, results tied to their upload, re-upload safe (section 5).
- MED a description edit on the product page changes new quote lines with no warning: fixed; product-page hint and a search for every other notes editor (6.2, 6.4, USE-3 case 6).
- LOW crop options have no `updated_at`: refuted, as in round 1 (migration-only writer).

**Luna round 3** (gpt-6-luna xhigh, head `cfe689e65`): 5 findings (1 BLOCKER, 1 HIGH, 1 MED, 2 LOW).
- BLOCKER the data step had an agent write into Mason's private vault, which is read-only from this repo: fixed; the list goes to the private review location only through the `brain` skill with Mason's go, or to him as a scratchpad file (6.3).
- HIGH Range/Pasture/Turf (no crop) would show as "Any crop": fixed; a `range_pasture_turf` crop entry and re-filing it, both under question 2 (3.2, 4.D, 4.H, questions 1 and 2).
- MED a null expected version could slip past the stale check: fixed; all three arguments required (3.3).
- LOW a null `p_is_active` would fail with a raw database error: fixed by the same rule.
- LOW `updated_at` on crop options: added this time (3.2), ending the repeat finding.

**Luna round 4** (gpt-6-luna xhigh, head `7a9051bbf`): 6 findings (1 HIGH, 2 MED, 3 LOW).
- HIGH the round 3 fix still let an agent file the list in the private vault: fixed; the list only goes to Mason as a scratchpad file, and the agent never writes to the vault (6.3).
- MED a product holding a retired option could also pick its replacement and show one pair twice: fixed; the picker hides the duplicate and offers "Switch to <new label>" (section 5).
- MED the toggle's retry fingerprint was not stated: fixed; it covers all three arguments (3.3).
- LOW the add modal had no in-flight rule: fixed; submit and close disabled, one key per form, late replies ignored (section 5).
- LOW options had `changed_at` but no `updated_at`: fixed by naming the columns `updated_by` and `updated_at` (3.2, 3.3).
- LOW a label starting with a non-ASCII letter could produce an empty code: fixed; the label must start with an ASCII letter (3.3, case 3).

**Luna round 5** (gpt-6-luna xhigh, head `cc9f8dffe`): 4 findings (2 MED, 2 LOW), no BLOCKER or HIGH.
- MED a retired option could be newly assigned through an import, workbook or parent edit: refuted. `sync_product_use_timings` runs on every insert and update of `products` and refuses an inactive code the row did not already hold (`20261103210000`: `NOT v_option.is_active AND NOT (v_code = ANY(v_old_codes))`). A parent edit reaches each size through `_copy_parent_to_size`, an ordinary update, so the same trigger refuses it and the parent edit rolls back. Harness case 7 now proves each path.
- MED preflight did not check for same-name functions: fixed; preflight refuses any existing function with either name and any argument list (4.A).
- LOW the pair rule includes category: clarified, not changed; a pair is defined within one category (Words used here).
- LOW a reactivation could race an add and hit a raw unique error: refuted; both RPCs take the same `crx_use_timing_options` advisory lock (3.3), so the duplicate check and the write cannot interleave.

**Codex GitHub review** (head `c39dc61d8`): 1 finding (P2).
- P2 a parent holding a retired option would make "Add a size" (and moving a size into it) fail, because the size trigger refuses a retired code the new size did not hold: confirmed against `20261108120000` (`add_product_size` and `move_product_size` write the member row, then copy). Fixed: sizes inherit a retired code only during a parent copy and only when the parent holds it; a new parent trigger stops a parent newly taking a retired option (3.4, 4.A–4.F, case 9).

**Luna round 6** (gpt-6-luna xhigh, head `16d63512b`): 4 findings (1 MED, 3 LOW), no BLOCKER or HIGH.
- MED a workbook or parent write could hold a retired option and its replacement, one pair twice: fixed; both triggers refuse two options of the same pair on one row on every path (3.4).
- LOW the add form's retry key could replay an edited request: fixed; a new key whenever a field changes, and a timed-out add is resolved by reloading before editing (section 5).
- LOW `range_pasture_turf` has no customer crop code: noted, not changed; it is a use site by design (question 2), and the later grower view's rule is written down (3.2).
- LOW the batch gate compared the batch size with the customer-visible count: fixed; it compares the changed-row count (6.3).

**Codex GitHub review** (head `c91e12949`): 1 finding (P2).
- P2 a label equal to another option's code (for example `post_emergence` on a wheat pair) would re-import as the wrong option, because the workbook parser matches label or code with one `find`: confirmed against `productSetupWorkbook.ts:500`. Fixed: `add_use_timing_option` refuses a label equal to any option code and never generates a code equal to another label (3.3); the parser resolves label first (section 5); an unchanged round-trip test covers it.
