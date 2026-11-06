# Product Master Stage 2: REG-1 build sheet (registration per EPA number) and 7.7 (EPA-number correction on)

**Status:** plan only; nothing built. Written 2026-11-06 against `main` at `b6342d091` and the live database (read-only). This sheet replaces the REG-1 outline in `docs/plans/2026-11-04-product-stage2-BUILD-SHEET.md` §7.3 and the 7.7 outline in §7.7 for building; where they differ, this sheet wins (section 2 lists each difference). Section numbers like "§4" without a file name point to the Stage 2 sheet.

**Words used here.**
- **Registration**: one row per EPA registration number, holding the facts printed on that label (signal word, restricted-use status, REI, PHI, label maximum rate, label adjuvants), its status (active or cancelled) and the label link. Every size and brand carrying that number reads these facts from it.
- **Size**: a `products` row. **Parent**: a `product_parents` row (PAR-1). **Brand**: a `product_parent_brands` row (PAR-2) or a legacy `product_brands` row.
- **Pass**: a private one-row permission slip (transaction ID plus target) inserted just before a governed write and deleted just after; a guard refuses the governed columns without one. Same mechanism as PAR-1's `product_parent_copy_passes`.
- **RUP**: restricted-use pesticide. Stored on the registration as `rup_status` in (`yes`, `no`, `unknown`).
- **Drift**: a size or brand whose copied label facts differ from its registration's.

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
| Latest applied migration | `20261106182955` |

**Live schema REG-1 touches:**
- `products` label columns: `epa_registration`, `is_rup boolean NOT NULL`, `signal_word`, `rei_hours`, `phi_days`, `max_label_rate`, `max_label_rate_unit`. No adjuvant column. `authenticated` holds column-level `INSERT` and `UPDATE` on all of them, so a direct app write is a real path today.
- `products` has 23 triggers (listed in the Stage 2 sheet's §4.4 risk; PAR-1 added `trg_b_guard_product_parent_timings` and `trigger_zz_guard_product_parent_values`).
- `product_brands` (legacy) and `product_parent_brands` (PAR-2) each carry `epa_registration` (strict CHECK `^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$`), `is_rup boolean` (nullable) and `signal_word`. **Neither has REI, PHI or label-max columns.** Both are write-locked (writes only through admin RPCs).
- `product_label_drafts`: `authenticated` holds table-level `INSERT`, `UPDATE`, `DELETE`. It stores proposed signal word, REI, PHI, EPA number and label max rate, but **no RUP**.
- `commit_label_draft`, `create_label_draft` and `bulk_create_label_drafts` already require a retry key bound to a request fingerprint (the 2026-10-15 wrapper pattern: public wrapper → `_…_replay_impl_20261015`). The commit implementation locks the draft, then the product `FOR UPDATE`, and writes the product directly.
- `generate_rup_sales_records` selects invoice lines joined to products `WHERE p.is_rup = true` and copies `p.epa_registration` and `p.signal_word` into `rup_sales_records`.
- `_product_parent_grouping_open()` returns false (PAR-2 approvals are off).

---

## 2. Where the §7.3 / §7.7 outline is wrong against current code

| # | Outline says | Current code says | What this sheet does |
|---|---|---|---|
| 1 | PAR-1 added `product_parent_settings.epa_correction_enabled` | No such table or setting exists. PAR-1's `_product_parent_identity_after` refuses every EPA change outright (`PRODUCT_PARENT_EPA_CORRECTION_OFF`). The parked branch `claude/sweet-bun-f7920f` adds a function switch `_product_parent_epa_correction_enabled()` | 7.7 uses that function switch (section 8) |
| 2 | A separate `trigger_zz_guard_product_parent_identity` | The EPA check lives inside `trigger_zz_guard_product_parent_values` (normalized EPA number with category, timings and rates) | REG-1's new guard sorts after it (section 3) |
| 3 | PAR-1 re-issued `commit_label_draft` to hold an EPA change on a grouped size with `LABEL_DRAFT_EPA_BELONGS_TO_PARENT` | Not re-issued. On a grouped size, a draft that changes the EPA number fails as a whole on the parent guard | PR 2a re-issues it with the registration routing |
| 4 | PR 1 brings the label-draft RPCs up to the retry rule | Already done (2026-10-15 batch) | Dropped from PR 1; re-issues keep the wrapper pattern |
| 5 | `BulkProductImport.tsx:264-288` inserts directly | It now calls `preview_product_import` (`:67`) and `apply_product_setup` (`:391`); product creation is moving to `create_product_with_parent` (PR #1553). Every create runs through `apply_product_setup` insert mode | One insert path to cover: the insert trigger (PR 3) and the pre-lock in `apply_product_setup` |
| 6 | Copy all label facts onto brands | Brand tables have only `signal_word` and `is_rup`; brand `is_rup` is nullable | Brands get signal word and RUP only (§7.8 item 5) |
| 7 | Draft target columns on `product_label_drafts` | The table has client write grants, so new columns there could be forged | A private side table `label_draft_targets` (PR 1) |
| 8 | Writers listed in the §7.3 table are complete | `move_product_size` writes the parent's EPA number onto a moved size that has none (`20261110150000`, around `:214-217`; Taha re-issues it) | Added to the writer list and to PR 3 |
| 9 | "No lock-order issue" | `add_product_size` locks the parent and its sizes, then inserts; `apply_product_setup` locks products before writing. An insert trigger that locks a registration would take it after product locks: a deadlock risk | One global lock order (section 3); those functions pre-lock registrations |
| 10 | 7.7 adds a side table `job_line_epa_snapshots` and is gated on REG-1 | The parked branch already built a different design: `job_chemicals.epa_registration` column filled by trigger, the correction re-issued with its own switch (off), and switch-on planned for its screens PR | 7.7 builds on the parked branch, not a redesign (section 8) |
| 11 | Line references | Moved: `LabelDataQuality.tsx` `:518`/`:579`/`:797` → `:524-525`/`:585-586`/`:803-804`; `Products.tsx:1167-1169` → `:1169-1171`; `ProductBrandsSection.tsx:476-481` → `:480`; `ProductDetail.tsx:762-764` → `:764-765` | Current numbers used below |
| 12 | Back-fill compares sizes and brands | Both brand tables are empty today | Seed compares sizes; brand rows (if any by then) are checked by the same preview |
| 13 | REG-1 defines its own normalization | `_normalize_epa_registration` (PAR-1) plus three strict CHECKs already force one canonical form | Reuse it; the registration key gets the same strict CHECK |

---

## 3. Shared design

### 3.1 Tables (PR 1)

All with RLS on, a `SELECT` policy for active users, and no write grants. **Every function in this sheet** (RPCs, helpers, trigger functions, re-issues) is `SECURITY DEFINER` with `SET search_path = public, pg_temp`, follows `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`, and grants `EXECUTE` to `authenticated` only for the public RPCs; helpers and trigger functions get no grant. **"Admin" means enforced, not named:** every admin RPC's first statement is `v_actor := public._product_parent_require_admin();` (PAR-1's helper, `20261108120000:512-519`: refuses a missing `auth.uid()`, then a caller for whom `is_admin()` is false), before the replay lookup and before any lock. The actor recorded on every event, and `created_by`/`updated_by`, is that returned `v_actor` (or `auth.uid()` in the insert trigger), never a parameter.

- **`epa_registrations`**
  - `epa_registration text` primary key, strict CHECK as on `product_parent_brands`.
  - `registration_status` in (`active`, `cancelled`, `unknown`), default `unknown`; `cancelled_on date` (required when cancelled, else null).
  - `label_url text` (https only), `label_accepted_on date`, `source text`, `checked_at timestamptz`.
  - Label facts: `signal_word` (same CHECK as `products.signal_word`, nullable), `rup_status` in (`yes`, `no`, `unknown`) not null default `unknown`, `rei_hours`, `phi_days`, `max_label_rate`, `max_label_rate_unit` (same CHECKs as the product columns).
  - `label_adjuvants jsonb` nullable, default NULL meaning **not reviewed** (products have no adjuvant column, so the seed leaves it NULL); `'[]'` means reviewed, none on the label. Otherwise an array of `{kind: required|recommended, adjuvant_type text, note text}`, checked by an immutable validator function.
  - `registration_version bigint` (starts at 1; every successful write to the row, by any function, increments it and sets `updated_by` and `updated_at` in the same statement, so a second admin holding the old version is refused), `created_by`, `created_at`, `updated_by`, `updated_at`.
- **`epa_registration_events`**: append-only (update and delete refused). `event_type` in (`seeded`, `created`, `updated`, `assigned`, `draft_committed`, `drift_settled`); `reason`, `before_values`, `after_values`, `affected jsonb` (per size or brand: table, ID, before and after); `changed_by`, `changed_by_name`, `changed_at`.
- **`epa_registration_copy_passes(txid bigint, target_table text, target_id uuid, event_id bigint)`**: private, no grants.
- **`label_draft_targets(draft_id uuid primary key, epa_registration text, product_epa_registration text, product_id uuid, product_label_fingerprint text, registration_version bigint)`**: private, no grants. Filled by the draft-create functions, read only by the commit. `epa_registration` is the draft's own number at creation; `product_epa_registration` is the product's number at that moment.

### 3.2 Global lock order

Every REG-1 function, and every function it re-issues, takes locks in this order:

1. registrations, in number order;
2. parents, in ID order;
3. products, in ID order;
4. brand rows: legacy, then parent brands, each in ID order;
5. the rate lock `FOR SHARE`, where the function already takes it.

Rules that follow:
- **No UPDATE trigger locks a registration.** Guards only compare.
- **The INSERT trigger** (PR 3) takes the registration `FOR SHARE` (or inserts it).
- **Pre-lock, then re-check.** A function that pre-locks a registration it read without a lock (the parent's number in `add_size`, a moved size's target parent's number, a batch's numbers in `apply_product_setup`) re-reads that number after it has locked the parent or product. If the number changed in between (a correction committed before the pre-lock), it raises `EPA_REGISTRATION_CHANGED_RETRY` before writing anything; the whole call rolls back, holds nothing, and the screen retries with the same key. It never goes on to lock a second registration while holding a parent or product, so no lock is ever taken out of order. Any function that already holds parent or product locks before inserting a size (`add_product_size`, `create_product_with_parent`, `_insert_parent_size`, `apply_product_setup` insert mode) first locks the registration it is about to use, so the trigger's lock is already held.
- Today's PAR-1/PAR-2 order (parent → products → brands; approval: proposal → products → rate lock; Taha's `move_product_size`: both parents in ID order → size → brands) is a suffix of this order, so adding registrations in front does not invert anything.
- **Creating a registration that does not exist yet** cannot be serialized by a row lock. Every create path uses `INSERT … ON CONFLICT (epa_registration) DO NOTHING`, then `SELECT … FOR UPDATE` (or `FOR SHARE` in the insert trigger) on the row that now exists, whoever inserted it. An admin create (`set_epa_registration` with a null expected version) that loses that race is refused as stale (`EPA_REGISTRATION_STALE`), never with a raw key error. Two creators of the same new number therefore end with one row and no uniqueness error.
- The harness runs two-session races for each pair in sections 4 to 8.

