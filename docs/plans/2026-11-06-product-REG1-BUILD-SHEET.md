# Product Master Stage 2: REG-1 build sheet (registration per EPA number) and 7.7 (EPA-number correction on)

**Status:** plan only; nothing built. Written 2026-11-06 against `main` and the live database (read-only). This sheet replaces the REG-1 outline in `docs/plans/2026-11-04-product-stage2-BUILD-SHEET.md` §7.3 and the 7.7 outline in §7.7 for building; where they differ, this sheet wins (section 2 lists each difference). Section numbers like "§4" without a file name point to the Stage 2 sheet.

**Re-planned 2026-11-06** (Mason: hold the EPA-number tools until restricted-use posting reads what was sold, then re-plan the posting and rollout parts). The earlier four-PR rollout left live windows between the seed and the guards, and posting read each product's current state; reviewers kept finding new HIGHs there (17 Luna rounds, 6 Sol rounds; section 12). The re-plan (designed with Astra, then checked against the code and live data) ships **one database PR** that holds every database change, **one Mason-approved seed** that switches registrations on in a single transaction, then **one screens PR**. Guards exist before any registration does, so registrations and sizes can never disagree on live, and posting reads facts captured on each invoice line when it was saved.

**Words used here.**
- **Registration**: one row per EPA registration number, holding the facts printed on that label (signal word, restricted-use status, REI, PHI, label maximum rate, label adjuvants), its status (active or cancelled) and the label link. Every size and brand carrying that number reads these facts from it.
- **Size**: a `products` row. **Parent**: a `product_parents` row (PAR-1). **Brand**: a `product_parent_brands` row (PAR-2) or a legacy `product_brands` row.
- **Pass**: a private one-row permission slip (transaction ID plus target) inserted just before a governed write and deleted just after; a guard refuses the governed columns without one. Same mechanism as PAR-1's `product_parent_copy_passes`.
- **RUP**: restricted-use pesticide. Stored on the registration as `rup_status` in (`yes`, `no`, `unknown`).
- **Seeded**: the one-time seed (section 5) has committed. Before it, no registration exists and every REG-1 guard and tool is inert or refused; after it, every size or brand with a number has a registration.
- **Sale capture**: the EPA number, RUP answer and signal word stored on an invoice line by the database when the line is saved.

---

## 1. Facts this plan is built on (checked 2026-11-06)

**Live data (counts only):**

| Fact | Value |
|---|---|
| Products with an EPA number | 286 rows, 203 distinct numbers |
| Numbers shared by two or more products | 75 numbers, 158 rows |
| Shared numbers whose rows disagree on a label fact | **1** (signal word); 0 on RUP, REI, PHI, label max rate or unit |
| EPA numbers failing the strict format after normalizing | 0 (`guard_product_setup_fields` already enforces it on insert and on change) |
| Inactive products with an EPA number | 0 |
| Products with `is_rup = true` | 2 |
| Products with an EPA number but no signal word | 191 |
| `product_parents`, `product_parent_members`, `product_parent_brands`, `product_brands` rows | 0 each |
| `product_label_drafts` rows | 0 |
| Invoice lines | 27: 19 on invoices not yet posted (18 draft, 1 unposted), 8 on posted invoices (paid, overdue, voided); 9 lines have a blank EPA number where the product has one (8 of them on drafts); 0 lines differ from their product's number; 0 lines on a product marked restricted-use |

