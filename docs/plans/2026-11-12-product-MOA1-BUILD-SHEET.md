# Product Master MOA-1 build sheet: resistance mode-of-action groups shown on the product

**Status (2026-11-12):** a plan only. No code and no migration have been written. It was written against `main` (`8b6c3281c`) and the live database, using read-only SQL only (counts, no product names). For building, this sheet replaces the MOA-1 outline in `docs/plans/2026-10-29-product-GRAND-PLAN.md` (Stage 2, "MOA-1 ·"). Where the two differ, this sheet wins on *how*, and section 2 lists each difference; the grand plan still wins on order and on Mason's settled decisions. **Nothing here authorizes building; the package starts when Mason says so** (Mason, 2026-11-11: he reviews the plan before any build).

**What MOA-1 does, in one line.** Each shared active ingredient carries one reviewed list of its resistance groups (FRAC for fungicides, HRAC/WSSA for herbicides, IRAC for insecticides), and every product containing that ingredient shows those groups, with a "Groups: …" summary, without anyone retyping them per product.

**Words used here.**
- **Group:** one mode-of-action code in one scheme, such as `HRAC 9` or `FRAC 11`. The schemes are the three DM-1 already allows: `HRAC`, `FRAC`, `IRAC`. There is no separate `WSSA` (the August record D-17 chose the numeric global herbicide code, which HRAC and WSSA now share).
- **Ingredient:** one row of `active_ingredients` (DM-1): one specific chemical form, shared by every product that contains it.
- **Acid (canonical ingredient):** the parent acid a salt or ester form names in `active_ingredients.canonical_ingredient_id` (DM-1, D-A).
- **Parent / size:** as in the Stage 2 sheet. Chemistry lives on the parent; every size of the parent shows it.
- **Ingredient list (of groups):** the new per-ingredient group list this sheet adds.
- **Typed group:** a row of the existing `product_parent_modes_of_action`, typed by an admin on one product (DM-1).
- **Derived group:** a group a product shows because one of its ingredients carries it on the ingredient list.
- **EPA gate (D-Z):** `_parent_chemistry_epa_refusal`. On a parent with a usable EPA number, typed chemistry is refused; it must come from the EPA auto-fill (DM-4).

---

## 1. Facts this plan is built on (checked 2026-11-12)

**Live data (read-only counts):**

| Fact | Value |
|---|---|
| Products | 606 |
| Parents (all / active) / members | 456 / 413 / 593 |
| Parents by category (pesticide part) | Herbicide 204, Insecticide 49, Fungicide 44, Seed Treatment 16 (313 in all) |
| Pesticide parents carrying at least one EPA number (on the parent, a size, a parent brand or a legacy brand) | **303 of 313** |
| `active_ingredients` rows | **0** |
| `product_parent_ingredients` active rows | **0** |
| `product_parent_modes_of_action` rows (any status) | **0** |
| `chemistry_change_proposals` (DM-1b workbook) / `epa_chemistry_proposals` / `epa_lookups` (DM-4) | 0 / 0 / 0 |
| Latest ledger version | `20261112123046`; newest migration file on `main`: `20270106110000_invoice_brands_rup.sql` |

So **no group data exists yet**: there is nothing to migrate, back-fill or reconcile, and every rule below starts from an empty table.

**Where groups live today (code on `main`):**