### 3.3 Guards (PR 3)

- **`trigger_zz_guard_product_registration`** on `products` (`BEFORE INSERT OR UPDATE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, owned by `postgres`). Name sorts after `trigger_zz_guard_product_parent_values` (so a grouped size gets the parent message first) and before `trigger_zzz_guard_product_rate_lock`. On UPDATE: when the row has an EPA number with a registration, a change to `signal_word`, `is_rup`, `rei_hours`, `phi_days`, `max_label_rate` or `max_label_rate_unit` without a pass is refused: `EPA_REGISTRATION_FACT: <column> belongs to EPA registration <number>; edit it on the registration (reload the app if you do not see a Registration panel)`. An update that resends unchanged values passes. A change to `epa_registration` itself without a pass is refused with `EPA_REGISTRATION_ASSIGN: use Change EPA number`, including adding a number to a numberless size. Every place that can set a number therefore routes through the assignment helper (`_assign_epa_registration`, the body of `assign_epa_registration`, which takes the locks and the pass): the product page's EPA field on a numberless size calls `assign_epa_registration` (PR 2b); `apply_product_setup` update mode calls the helper for a row whose number changes, after pre-locking (PR 2a); `upsert_product_brand` / `upsert_parent_brand` refuse a number change on an existing brand with the same code and route the brand screen to Change EPA number (PR 3).
- **The INSERT branch** of the same trigger: when the new row has an EPA number, it locks or creates the registration (`INSERT … ON CONFLICT DO NOTHING`, then `SELECT … FOR SHARE`), then overwrites the row's label facts from it. **An insert never changes an existing registration**: a size or brand inserted with a number that already has one receives its facts. A sent label fact that is not NULL and differs from the registration's is refused (`EPA_REGISTRATION_FACT_CONFLICT: <column> on EPA registration <number> is <value>`), so two imports racing to add the same new number with different facts never silently overwrite one; for RUP only a sent `true` against a registration that is not `yes` conflicts (a default `false` does not, because a boolean cannot tell a default from an intended No, which is why Q7 recommends removing direct product inserts; so every insert function re-issued in PR 3 (and `apply_product_setup` insert mode) sets the row's `is_rup` from the registration it has already pre-locked, unless its caller supplied an explicit RUP value, which is compared and refused on any difference; the import and workbook previews in PR 2b also compare the file's RUP column with the registration and list every difference by name before apply, so an intended No against a Yes registration is shown, never silently replaced). The PR 2b screens prefill from the registration, so they send equal values. A number new to the system creates a registration from the row's own facts (an insert function that carries an explicit RUP answer or other label facts for a new number, such as an import's RUP column, first creates the registration itself through the internal create helper from its `p_new_registration`, `yes`/`no`/`unknown`, and only then inserts the row, so the trigger finds the registration and the reviewed No is kept) (that number is on no other row yet, so nothing else changes), **only when the inserting session is an admin** (`is_admin()`); a non-admin insert carrying a number with no registration is refused with `EPA_REGISTRATION_NEW_NUMBER: an admin must add this EPA number`. (Luna rounds 3, 5 and 8 each found a new way an unverified registration could spread a user's typed facts; the unverified state was deleted instead of patched. Every product-create screen is already admin-only through `create_product_with_parent` / `apply_product_setup`, so no current screen loses anything.) The created registration's facts are set with `rup_status` = `yes` when `is_rup` is true, else `unknown` (§7.8 item 2). `is_rup` on the size is set to `rup_status = 'yes'`. A registration created here writes a `created` event naming the source table and row and the session's user.
- **Brand guards** on `product_brands` and `product_parent_brands`: same rule for `signal_word` and `is_rup`; brand `is_rup` mirrors `rup_status` as `true` / `false` / `null`.
- **Created only after drift is zero.** The PR 3 migration locks the three tables, re-runs the drift check and aborts the whole migration if any row drifts (section 7).

### 3.4 Writers (every path that writes an EPA number or a label fact)

| Writer | Today | After REG-1 |
|---|---|---|
| Product page save (`ProductDetail.tsx:503-504`, `PRODUCT_NONPRICING_FIELDS` `:76`) | direct update incl. `is_rup`, `signal_word` | stops sending label facts and EPA number when registered (PR 2b); the guard refuses anyway (PR 3) |
| Product page create (`ProductDetail.tsx:764-765`) | direct insert | replaced by #1553 (`create_product_with_parent`); insert trigger covers it |
| Products list (`Products.tsx:808-809`) | nonpricing update | same as product page |
| Label data quality (`LabelDataQuality.tsx:524-525`, `:585-586`, `:803-804`) | updates `signal_word`; `:803-804` sets the EPA number and clears signal word | signal word goes to `set_epa_registration`; the EPA number goes to Change EPA number (PR 2b) |
| Setup workbook / bulk import (`productSetupWorkbook.ts:183`, `BulkProductImport.tsx:391`) via `apply_product_setup` | writes all label facts, update and insert | PR 2a re-issue: pre-lock, label facts on a registered row refused unless equal, number changes through assignment; PR 3: insert routing |
| `commit_label_draft` (`LabelReview.tsx:293`) | writes the product | PR 2a: writes the registration, which copies to sizes and brands |
| `upsert_product_brand` (`productBrands.ts:49`), `upsert_parent_brand` | write brand `is_rup`, `signal_word`, `epa_registration` | PR 3 re-issue: registration lock first; facts come from the registration |
| `move_product_size` | sets the parent's EPA number on a moved size with none | PR 3 re-issue (from Taha's body): registration pre-lock, copy under pass |
| `_insert_parent_size` / `add_product_size` / `create_product_with_parent` | force the parent's number on the size | PR 3 re-issue (from #1581's body): registration pre-lock |
| `correct_product_parent_identity` (parked branch) | switch off | 7.7 (section 8) |
| Edge Functions | read only (`process-blend-ticket`) | unchanged |

---

## 4. PR 1 · Storage, back-fill tools and draft targets (database only)

**Migration** `<stamp>_epa_registrations`. Writes **no live rows** at apply; the back-fill is a separate Mason-gated run (section 7).

**Objects:**
- The four tables in 3.1, with RLS, `SELECT` policies, the event table's append-only triggers, and the adjuvant validator.
- `preview_epa_registration_seed()` (admin, read-only): per distinct normalized number on active and inactive sizes and on brand rows, the proposed registration facts, every disagreement (column, values, row counts, product IDs), and a `fingerprint` of the whole result. RUP proposal: any row `true` → `yes`, else the seed's RUP default.
- `seed_epa_registrations(p_picks jsonb, p_rup_default text, p_expected_fingerprint text, p_idempotency_key text)` (admin, key required, `_product_parent_replay` pattern): `p_rup_default` in (`unknown`, `no`) is Mason's answer to Q1 and sets `rup_status` for numbers with no `true` row (no default value; a missing one is refused); first takes `LOCK TABLE products, product_brands, product_parent_brands IN SHARE ROW EXCLUSIVE MODE` (no registration exists yet, so nothing earlier in the lock order can be held), which blocks every insert, update and delete on those tables until the seed commits while reads continue, so no new row or number can appear between the check and the commit; it then recomputes the preview fingerprint from those locked rows and refuses a mismatch (`EPA_REGISTRATION_SEED_STALE`); refuses unless every disagreement has a pick; inserts all registrations, writes one `seeded` event each, and copies each pick onto disagreeing sizes and brands under passes. All-or-nothing. Refuses if any registration already exists (one-time). **Until the seed has run** (a `seeded` event exists), `set_epa_registration`, `assign_epa_registration` and `settle_epa_registration_drift` refuse with `EPA_REGISTRATION_NOT_SEEDED`, so nothing can create a registration that would block the seed; the insert trigger and the PR 2a/PR 3 re-issues ship only after the seed.
- `set_epa_registration(p_epa_registration, p_expected_version, p_changes jsonb, p_reason, p_idempotency_key)` (admin, key): locks the registration, then the sizes (ID order) and brands carrying it; refuses a stale version; updates it; writes one event; copies the changed facts to every size and brand under passes. Creates the registration when `p_expected_version` is null and none exists (create rule in 3.2), writing a `created` event. Every successful save also sets `updated_by`/`updated_at`
- `preview_epa_assignment(p_target_table, p_target_id, p_new_number)` and `assign_epa_registration(p_target_table, p_target_id, p_new_number, p_new_registration jsonb, p_expected_target_fingerprint, p_expected_new_version, p_reason, p_idempotency_key)` (admin, key): Change EPA number on one ungrouped size or one brand. Locks old and new registration (number order), then the target; refuses a grouped size (`EPA_REGISTRATION_GROUPED_USE_PARENT`, which points to 7.7's correction); writes the number and the new registration's facts under a pass; when the new number has no registration, the call must carry the new registration's facts in `p_new_registration jsonb` (the admin enters them from B's label in the preview; the target's current facts belong to its old number and are never copied), else it is refused with `EPA_REGISTRATION_FACTS_REQUIRED`; it then creates the registration (create rule in 3.2, `created` event). **Destination version:** the call carries the `registration_version` the preview showed for the new number (`p_expected_new_version`, NULL when the preview showed no registration) and is refused on a mismatch (`EPA_REGISTRATION_STALE`), including when the preview showed none and another admin has since created one, so the facts written are the ones the admin saw. **History first:** assignment is refused (`EPA_REGISTRATION_HISTORY_NOT_SNAPSHOTTED`) while any posted invoice line or any line on a sprayed or finished job for the size has no number copy of its own; until the KI-18 invoice-line fill and the parked job-line snapshot are on `main` and filled, that means Change EPA number stays unavailable for sizes with such history (the same rule 7.7 uses), so a later fill can never stamp B on a sale or spray made under A. **Unposted invoices:** because `generate_rup_sales_records` reads the product's current number and RUP flag at posting, assignment refuses while the size has a line on an invoice that is not yet posted or voided (`EPA_REGISTRATION_OPEN_INVOICE: post or void invoice <number> first`; the preview lists them), so a sale recorded under A is never posted under B. Blocking rather than warning is this sheet's default; it is part of Mason's Q2. **Open jobs:** once the parked job-line copy (section 8) is on `main`, assignment also moves the size's lines on jobs not yet sprayed to the new number, locking those jobs `FOR UPDATE` (ID order, after the size) and then checking `_job_line_epa_follows_product(job_id)` under the lock, updating `job_chemicals.epa_registration` only for the size's lines on jobs where it is still true (the same rule the parked parent correction uses), so an ungrouped size and a grouped one behave alike; until then job screens read the size's number live, as they do today after a direct edit. Writes one `assigned` event on each of the old and new registrations (only the new one when the target had no number, or when its old number has no registration, with the old number recorded in the event either way), carrying the target, old and new number, reason and actor.
- `get_epa_registrations(p_numbers text[] default null)`: open to active users, checked inside the function (`auth.uid()` must be an active `profiles` row), because a `SECURITY DEFINER` function does not apply the table's RLS; no cost or price.
- `preview_epa_registration_drift()` (admin, read-only) and `settle_epa_registration_drift(p_picks jsonb, p_expected_fingerprint text, p_idempotency_key text)` (admin, key): used before PR 3 (section 7).
- **Draft targets:** `create_label_draft` and `bulk_create_label_drafts` implementations re-issued from their live bodies with one addition: insert the `label_draft_targets` row (the draft's number, the product's number, product, the product's label-fact fingerprint, the registration version if one exists). Public wrappers unchanged.
- Grants: public RPCs `EXECUTE` to `authenticated`, helpers none. **No grant or policy change on an existing table.**

**Files:** `supabase/migrations/<stamp>_epa_registrations.sql`; `docs/changelog.d/<date>-epa-registrations.md`; `docs/reference/migrations.d/<stamp>_epa_registrations.md`; `scripts/smoke/prove-epa-registrations-real-schema.mjs`; `src/types/index.ts`, `src/types/supabase.ts`; `docs/reference/rpc-functions.md`; `.claude/schema-registry.json` after apply.

**Done when (harness):**
- Seed preview on a copy shaped like live (counts above): 203 proposed registrations, one disagreement listed; seed without a pick for it refused; with a pick, all 203 created, the disagreeing row now matches, one `seeded` event each; a second seed refused; a changed product between preview and seed refuses on fingerprint.
- `is_rup` true → `yes`; false → `unknown`.
- `set_epa_registration` changes signal word on a number shared by three sizes and one brand: all four updated, one event, each size's history shows the change; a stale version refused.
- Assignment: ungrouped size moved from number A to B gets B's facts and writes an `assigned` event on A and on B; grouped size refused by name; brand assignment works.
- (Checked in PR 2b's and PR 3's harness, once those screens and guards exist; not part of PR 1's gate.) Adding a number to a numberless size through the product page, the setup workbook and a bulk import each goes through assignment (one `assigned` event, registration facts on the size); a direct `UPDATE` setting it is refused with `EPA_REGISTRATION_ASSIGN`.
- Before the seed, `set_epa_registration` and `assign_epa_registration` are refused with `EPA_REGISTRATION_NOT_SEEDED`; assigning a number to a target that had none writes one `assigned` event (old number null).
- Every new function: `prosecdef` true, `proconfig` holds `search_path=public, pg_temp`, and `EXECUTE` is granted only as listed (read back from `pg_proc` and `information_schema.routine_privileges`).
- Two sessions creating the same new number (two admin creates, or an admin create racing an assignment to it) end with one registration; the loser gets `EPA_REGISTRATION_STALE` or proceeds on the existing row, never a uniqueness error.
- Draft create writes a target row; a direct client insert or select on `label_draft_targets` and every new table is refused.
- Every RPC: non-admin writes nothing; one key twice writes once; one key with a different request refused. Every RPC passes its own operation name as the scope to `_product_parent_replay(p_key, p_scope, p_fp)` (which calls `check_idempotency(p_key, p_scope)`); the harness proves one key used first for the seed and then for an assignment is refused and is never answered with the seed's result.
- Assignment of a size to a number with no registration without `p_new_registration` is refused with `EPA_REGISTRATION_FACTS_REQUIRED`; with it, the new registration holds the entered facts, not the size's old ones.

**Risks:** the seed is the only live data step; it is gated (section 7). Adding readers before PR 2b leaves screens reading sizes, which are still correct.

**Sol list:** yes. **Mason-gated at apply:** none (no rows written, no existing-object grants).

---

## 5. PR 2a · Commit label drafts into the registration (database only)

**Depends on:** PR 1 applied and seeded, **and RUP-POST (section 5a) live** (Mason, 2026-11-06, Q5).

**Early RUP guard** (in this migration, ahead of PR 3's full guard): a narrow `BEFORE UPDATE` trigger on `products` (`trigger_zz_guard_product_rup`, same security settings as 3.3; dropped by PR 3 when the full guard replaces it) refuses, without a pass, a change to `is_rup` on a size whose number has a registration (`EPA_REGISTRATION_FACT: is_rup belongs to EPA registration <number>; reload the app`). An old page resending the unchanged value passes, so nothing breaks, but no old page or direct client can flip one size's RUP flag away from its registration before posting reads it.

**Migration** `<stamp>_label_draft_commit_registration`:
- **`_commit_label_draft_replay_impl_20261015`** re-issued from its live body (md5 `dee9e34d…` at writing; diffed again before build):
  0. **Who and what.** The registration branches (steps 3-5) change facts shared by every size and brand on the number, so they require an admin; the numberless branch (step 6) keeps today's role rule. The public wrapper is re-issued with its signature unchanged so that, **before the replay lookup**, it reads the draft's private `label_draft_targets` row (which clients cannot write; no lock) and calls `_product_parent_require_admin()` when either number on that row has a registration **or** when there is no target row; only a draft whose target row has no number at all skips it; a non-admin can therefore never receive a cached registered-number result. The impl re-checks the route after its locks and refuses `LABEL_DRAFT_TARGET_MISMATCH` if it changed, **and** calls `_product_parent_require_admin()` again whenever, with the locks held, either number now has a registration (one may have been created between the wrapper's unlocked check and the lock), so a non-admin commit can never reach a registration branch. The values written are always the wrapper's own parameters (the facts the reviewer saw and sent), for `accepted` as well as `edited`: today `accepted` copies from the draft row (`20260629210000:288-299`), which clients can still edit. For `accepted`, the commit refuses `LABEL_DRAFT_CHANGED` when the parameters differ from the locked draft row, so a draft changed after the screen loaded it is never committed. No new parameter and no new overload; the wrapper signature `commit_label_draft(uuid, text, text, integer, integer, text, numeric, text, boolean, text)` is unchanged.
  1. Read the draft's `label_draft_targets` row (no lock), then lock the registrations of its two numbers (if any, number order), then the draft, then the product: section 3.2 order. Because clients can still update `product_label_drafts`, the commit then refuses with `LABEL_DRAFT_TARGET_MISMATCH` unless the locked draft's `product_id` and normalized EPA number equal the target row's `product_id` and `epa_registration`, and the locked product's current normalized number equals the target row's `product_epa_registration` (so a draft made while its product was on A is refused after the product is moved to B, even with unchanged label facts); a draft with no target row (made before PR 1) is refused the same way and must be recreated (none exist live today).
  2. Staleness: refuse when the product's current label-fact fingerprint differs from the target row's and `p_force_overwrite` is false (`LABEL_DRAFT_STALE`). This is keyed on label facts on purpose: the guards keep a registered size's facts equal to its registration's, so any fact change on the registration also changes the size fingerprint; a change to registration-only fields (status, label link, accepted date) does not touch what a draft proposes and does not make it stale.
  3. **Same number, registration exists:** write the facts through `set_epa_registration`'s internal helper (one `draft_committed` event; copies to all sizes and brands).
  4. **Same number, no registration:** hold the draft with `LABEL_DRAFT_NO_REGISTRATION` (status stays `pending`; screen offers "Create registration"). §7.8 item 3.
  5. **Different number on the draft:** do not write; return `LABEL_DRAFT_EPA_CHANGE` so the screen opens Change EPA number (ungrouped) or the parent correction (grouped).
  6. **Product with no number:** keep today's direct size commit, checked against the target row's fingerprint.
  7. RUP: drafts have no RUP field, so a commit never changes `rup_status`.
- **`apply_product_setup` / `_apply_product_setup_update`** re-issued from the body on `main` at build time: before any product lock, it pre-locks every registration the batch touches (each row's current number and any new number), in number order, then re-checks them after the product locks (section 3.2); on a registered row, a label-fact value that differs from the registration is refused by name (`EPA_REGISTRATION_FACT: <column> belongs to EPA registration <number>`); a row whose number changes goes through `_assign_epa_registration` (a new number with no registration needs the workbook's label-fact columns for it, else `EPA_REGISTRATION_FACTS_REQUIRED`). Today's screens show these refusals as they are, so this lands safely before PR 2b.
- **RUP posting is not changed, and REG-1 adds nothing to it** (Luna rounds 4-12 raised a new HIGH on every design that re-classed or back-filled RUP sales, so per `AGENTS.md` the mechanism is dropped from REG-1 and the trade-off goes to Mason as Q2). Each size's `is_rup` is a copy of its registration (`is_rup = (rup_status = 'yes')`, written under a pass by the seed, `set_epa_registration`, the setup re-issue and the insert trigger), so `generate_rup_sales_records` runs exactly as today, at posting time, and is not re-issued. "Not reviewed" registrations (`rup_status = 'unknown'`) are listed on Compliance through `get_epa_registrations`, so the labels get reviewed. **Pre-existing gap, unchanged by REG-1 (NEEDS MASON - DECISION, Q2):** a sale posted while its product is not marked restricted-use is never added to the RUP register later, even if the label is then reviewed as restricted-use; this is how the app behaves today when the box is ticked after a sale. So it is not silent: when `set_epa_registration` changes a registration to `yes`, its result includes a read-only count of posted invoice lines for sizes carrying that number that have no active RUP record, and the screen shows "N earlier sales of this product are not on the RUP register" (information only; nothing is written). Luna's position is that this should block release; this sheet's position is that REG-1 does not make it worse and the fix is its own package. Mason decides (Q2).

**Files:** migration, changelog note, migrations.d record, `scripts/smoke/prove-label-draft-registration-real-schema.mjs`, types, rpc-functions doc.

**Done when (harness):**
- A draft for a number shared by two sizes commits once and both sizes plus the registration change; one event.
- A non-admin call to every admin RPC is refused before any read of the replay table, and every event's actor equals the caller (a forged actor parameter is not accepted because none exists).
- A draft accepted after a client changed its REI directly is refused with `LABEL_DRAFT_CHANGED`; a non-admin commit on a registered number is refused; the numberless commit keeps today's role rule.
- Moving a numberless size into a parent with number B writes one `assigned` event on B with the mover as actor.
- Seeded registrations have `label_adjuvants` NULL (not reviewed).
- After PR 2a, a direct update flipping one registered size's `is_rup` is refused; resending the same value passes.
- Assignment with a stale `p_expected_new_version` is refused with `EPA_REGISTRATION_STALE`; on a size with a posted invoice line lacking its own number it is refused with `EPA_REGISTRATION_HISTORY_NOT_SNAPSHOTTED`.
- A non-admin commit that passes the wrapper check while number A has no registration, then waits while an admin creates A, is refused after the locks.
- A draft proposing B for a product on A reaches `LABEL_DRAFT_EPA_CHANGE`, not `LABEL_DRAFT_TARGET_MISMATCH`.
- Change EPA number on a size with a line on an unposted invoice is refused with `EPA_REGISTRATION_OPEN_INVOICE`.
- A registration edit changing REI, PHI, label max or signal word on a number carried by a grouped size succeeds: the parent guard covers only category, Use Timing, rate per acre, rate unit, suggested rate and the EPA number (`guard_product_parent_values`, `20261108120000`), so it does not see these columns.
- The seed run while another session changes a source row after the preview: refused with `EPA_REGISTRATION_SEED_STALE`; nothing written.
- A product insert with a new number started while the seed holds its table lock waits, then commits after the seed; it appears in the drift preview as a number with no registration (never silently missing).
- A registration changed to `yes` returns the count of earlier posted lines with no RUP record; nothing is written to `rup_sales_records`.
- The seed preview shows the same read-only count for every number it will seed as Yes, so sales made before a product was marked restricted-use are visible to Mason at the seed, not only at a later change.
- Setup workbook and bulk import (through `apply_product_setup`): a grouped row with a changed number is refused naming the parent; a changed signal word or RUP on a registered row is refused by name; an unchanged resend succeeds; a changed number is assigned with an `assigned` event; a numberless row is unchanged from today.
- RUP: setting a registration to `yes` sets `is_rup = true` on every size carrying it; to `no` or `unknown`, false; `generate_rup_sales_records` is byte-identical to its live body (md5 compared) and an invoice posted afterwards records exactly the `yes` sizes.
- A non-admin replaying an admin's key for a registered-number commit is refused before the replay lookup, including after clearing the draft row's EPA number directly.
- Two sessions inserting the same new number with different signal words: one creates the registration, the other is refused with `EPA_REGISTRATION_FACT_CONFLICT`; with equal facts both succeed.
- A brand upsert or direct brand insert with an unregistered number and no `p_new_registration` is refused with `EPA_REGISTRATION_FACTS_REQUIRED`.
- With the job-line copy present: assigning an ungrouped size from A to B moves its unsprayed job lines to B and leaves sprayed ones on A.
- A draft whose `product_id` or EPA number was changed directly after creation is refused with `LABEL_DRAFT_TARGET_MISMATCH` and writes nothing.
- Draft on a number with no registration: held, nothing written; after creating the registration, commit succeeds.
- Draft with a different number: nothing written, code returned.
- Product edited after the draft was made: refused unless force.
- Numberless product: today's behaviour, byte for byte.
- A grouped size's draft no longer fails on the parent guard for same-number facts.
- Replay and admin checks as PR 1. Two sessions committing drafts on the same number serialize without deadlock.

**Risks:** the commit impl is re-issued from its live body; diff it against `pg_get_functiondef` before review. **Sol list:** yes. **Mason-gated:** none.

---

## 5a. RUP-POST · Posting reads what was sold (prerequisite for PR 2a onward)

**Why:** Mason decided (2026-11-06, Q5) to hold PR 2a, PR 2b, PR 3 and 7.7 until restricted-use posting reads each invoice line's own copy instead of the product's current state. That removes the mechanism behind every repeating RUP finding: once posting reads the line, a later change to a product's number or RUP answer cannot change what an earlier sale records. **Correction to the Q5 wording:** KI-18 batch 1 does **not** do this; its re-issued `generate_rup_sales_records` still selects `p.epa_registration` and filters on `p.is_rup` (`20261128100000_ki18_batch1_chicago_today.sql:2535-2542`, read 2026-11-06). So this is a small new package, built on KI-18 batch 1's body after it merges.

**Facts (live, read-only, 2026-11-06):** `invoice_items.epa_registration` exists; 27 invoice lines, 9 blank where the product has a number, 0 that differ from their product. `save_invoice` takes each line's number from the screen's payload (`20261106140000_invoice_resave_keeps_cost.sql:322-336`).

**Depends on:** REG-1 PR 1 applied and seeded (registrations exist); KI-18 batch 1 merged.

**Migration** `<stamp>_rup_posting_reads_invoice_line`:
- New column `invoice_items.is_rup boolean` (nullable; NULL means "not captured", for lines saved before this migration).
- `save_invoice` re-issued from its body on `main`: when a line is new, or an existing line's product changes, the server sets the line's EPA number from that product and `is_rup` from that number's registration (`rup_status = 'yes'`; for a number with no registration, the product's `is_rup`), locking the registration `FOR SHARE` first (section 3.2 order); the payload's values are ignored. An existing line whose product is unchanged keeps both copies, so a re-save never rewrites them.
- `generate_rup_sales_records` re-issued from KI-18 batch 1's body: reads only the line's own copies: a line is restricted-use when `ii.is_rup` is true, and the record names `ii.epa_registration`. A line with no captured copy (`ii.is_rup` NULL, saved before this migration) uses today's rule (the product's current number and flag), so nothing posts worse than today. Roles, posted-invoice check and de-duplication are unchanged.
- No row is written at apply.

**No automatic fill of old lines.** A product's current number cannot prove what an old line sold (it may have changed since), so lines saved before this migration are not stamped. They keep today's posting rule, and a read-only list of them (count, invoice date, product's current number) is shown to Mason. Only he can say what was sold, so any correction is his, line by line, in the app.

**Done when (harness):**
- A line saved under A, product then moved to B, posts a record naming A; a line saved while A was `yes` still posts after A changes to `no`, and one saved while A was `no` does not post after A changes to `yes`.
- Changing a line's product from A's product to B's on re-save takes B's number and RUP answer.
- A registration changed to `yes` after a line was posted adds nothing (Q2 is still separate); one changed to `yes` before posting records the sale.
- A re-save of an invoice with a forged line number keeps the stored number; a new line's forged number is replaced by the product's.
- A line saved before the migration (no captured copy) posts by today's rule.

**Files:** migration, changelog note, migrations.d record, types, rpc-functions doc. **Sol list:** yes (money and RUP compliance). **Mason-gated:** none (no live rows written).

---

## 6. PR 2b · Screens

**Depends on:** PR 2a deployed. Shares `ProductDetail.tsx` with #1553, DM-1 and DM-2 screen PRs: build after #1553 merges and rebase on whichever lands first.

- **Numberless sizes:** on an ungrouped size the EPA field stays editable (admins) but saves through `assign_epa_registration` (preview first), never in the product save payload; on a grouped size it is read-only with "Set on parent <name>" (the parent's identity correction, once 7.7 is on); the setup workbook and bulk import show a changed or new number as an assignment in their preview and send it to the database, which routes it once PR 3 is live. There is no gap between screens and guards for imports: PR 2a (database, before the screens) already re-issues `apply_product_setup` so that a label-fact change on a registered row is refused unless equal (`EPA_REGISTRATION_FACT`) and a number change goes through `_assign_epa_registration` (section 5); PR 3 only adds the insert pre-lock and the table triggers. A grouped row whose number changes in an import is refused by name (`EPA_REGISTRATION_GROUPED_USE_PARENT: correct the number on parent <name>`), and the import preview marks that row with the same message before upload.
- **Import requests** follow the same saving rules as the modals: each preview and apply carries the token of the file it was made for, and a reply for another file is dropped; the apply keeps its key **and the parsed rows it sent** (page state and `sessionStorage`, inside try/catch) until a definite answer, so a refresh after a timeout can resend the identical request; if storage was unavailable, the page asks for the same file again and, when its parsed rows match the stored fingerprint, reuses the same key; file pick, preview and apply controls are disabled while a request is in flight.
- **Drift between PR 1 and PR 3 is expected, not a gap** (kept short: PR 3 is applied as soon as PR 2b is live and drift is settled; the daily drift sweep reports any new drift meanwhile). Until PR 3's guards exist, an old product page can still write a label fact to one size directly, and a product inserted after the seed (only admins can create one) can carry a number with no registration or facts that differ from its number's registration. Nothing is misstated meanwhile: posting, compliance reports and job screens read each size's own copied facts, exactly as today, and the Registration panel shows "No registration yet" or a "Differs from registration" badge for such a size. Those rows show up in the drift preview, Mason settles them, and PR 3's migration refuses to apply while any remain (section 7), so no drift survives into the guarded state. The screens (PR 2b) stop sending label facts before PR 3, which keeps the drift list short.
- **Product page** (`ProductDetail.tsx`): a Registration panel for a size with a number: status, label link (`EpaLabelLink.tsx`), signal word, RUP (Yes / No / Not reviewed), REI, PHI, label max, adjuvants, "Edit registration" (admin), "Change EPA number" (admin; ungrouped only; on a grouped size the button opens the parent's identity correction once 7.7 is on, and is shown disabled with "Set on parent <name>" until then). The EPA field on a numberless size is editable for admins only (it saves through the admin-only assignment); for other users it is read-only, which narrows today's behaviour on purpose. Label-fact inputs become read-only; `PRODUCT_NONPRICING_FIELDS` (`:76`) stops sending them and `epa_registration` for registered sizes; a numberless size has no registration, so it keeps today's Yes/No checkbox (`:253`, `:1309`) on `products.is_rup`; when a number is later assigned, a new registration takes `yes` from a ticked box and otherwise `unknown` (a numberless "No" is not carried over, because it was never a label review); EPA lookup compare (`:1153`, `:1425`) compares against the registration. Banner when status is `cancelled` (warning only, never blocks).
- **Label review** (`LabelReview.tsx:293`, `:376`): handles `LABEL_DRAFT_NO_REGISTRATION` (offer create), `LABEL_DRAFT_EPA_CHANGE` (open the right flow), `LABEL_DRAFT_STALE`.
- **Label data quality** (`LabelDataQuality.tsx:221`, `:388-427`, `:524-525`, `:585-586`, `:803-804`): signal-word fixes go to the registration; the EPA set goes to Change EPA number.
- **Products list and CSV** (`Products.tsx:125`, `:808-809`, `:1169-1171`): RUP shown as Yes / No / Not reviewed.
- **Bulk import and workbook** (`bulkProductImportSafety.ts:232`, `:264-265`; `productSetupWorkbook.ts:38`, `:225`, `:378`, `:404`): label columns on registered rows are read-only; an upload that changes them gets a by-name message.
- **Brands** (`ProductBrandsSection.tsx:68`, `:98`, `:480`): brand label facts read-only, shown from the registration; a "Change EPA number" action on each brand row (admin) opens `preview_epa_assignment` / `assign_epa_registration` for that brand.
- **RUP readers** (`rupCompliance.ts:56`, `Compliance.tsx:179`, `LogbookReport.tsx:313`, `:343`, `epaDataQualityReport.ts:207`, `ProductChangeHistory.tsx:16`, `:28`, `costFields.ts:34`): read `rup_status`; Compliance shows an "RUP not reviewed" registration list (§7.8 item 1).
- **Warnings** (grand plan §8): quote-add warning for a cancelled registration. Delivery brand-pick warning stays Stage 3.

- **Adjuvants** show "Not reviewed" for NULL and "None on label" for an empty list; the warnings never treat NULL as none.
- **No refresh-safe key without storage:** when `sessionStorage` is unavailable, the page shows "Keep this page open until it finishes" while a save is unconfirmed. After a refresh the panel reloads from the database, and every save carries the version or fingerprint it was built from (`p_expected_version`, the target and destination versions, the preview fingerprint), so re-sending a save that already landed is refused as stale, not applied twice; the import preview is recomputed from the database, so rows already applied show as unchanged and are not sent again.
- **Saving safely** (every new save: registration edit, Change EPA number, draft commit outcomes, drift settlement): each modal keeps its retry key from `useIdempotencyKey` until the database confirms the save (or refuses by name), so a retry after a lost reply reuses the same key; the key is bound to the submitted values, and any edit to them after a failed or lost save starts a new key. While a save is in flight, the whole form (inputs and buttons) is disabled, and the page-level state marks that target as saving, so reopening the same target shows "Saving…" with the form disabled until the first reply or a refusal; a second save for one target can never be in flight. A network error or a 30-second timeout with no reply keeps the form's inputs disabled and offers only "Not sure this saved: Retry"; Retry resends the same values with the same key, which waits on the first request in the database (the replay helper's advisory lock) and then answers with its result. The inputs unlock only on a definite answer (saved, or refused by name), so no second, different save can start while the first may still be running, so a reply can never overwrite a newer unsaved value. The retry key and submitted values are held at page level and also in `sessionStorage`, keyed by the target (cleared on a definite answer), so a refresh before the reply still retries with the same key; read and written inside try/catch, falling back to page state when storage is unavailable. Not inside the modal, so closing and reopening the same target before a reply keeps the same key. Reads follow the same rule: every registration read and assignment preview gets its own request token and carries the target it was made for, and only the latest token for the currently open view of that target is applied (a reply from an earlier open, or an older read of the same target, is dropped), so A's facts never appear under B and an edit never starts from another target's values. Each save request gets its own token, and the page remembers only the latest one per target; a reply is applied only if its token is still the latest and the same open is still showing, otherwise it is dropped and the panel reloads from the database.

**Files:** the screens above, their tests, `src/lib/epaRegistrations.ts` (new: the RPC calls), `docs/workflows/UI_PATTERNS.md` untouched.

**Done when:** in the private test copy, observed: Registration panel, edit on one size changes its sibling, Change EPA number on an ungrouped size, grouped size pointing to the parent correction, label-review commit for each outcome, RUP tri-state on product page, list, CSV and Compliance, cancelled banner and quote warning. Unit tests for the tri-state mapping, error-code handling, key kept across a retry after a lost reply (one event in the database), a late reply for registration A ignored while B is shown, a late reply ignored after A was closed and reopened, an import preview for file A dropped after file B was picked, a new key after the values were edited, and inputs disabled while saving.

**Sol list:** no unless it touches a listed path (check with the classifier at build). **Mason-gated:** none.

---

## 7. PR 3 · Enforcement guards and the insert trigger (database only)

**Depends on:** PR 2b deployed (old pages would otherwise hit the guard on every save); #1581 merged (re-issue `_insert_parent_size` from its body); Taha's `20261126100000_product_parent_review_fixes` merged (re-issue `move_product_size` from its body); drift at zero (below).

**Drift settlement (Mason-gated, before the PR 3 apply):**
- `preview_epa_registration_drift()` (PR 1) lists every size or brand whose copied facts differ from its registration, and every number on a size or brand with no registration.
- Mason picks per row: keep the registration's value, take the row's value onto the registration, or, for a number with no registration, create it from that row's facts (the drift preview groups such rows by number and offers one pick per number, refused while its rows disagree until each disagreement also has a pick); `settle_epa_registration_drift(p_picks, p_expected_fingerprint, p_idempotency_key)` applies them in one transaction with `drift_settled` events.
- A `db-sweeps` predicate reports drift daily.

**Migration** `<stamp>_epa_registration_guards`:
1. `LOCK TABLE epa_registrations, products, product_brands, product_parent_brands IN SHARE ROW EXCLUSIVE MODE` (registration first, section 3.2).
2. Re-run the drift check; `RAISE EXCEPTION` if any row drifts or any number lacks a registration. The migration then rolls back as a whole and changes nothing.
3. Create the triggers in 3.3 and drop PR 2a's early `trigger_zz_guard_product_rup` (the full guard covers it).
4. Re-issue, each from its body as it is on `main` at build time:
   - `upsert_product_brand`, `upsert_parent_brand`: lock the registration before the parent; facts come from the registration; a number change on an existing brand is refused (`EPA_REGISTRATION_ASSIGN`); a new brand's number with no registration needs the full registration facts in the call (`p_new_registration jsonb`, entered from the label; brand rows hold only signal word and RUP), else it is refused with `EPA_REGISTRATION_FACTS_REQUIRED`; it then creates the registration (create rule in 3.2, `created` event naming the brand row and actor). A direct brand insert with an unregistered number is refused by the brand trigger for the same reason. **Signature:** adding `p_new_registration jsonb DEFAULT NULL` as the last parameter is done in PR 2a (so PR 2b's screens can send it), by `DROP FUNCTION` of the old signature and `CREATE` of the new one in the same migration with grants re-applied, so no old overload stays callable and existing callers resolve to the new body.
   - `apply_product_setup` insert mode (on top of PR 2a's re-issue): an inserted row's number is pre-locked with the batch's other numbers, so the insert trigger's lock is already held.
   - `_insert_parent_size` (post-#1581), `add_product_size`, `create_product_with_parent`: pre-lock the parent's registration before the parent.
   - `move_product_size` (post-Taha): lock the size's current registration and the target parent's registration together, in number order, before both parents (so the assignment helper never needs a lock it does not already hold), re-checking both numbers after the parent locks (section 3.2); when the move gives the size a number (it had none) or changes it, write it through `_assign_epa_registration` with its `assigned` event naming the move's actor and reason.
   - `correct_product_parent_identity`: only if the parked switch is already on when PR 3 is built; otherwise 7.7 does it.

**Files:** migration, changelog, migrations.d record, `scripts/smoke/prove-epa-registration-guards-real-schema.mjs`, db-sweeps predicate, types.

**Done when (harness):**
- With drift present, the migration aborts and leaves no trigger; after settlement (including a create-from-row pick for an unregistered number) it applies.
- A non-admin inserting a size with an existing number gets the registration's facts and the registration is unchanged; with a new number, the insert is refused with `EPA_REGISTRATION_NEW_NUMBER`; an admin insert with a new number creates the registration.
- A direct `UPDATE` of `signal_word` on a registered size refused by name; an update resending the same value passes; a numberless size still edits freely.
- On a grouped size, a label-fact edit gets the parent message first only for parent-owned columns; label facts get the registration message.
- Insert of a size with an existing number takes the registration's facts regardless of what was sent; with a new number creates a registration (`is_rup` true → `yes`, else `unknown`); two concurrent inserts of the same new number create one registration.
- Every re-issued function: same outputs as before on the harness fixtures, plus the registration lock first.
- Race: `add_product_size` reads the parent's number A, a correction A→B commits before its pre-lock, then a B→C correction starts; `add_product_size` raises `EPA_REGISTRATION_CHANGED_RETRY` after locking the parent, writes nothing, and no session deadlocks; the retry succeeds on the new number.
- Lock-order races (two sessions each): registration edit vs `add_product_size`; registration edit vs `move_product_size`; `apply_product_setup` vs `upsert_parent_brand`; draft commit vs registration edit. None deadlocks.
- Brand edit of `is_rup` without the registration refused; an upsert changing an existing brand's number refused with `EPA_REGISTRATION_ASSIGN`.
- Rollback: dropping the triggers and restoring the prior function bodies leaves every row reading the same.

**Risks:** the most invasive PR (many re-issues on a busy table). Each re-issue is diffed against `pg_get_functiondef` on live before review. **Sol list:** yes. **Mason-gated:** drift settlement; the apply itself is non-destructive (guards only), but if settlement is folded into the migration it overwrites rows and needs his `I approve`; this plan keeps settlement in the RPC so the migration writes no rows.

---

## 8. 7.7 · EPA-number correction on (parent)

**Starting point:** the parked branch `claude/sweet-bun-f7920f` (local only, not pushed; its session was `local_72ea5177`). Its migration `20261127100000_job_line_epa_snapshot.sql` already:
- adds `job_chemicals.epa_registration`, filled by trigger, read-only to clients, and fills blank invoice-line copies;
- re-issues `_product_parent_identity_after` and `correct_product_parent_identity` so an EPA change reaches the parent, its sizes (under the copy pass) and job lines of jobs not yet sprayed, refused while any invoice line lacks its own copy;
- adds the switch `_product_parent_epa_correction_enabled()`, returning false;
- claimed stamps `20261123100000` and `20261123150000` (the switch-on) in its notes, but its base migration is now stamped `20261127100000`. A switch-on stamped `20261123150000` would sort **before** the base and fail (the switch function would not exist yet). **The switch-on must get a fresh stamp later than the base migration's**, picked when it is built; the harness applies the files in stamp order to prove it.

§7.8 item 4 (job snapshot lost on `save_job` delete-recreate) is **not** covered by the parked database file alone: `save_job` deletes and re-inserts a job's lines, and the trigger can only keep a number the writer passes back (its own header, lines 121-124). The parked plan has its screens PR make `save_job` pass each line's number back. So the 7.7 switch-on additionally requires that change to be live, and `save_job` itself (not only its screens) must enforce it: for a line that already exists on a sprayed or finished job, the database keeps the stored number and ignores whatever the client sends (missing, old or invented), so a stale or hostile caller can neither drop nor rewrite a sprayed line's history; and a re-save that omits an existing line of a sprayed or finished job is refused (`JOB_LINE_HISTORY_KEPT`) rather than deleting it; a new line added to a sprayed or finished job is refused too (`JOB_LINE_HISTORY_KEPT`) unless the save names that line's EPA number explicitly, which the job screen asks for and records as entered (Q6). Harness cases: a sprayed job keeps number A after a parent correction to B and a later re-save of that job, both when the re-save omits the number and when it sends C. Without it, the switch stays off. **REG-1 does not redesign it.**

**Order:**
- **Unposted invoices:** the same open-invoice refusal as single-size assignment applies to every size under the parent.
- **New number with no registration:** the correction must carry the new number's facts (`p_changes.new_registration`, entered from that label in the preview), else it is refused with `EPA_REGISTRATION_FACTS_REQUIRED`, the same rule as single-size assignment; the old number's facts are never copied to the new one.
- **Open jobs:** the parked trigger keeps a number the writer passes back only on sprayed or finished jobs; a line of a job not yet sprayed always takes the product's current number (its header, lines 18-23), so a stale job screen saving after a correction cannot put the old number back.
- **If the parked work lands before PR 3:** PR 3 re-issues its `correct_product_parent_identity` to lock old and new registrations first and copy the new registration's facts onto the sizes. The switch-on stays in the parked owner's screens PR.
- **If it lands after PR 3:** its author re-issues against REG-1's guards (pre-lock, pass), and the switch-on ships in its screens PR as planned.
- **Either way**, the switch-on migration (`<stamp>_parent_epa_correction_on`, one function returning true) is the "7.7 PR". It ships only when: PR 3 is live; the correction locks registrations first; the reader trace in §4.1 is complete.

**Done when (harness, on top of the parked branch's own):** switch on; a correction to an unregistered number without its facts is refused; a stale job screen saving an unsprayed job after a correction keeps the new number; correcting a grouped parent's number from A to B moves every size to B's facts, leaves A's other sizes on A, writes one parent event and one registration event per number; a correction to a number with no registration creates it; a race with `set_epa_registration` on A or B does not deadlock; old invoice lines keep their stored number.

**Sol list:** yes. **Mason-gated:** none beyond the parked owner's own gates.

---

## 9. How each §7.8 open item is settled

| §7.8 item | Settled by |
|---|---|
| RUP tri-state through `generate_rup_sales_records`, Compliance list, Products CSV | `rup_status` on the registration (PR 1); sizes' `is_rup` copied from it, so posting is unchanged (section 5); not-reviewed registrations listed on Compliance, CSV shows the tri-state (PR 2b); past-sale gap is Q2; Q1, Q2 below |
| Insert-created registration starts as `unknown` | Insert trigger rule (3.3): `is_rup` true → `yes`, else `unknown` |
| PR 2a commit when no registration exists | Held with `LABEL_DRAFT_NO_REGISTRATION`; screen offers create (section 5) |
| 7.7 job snapshot lost on `save_job` delete/recreate | Parked branch's column-plus-trigger design; harness must prove the recreate case (section 8) |
| Copy only the columns a brand row has | Brands get signal word and RUP only (3.3) |
| Open-job offer permissions | No "update open jobs" offer in REG-1: label facts are read live by job screens today, and the EPA number on job lines is handled by the parked snapshot. Revisit only if Mason asks |

---

## 10. Dependencies and overlap with other work (checked read-only 2026-11-06)

| Work | Where | Overlap | Rule |
|---|---|---|---|
| PR #1581 size notes | `20261127110000_product_size_notes_in_one_step.sql` re-issues `_insert_parent_size` | PR 3 re-issues the same function | PR 3 builds after #1581 merges, from its body |
| Taha's PAR-2 fixes | worktree `happy-mendel-a24b2b`, `20261126100000_product_parent_review_fixes.sql`; re-issues `move_product_size`, `_product_size_move_refusal`, approval functions; does **not** touch the brand RPCs | PR 3 re-issues `move_product_size` | PR 3 builds after it merges, from its body |
| KI-18 batch 1 | worktree `mystifying-chandrasekhar-760465`, `20261128100000` re-issues `generate_rup_sales_records` (dates only; still reads the product) | RUP-POST (section 5a) re-issues it again | RUP-POST builds after KI-18 batch 1 merges, from its body |
| Parked EPA correction | local branch `claude/sweet-bun-f7920f`, `20261127100000_job_line_epa_snapshot.sql` | 7.7 | Section 8 |
| PAR-1 screens #1553 | `ProductDetail.tsx` | PR 2b | PR 2b after #1553 |
| DM-1 / DM-2 screens | `ProductDetail.tsx` | PR 2b | Rebase on whichever lands first |
| PAR-2 grouping switch | `_product_parent_grouping_open()` false | brand RPCs refuse while closed; REG-1 re-issues keep that refusal | none |

Migration stamps in this project run ahead of the calendar, so the November 26-28 stamps above are open work that exists today in the named worktrees and branch (checked by path on 2026-11-06), not future work. Stamps already claimed by others (do not reuse): `20261115120000`, `20261117130000`, `20261117160000`, `20261123100000`, `20261123150000` (not usable for the switch-on, see section 8), `20261126100000`, `20261127100000`, `20261127110000`, `20261128100000`. REG-1 picks fresh stamps at build time.

**Order (Mason, 2026-11-06):** PR 1 → seed → KI-18 batch 1 merged → RUP-POST → PR 2a → PR 2b → drift settlement → PR 3 → 7.7. PR 1 can be built now and in parallel with DM-1 and DM-2 database PRs (no shared functions). PR 3 also waits for the items above.

---

## 11. Steps that need Mason

1. **Seed picks**: one shared number disagrees on signal word today; Mason picks the right value from the seed preview (shown with the product names in the app, never in the repo).
2. **Seed run**: the one-time live back-fill (`seed_epa_registrations`) writes about 203 rows and may change one size's signal word. Mason's explicit yes in the conversation that runs it.
3. **Old invoice lines** (section 5a): review the read-only list of lines saved before RUP-POST (9 live lines have no number today) and correct any in the app if needed; nothing is filled automatically.
4. **Drift settlement** before PR 3, if any drift appears after the seed.
5. Answers to the questions below (Q1 changes the seed).

---

## 12. Questions for Mason

1. **Today's "not restricted-use" ticks: count them as "No" or "Not reviewed"?** Right now every product except two is marked not restricted-use, mostly because the box starts unticked. **Recommendation: "Not reviewed"**, then you confirm each label once; the two marked "Yes" stay "Yes".
2. **Today, if a product is sold before anyone marks it restricted-use, that sale never reaches the RUP register, even after the box is ticked. REG-1 does not change this. Do you want a separate piece of work to catch those past sales?** It needs care: every way of re-recording past sales that we tried in review hit timing problems, so it would be its own small, carefully tested package. **Recommendation: not now.** First review the labels REG-1 lists as "Not reviewed" (only two products are marked restricted-use today); if a review turns up a restricted-use product with past sales, record those few by hand and then decide. A related choice: REG-1 blocks changing a product's EPA number while it sits on an invoice that has not been posted yet, so the restricted-use record always names the number that was sold. **Recommendation: keep the block** (post or void the invoice first); the alternative, a warning only, could post a sale under the wrong number.
3. **Who may edit a registration's label facts?** **Recommendation: admins only**, as for parents and brands today.
4. **The parked EPA-number correction work (branch `claude/sweet-bun-f7920f`) is only on this computer and not pushed.** **Recommendation:** have its session push it and land its database part first; REG-1 then builds on it (section 8).
5. **ANSWERED (Mason, 2026-11-06): yes, hold.** Correction since he answered: KI-18 batch 1 does not make posting read the invoice line (it changes dates only), so the hold is on a new small package, RUP-POST (section 5a), built on KI-18's body. Original question: **Should the new EPA-number tools wait until restricted-use (RUP) sales are recorded from each invoice line's own copy?** Today the RUP register is filled at posting from the product's *current* EPA number and RUP flag. Every reviewer round (Luna 1-17, Sol 1-3) found another way that a later change to a product (a new number, a RUP flag, an earlier sale) leaves the register wrong, because posting reads the product instead of what was actually sold. Patching each case has not converged. The change that removes the whole family is for posting to use each invoice line's own saved number and its registration's RUP answer. That is the KI-18 work in another worktree. **Recommendation: yes. Build REG-1 PR 1 (storage and seed tools, no behaviour change) now, but hold PR 2a onward until posting reads the invoice line's own copy.** The cost is a few weeks' delay on the Registration panel. The alternative is to ship on the current design with the named gaps and catch any problems in the daily drift sweep.
6. **Adding a chemical to a job that was already sprayed:** after 7.7, should the job screen refuse it, or allow it if the user types that chemical's EPA number as it was on the day? **Recommendation: allow it with the typed number** (corrections to old jobs happen), and the line records who entered it.
7. **Direct product inserts:** today the app's own login can still insert product rows directly, outside the setup screens; the database cannot tell an intended "No" from a default there. **Recommendation: remove that direct insert permission in PR 3** (every create screen already goes through the admin functions). This is a permission change, so it needs your yes when PR 3 is built.

---

## 13. Sol review record

**Luna rounds 1-17** (gpt-6-luna, xhigh): every finding was fixed in this sheet or refuted, except three named items:
- **RUP past sales** (HIGH in most rounds): one repeating mechanism, so per `AGENTS.md` it stopped being patched; both positions are recorded in section 5 and it is Mason's Q2.
- **Delivery brand-pick warning** for a cancelled registration: deferred to Stage 3 (grand plan §8); the quote-add warning ships here.
- **Interim drift between PR 1 and PR 3**: accepted by design (section 6); the daily sweep reports it and PR 3 refuses to apply until it is zero.

| Date | Reviewer | Head | Verdict | Notes |
|---|---|---|---|---|
| 2026-11-06 | gpt-6-sol high (advisory; plan is off the Sol list) | d6f15baf9 | 1 BLOCKER, 3 HIGH, 3 MED/LOW | admin re-check, draft target numbers, open-invoice block fixed; RUP past sales → Q2 |
| 2026-11-06 | gpt-6-sol high (advisory) | 453af6e73 | 5 HIGH, 3 MED | early RUP guard, history-first assignment, destination version, kept job lines, import retry fixed |
| 2026-11-06 | gpt-6-sol high (advisory) | 0598fb3c2 | 3 HIGH, 4 MED, 1 LOW | **stopped**: HIGHs 1, 2 and 7 trace to RUP posting reading the product's current state, a third Sol round in a row on that mechanism; per `AGENTS.md` it goes to Mason as Q5; the MED/LOW items are fixed. **Not a clean Sol.** |
| 2026-11-06 | gpt-6-sol high (advisory) | b5be085bf | 7 HIGH, 3 MED | after Mason's Q5: RUP-POST now snapshots each line's RUP answer, no automatic fill of old lines, job lock under assignment, destination-none stale check, insert path creates the registration first; new-line-on-sprayed-job and direct product inserts → Q6, Q7; past sales → Q2 |