**Live schema and code REG-1 touches:**
- `products` label columns: `epa_registration`, `is_rup boolean NOT NULL`, `signal_word`, `rei_hours`, `phi_days`, `max_label_rate`, `max_label_rate_unit`. No adjuvant column. `authenticated` holds column-level `INSERT` and `UPDATE` on all of them, so a direct app write is a real path today.
- `products` has 23 triggers (listed in the Stage 2 sheet's §4.4 risk; PAR-1 added `trg_b_guard_product_parent_timings` and `trigger_zz_guard_product_parent_values`).
- `product_brands` (legacy) and `product_parent_brands` (PAR-2) each carry `epa_registration` (strict CHECK `^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$`), `is_rup boolean` (nullable) and `signal_word`. **Neither has REI, PHI or label-max columns.** Both are write-locked (writes only through admin RPCs).
- `product_label_drafts`: `authenticated` holds table-level `INSERT`, `UPDATE`, `DELETE`. It stores proposed signal word, REI, PHI, EPA number and label max rate, but **no RUP**.
- `commit_label_draft`, `create_label_draft` and `bulk_create_label_drafts` already require a retry key bound to a request fingerprint (the 2026-10-15 wrapper pattern: public wrapper → `_…_replay_impl_20261015`). The commit implementation locks the draft, then the product `FOR UPDATE`, and writes the product directly.
- `generate_rup_sales_records(p_invoice_id uuid, p_idempotency_key text)`: active admin or sales_rep; refuses an unposted invoice; selects invoice lines joined to products `WHERE p.is_rup = true` and copies the product's **current** `epa_registration` and `signal_word`; de-duplicates on `(invoice_id, product_id)` for rows not voided. KI-18 batch 1 (PR #1579, open) re-issues it with Chicago dates and still reads the product (`20261128100000_ki18_batch1_chicago_today.sql:2535-2542`).
- `save_invoice` (body in `20261106140000_invoice_resave_keeps_cost.sql`, impl `_save_invoice_lineage_unaware_impl_20260827`): deletes every line of the invoice (`:281`) and re-inserts the payload's lines, carrying values of a kept line through a map keyed by the old line ID (`:301-303`); it stores `invoice_items.epa_registration` from the payload (`:322-336`). Line IDs are therefore not stable across a save.
- `_product_parent_grouping_open()` returns false (PAR-2 approvals are off).

---

## 2. Where the §7.3 / §7.7 outline is wrong against current code

| # | Outline says | Current code says | What this sheet does |
|---|---|---|---|
| 1 | PAR-1 added `product_parent_settings.epa_correction_enabled` | No such table or setting exists. PAR-1's `_product_parent_identity_after` refuses every EPA change outright (`PRODUCT_PARENT_EPA_CORRECTION_OFF`). The parked branch `claude/sweet-bun-f7920f` adds a function switch `_product_parent_epa_correction_enabled()` | 7.7 uses that function switch (section 7) |
| 2 | A separate `trigger_zz_guard_product_parent_identity` | The EPA check lives inside `trigger_zz_guard_product_parent_values` (normalized EPA number with category, timings and rates) | REG-1's new guard sorts after it (section 3) |
| 3 | PAR-1 re-issued `commit_label_draft` to hold an EPA change on a grouped size with `LABEL_DRAFT_EPA_BELONGS_TO_PARENT` | Not re-issued. On a grouped size, a draft that changes the EPA number fails as a whole on the parent guard | Part B re-issues it with the registration routing |
| 4 | PR 1 brings the label-draft RPCs up to the retry rule | Already done (2026-10-15 batch) | Dropped; re-issues keep the wrapper pattern |
| 5 | `BulkProductImport.tsx:264-288` inserts directly | It now calls `preview_product_import` (`:67`) and `apply_product_setup` (`:391`); product creation is moving to `create_product_with_parent` (PR #1553). Every create runs through `apply_product_setup` insert mode | Insert paths are covered by the insert trigger and the re-issues in part D |
| 6 | Copy all label facts onto brands | Brand tables have only `signal_word` and `is_rup`; brand `is_rup` is nullable | Brands get signal word and RUP only (§7.8 item 5) |
| 7 | Draft target columns on `product_label_drafts` | The table has client write grants, so new columns there could be forged | A private side table `label_draft_targets` (part A) |
| 8 | Writers listed in the §7.3 table are complete | `move_product_size` writes the parent's EPA number onto a moved size that has none (`20261110150000`, around `:214-217`; re-issued by Taha's `20261201110000_product_parent_review_fixes`) | Added to the writer list and to part D |
| 9 | "No lock-order issue" | `add_product_size` locks the parent and its sizes, then inserts; `apply_product_setup` locks products before writing. An insert trigger that locks a registration would take it after product locks: a deadlock risk | One shared lock taken first, then one row order (section 3.2) |
| 10 | 7.7 adds a side table `job_line_epa_snapshots` and is gated on REG-1 | The parked branch already built a different design: `job_chemicals.epa_registration` column filled by trigger, the correction re-issued with its own switch (off), and switch-on planned for its screens PR | 7.7 builds on the parked branch, not a redesign (section 7) |
| 11 | Line references | Moved: `LabelDataQuality.tsx` `:518`/`:579`/`:797` → `:524-525`/`:585-586`/`:803-804`; `Products.tsx:1167-1169` → `:1169-1171`; `ProductBrandsSection.tsx:476-481` → `:480`; `ProductDetail.tsx:762-764` → `:764-765` | Current numbers used below |
| 12 | Back-fill compares sizes and brands | Both brand tables are empty today | Seed compares sizes; brand rows (if any by then) are checked by the same preview |
| 13 | REG-1 defines its own normalization | `_normalize_epa_registration` (PAR-1) plus three strict CHECKs already force one canonical form | Reuse it; the registration key gets the same strict CHECK |
| 14 | RUP posting is untouched by REG-1 | Posting reads the product's current number and flag, so any later change to a product rewrites what an unposted sale records | Part C: posting reads the sale capture on each invoice line |

---

## 3. Shared design

### 3.1 Tables

All new tables have RLS on, a `SELECT` policy for active users (except the private ones), and no write grants. **Every function in this sheet** (RPCs, helpers, trigger functions, re-issues) is `SECURITY DEFINER` with `SET search_path = public, pg_temp`, follows `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`, and grants `EXECUTE` to `authenticated` only for the public RPCs; helpers and trigger functions get no grant. **"Admin" means enforced, not named:** every admin RPC's first statement is `v_actor := public._product_parent_require_admin();` (PAR-1's helper, `20261108120000:512-519`: refuses a missing `auth.uid()`, then a caller for whom `is_admin()` is false), before the replay lookup and before any lock. The actor recorded on every event, and `created_by`/`updated_by`, is that returned `v_actor` (or `auth.uid()` in a trigger), never a parameter. Every mutating RPC takes `p_idempotency_key text DEFAULT NULL`, refuses a missing key, and uses `_product_parent_replay(p_key, p_scope, p_fp)` with its own operation name as the scope.

- **`epa_registrations`**
  - `epa_registration text` primary key, strict CHECK as on `product_parent_brands`.
  - `registration_status` in (`active`, `cancelled`, `unknown`), default `unknown`; `cancelled_on date` (required when cancelled, else null).
  - `label_url text` (https only), `label_accepted_on date`, `source text`, `checked_at timestamptz`.
  - Label facts: `signal_word` (same CHECK as `products.signal_word`, nullable), `rup_status` in (`yes`, `no`, `unknown`) not null default `unknown`, `rei_hours`, `phi_days`, `max_label_rate`, `max_label_rate_unit` (same CHECKs as the product columns).
  - `label_adjuvants jsonb` nullable, default NULL meaning **not reviewed** (products have no adjuvant column, so the seed leaves it NULL); `'[]'` means reviewed, none on the label. Otherwise an array of `{kind: required|recommended, adjuvant_type text, note text}`, checked by an immutable validator function.
  - `registration_version bigint` (starts at 1; every successful write to the row increments it and sets `updated_by` and `updated_at` in the same statement), `created_by`, `created_at`, `updated_by`, `updated_at`.
- **`epa_registration_events`**: append-only (update and delete refused). `event_type` in (`seeded`, `created`, `updated`, `assigned`, `draft_committed`); `reason`, `before_values`, `after_values`, `affected jsonb` (per size or brand: table, ID, before and after); `changed_by`, `changed_by_name`, `changed_at`.
- **`epa_registration_copy_passes(txid bigint, target_table text, target_id uuid, event_id bigint)`**: private, no grants.
- **`label_draft_targets(draft_id uuid primary key, epa_registration text, product_epa_registration text, product_id uuid, product_label_fingerprint text, registration_version bigint)`**: private, no grants. Filled by the draft-create functions, read only by the commit. `epa_registration` is the draft's own number at creation; `product_epa_registration` is the product's number at that moment.
- **Sale capture columns on `invoice_items`** (part C): the existing `epa_registration` becomes the number sold; new `sale_is_rup boolean` (NULL = not captured, never "No"), `sale_signal_word text`, `sale_facts_captured_at timestamptz` (NULL = not captured), `sale_facts_source text` (`registration:<number>@<version>`, `product:<id>` for a numberless product, or `seed-approved`). Clients cannot write them (column grants revoked for these four, set only by the database; see Q7 for the grant change).