| Thing | Where | What it does |
|---|---|---|
| Table | `product_parent_modes_of_action` (`20261209100000_product_chemistry.sql:261`) | One row per parent, ingredient, scheme and group. `scheme` CHECK `HRAC`/`FRAC`/`IRAC`; `group_code` CHECK upper-case, trimmed, 1–10 characters; `status` active/retired; unique active `(parent_id, ingredient_id, scheme, group_code)`. RLS: active profiles read active rows, admins read all; no write grant. |
| Source column | `20261211100000_product_chemistry_confirmed_swaps.sql:47` | `source` `typed` or `epa_lookup`. |
| Writer | `_apply_parent_chemistry` (re-issued in `20261211100000`), called by `set_parent_chemistry`, `correct_parent_chemistry`, DM-1b's `promote_chemistry_proposal` and DM-4's `commit_epa_proposal` | Adds a group (kind `mode_of_action`, action `add`), retires one (correction), keeps/moves listed groups on a swap or consolidate. Refuses a group whose ingredient is not on the product (`_check_parent_chemistry`, `CHEMISTRY_MOA_NEEDS_INGREDIENT`). |
| **EPA gate on groups** | `_apply_parent_chemistry` line 287 of `20261211100000` | On a gated parent, **every** typed group add or retire is refused (only a correction retiring a typed *ingredient* row is allowed). With 303 of 313 pesticide parents carrying an EPA number, typing a group is refused on almost every pesticide product once its number counts as usable. |
| EPA auto-fill | `20270105110000_epa_chemistry_proposals.sql` (live 2026-11-12); DM-4 sheet line 51 | The EPA lookup returns **no** modes of action. Its proposals contain ingredient and label items only. |
| Workbook | `20270103160000_setup_workbook_chemistry_tabs.sql`; DM-1b sheet point 4 | The Ingredients tab carries ingredient rows only; groups "stay on the product page". |
| Reads | `_parent_chemistry_values` → `get_parent_chemistry` (`modes_of_action` list); `_ingredient_users` (parents using an ingredient, including through a group row); `_ingredient_usage_fingerprint` (`moa` part) | Read the typed rows only. |
| Screens | `ChemistryParts.tsx` (`ChemistryLists` shows each ingredient's typed groups; `ModeRows` editor), `ChemistryEntryModal.tsx` (type groups beside a new or existing ingredient), `ChemistryCorrectionModal.tsx` (keep/move groups on swap or consolidate; retire a group), `ProductChemistrySection.tsx` (the section on the product page; admins see the EPA panel and the ingredient review) | Show and type per-product groups. |
| Types / lib | `src/types/index.ts` (`ModeOfActionScheme`, `ProductParentModeOfAction`, `ParentChemistryModeRow`), `src/lib/productChemistry.ts` (`SCHEMES`, `ChemistryChange`) | — |
| Prover | `scripts/smoke/prove-product-chemistry-real-schema.mjs` | DM-1's cases for groups. |
| Not readers | quotes, jobs, invoices, PDFs, field app, price workbook, change history | None reads a group today. |

**Every reader and writer of the existing group field**, from `rg "modes_of_action|mode_of_action"` over `supabase/migrations`, `src` and `scripts`: the two DM-1 migrations above (table, `_parent_chemistry_values`, `_check_parent_chemistry`, `_apply_parent_chemistry`, `_chemistry_kept_modes`, `_ingredient_users`, `_ingredient_usage_fingerprint`), the DM-4 and DM-1b writers only through `_apply_parent_chemistry`, the three chemistry screens and `chemistryFormHelpers.ts`, the types, the chemistry prover and `ProductChemistrySection.test.tsx`. **MOA-1 changes none of them** (section 4.C).

---

## 2. Where the grand plan's outline is wrong or silent against current code

1. **"When a product's actives are set … it shows which groups it contains" has a hidden blocker.** The EPA gate refuses typed groups on gated parents, and the EPA lookup supplies none. Once DM-4 fills a gated product's actives, nobody can record its groups on that product. A per-ingredient list closes this without touching the gate: the group is a fact about the molecule, not about one product's label, so it never needs a per-product write.
2. **"Fills or proposes the product's rows":** this sheet does neither. Derived groups are **computed when read**, never copied into `product_parent_modes_of_action`. Copying would need a writer through `_apply_parent_chemistry` (refused by the gate) and would drift whenever the ingredient list changes. Reading live means one fix to an ingredient's list shows on every product at once.
3. **Salts and esters.** The outline is silent. A salt or ester has the same mode of action as its acid, so a form with no list of its own shows its acid's groups (one step; section 3.3).
4. **CMP-2's mode-of-action filter** reads the same derived groups through the private helper this sheet adds (`_parent_mode_groups`, 3.4), so the filter and the product page can never disagree.

---

## 3. Design

### 3.1 Storage: one reviewed list per ingredient

**`active_ingredient_modes_of_action`** (new):

| Column | Rule |
|---|---|
| `id` | uuid, primary key |
| `ingredient_id` | uuid, NOT NULL, references `active_ingredients(id)` ON DELETE RESTRICT |
| `scheme` | text NOT NULL, CHECK `IN ('HRAC','FRAC','IRAC')` (the same CHECK as `product_parent_modes_of_action`, so the two compare exactly) |
| `group_code` | text NOT NULL, CHECK `group_code = upper(btrim(group_code)) AND group_code <> '' AND char_length(group_code) <= 10` (same as DM-1) |
| `source_note` | text NOT NULL, trimmed, 1–1000 characters: where the group came from (for example "HRAC 2024 classification" or "label, section 2") |
| `status` | `active` / `retired` |
| `row_version`, `created_by`, `updated_by`, `created_at`, `updated_at` | as DM-1 tables |

Unique active `(ingredient_id, scheme, group_code)`; index on `ingredient_id`. A list can hold several groups (some actives carry two). Owner `postgres`; RLS on; one policy `active_ingredient_modes_of_action_select` FOR SELECT TO authenticated USING `(SELECT public.is_active_profile()) AND (status = 'active' OR (SELECT public.is_admin()))` (the DM-1 group policy); `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role, metabase_ro`; `GRANT SELECT … TO authenticated`. **No write grant to any role**: only the RPC in 3.2 writes.

**History:** each save writes one `active_ingredient_events` row (`event_type 'updated'`, the reason, `before_values {"modes_of_action": [...]}` and `after_values {"modes_of_action": [...]}`) through DM-1's private `_active_ingredient_event`. No new event table; nothing in `src` reads ingredient events, and the table is already append-only.

**Why a table on the ingredient, not an array column on `active_ingredients`:** it matches the existing group shape (one row per group, retired not deleted), needs no change to `active_ingredients`, and leaves `_active_ingredient_values`, the ingredient fingerprints and every DM-1 ingredient writer untouched.

### 3.2 Writer: `set_active_ingredient_modes`

**`set_active_ingredient_modes(p_ingredient_id uuid, p_expected_modes jsonb, p_modes jsonb, p_reason text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`**, `SECURITY DEFINER`, `SET search_path = public, pg_temp`, owner `postgres`, `EXECUTE` for `authenticated` only.

1. `v_actor := _product_parent_require_admin()` (admin and active, else refused).
2. Fingerprint `md5(actor, ingredient, expected, modes, reason)`; `_product_parent_replay(p_idempotency_key, 'set_active_ingredient_modes', fp)` refuses a missing key (`IDEMPOTENCY_KEY_REQUIRED`), returns the saved answer for a repeat, refuses the same key with a different request (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
3. `pg_advisory_xact_lock(hashtext('crx.active_ingredients'))` (the lock every DM-1 chemistry and ingredient writer takes), then the ingredient row `FOR UPDATE`. It takes no parent or product lock, so it cannot invert DM-1's order (parents, then sizes, then this lock).
4. Refuse: ingredient not found (`INGREDIENT_NOT_FOUND`); retired (`INGREDIENT_RETIRED: reactivate it first`); `p_modes` not an array of `{scheme, group_code, source_note}` objects with no other keys (each `source_note` trimmed, 1–1000 characters: where that one group came from), more than 10 entries, a repeated pair, or a bad scheme or code (`CHEMISTRY_MOA_INVALID`, the DM-1 wording); a blank or over-1000-character reason for the change (`MOA_REASON_REQUIRED`; it goes on the ingredient event).
5. **Stale check:** the ingredient's active list of `{scheme, group_code, source_note}`, sorted, must equal `p_expected_modes` sorted (the list the screen showed, notes included), else `MOA_LIST_STALE: the groups of "<name>" changed since you opened them; reload`. No new version column is needed.
6. Retire each active row not in `p_modes` (`status 'retired'`, `row_version + 1`); insert each pair not yet active with its own `source_note`; on a pair that stays, update `source_note` (and `row_version + 1`) when the request's note differs, so a corrected source is never silently dropped (Luna round 1).
7. If nothing changed, write no event and set the result to `{unchanged: true}`; otherwise write the ingredient event. **Either way `save_idempotency` runs last**, so a key used for a no-change request still refuses a later different request (Luna round 1).
8. Return `{ingredient_id, modes, parents_affected, products_affected}`: the active parents, and the active sizes of those parents, whose shown groups this list feeds. That is parents with an active row of this ingredient, plus parents with an active row of a form whose acid it is **and that has no list of its own** (3.3). The editor's "This changes N products" uses `products_affected`, read before saving from the same count in `get_ingredient_mode_users` (3.4).

No product row, chemistry version or parent event changes: a list change is shown live on every product (2.2).

### 3.3 How a product's groups are worked out

For each **active ingredient row** of the parent, and for each scheme:

- **Derived groups** = the ingredient's own active list for that scheme; if the ingredient has **no list at all** (no active row in any scheme) and it names an acid, the acid's list instead (one step only: DM-1's writers let a form name only an active parent-form acid, `_resolve_active_ingredient`, and a parent form names no acid, `active_ingredients_parent_form_shape`, so there is no second step; the helper never follows more than one step even if that ever changed). The read says which: `from_ingredient` or `from_acid`.
- **Typed groups** = the parent's active `product_parent_modes_of_action` rows for that ingredient and scheme.

| Typed | Derived | Shown (live) | Label |
|---|---|---|---|
| none | some | derived | "from ingredient list" (or "from <acid>") |
| some | none | typed | "typed on this product" |
| same set | same set | once | "matches ingredient list" |
| different sets | — | **typed** | flagged: "Ingredient list says HRAC 27; this product says HRAC 5" |
| none, and no derived in any scheme | — | nothing | "group not recorded" (never a guess) |

**Disagreement rule (mirrors D-L):** what an admin typed on the product stays live and is never overwritten; the ingredient list's value is shown beside it as a flagged difference. The admin resolves it either by correcting the ingredient list (3.2) or by retiring the product's typed group (DM-1's correction, on an ungated parent). The summary marks a differing group with "differs". This is the same rule D-L applies to EPA values against typed chemistry.

**Product summary ("Groups: …"):** the distinct live groups across all ingredients, grouped by scheme in the order HRAC, FRAC, IRAC, codes sorted naturally ("Groups: HRAC 5, 9, 27"). If any ingredient has none: "… · 1 ingredient: group not recorded". With no ingredients: no summary line (the section already says "No chemistry recorded yet").

### 3.4 Reads

- **`_parent_mode_groups(p_parent_id uuid) RETURNS jsonb`** (private, `STABLE SECURITY DEFINER`, `search_path` pinned, no grants): the 3.3 result, `{ingredients: [{ingredient_id, name, derived_from, acid_name, schemes: [{scheme, live: [...], derived: [...], typed: [{row_id, group_code, source}], status}], not_recorded}], summary: [{scheme, group_code, differs}], not_recorded_count}`. Active rows only. CMP-2 calls this helper for its filter.
- **`get_parent_mode_groups(p_parent_id uuid) RETURNS jsonb`**: refuses a caller who is not an active profile (`is_active_profile()`), refuses an unknown parent, returns the helper's result. `EXECUTE` for `authenticated`. Everyone who can see the product page sees its groups (groups are label facts, not costs).
- **`get_ingredient_mode_users(p_ingredient_id uuid) RETURNS jsonb`**: admin only. The ingredient's active list (with notes) and the `parents_affected` / `products_affected` counts of 3.2 step 8, for the editor to show before saving. `EXECUTE` for `authenticated`; refuses non-admins inside.
- **`get_ingredient_mode_worklist() RETURNS jsonb`**: admin only. Active ingredients used by at least one active parent that have no list of their own and whose acid (if any) has none, with the count of products using each, sorted by that count. `EXECUTE` for `authenticated`; refuses non-admins inside.

### 3.5 Who may edit

**Admins only** (the writer calls `_product_parent_require_admin`). Reasons: every DM-1, DM-1b and DM-4 chemistry writer is admin-only; one ingredient-list save changes what every product containing it shows, so a typo spreads catalog-wide; and groups feed resistance advice to growers. Everyone with an active profile can read them.

---

## 4. MOA-1 DB · The database PR

**File:** `supabase/migrations/<stamp>_ingredient_modes_of_action.sql`. The stamp is chosen at build: after `20270106110000` (newest file on `main` today) and after any stamp claimed in `docs/changelog.d/` or the sibling notes folder.

### 4.A Preflight (refuse unless all hold; one transaction, the temp-table pattern of `20270105110000`)
- `active_ingredient_modes_of_action` does not exist; no function named `set_active_ingredient_modes`, `get_parent_mode_groups`, `get_ingredient_mode_users`, `get_ingredient_mode_worklist` or `_parent_mode_groups` exists with any argument list (`pg_proc` by name).
- These exist: `active_ingredients`, `active_ingredient_events`, `product_parent_ingredients`, `product_parent_modes_of_action` with its `source` column, `_product_parent_require_admin()`, `_product_parent_replay(text,text,text)`, `save_idempotency(text,text,jsonb)`, `_active_ingredient_event(uuid,text,text,text,jsonb,jsonb)`, `is_active_profile()`, `is_admin()`.
- Capture an md5 of source, settings, owner, security mode and grants for the functions MOA-1 must not touch: `_apply_parent_chemistry`, `_parent_chemistry_values`, `_check_parent_chemistry`, `_chemistry_kept_modes`, `_parent_chemistry_epa_refusal`, `get_parent_chemistry`, `set_parent_chemistry`, `correct_parent_chemistry`, `_ingredient_users`, `_ingredient_usage_fingerprint`, `get_active_ingredient_worklist`, `retire_active_ingredient`, `reactivate_active_ingredient`, `promote_chemistry_proposal`, `commit_epa_proposal`.
- Capture row counts and an md5 of `(id, status, row_version)` for `product_parent_modes_of_action` and `active_ingredients`.

### 4.B Body
Section 3.1's table, index, RLS, policy and grants; 3.2's writer; 3.4's helper and three reads. Every function owned by `postgres` with `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role, metabase_ro`, then `GRANT EXECUTE … TO authenticated` on the four public ones only. Header line `-- idempotency-body-check: exempt` with the house reason (the writer checks its key through `_product_parent_replay`, which calls `check_idempotency`, and saves its receipt with `save_idempotency` last).

### 4.C What the migration does not touch
No existing table, column, row, grant, policy or trigger. None of the fifteen functions in 4.A. The EPA gate is unchanged. Typed groups keep working exactly as today on ungated parents.

### 4.D Rollback (its own reviewed migration)
Revert the screen PR first, so no screen calls a dropped function. Then revoke `EXECUTE` on the four public functions and drop all five (never CASCADE); revoke `SELECT` on `active_ingredient_modes_of_action` and keep it as unreadable history (the house rule for DM-1b and DM-4 tables). No product data to restore: nothing outside the new table was written. The ingredient events written by MOA-1 stay (append-only history).

### 4.E Lock and timing
`SET LOCAL lock_timeout = '5s'`. The new table's foreign key briefly locks `active_ingredients` against writes while it is created (milliseconds; the table is empty today). If an ingredient save holds it, the migration waits at most 5 seconds and then fails whole, changing nothing, and is simply re-run. No product, price or stock table is locked, so no fixed window is needed (Luna round 1).

### 4.F Postflight (inside the migration)
- RLS on, one policy, exact grants (read from `has_table_privilege` for each role), no write privilege for any role.
- Each new function: owner `postgres`, `SECURITY DEFINER`, `search_path = public, pg_temp`; `EXECUTE` only for `authenticated` on the four public ones and for nobody on the helper (`has_function_privilege` for `PUBLIC`, `anon`, `authenticated`, `service_role`, `metabase_ro`).
- The fifteen captured md5s and both row-count captures are unchanged.

### 4.G Files
- the migration;
- `docs/changelog.d/<date>-moa1-ingredient-groups.md` and `docs/reference/migrations.d/<stamp>_ingredient_modes_of_action.md`;
- `scripts/smoke/prove-ingredient-modes-of-action-real-schema.mjs` (cases in section 6);
- `docs/reference/rpc-functions.md` entries for the four public functions;
- `src/types/index.ts` (`IngredientModeOfAction`, `ParentModeGroups`) and regenerated `src/types/supabase.ts`;
- after apply: schema registry refresh, live function snapshot entries, `npm run db-sweeps:live` (and the sweep allowlist if it flags the new `SECURITY DEFINER` functions).

### 4.H Risks

| Risk | Handling |
|---|---|
| A wrong group on one ingredient shows on every product with it | Admin only; a required source note per group; the editor shows "This changes N products" before saving; every save is logged with before and after. |
| Two admins edit one ingredient's list at once | The stale check (3.2 step 5) refuses the second save by name. |
| A salt shows its acid's groups when the salt itself is different | It cannot differ in mode of action; and a form that has its own list uses only its own. |
| A typed group that disagrees can't be removed on a gated parent | DM-1's gate refuses group retires there. Live count of typed groups: **0**, and after MOA-1 nobody needs to type one on a gated parent. The flag shows the difference; removing such a row is deferred to a follow-up only if one ever appears (section 8). |
| CMP-2 computes groups its own way | It calls `_parent_mode_groups` (2.4). |
| The new read is slow on a large product | One parent at a time, a handful of ingredients; indexes on `ingredient_id` exist on both tables. |

---

## 5. MOA-1 Screens · The screen PR

Lands after the database PR is applied (migration-plus-callers split, `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`).

**Files:**
- `src/lib/productModeGroups.ts` (new): `fetchParentModeGroups`, `fetchIngredientModeWorklist`, `setIngredientModes`, each through `src/lib/db.ts` with `assertRpcResult()` and one retry key per intent (the `getCreateKeyFor` pattern; a new key whenever the request changes).
- `src/components/products/ChemistryParts.tsx`: `ChemistryLists` shows each ingredient's live groups with the 3.3 label; a difference shows both values and "differs"; an ingredient with none shows "group not recorded". Admins get **"Set groups"** beside each ingredient.
- `src/components/products/IngredientGroupsModal.tsx` (new): edits one ingredient's list (scheme and group rows, the existing `ModeRows` look, each row with its own required "Where is this from?" note), a reason for the change, and "This changes N products" (from `get_ingredient_mode_users`). It sends the list it loaded (notes included) as `p_expected_modes`. Submit and close are disabled while saving. A reply that times out keeps the form locked and **re-sends the identical request with the same retry key** until it gets an answer (the database either returns the saved answer or runs it once, behind the same lock), and only then says saved or refused; it never decides from a plain reload, which could run before the timed-out save commits (Luna round 1). A `MOA_LIST_STALE` refusal reloads and says "someone else just changed this".
- `src/components/products/ProductChemistrySection.tsx`: reads `get_parent_mode_groups` beside `get_parent_chemistry` and shows the **"Groups: …"** summary at the top of the Chemistry section; refreshes it after any chemistry or group save. Each pair of reads is tagged with the parent ID and a request number; a reply for another parent or an older request is ignored, and the groups show only once both reads of the same request have answered, so a slow reply for product A never shows under product B and the two lists never come from different moments (Luna round 1).
- `src/components/products/IngredientReviewModal.tsx`: a third list, **"Ingredients with no group yet"**, from `get_ingredient_mode_worklist`, each with "Set groups".
- `src/components/products/ChemistryEntryModal.tsx`: when an admin picks an existing ingredient that has a list, show "Groups from the ingredient list: …" above the per-product group rows, so nobody retypes them. No change to what it saves.
- Tests: component tests for each 3.3 row, the summary line, the editor's stale and timeout paths, and the worklist.

**Not touched:** `src/pages/ProductDetail.tsx` (the section already renders inside it), the setup workbook, every quote, job, invoice, PDF and field-app file.

**Sol:** none of the screen files is on `docs/reference/sol-required-paths.md` and none carries a money word, so the screen PR lands on green checks. The database PR is under `supabase/`, so it needs Sol and the apply proof gate.

---

## 6. Done when

**In the prover (`prove-ingredient-modes-of-action-real-schema.mjs`, against the schema-matched copy):**
1. An admin sets `HRAC 9` on an ingredient; a parent containing it shows `HRAC 9` "from ingredient list" with no typed row.
2. A two-ingredient premix shows both ingredients' groups and a summary with both.
3. An ingredient with no list (and no acid list) shows "group not recorded"; the summary counts it.
4. A salt with no list of its own shows its acid's groups, labelled from the acid; once the salt gets its own list, only its own shows.
5. A typed `HRAC 5` on a product whose ingredient list says `HRAC 27` keeps `HRAC 5` live and returns both, flagged as differing.
6. A product on an EPA-gated parent shows derived groups (the gate is not consulted by the read and not changed).
7. Refusals: a non-admin save; a retired ingredient; a bad scheme or code; a repeated pair; 11 groups; a blank reason; a stale `p_expected_modes`; a missing retry key.
8. The same retry key twice writes once; the same key with a different list is refused, including after a first request that changed nothing; changing only a kept group's note updates the note and logs an event.
9. A save that removes a group retires the row (not deleted) and writes one ingredient event with before and after.
10. A non-admin active user can read groups; an inactive profile and `anon` cannot; nobody can write the table directly.
11. The postflight md5s prove none of the fifteen DM-1/DM-1b/DM-4 functions changed.

**Observed in the app against the private test copy (`scripts/local-app/`):** as an admin, set groups on an ingredient from the product page; see them on a second product that contains it without typing; see a premix's summary; see "group not recorded" and the worklist entry for an ingredient without a list; as a non-admin, see the groups and no "Set groups" button. A flow the test copy cannot run is recorded as owed, not passed.

---

## 7. Order and dependencies

- **Ready to build now:** DM-1, DM-1b and DM-4's database parts are live (`20270105110000` applied 2026-11-12). MOA-1 needs nothing else.
- **Lands before CMP-2:** CMP-2's mode-of-action filter reads `_parent_mode_groups`. CMP-2 is on hold until Mason re-reviews its plan (Stage 5); MOA-1 does not wait for it.
- **Out of scope:** anything on the quote page. Taha owns the quote screens; the quote-page option to show each line's actives and groups to the grower stays a logged "Later features" item until his quote work lands. No quote file is touched. Also out: a groups column on the setup workbook, a bulk import of a published classification list, and showing groups on the product list or in search.
- **Other sessions:** the screen PR edits only `src/components/products/` chemistry files and a new lib file. Before building, check open PRs for those files (none on 2026-11-12) and never edit a file another open PR touches.

---

## 8. Named deferrals

- **Retiring a typed group on an EPA-gated parent** stays refused (DM-1's gate). There are 0 typed groups live and MOA-1 removes the need to type them; if one ever needs removing, a follow-up re-issues that one gate allowance with its own review.
- **Bulk-filling ingredient lists** from a published HRAC/FRAC/IRAC table or a workbook tab: later, if typing them from the worklist proves slow.

---

## 9. Questions for Mason

**NEEDS MASON - DECISION REQUIRED (1 of 4): who can set an ingredient's groups?**
One save changes every product that contains that ingredient. **Recommended: admins only**, the same as all other chemistry; everyone can see them.

**NEEDS MASON - DECISION REQUIRED (2 of 4): if a product has a group typed by hand that disagrees with the ingredient's list, which one shows?**
**Recommended: keep the hand-typed one showing and flag the difference beside it**, the same rule you set for EPA values (D-L). You then fix whichever side is wrong.

**NEEDS MASON - DECISION REQUIRED (3 of 4): should a salt or ester form automatically use its acid's groups?**
For example, a 2,4-D ester showing 2,4-D's group. **Recommended: yes**, unless that form has its own list, so you type each group once per acid.

**NEEDS MASON - DECISION REQUIRED (4 of 4): how should the lists get filled?**
There are no ingredients in the system yet; they arrive as EPA lookups and the workbook fill products in. **Recommended: an admin types each ingredient's groups from a "no group yet" list, noting where each came from** (a label or the published HRAC/FRAC/IRAC list). No bulk import for now.

---

## 10. Review record

**Luna round 1** (gpt-6-luna xhigh, head `021efe046`): 6 findings (4 MED, 2 LOW), no BLOCKER or HIGH. All fixed:
- MED: a no-change save saved no retry receipt, so its key could be reused for a different list → the receipt is saved on every path (3.2 step 7).
- MED: a kept group's source note could never be corrected → notes are per group, compared in the stale check, and updated when they change (3.2 steps 4–6).
- MED: the timeout path decided from a plain reload, which can run before the save commits → it re-sends the same request with the same key and reports only that answer (section 5).
- MED: the product page's two reads had no guard against a late reply for another product → replies are tagged with parent and request number and shown only as a matched pair (section 5).
- LOW: "This changes N products" counted parents, and counted salt forms that have their own list → `products_affected` counts active sizes and excludes forms with their own list; a new admin read gives the number before saving (3.2 step 8, 3.4).
- LOW: "creating a table takes no lock on an existing table" was wrong for the foreign key → 4.E now states the brief lock and the 5-second clean failure.
