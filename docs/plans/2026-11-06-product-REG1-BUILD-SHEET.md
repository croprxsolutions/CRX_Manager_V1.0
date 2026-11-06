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
  - `label_adjuvants jsonb` not null default `'[]'`: an array of `{kind: required|recommended, adjuvant_type text, note text}`, checked by an immutable validator function.
  - `registration_version bigint` (starts at 1; every successful write to the row, by any function, increments it and sets `updated_by` and `updated_at` in the same statement, so a second admin holding the old version is refused), `created_by`, `created_at`, `updated_by`, `updated_at`.
- **`epa_registration_events`**: append-only (update and delete refused). `event_type` in (`seeded`, `created`, `updated`, `assigned`, `draft_committed`, `drift_settled`); `reason`, `before_values`, `after_values`, `affected jsonb` (per size or brand: table, ID, before and after); `changed_by`, `changed_by_name`, `changed_at`.
- **`epa_registration_copy_passes(txid bigint, target_table text, target_id uuid, event_id bigint)`**: private, no grants.
- **`label_draft_targets(draft_id uuid primary key, epa_registration text, product_id uuid, product_label_fingerprint text, registration_version bigint)`**: private, no grants. Filled by the draft-create functions, read only by the commit.

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

- **`trigger_zz_guard_product_registration`** on `products` (`BEFORE INSERT OR UPDATE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, owned by `postgres`). Name sorts after `trigger_zz_guard_product_parent_values` (so a grouped size gets the parent message first) and before `trigger_zzz_guard_product_rate_lock`. On UPDATE: when the row has an EPA number with a registration, a change to `signal_word`, `is_rup`, `rei_hours`, `phi_days`, `max_label_rate` or `max_label_rate_unit` without a pass is refused: `EPA_REGISTRATION_FACT: <column> belongs to EPA registration <number>; edit it on the registration (reload the app if you do not see a Registration panel)`. An update that resends unchanged values passes. A change to `epa_registration` itself without a pass is refused with `EPA_REGISTRATION_ASSIGN: use Change EPA number`, including adding a number to a numberless size. Every place that can set a number therefore routes through the assignment helper (`_assign_epa_registration`, the body of `assign_epa_registration`, which takes the locks and the pass): the product page's EPA field on a numberless size calls `assign_epa_registration` (PR 2b); `apply_product_setup` update mode calls the helper for a row whose number changes, after pre-locking (PR 3); `upsert_product_brand` / `upsert_parent_brand` refuse a number change on an existing brand with the same code and route the brand screen to Change EPA number (PR 3).
- **The INSERT branch** of the same trigger: when the new row has an EPA number, it locks or creates the registration (`INSERT … ON CONFLICT DO NOTHING`, then `SELECT … FOR SHARE`), then overwrites the row's label facts from it. **An insert never changes an existing registration**: a size or brand inserted with a number that already has one simply receives its facts, whatever the insert sent. A number new to the system creates a registration from the row's own facts (that number is on no other row yet, so nothing else changes), **only when the inserting session is an admin** (`is_admin()`); a non-admin insert carrying a number with no registration is refused with `EPA_REGISTRATION_NEW_NUMBER: an admin must add this EPA number`. (Luna rounds 3, 5 and 8 each found a new way an unverified registration could spread a user's typed facts; the unverified state was deleted instead of patched. Every product-create screen is already admin-only through `create_product_with_parent` / `apply_product_setup`, so no current screen loses anything.) The created registration's facts are set with `rup_status` = `yes` when `is_rup` is true, else `unknown` (§7.8 item 2). `is_rup` on the size is set to `rup_status = 'yes'`. A registration created here writes a `created` event naming the source table and row and the session's user.
- **Brand guards** on `product_brands` and `product_parent_brands`: same rule for `signal_word` and `is_rup`; brand `is_rup` mirrors `rup_status` as `true` / `false` / `null`.
- **Created only after drift is zero.** The PR 3 migration locks the three tables, re-runs the drift check and aborts the whole migration if any row drifts (section 7).

### 3.4 Writers (every path that writes an EPA number or a label fact)

| Writer | Today | After REG-1 |
|---|---|---|
| Product page save (`ProductDetail.tsx:503-504`, `PRODUCT_NONPRICING_FIELDS` `:76`) | direct update incl. `is_rup`, `signal_word` | stops sending label facts and EPA number when registered (PR 2b); the guard refuses anyway (PR 3) |
| Product page create (`ProductDetail.tsx:764-765`) | direct insert | replaced by #1553 (`create_product_with_parent`); insert trigger covers it |
| Products list (`Products.tsx:808-809`) | nonpricing update | same as product page |
| Label data quality (`LabelDataQuality.tsx:524-525`, `:585-586`, `:803-804`) | updates `signal_word`; `:803-804` sets the EPA number and clears signal word | signal word goes to `set_epa_registration`; the EPA number goes to Change EPA number (PR 2b) |
| Setup workbook / bulk import (`productSetupWorkbook.ts:183`, `BulkProductImport.tsx:391`) via `apply_product_setup` | writes all label facts, update and insert | PR 3 re-issue: label facts on a registered row are refused unless equal; insert pre-locks the registration |
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
- `seed_epa_registrations(p_picks jsonb, p_rup_default text, p_expected_fingerprint text, p_idempotency_key text)` (admin, key required, `_product_parent_replay` pattern): `p_rup_default` in (`unknown`, `no`) is Mason's answer to Q1 and sets `rup_status` for numbers with no `true` row (no default value; a missing one is refused); refuses a stale fingerprint; refuses unless every disagreement has a pick; inserts all registrations, writes one `seeded` event each, and copies each pick onto disagreeing sizes and brands under passes. All-or-nothing. Refuses if any registration already exists (one-time). **Until the seed has run** (a `seeded` event exists), `set_epa_registration`, `assign_epa_registration` and `settle_epa_registration_drift` refuse with `EPA_REGISTRATION_NOT_SEEDED`, so nothing can create a registration that would block the seed; the insert trigger and the PR 2a/PR 3 re-issues ship only after the seed.
- `set_epa_registration(p_epa_registration, p_expected_version, p_changes jsonb, p_reason, p_idempotency_key)` (admin, key): locks the registration, then the sizes (ID order) and brands carrying it; refuses a stale version; updates it; writes one event; copies the changed facts to every size and brand under passes. Creates the registration when `p_expected_version` is null and none exists (create rule in 3.2), writing a `created` event. Every successful save also sets `updated_by`/`updated_at`
- `preview_epa_assignment(p_target_table, p_target_id, p_new_number)` and `assign_epa_registration(p_target_table, p_target_id, p_new_number, p_new_registration jsonb, p_expected_target_fingerprint, p_reason, p_idempotency_key)` (admin, key): Change EPA number on one ungrouped size or one brand. Locks old and new registration (number order), then the target; refuses a grouped size (`EPA_REGISTRATION_GROUPED_USE_PARENT`, which points to 7.7's correction); writes the number and the new registration's facts under a pass; when the new number has no registration, the call must carry the new registration's facts in `p_new_registration jsonb` (the admin enters them from B's label in the preview; the target's current facts belong to its old number and are never copied), else it is refused with `EPA_REGISTRATION_FACTS_REQUIRED`; it then creates the registration (create rule in 3.2, `created` event). Writes one `assigned` event on each of the old and new registrations (only the new one when the target had no number, or when its old number has no registration, with the old number recorded in the event either way), carrying the target, old and new number, reason and actor.
- `get_epa_registrations(p_numbers text[] default null)`: open to active users, checked inside the function (`auth.uid()` must be an active `profiles` row), because a `SECURITY DEFINER` function does not apply the table's RLS; no cost or price.
- `preview_epa_registration_drift()` (admin, read-only) and `settle_epa_registration_drift(p_picks jsonb, p_expected_fingerprint text, p_idempotency_key text)` (admin, key): used before PR 3 (section 7).
- **Draft targets:** `create_label_draft` and `bulk_create_label_drafts` implementations re-issued from their live bodies with one addition: insert the `label_draft_targets` row (number, product, the product's label-fact fingerprint, the registration version if one exists). Public wrappers unchanged.
- Grants: public RPCs `EXECUTE` to `authenticated`, helpers none. **No grant or policy change on an existing table.**

**Files:** `supabase/migrations/<stamp>_epa_registrations.sql`; `docs/changelog.d/<date>-epa-registrations.md`; `docs/reference/migrations.d/<stamp>_epa_registrations.md`; `scripts/smoke/prove-epa-registrations-real-schema.mjs`; `src/types/index.ts`, `src/types/supabase.ts`; `docs/reference/rpc-functions.md`; `.claude/schema-registry.json` after apply.

**Done when (harness):**
- Seed preview on a copy shaped like live (counts above): 203 proposed registrations, one disagreement listed; seed without a pick for it refused; with a pick, all 203 created, the disagreeing row now matches, one `seeded` event each; a second seed refused; a changed product between preview and seed refuses on fingerprint.
- `is_rup` true → `yes`; false → `unknown`.
- `set_epa_registration` changes signal word on a number shared by three sizes and one brand: all four updated, one event, each size's history shows the change; a stale version refused.
- Assignment: ungrouped size moved from number A to B gets B's facts and writes an `assigned` event on A and on B; grouped size refused by name; brand assignment works.
- Adding a number to a numberless size through the product page, the setup workbook and a bulk import each goes through assignment (one `assigned` event, registration facts on the size); a direct `UPDATE` setting it is refused with `EPA_REGISTRATION_ASSIGN`.
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

**Depends on:** PR 1 applied and seeded.

**Migration** `<stamp>_label_draft_commit_registration`:
- **`_commit_label_draft_replay_impl_20261015`** re-issued from its live body (md5 `dee9e34d…` at writing; diffed again before build):
  0. **Who and what.** The registration branches (steps 3-5) change facts shared by every size and brand on the number, so they require an admin (`_product_parent_require_admin()`, section 3.1); the numberless branch (step 6) keeps today's role rule. The values written are always the wrapper's own parameters (the facts the reviewer saw and sent), for `accepted` as well as `edited`: today `accepted` copies from the draft row (`20260629210000:288-299`), which clients can still edit. For `accepted`, the commit refuses `LABEL_DRAFT_CHANGED` when the parameters differ from the locked draft row, so a draft changed after the screen loaded it is never committed. No new parameter and no new overload; the wrapper signature `commit_label_draft(uuid, text, text, integer, integer, text, numeric, text, boolean, text)` is unchanged.
  1. Read the draft's `label_draft_targets` row (no lock), then lock the registration it names (if any), then the draft, then the product: section 3.2 order. Because clients can still update `product_label_drafts`, the commit then refuses with `LABEL_DRAFT_TARGET_MISMATCH` unless the locked draft's `product_id` and normalized EPA number equal the target row's; a draft with no target row (made before PR 1) is refused the same way and must be recreated (none exist live today).
  2. Staleness: refuse when the product's current label-fact fingerprint differs from the target row's and `p_force_overwrite` is false (`LABEL_DRAFT_STALE`). This is keyed on label facts on purpose: the guards keep a registered size's facts equal to its registration's, so any fact change on the registration also changes the size fingerprint; a change to registration-only fields (status, label link, accepted date) does not touch what a draft proposes and does not make it stale.
  3. **Same number, registration exists:** write the facts through `set_epa_registration`'s internal helper (one `draft_committed` event; copies to all sizes and brands).
  4. **Same number, no registration:** hold the draft with `LABEL_DRAFT_NO_REGISTRATION` (status stays `pending`; screen offers "Create registration"). §7.8 item 3.
  5. **Different number on the draft:** do not write; return `LABEL_DRAFT_EPA_CHANGE` so the screen opens Change EPA number (ungrouped) or the parent correction (grouped).
  6. **Product with no number:** keep today's direct size commit, checked against the target row's fingerprint.
  7. RUP: drafts have no RUP field, so a commit never changes `rup_status`.
- **RUP posting is not changed** (decided after Luna rounds 4-6 kept finding races in every design that re-classed sales by registration; that mechanism is deleted, not patched). Each size's `is_rup` is a copy of its registration (`is_rup = (rup_status = 'yes')`, written under a pass by the seed, `set_epa_registration` and the insert trigger), so `generate_rup_sales_records` keeps working exactly as today and is not re-issued. "Not reviewed" registrations (`rup_status = 'unknown'`) are listed on Compliance through `get_epa_registrations`, so the labels get reviewed. **Past sales are not lost:** a new read-only `get_rup_sales_missing(p_from date, p_to date)` (admin and sales rep, active-user check inside) lists posted, not-deleted invoice lines whose product is now marked restricted-use and that have no active `rup_sales_records` row (the same match the generator's own de-duplication uses). Compliance shows it as "RUP sales not yet recorded" with a "Record" button per invoice that calls the existing `generate_rup_sales_records(p_invoice_id, p_idempotency_key)`; that function already refuses unposted invoices, checks the caller's role and skips lines already recorded, so this adds no new write path and no new lock. The list is computed fresh each time, so a sale cannot be stranded on it, and after a label is reviewed as "Yes" its earlier sales appear there until recorded.

**Files:** migration, changelog note, migrations.d record, `scripts/smoke/prove-label-draft-registration-real-schema.mjs`, types, rpc-functions doc.

**Done when (harness):**
- A draft for a number shared by two sizes commits once and both sizes plus the registration change; one event.
- A non-admin call to every admin RPC is refused before any read of the replay table, and every event's actor equals the caller (a forged actor parameter is not accepted because none exists).
- A draft accepted after a client changed its REI directly is refused with `LABEL_DRAFT_CHANGED`; a non-admin commit on a registered number is refused; the numberless commit keeps today's role rule.
- Missing RUP sales: a posted sale of a size later set to `yes` appears on `get_rup_sales_missing`; "Record" posts it once; recording again adds nothing; the line then leaves the list; an inactive user and an applicator are refused.
- A registration edit changing REI, PHI, label max or signal word on a number carried by a grouped size succeeds: the parent guard covers only category, Use Timing, rate per acre, rate unit, suggested rate and the EPA number (`guard_product_parent_values`, `20261108120000`), so it does not see these columns.
- RUP: setting a registration to `yes` sets `is_rup = true` on every size carrying it; to `no` or `unknown`, false; `generate_rup_sales_records` is byte-identical to its live body (md5 compared) and an invoice posted afterwards records exactly the `yes` sizes.
- A draft whose `product_id` or EPA number was changed directly after creation is refused with `LABEL_DRAFT_TARGET_MISMATCH` and writes nothing.
- Draft on a number with no registration: held, nothing written; after creating the registration, commit succeeds.
- Draft with a different number: nothing written, code returned.
- Product edited after the draft was made: refused unless force.
- Numberless product: today's behaviour, byte for byte.
- A grouped size's draft no longer fails on the parent guard for same-number facts.
- Replay and admin checks as PR 1. Two sessions committing drafts on the same number serialize without deadlock.

**Risks:** the commit impl is re-issued from its live body; diff it against `pg_get_functiondef` before review. **Sol list:** yes. **Mason-gated:** none.

---

## 6. PR 2b · Screens

**Depends on:** PR 2a deployed. Shares `ProductDetail.tsx` with #1553, DM-1 and DM-2 screen PRs: build after #1553 merges and rebase on whichever lands first.

- **Numberless sizes:** the EPA field stays editable but saves through `assign_epa_registration` (preview first), never in the product save payload; the setup workbook and bulk import show a changed or new number as an assignment in their preview and send it to the database, which routes it once PR 3 is live. Between PR 2b and PR 3 an import still writes numbers and facts as today (`apply_product_setup` is unchanged until PR 3); any number it adds without a registration appears in the drift preview and is settled (create-from-row pick) before PR 3 applies.
- **Product page** (`ProductDetail.tsx`): a Registration panel for a size with a number: status, label link (`EpaLabelLink.tsx`), signal word, RUP (Yes / No / Not reviewed), REI, PHI, label max, adjuvants, "Edit registration" (admin), "Change EPA number" (admin; ungrouped only; on a grouped size the button opens the parent's identity correction once 7.7 is on, and is shown disabled with "Set on parent <name>" until then). The EPA field on a numberless size is editable for admins only (it saves through the admin-only assignment); for other users it is read-only, which narrows today's behaviour on purpose. Label-fact inputs become read-only; `PRODUCT_NONPRICING_FIELDS` (`:76`) stops sending them and `epa_registration` for registered sizes; a numberless size has no registration, so it keeps today's Yes/No checkbox (`:253`, `:1309`) on `products.is_rup`; when a number is later assigned, a new registration takes `yes` from a ticked box and otherwise `unknown` (a numberless "No" is not carried over, because it was never a label review); EPA lookup compare (`:1153`, `:1425`) compares against the registration. Banner when status is `cancelled` (warning only, never blocks).
- **Label review** (`LabelReview.tsx:293`, `:376`): handles `LABEL_DRAFT_NO_REGISTRATION` (offer create), `LABEL_DRAFT_EPA_CHANGE` (open the right flow), `LABEL_DRAFT_STALE`.
- **Label data quality** (`LabelDataQuality.tsx:221`, `:388-427`, `:524-525`, `:585-586`, `:803-804`): signal-word fixes go to the registration; the EPA set goes to Change EPA number.
- **Products list and CSV** (`Products.tsx:125`, `:808-809`, `:1169-1171`): RUP shown as Yes / No / Not reviewed.
- **Bulk import and workbook** (`bulkProductImportSafety.ts:232`, `:264-265`; `productSetupWorkbook.ts:38`, `:225`, `:378`, `:404`): label columns on registered rows are read-only; an upload that changes them gets a by-name message.
- **Brands** (`ProductBrandsSection.tsx:68`, `:98`, `:480`): brand label facts read-only, shown from the registration; a "Change EPA number" action on each brand row (admin) opens `preview_epa_assignment` / `assign_epa_registration` for that brand.
- **RUP readers** (`rupCompliance.ts:56`, `Compliance.tsx:179`, `LogbookReport.tsx:313`, `:343`, `epaDataQualityReport.ts:207`, `ProductChangeHistory.tsx:16`, `:28`, `costFields.ts:34`): read `rup_status`; Compliance shows an "RUP not reviewed" registration list and the "RUP sales not yet recorded" list with its per-invoice Record button (§7.8 item 1).
- **Warnings** (grand plan §8): quote-add warning for a cancelled registration. Delivery brand-pick warning stays Stage 3.

- **Saving safely** (every new save: registration edit, Change EPA number, draft commit outcomes, drift settlement): each modal keeps its retry key from `useIdempotencyKey` until the database confirms the save (or refuses by name), so a retry after a lost reply reuses the same key; the key is bound to the submitted values, and any edit to them after a failed or lost save starts a new key. While a save is in flight, the whole form (inputs and buttons) is disabled, and the page-level state marks that target as saving, so reopening the same target shows "Saving…" with the form disabled until the first reply or a refusal; a second save for one target can never be in flight. A network error or a 30-second timeout with no reply clears the saving state but keeps the key and the submitted values, and the form shows "Not sure this saved: Retry"; Retry resends the same values with the same key (the database answers with the first result if it had saved), so a reply can never overwrite a newer unsaved value. The retry key is held at page level, keyed by the target, not inside the modal, so closing and reopening the same target before a reply keeps the same key. Each open of a panel or modal gets a fresh request token; a reply is applied only if the same open is still showing (same token), otherwise it is dropped and the panel reloads from the database.

**Files:** the screens above, their tests, `src/lib/epaRegistrations.ts` (new: the RPC calls), `docs/workflows/UI_PATTERNS.md` untouched.

**Done when:** in the private test copy, observed: Registration panel, edit on one size changes its sibling, Change EPA number on an ungrouped size, grouped size pointing to the parent correction, label-review commit for each outcome, RUP tri-state on product page, list, CSV and Compliance, cancelled banner and quote warning. Unit tests for the tri-state mapping, error-code handling, key kept across a retry after a lost reply (one event in the database), a late reply for registration A ignored while B is shown, a late reply ignored after A was closed and reopened, a new key after the values were edited, and inputs disabled while saving.

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
3. Create the triggers in 3.3.
4. Re-issue, each from its body as it is on `main` at build time:
   - `upsert_product_brand`, `upsert_parent_brand`: lock the registration before the parent; facts come from the registration; a number change on an existing brand is refused (`EPA_REGISTRATION_ASSIGN`); a new brand's number with no registration creates one (create rule in 3.2, `created` event naming the brand row and actor).
   - `apply_product_setup` / `_apply_product_setup_update` (and insert mode): pre-lock every registration in the batch, in number order, before any product lock; a label-fact change on a registered row is refused unless equal (`EPA_REGISTRATION_FACT`).
   - `_insert_parent_size` (post-#1581), `add_product_size`, `create_product_with_parent`: pre-lock the parent's registration before the parent.
   - `move_product_size` (post-Taha): lock the target parent's registration before both parents; copy under a pass.
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

§7.8 item 4 (job snapshot lost on `save_job` delete-recreate) is **not** covered by the parked database file alone: `save_job` deletes and re-inserts a job's lines, and the trigger can only keep a number the writer passes back (its own header, lines 121-124). The parked plan has its screens PR make `save_job` pass each line's number back. So the 7.7 switch-on additionally requires that change to be live, with a harness case: a sprayed job keeps number A after a parent correction to B and a later re-save of that job. Without it, the switch stays off. **REG-1 does not redesign it.**

**Order:**
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
| RUP tri-state through `generate_rup_sales_records`, Compliance list, Products CSV | `rup_status` on the registration (PR 1); sizes' `is_rup` copied from it, so posting is unchanged (section 5); not-reviewed registrations and missing RUP sales listed on Compliance, CSV shows the tri-state (PR 2b); Q1, Q2 below |
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
| KI-18 batch 1 | worktree `mystifying-chandrasekhar-760465`, `20261128100000` re-issues `generate_rup_sales_records` | none: REG-1 no longer re-issues it (section 5) | only if Q2 is answered yes, the later sales-list package builds on its body |
| Parked EPA correction | local branch `claude/sweet-bun-f7920f`, `20261127100000_job_line_epa_snapshot.sql` | 7.7 | Section 8 |
| PAR-1 screens #1553 | `ProductDetail.tsx` | PR 2b | PR 2b after #1553 |
| DM-1 / DM-2 screens | `ProductDetail.tsx` | PR 2b | Rebase on whichever lands first |
| PAR-2 grouping switch | `_product_parent_grouping_open()` false | brand RPCs refuse while closed; REG-1 re-issues keep that refusal | none |

Migration stamps in this project run ahead of the calendar, so the November 26-28 stamps above are open work that exists today in the named worktrees and branch (checked by path on 2026-11-06), not future work. Stamps already claimed by others (do not reuse): `20261115120000`, `20261117130000`, `20261117160000`, `20261123100000`, `20261123150000` (not usable for the switch-on, see section 8), `20261126100000`, `20261127100000`, `20261127110000`, `20261128100000`. REG-1 picks fresh stamps at build time.

Database PRs 1 and 2a can be built in parallel with DM-1 and DM-2 database PRs (no shared functions). PR 3 waits for the items above.

---

## 11. Steps that need Mason

1. **Seed picks**: one shared number disagrees on signal word today; Mason picks the right value from the seed preview (shown with the product names in the app, never in the repo).
2. **Seed run**: the one-time live back-fill (`seed_epa_registrations`) writes about 203 rows and may change one size's signal word. Mason's explicit yes in the conversation that runs it.
3. **Drift settlement** before PR 3, if any drift appears after the seed.
4. Answers to the questions below (Q1 changes the seed).

---

## 12. Questions for Mason

1. **Today's "not restricted-use" ticks: count them as "No" or "Not reviewed"?** Right now every product except two is marked not restricted-use, mostly because the box starts unticked. **Recommendation: "Not reviewed"**, then you confirm each label once; the two marked "Yes" stay "Yes".
2. **When a label is reviewed and turns out to be restricted-use, should its earlier sales be added to the RUP register by hand (one click per invoice on a "not yet recorded" list) or automatically?** **Recommendation: by hand from the list**, which the plan already includes; it adds nothing that can misfire, and the list shows you exactly what is missing. Automatic recording can be added later if the list gets long.
3. **Who may edit a registration's label facts?** **Recommendation: admins only**, as for parents and brands today.
4. **The parked EPA-number correction work (branch `claude/sweet-bun-f7920f`) is only on this computer and not pushed.** **Recommendation:** have its session push it and land its database part first; REG-1 then builds on it (section 8).

---

## 13. Sol review record

| Date | Reviewer | Head | Verdict | Notes |
|---|---|---|---|---|
| _pending_ | | | | |