### 3.2 Locking

**One shared lock first.** Every function that reads or writes an EPA number, a label fact or a sale capture takes the transaction-level advisory lock `pg_advisory_xact_lock(hashtext('crx_epa_registration'))` **before it reads any product's number or facts**:
- **Exclusive** (`pg_advisory_xact_lock`): the seed, `set_epa_registration`, `assign_epa_registration`, the draft commit, `apply_product_setup`, the brand upserts, `move_product_size`, `_insert_parent_size` / `add_product_size` / `create_product_with_parent`, and 7.7's correction.
- **Shared** (`pg_advisory_xact_lock_shared`): `save_invoice` and `generate_rup_sales_records`, so invoice saves never wait on each other, only on a registration or number change.

So a save cannot read a product's number, then see it change before it locks: nothing that changes numbers or facts can run between the read and the commit. Direct client writes do not take the lock, but the guards (3.3) refuse every direct change to a number or label fact once seeded, so they cannot race.

**Row order after the shared lock:** invoices (ID order) → registrations (number order) → parents (ID) → products (ID) → brands (legacy, then parent brands, ID) → invoice lines and RUP records (ID) → the rate lock `FOR SHARE` where already taken. Today's PAR-1/PAR-2 orders (parent → products → brands; approval: proposal → products → rate lock; `move_product_size`: both parents in ID order → size → brands) are a suffix of it.

**Creating a registration that does not exist yet:** `INSERT … ON CONFLICT (epa_registration) DO NOTHING`, then `SELECT … FOR UPDATE`. Under the exclusive shared lock two creators cannot overlap; an admin create with a null expected version that finds a row is refused as stale (`EPA_REGISTRATION_STALE`), never with a raw key error.

### 3.3 Guards (part D; inert until seeded)

Each guard first checks whether the seed has committed (a `seeded` event exists, read through a stable helper `_epa_registrations_seeded()`); before that it does nothing, so the database PR changes no behaviour until Mason approves the seed.

- **`trigger_zz_guard_product_registration`** on `products` (`BEFORE INSERT OR UPDATE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, owned by `postgres`). Name sorts after `trigger_zz_guard_product_parent_values` (so a grouped size gets the parent message first) and before `trigger_zzz_guard_product_rate_lock`.
  - **UPDATE:** a change to `signal_word`, `is_rup`, `rei_hours`, `phi_days`, `max_label_rate` or `max_label_rate_unit` on a row with a number, without a pass, is refused: `EPA_REGISTRATION_FACT: <column> belongs to EPA registration <number>; edit it on the registration (reload the app if you do not see a Registration panel)`. A change to `epa_registration` without a pass is refused with `EPA_REGISTRATION_ASSIGN: use Change EPA number`, including adding a number to a numberless size. An update that resends unchanged values passes. A numberless size edits its own `is_rup` freely (it has no registration).
  - **INSERT** with a number: the number must already have a registration, else `EPA_REGISTRATION_NEW_NUMBER: add this EPA number's registration first`. The row's label facts are overwritten from the registration; a sent fact that is not NULL and differs is refused (`EPA_REGISTRATION_FACT_CONFLICT: <column> on EPA registration <number> is <value>`). For RUP, only a sent `true` against a registration that is not `yes` conflicts, because a boolean cannot tell a default `false` from an intended No; Q7 removes the direct insert grant so that only the admin functions (which take RUP from the registration) insert. The trigger never creates a registration; every insert function that brings a new number creates the registration first through the internal create helper from its `p_new_registration` (label facts entered from the label, `rup_status` as `yes`/`no`/`unknown`), else it is refused with `EPA_REGISTRATION_FACTS_REQUIRED`.
- **Brand guards** on `product_brands` and `product_parent_brands`: same rules for `signal_word`, `is_rup` and `epa_registration`; brand `is_rup` mirrors `rup_status` as `true` / `false` / `null`.
- **Invoice-line guard** on `invoice_items` (`BEFORE INSERT OR UPDATE`): the four capture columns and `epa_registration` can only be written under the capture pass that `save_invoice` and the seed take; any other write to them is refused (`INVOICE_LINE_SALE_CAPTURE`). Not seeded-gated: it applies from the database PR's apply (see part C).

### 3.4 Writers (every path that writes an EPA number, a label fact or a sale capture)

| Writer | Today | After REG-1 |
|---|---|---|
| Product page save (`ProductDetail.tsx:503-504`, `PRODUCT_NONPRICING_FIELDS` `:76`) | direct update incl. `is_rup`, `signal_word` | guard refuses a changed label fact or number once seeded; the screens PR stops sending them for registered sizes |
| Product page create (`ProductDetail.tsx:764-765`) | direct insert | replaced by #1553 (`create_product_with_parent`); insert trigger covers any direct insert |
| Products list (`Products.tsx:808-809`) | nonpricing update | same as product page |
| Label data quality (`LabelDataQuality.tsx:524-525`, `:585-586`, `:803-804`) | updates `signal_word`; `:803-804` sets the EPA number and clears signal word | refused once seeded; screens PR routes signal word to `set_epa_registration` and the number to Change EPA number |
| Setup workbook / bulk import (`productSetupWorkbook.ts:183`, `BulkProductImport.tsx:391`) via `apply_product_setup` | writes all label facts, update and insert | part B re-issue |
| `commit_label_draft` (`LabelReview.tsx:293`) | writes the product | part B: writes the registration, which copies to sizes and brands |
| `upsert_product_brand` (`productBrands.ts:49`), `upsert_parent_brand` | write brand `is_rup`, `signal_word`, `epa_registration` | part B: signature and new-number rule; part D: facts from the registration, number change refused |
| `move_product_size` | sets the parent's EPA number on a moved size with none | part D re-issue from Taha's body (`20261201110000`) |
| `_insert_parent_size` / `add_product_size` / `create_product_with_parent` | force the parent's number on the size | part D re-issue (from #1581's body once merged) |
| `save_invoice` | stores the payload's line number | part C: the database captures the sale facts |
| `generate_rup_sales_records` | reads the product's current state | part C: reads the sale capture |
| `correct_product_parent_identity` (parked branch) | switch off | 7.7 (section 7) |
| Edge Functions | read only (`process-blend-ticket`) | unchanged |

---

## 4. REG-DB · The database PR (all database changes, one PR)

**Shape:** one PR, four migration files applied in order (parts A to D), all applied live before merge through the normal migration gate. Nothing changes behaviour at apply except part C's sale capture on new invoice saves (section 4.C); every registration tool refuses with `EPA_REGISTRATION_NOT_SEEDED` and every product guard is inert until the seed (section 5). **Writes no live product or registration rows at apply.**

**Depends on:** KI-18 batch 1 (#1579) merged (part C re-issues `generate_rup_sales_records` from its body); #1581 merged (part D re-issues `_insert_parent_size` from its body); Taha's `20261201110000_product_parent_review_fixes` (merged in #1586). Built from each function's body on `main` at build time and diffed against `pg_get_functiondef` on live before review.

### 4.A Storage, seed tools, registration RPCs, draft targets

- The tables in 3.1, with RLS, policies, the event table's append-only triggers, the adjuvant validator, and `_epa_registrations_seeded()`.
- `preview_epa_registration_seed()` (admin, read-only): per distinct normalized number on sizes and brand rows, the proposed registration facts, every disagreement (column, values, row counts, product IDs); the not-yet-posted invoice lines and their proposed sale capture (section 5); and a `fingerprint` of the whole result. RUP proposal: any row `true` → `yes`, else the seed's RUP default.
- `seed_epa_registrations(p_picks jsonb, p_line_picks jsonb, p_rup_default text, p_expected_fingerprint text, p_idempotency_key text)`: section 5.
- `set_epa_registration(p_epa_registration, p_expected_version, p_changes jsonb, p_reason, p_idempotency_key)` (admin, key): exclusive shared lock; locks the registration, then the sizes (ID order) and brands carrying it; refuses a stale version; updates it; writes one event; copies the changed facts to every size and brand under passes. Creates the registration when `p_expected_version` is null and none exists, writing a `created` event. Unposted invoice lines are not touched: their sale capture stands, and posting also consults the registration (part C), so a Yes→No edit cannot drop a sale made while it was Yes, and a No→Yes edit before posting records it.
- `preview_epa_assignment(p_target_table, p_target_id, p_new_number)` and `assign_epa_registration(p_target_table, p_target_id, p_new_number, p_new_registration jsonb, p_expected_target_fingerprint, p_expected_new_version, p_reason, p_idempotency_key)` (admin, key): Change EPA number on one ungrouped size or one brand. Exclusive shared lock; locks old and new registration (number order), then the target; refuses a grouped size (`EPA_REGISTRATION_GROUPED_USE_PARENT`, which points to 7.7); refuses a stale target fingerprint; `p_expected_new_version` is the new number's `registration_version` the preview showed, NULL when it showed none, and any mismatch (including one created since) is refused (`EPA_REGISTRATION_STALE`); a new number with no registration needs `p_new_registration` (entered from the new label; the target's old facts are never copied), else `EPA_REGISTRATION_FACTS_REQUIRED`, and the registration is created first. Writes the number and the new registration's facts under a pass. Invoice lines keep their sale capture, so no open-invoice block is needed. **Job lines:** once the parked job-line copy (section 7) is on `main`, assignment also locks the size's jobs `FOR UPDATE` (ID order, after the size), checks `_job_line_epa_follows_product(job_id)` under the lock, and moves `job_chemicals.epa_registration` to the new number only where it is still true; until then, assignment is refused on a size that has a line on a sprayed or finished job (`EPA_REGISTRATION_JOB_HISTORY: change this number after the job-line history is kept`), so no spray record is ever re-labelled. Writes one `assigned` event on each of the old and new registrations (only the new one when there was no old number), carrying target, numbers, reason and actor.
- `_assign_epa_registration_internal(target, new number, …)`: the assignment body without the grouped-size refusal, for callers that already hold the parent locks (`move_product_size`, 7.7); not granted.
- `get_epa_registrations(p_numbers text[] default null)`: active users (checked inside: `auth.uid()` must be an active `profiles` row); no cost or price.
- **Draft targets:** `create_label_draft` and `bulk_create_label_drafts` implementations re-issued from their live bodies with one addition: insert the `label_draft_targets` row. Public wrappers unchanged.

### 4.B Draft commit, setup and brand signatures

- **`_commit_label_draft_replay_impl_20261015`** re-issued from its live body (md5 `dee9e34d…` at writing; diffed again before build), with the public wrapper re-issued at the same signature `commit_label_draft(uuid, text, text, integer, integer, text, numeric, text, boolean, text)` (no new overload):
  0. **Who.** Before the replay lookup the wrapper reads the draft's private `label_draft_targets` row and calls `_product_parent_require_admin()` when either number on it has a registration or there is no target row; a non-admin can never receive a cached registered-number result. The impl repeats the admin check after its locks whenever either number now has a registration.
  1. Exclusive shared lock; lock the registrations of the target's two numbers (number order), then the draft, then the product. Refuse `LABEL_DRAFT_TARGET_MISMATCH` unless the locked draft's `product_id` and number equal the target's `product_id` and `epa_registration`, and the product's current number equals the target's `product_epa_registration`. A draft with no target row is refused the same way (none exist live).
  2. Values written are the wrapper's parameters for `accepted` and `edited`; for `accepted`, refuse `LABEL_DRAFT_CHANGED` when they differ from the locked draft row (today `accepted` copies from the client-editable row, `20260629210000:288-299`).
  3. Staleness: refuse `LABEL_DRAFT_STALE` when the product's label-fact fingerprint differs from the target's and `p_force_overwrite` is false.
  4. **Same number, registration exists:** write through `set_epa_registration`'s internal helper (one `draft_committed` event; copies to all sizes and brands).
  5. **Same number, no registration:** hold with `LABEL_DRAFT_NO_REGISTRATION` (status stays `pending`; screen offers "Create registration"). §7.8 item 3.
  6. **Draft number differs from the product's:** return `LABEL_DRAFT_EPA_CHANGE`; the screen opens Change EPA number (ungrouped) or the parent correction (grouped).
  7. **Numberless product:** today's direct size commit, checked against the target's fingerprint.
  8. Drafts have no RUP field, so a commit never changes `rup_status`.
  Before the seed, every branch behaves as today's body (no registration exists), byte for byte on the harness fixtures.
- **`apply_product_setup` / `_apply_product_setup_update`** re-issued: exclusive shared lock; locks every registration the batch touches (number order) before any product; on a registered row, a label-fact value that differs from the registration is refused by name (`EPA_REGISTRATION_FACT`); a number change goes through `_assign_epa_registration` (refused for a grouped row naming the parent); insert mode takes facts from the registration, and a new number needs the workbook's label-fact columns for it (`EPA_REGISTRATION_FACTS_REQUIRED`), from which the registration is created first; an explicit RUP column is compared with the registration and refused on any difference. Before the seed it behaves as today.
- **Brand RPC signatures:** `upsert_product_brand` and `upsert_parent_brand` are replaced (`DROP FUNCTION` old signature, `CREATE` with `p_new_registration jsonb DEFAULT NULL` last, grants re-applied), so no old overload stays callable and existing callers resolve to the new body.

### 4.C Sale capture and posting

- The four capture columns (3.1) and the invoice-line guard (3.3).
- **`save_invoice`** re-issued from its body on `main` (shared lock first). For each line:
  - **New line, or a kept line whose product changed:** the database captures the sale facts from the product locked under the shared lock: its number; when that number has a registration (after the seed), `sale_is_rup = (rup_status = 'yes')`, `sale_signal_word` = the registration's, source `registration:<number>@<version>`; for a numberless product, its own `is_rup` and `signal_word`, source `product:<id>`; before the seed, the product's own flag and signal word, source `product:<id>`. The payload's number is compared with the product's and the save is refused on a difference (`INVOICE_LINE_EPA_MISMATCH: reload the invoice`), never silently replaced.
  - **Kept line, same product:** the capture is carried from the old line through the existing kept-line map (`:301-303`), including an uncaptured line (it stays uncaptured; a re-save never makes a legacy line look captured).
- **`generate_rup_sales_records`** re-issued from KI-18 batch 1's body (shared lock first), reading only the line:
  - A line with no capture (`sale_facts_captured_at` NULL) refuses the whole posting (`INVOICE_LINE_NOT_CAPTURED: re-save this invoice's line <n> or ask an admin`), except before the seed, when it posts by today's rule (the product's current state), exactly as today.
  - A line needs a RUP record when `sale_is_rup` is true **or** the registration of its **sold** number says `yes` at posting (never the product's current number). A sold number with no registration after the seed refuses the posting (`INVOICE_LINE_NO_REGISTRATION`); it never counts as No. Over-recording is the safe side for a compliance register; a registration changed later never touches posted invoices.
  - The record copies the line's sold number and `sale_signal_word`.
  - **De-duplication limit:** one active record per `(invoice_id, product_id)`. Lines sharing a product on one invoice must have the same sold number and signal word; their quantities are added and their RUP eligibility is OR-ed. Different captures for one product on one invoice refuse the posting (`INVOICE_LINE_MIXED_EPA: split into separate invoices`). An existing active record that disagrees is an error, not skipped.
- **Posted invoices** are never edited: `save_invoice` already refuses a posted invoice; a correction to what was sold on a posted invoice uses the existing void path and a replacement invoice, which captures and posts normally. No new correction RPC.
- Roles and the posted-invoice check are unchanged.

### 4.D Guards and insert paths

- The guards in 3.3 (inert until seeded) and `_epa_registrations_seeded()`.
- Re-issues, each from its body on `main` at build time, all taking the exclusive shared lock first:
  - `upsert_product_brand`, `upsert_parent_brand`: lock the registration before the parent; facts from the registration; a number change on an existing brand refused (`EPA_REGISTRATION_ASSIGN`); a new brand number with no registration needs `p_new_registration`.
  - `_insert_parent_size` (post-#1581), `add_product_size`, `create_product_with_parent`: lock the parent's registration before the parent; a new number needs `p_new_registration` (the parent's facts are never copied to a new number).
  - `move_product_size` (Taha's body): lock the size's current registration and the target parent's registration (number order) before both parents; when the move gives the size a number or changes it, write it through `_assign_epa_registration_internal` with an `assigned` event naming the move's actor and reason; the same job-history rule as assignment applies.
  - `correct_product_parent_identity`: only if the parked switch is already on when this PR is built; otherwise 7.7 does it.

### 4.E Files, harness, risks

**Files:** `supabase/migrations/<stamp>_epa_registrations.sql`, `<stamp>_epa_registration_draft_setup.sql`, `<stamp>_invoice_line_sale_capture.sql`, `<stamp>_epa_registration_guards.sql`; a changelog note and a migrations.d record for each; `scripts/smoke/prove-epa-registrations-real-schema.mjs`; `src/types/index.ts`, `src/types/supabase.ts`; `docs/reference/rpc-functions.md`; a `db-sweeps` predicate (registrations versus sizes, which must stay empty); `.claude/schema-registry.json` after apply.

**Done when (harness, before the seed):**
- Every new or re-issued function: `prosecdef` true, `proconfig` holds `search_path=public, pg_temp`, `EXECUTE` only as listed (read back from `pg_proc` and `information_schema.routine_privileges`); every admin RPC refuses a non-admin before any read of the replay table; one key twice writes once; one key with a different request is refused; a key used for one operation is refused for another.
- Every registration tool refuses with `EPA_REGISTRATION_NOT_SEEDED`; product page, setup workbook, brand upserts, draft commit and size inserts behave as before on the harness fixtures; a direct client write to a capture column is refused.
- A new invoice line gets a `product:<id>` capture; a payload number that differs from the product's is refused; a kept line carries its capture; posting an uncaptured line before the seed records exactly what today's body records.

**Done when (harness, after a seed on a copy shaped like live):**
- Seed preview: 203 proposed registrations, one disagreement, the not-yet-posted lines listed; seed without a pick refused; a changed product or invoice line between preview and seed refused on fingerprint; with picks, all registrations created, the disagreeing row matches, each not-yet-posted line captured as picked; a second seed refused; `is_rup` true → `yes`, else the RUP default.
- Direct `UPDATE` of a registered size's signal word, RUP or number refused by name; resending the same values passes; a numberless size edits freely.
- Insert with an existing number takes its facts; with a new number and no `p_new_registration`, refused; an explicit `true` against a registration that is not `yes` refused.
- `set_epa_registration` on a number shared by three sizes and one brand: all four updated, one event; a stale version refused.
- Assignment: A to B moves facts and writes events on A and B; grouped size refused; stale destination version refused (including none-then-created); a size with a sprayed job line refused until the job-line copy exists.
- Posting: a line saved under A, product then moved to B, records A with A's signal word; a line saved while A was Yes still records after A becomes No; a line saved while A was No records when A is Yes by posting; a line whose sold number has no registration refuses; two lines of one product with different captures refuse; an uncaptured line refuses after the seed.
- Draft commit: each branch in 4.B, including a draft proposing B for a product on A reaching `LABEL_DRAFT_EPA_CHANGE`, a non-admin refused after the locks when a registration appeared, and `LABEL_DRAFT_CHANGED`.
- Races (two sessions): registration edit vs `save_invoice`; assignment vs `save_invoice`; registration edit vs posting; registration edit vs `add_product_size`, `move_product_size`, the draft commit and `apply_product_setup`. None deadlocks; each ends in a state one of the two orders would give.
- Rollback rehearsal: dropping the triggers and restoring the prior bodies leaves every row reading the same.

**Risks:** the largest database change in Stage 2 (many re-issues on busy tables). Each re-issue is diffed against live before review. A missed writer could bypass the guards: the harness lists every function that writes `products`, the brand tables or `invoice_items` (from `pg_proc` source search) and fails if one is not in 3.4. The shared lock serializes registration changes with invoice saves; the business volume makes the wait negligible, and the harness measures it. **Sol list:** yes. **Mason-gated at apply:** the column-grant change on `invoice_items` and `products` (Q7).

---

## 5. Seed and switch-on (Mason-gated live step)

`seed_epa_registrations(p_picks, p_line_picks, p_rup_default, p_expected_fingerprint, p_idempotency_key)` (admin, key) is the switch: one transaction, all or nothing.
1. Exclusive shared lock; `LOCK TABLE products, product_brands, product_parent_brands, invoice_items IN SHARE ROW EXCLUSIVE MODE` (blocks writes, allows reads).
2. Recompute the preview fingerprint from the locked rows; refuse a mismatch (`EPA_REGISTRATION_SEED_STALE`). Refuse if any registration exists (one-time).
3. `p_rup_default` in (`unknown`, `no`) is Mason's Q1 answer, required.
4. Refuse unless every disagreement has a pick (`p_picks`) and every not-yet-posted invoice line without a capture has a line pick (`p_line_picks`: the number sold, default the product's current number shown in the preview; Mason confirms or corrects each).
5. Insert every registration with one `seeded` event each; copy each pick onto disagreeing sizes and brands under passes.
6. Capture each not-yet-posted line from its picked number's registration (`seed-approved` source). Posted lines are not captured: they are never posted again.
7. Commit. From this moment the guards are active, the registration tools work, and posting reads only captures.

**Live data counts for the preview (2026-11-06):** 203 registrations, 1 signal-word pick, 19 not-yet-posted lines (8 with a blank number today).

**Mason's steps:** read the preview in the app (product names and invoice lines shown there, never in the repo), make the picks, and give an explicit `I approve` in the conversation that runs it.

---

## 6. Screens PR

**Depends on:** REG-DB applied and the seed run. Shares `ProductDetail.tsx` with #1553, DM-1 and DM-2 screen PRs: build after #1553 merges and rebase on whichever lands first.

**Between the seed and this PR (short freeze):** old screens that try to change a registered size's label facts or number get the guard's by-name refusal ("edit it on the registration; reload the app"). Nothing writes wrong data; editing those facts waits for this PR. Mason's Q8.

- **Product page** (`ProductDetail.tsx`): a Registration panel for a size with a number: status, label link (`EpaLabelLink.tsx`), signal word, RUP (Yes / No / Not reviewed), REI, PHI, label max, adjuvants, "Edit registration" (admin), "Change EPA number" (admin; ungrouped only; on a grouped size disabled with "Set on parent <name>" until 7.7). Label-fact inputs become read-only; `PRODUCT_NONPRICING_FIELDS` (`:76`) stops sending them and `epa_registration` for registered sizes. A numberless size keeps today's Yes/No checkbox (`:253`, `:1309`); its EPA field is editable for admins only and saves through `assign_epa_registration` (preview first; a new number asks for its label facts). EPA lookup compare (`:1153`, `:1425`) compares against the registration. Banner when status is `cancelled` (warning only).
- **Label review** (`LabelReview.tsx:293`, `:376`): handles `LABEL_DRAFT_NO_REGISTRATION` (offer create), `LABEL_DRAFT_EPA_CHANGE` (open the right flow), `LABEL_DRAFT_STALE`, `LABEL_DRAFT_CHANGED`.
- **Label data quality** (`LabelDataQuality.tsx:221`, `:388-427`, `:524-525`, `:585-586`, `:803-804`): signal-word fixes go to the registration; the EPA set goes to Change EPA number.
- **Products list and CSV** (`Products.tsx:125`, `:808-809`, `:1169-1171`): RUP shown as Yes / No / Not reviewed.
- **Bulk import and workbook** (`bulkProductImportSafety.ts:232`, `:264-265`; `productSetupWorkbook.ts:38`, `:225`, `:378`, `:404`): label columns on registered rows read-only; the preview lists every difference from the registration (including RUP) by name before apply; a new number needs its label columns; a grouped row with a changed number is marked "correct the number on parent <name>".
- **Brands** (`ProductBrandsSection.tsx:68`, `:98`, `:480`): brand label facts read-only, from the registration; "Change EPA number" per brand row (admin); a new brand number asks for its label facts.
- **Invoices** (`InvoiceDetail.tsx`, `FieldApplicationInvoice.tsx`, `Invoices.tsx`): show each line's sold number and RUP answer from the capture; handle `INVOICE_LINE_EPA_MISMATCH` (reload), `INVOICE_LINE_NOT_CAPTURED`, `INVOICE_LINE_NO_REGISTRATION` and `INVOICE_LINE_MIXED_EPA` at posting by name.
- **RUP readers** (`rupCompliance.ts:56`, `Compliance.tsx:179`, `LogbookReport.tsx:313`, `:343`, `epaDataQualityReport.ts:207`, `ProductChangeHistory.tsx:16`, `:28`, `costFields.ts:34`): read `rup_status`; Compliance lists "RUP not reviewed" registrations with their posted-sale count (read-only, §7.8 item 1); historical sale screens read the capture or the RUP record, never the product's current facts.
- **Warnings** (grand plan §8): quote-add warning for a cancelled registration. Delivery brand-pick warning stays Stage 3.
- **Adjuvants** show "Not reviewed" for NULL and "None on label" for an empty list; warnings never treat NULL as none.
- **Saving safely** (registration edit, Change EPA number, draft commit outcomes, imports): each save keeps its retry key from `useIdempotencyKey` until a definite answer (saved, or refused by name); the key is bound to the submitted values and any edit starts a new key; the form is disabled while a save is in flight and after a 30-second timeout offers only "Not sure this saved: Retry" with the same key; key and values are kept at page level and in `sessionStorage` (inside try/catch); without storage, the page says "Keep this page open until it finishes", and after a refresh every save carries the version or fingerprint it was built from, so a re-sent save that already landed is refused as stale, never applied twice. Every read and every save gets its own request token; only the latest token for the currently open target is applied.

**Files:** the screens above, their tests, `src/lib/epaRegistrations.ts` (new: the RPC calls).

**Done when:** in the private test copy, observed: Registration panel, an edit on one size changing its sibling, Change EPA number on an ungrouped size, a grouped size pointing to the parent, each label-review outcome, RUP tri-state on product page, list, CSV and Compliance, an invoice line showing its captured number after the product moved, cancelled banner and quote warning. Unit tests: tri-state mapping, every error code, key kept across a retry after a lost reply (one event in the database), late replies dropped, new key after an edit, inputs disabled while saving.

**Sol list:** check with the classifier at build. **Mason-gated:** none.

---

## 7. 7.7 · EPA-number correction on (parent), parked

Stays parked until REG-DB, the seed and the screens PR are live. **Starting point:** the parked branch `claude/sweet-bun-f7920f` (local only, not pushed; its session was `local_72ea5177`). Its migration `20261127100000_job_line_epa_snapshot.sql`:
- adds `job_chemicals.epa_registration`, filled by trigger, read-only to clients; **its fill of blank invoice-line copies from each product's current number must be removed** before it lands, because a current number cannot prove what an old sale was (REG-DB's seed captures not-yet-posted lines from Mason's picks; posted lines are never posted again);
- re-issues `_product_parent_identity_after` and `correct_product_parent_identity` so an EPA change reaches the parent, its sizes (under the copy pass) and job lines of jobs not yet sprayed;
- adds the switch `_product_parent_epa_correction_enabled()`, returning false;
- claimed stamps `20261123100000` and `20261123150000` (the switch-on) in its notes, but its base migration is stamped `20261127100000`; **the switch-on must get a fresh stamp later than the base migration's**, picked when it is built.

**`save_job` must keep sprayed history in the database, not only in screens:** `save_job` deletes and re-inserts a job's lines; for a line that already exists on a sprayed or finished job, the database keeps the stored number and product and ignores what the client sends; a re-save that omits such a line, or changes its product, is refused (`JOB_LINE_HISTORY_KEPT`); a new line on a sprayed or finished job needs its EPA number named explicitly and records who entered it (Q6).

**Correction rules:** the exclusive shared lock first; old and new registrations locked before the parent; a new number with no registration needs its facts (`EPA_REGISTRATION_FACTS_REQUIRED`); sizes are moved through `_assign_epa_registration_internal`; job lines of jobs not yet sprayed follow, checked under job locks; invoice lines keep their capture.

**Switch-on** (`<stamp>_parent_epa_correction_on`, one function returning true) ships only when the items above are live and the reader trace in §4.1 is complete.

**Done when (harness, on top of the parked branch's own):** a correction to an unregistered number without facts refused; a sprayed job keeps number A after a correction to B and a re-save that omits the number, sends C, drops the line or changes its product; an unsprayed job follows to B; correcting A to B moves every size under the parent and leaves other sizes on A; a race with `set_epa_registration` does not deadlock; invoice lines keep their capture.

**Sol list:** yes. **Mason-gated:** none beyond the parked owner's own gates.

---

## 8. How each §7.8 open item is settled

| §7.8 item | Settled by |
|---|---|
| RUP tri-state through `generate_rup_sales_records`, Compliance list, Products CSV | `rup_status` on the registration; posting reads the sale capture OR the sold number's registration (4.C); not-reviewed registrations listed on Compliance, CSV shows the tri-state (section 6); past-sale gap is Q2 |
| Insert-created registration starts as `unknown` | No insert creates a registration silently: a new number needs its label facts, including RUP, entered from the label (3.3) |
| Commit when no registration exists | Held with `LABEL_DRAFT_NO_REGISTRATION`; screen offers create (4.B) |
| 7.7 job snapshot lost on `save_job` delete/recreate | Parked branch's column-plus-trigger design plus the database rules in section 7 |
| Copy only the columns a brand row has | Brands get signal word and RUP only (3.3) |
| Open-job offer permissions | No "update open jobs" offer in REG-1; job lines are handled by the parked snapshot. Revisit only if Mason asks |

---

## 9. Dependencies, overlap and order (checked read-only 2026-11-06)

| Work | Where | Overlap | Rule |
|---|---|---|---|
| KI-18 batch 1 | PR #1579 (open), `20261128100000` re-issues `generate_rup_sales_records` (dates only; still reads the product) | REG-DB part C re-issues it again | REG-DB builds after #1579 merges, from its body |
| PR #1581 size notes | `20261127110000_product_size_notes_in_one_step.sql` (open) re-issues `_insert_parent_size` | part D re-issues the same function | REG-DB builds after #1581 merges |
| Taha's PAR-2 fixes | `20261201110000_product_parent_review_fixes.sql` (merged, #1586); re-issues `move_product_size` | part D re-issues `move_product_size` | from its body on `main` |
| Parked EPA correction | local branch `claude/sweet-bun-f7920f`, `20261127100000_job_line_epa_snapshot.sql` | 7.7; assignment's job-line rule | Section 7; its invoice-line fill must be removed |
| PAR-1 screens #1553 | `ProductDetail.tsx` (open) | Screens PR | Screens PR after #1553 |
| DM-1 / DM-2 screens | `ProductDetail.tsx` | Screens PR | Rebase on whichever lands first |
| PAR-2 grouping switch | `_product_parent_grouping_open()` false | brand RPCs refuse while closed; REG-1 re-issues keep that refusal | none |

Migration stamps in this project run ahead of the calendar; the stamps above are open or merged work that exists today (checked 2026-11-06). Stamps already claimed by others (do not reuse): `20261115120000`, `20261117130000`, `20261117160000`, `20261123100000`, `20261123150000`, `20261126100000`, `20261127100000`, `20261127110000`, `20261128100000`, `20261201110000`. REG-1 picks fresh stamps at build time.

**Order (Mason, 2026-11-06):** #1579 and #1581 merge → REG-DB (applied live, then merged; behaviour unchanged until the seed) → seed (Mason's `I approve`) → screens PR → 7.7 later. The draft-commit, setup, brand and posting changes ship in REG-DB, so nothing that edits registrations exists before posting reads the sale capture.

---

## 10. Steps that need Mason

1. **Q7 grant change** at REG-DB's apply: remove direct client `INSERT` on `products` and client writes to the invoice-line capture columns.
2. **Seed picks**: one shared number disagrees on signal word; 19 not-yet-posted invoice lines need their sold number confirmed (the preview proposes each product's current number). Shown in the app, never in the repo.
3. **Seed run**: writes about 203 registrations, may change one size's signal word, captures 19 invoice lines, and switches the guards on. Mason's explicit `I approve` in the conversation that runs it.
4. Answers to the questions below (Q1 changes the seed).

---

## 11. Questions for Mason

1. **Today's "not restricted-use" ticks: count them as "No" or "Not reviewed"?** Right now every product except two is marked not restricted-use, mostly because the box starts unticked. **Recommendation: "Not reviewed"**, then you confirm each label once; the two marked "Yes" stay "Yes".
2. **Sales posted before a product was marked restricted-use never reach the RUP register, even after the box is ticked. Catch those past sales?** **Recommendation: not now.** Today no invoice line is on a restricted-use product. Review the labels REG-1 lists as "Not reviewed"; Compliance shows how many posted sales each one has, so if a review turns up a restricted-use product with past sales, those few can be recorded by hand, then decide.
3. **Who may edit a registration's label facts?** **Recommendation: admins only**, as for parents and brands today.
4. **The parked EPA-number correction work (branch `claude/sweet-bun-f7920f`) is only on this computer and not pushed.** **Recommendation:** have its session push it, remove its fill of old invoice lines, and land its database part after REG-1 (section 7).
5. **ANSWERED (Mason, 2026-11-06): hold the EPA-number tools until posting reads what was sold; then re-plan posting and rollout.** Done in this sheet: posting reads each invoice line's sale capture (4.C), and every registration tool ships in the same database PR, switched on only by the seed. (KI-18 batch 1 alone does not do this; it changes dates only.)
6. **Adding a chemical to a job that was already sprayed:** after 7.7, refuse it, or allow it if the user types that chemical's EPA number as it was on the day? **Recommendation: allow it with the typed number** (corrections to old jobs happen), and the line records who entered it.
7. **Permissions:** today the app's own login can insert product rows directly and write any invoice-line column. **Recommendation: remove direct product inserts and direct writes to the new sale-capture columns** at REG-DB's apply; every create and save screen already goes through the database functions. A permission change, so it needs your yes.
8. **Short freeze:** between the seed and the screens PR, the old screens cannot change a registered product's label facts or EPA number (they get a clear "edit it on the registration" message). **Recommendation: accept it**, and run the seed only when the screens PR is ready to follow within a day or two.

---

## 12. Review record

**Before the re-plan (four-PR rollout):** 17 Luna rounds and 6 advisory Sol rounds (gpt-6-sol high; this file is off the Sol list). Every finding was fixed or refuted, but new HIGHs kept coming from two places: RUP posting reading each product's current state, and the windows between the seed and the guards. Per `AGENTS.md`, review stopped, Mason answered Q5 and asked for a re-plan.

**Re-plan (2026-11-06):** designed with Astra (gpt-6-astra, high; its sandbox could not open the attached files, so it worked from the written rules and failure cases; its assumptions were then checked here against `save_invoice`, KI-18's `generate_rup_sales_records` and live counts). It answers each earlier open finding:
- Posting reads the sale capture and the **sold** number's registration (never the product's current number); signal word is captured; old not-yet-posted lines are captured from Mason's seed picks; posted lines are never re-posted; posted corrections use void and reissue.
- One shared lock taken before any read closes every read-then-lock race (including `save_invoice` against a number change).
- Guards ship in the same PR as every registration tool and switch on in the seed's transaction, so there is no window of direct edits after registrations exist.
- `move_product_size` and 7.7 use an internal assignment path without the grouped-size refusal.
- Direct product inserts and capture-column writes lose their grants (Q7).
- Past sales stay Q2.

| Date | Reviewer | Head | Verdict | Notes |
|---|---|---|---|---|
| 2026-11-06 | gpt-6-sol high (advisory) | d6f15baf9 | 1 BLOCKER, 3 HIGH, 3 MED/LOW | fixed |
| 2026-11-06 | gpt-6-sol high (advisory) | 453af6e73 | 5 HIGH, 3 MED | fixed |
| 2026-11-06 | gpt-6-sol high (advisory) | 0598fb3c2 | 3 HIGH, 4 MED, 1 LOW | repeating RUP mechanism → Q5 |
| 2026-11-06 | gpt-6-sol high (advisory) | b5be085bf | 7 HIGH, 3 MED | fixed |
| 2026-11-06 | gpt-6-sol high (advisory) | 6842bfbf0 | 5 HIGH, 2 MED | fixed |
| 2026-11-06 | gpt-6-sol high (advisory) | 2189fa23b | 7 HIGH, 3 MED | stopped; re-planned |
| _pending_ | Luna, then Sol, on the re-plan | | | |
