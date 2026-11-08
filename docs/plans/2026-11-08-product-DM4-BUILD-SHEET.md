# Product Master Stage 2: DM-4 build sheet (EPA lookup proposals for chemistry and label facts)

**Status (2026-11-08):** this is a plan only. No code and no migration have been written. It was written on 2026-11-08 against `main` (`4d47b2ad6`) and the live database, using read-only SQL only. For building, this sheet replaces the DM-4 outline in `docs/plans/2026-11-04-product-stage2-BUILD-SHEET.md` §7.4. Where the two differ, this sheet wins, and section 2 lists each difference. A reference like "§4" with no file name points to the Stage 2 sheet.

**Cannot start yet.** The DM-4 database PR depends on REG-1 step 2 (REG-DB), which is waiting on Taha's PR #1524. It also depends on the REG-1 seed (Mason-gated) and the DATA-2 review (Mason-gated). Section 9 has the full list.

**Words used here.**
- **Lookup:** one request to EPA for one EPA registration number, for one parent. It is stored as an `epa_lookups` row before the request is sent.
- **Proposal:** what a successful lookup suggests: chemistry items for the parent and label-fact items for the registration. It is shown to an admin and written only when the admin commits it (D-I).
- **Failure:** a lookup that produced nothing usable (not found, moved to a new number, error, or a result in the wrong shape). It is listed by number, and nothing is written for it.
- **Parent link:** how the number belongs to the parent. It can be the parent's own generic number, a member size's number, an active parent brand's number, or a legacy `product_brands` number on a member size. These are the same four places `_parent_chemistry_epa_refusal` reads.
- **Item:** one row of a proposal: one ingredient, or one label fact. Every item is sorted into a **class** (section 3.4). Only the add, fill and confirm classes can be written. Every other class is a **difference**: it is shown and never written (D-L).
- **Held:** a whole proposal that can no longer be committed, because the number was relinked, or the parent's chemistry or the registration changed after the lookup. A held proposal can only be rejected, or replaced by a new lookup.
- **Registration**, **registration writer**, **seeded:** as in the REG-1 sheet (`2026-11-06-product-REG1-BUILD-SHEET.md`).

---

## 1. Facts this plan is built on (checked 2026-11-08)

**Live data (counts only):**

| Fact | Value |
|---|---|
| Active products with an EPA number | 294 rows, 213 distinct numbers (was 286/203 before KI-30) |
| Active rows with a distributor (C-P-D) number | 12 |
| `epa_registrations` rows | 0 (REG-1 step 1 is live; not seeded) |
| `product_parents`, members, parent brands, legacy `product_brands` | 0 each |
| `product_parent_ingredients`, `active_ingredients` | 0 each |
| `epa_lookups`, `epa_chemistry_proposals`, `epa_lookup_failures` | do not exist |
| `start_epa_lookup`, `record_epa_lookup`, `commit_epa_proposal`, `reject_epa_proposal` | do not exist |
| `seed_epa_registrations`, `_epa_registrations_seeded` | do not exist (REG-1 step 2) |
| `set_epa_registration`, `preview_epa_assignment`, `assign_epa_registration` | live stubs; each refuses `EPA_REGISTRATION_NOT_SEEDED` |
| Latest live migration | `20261214100000_ki30_epa_registration_corrections`. It is live, but its PR #1653 is still open and not on `main`. |
| `epa-lookup` Edge Function | live version 6, ACTIVE |

**Live functions DM-4 builds on (checked with `pg_get_functiondef`):**

| Function | Source migration | What DM-4 relies on |
|---|---|---|
| `_lock_parent_chemistry(p_parent_id, p_expected_version)` | `20261209100000` | Lock order: the parent `FOR UPDATE`, then member sizes `FOR SHARE` in ID order, then the `product_parent_chemistry_state` row (inserted at version 0 if missing, then `FOR UPDATE`), then `pg_advisory_xact_lock(hashtext('crx.active_ingredients'))`. A version mismatch raises `CHEMISTRY_STALE`. |
| `_apply_parent_chemistry(p_parent_id, p_changes, p_mode, p_reason, p_evidence)` | `20261211100000` (live md5 `4499d74183e546ade4e039a0e0596ca7`) | Mode `'epa'`: accepts only `add` actions, skips the EPA gate, and forces `source = 'epa_lookup'`. Filling an unknown strength on an epa-sourced row writes the value. An equal value is a no-op (a confirmation). These **raise**: a typed row that differs, or a typed row with an unknown strength, raises `CHEMISTRY_TYPED_ROW_KEPT`; an epa-sourced row that differs raises `CHEMISTRY_CHANGE_NEEDS_CORRECTION`. It must run after `_lock_parent_chemistry`, or it raises `CHEMISTRY_NOT_LOCKED`. It writes one `set` event. |
| `_resolve_active_ingredient(jsonb)` | `20261209100000` | A CAS match reuses the existing row; a retired row raises `INGREDIENT_RETIRED`. A name-only entry **always inserts** a new provisional ingredient. |
| `_parent_chemistry_epa_refusal(uuid)` | `20261209100000` (live md5 `c64e2bee1c7499cf6ff509168885a0f9`) | Returns the `CHEMISTRY_FROM_EPA_ONLY` message when any usable number exists in any of the four parent-link places. DM-4 re-issues it (section 4.F). |
| `_product_parent_require_admin()`, `_product_parent_replay(p_key, p_scope, p_fp)`, `save_idempotency(p_key, p_operation, p_result)` | PAR-1 | The shared admin check and replay pattern. |
| REG-1 lock | `20261210100000` | A two-key advisory lock `(20261210, hashtext('crx_epa_registration'))`: shared for readers, exclusive for writers. DM-4 uses the same pair. |

**EPA lookup result** (`supabase/functions/epa-lookup/logic.ts` `EpaLookupResult`, and `src/lib/epaLookupClient.ts` `isEpaLookupResult`):
- **Fields:** `found`, `regType` (`section3` | `distributor`), `eparegno`, `productname`, `signalWordCanonical` (`Danger` | `Warning` | `Caution` | null), `needsManual`, `manufacturer`, `rupYn` (`Yes` | `No` | null), `productStatus`, `isCancelled`, `activeIngredients[{name, percent: number|null, pcCode, casNumber}]`, `latestLabelPdfUrl` and `labelPdfs[{fileName, acceptedDate, url}]`.
- **PR #1648** (Mason's, open) adds `transferredTo`. It is absent, null, or a string, and a string is allowed **only when `found` is false**. When EPA moved a number, the result is `found: false`, with `eparegno` = the new number and the details describing the new registration. A distributor number that EPA does not list directly is confirmed through the base registration; the result is then `found: true`, with `eparegno` = the distributor number and label facts from the base label.
- **Errors** come back as `{error: string}` with HTTP 4xx/5xx.
- **Not in the lookup:** REI, PHI, label maximum rate, adjuvants, modes of action, fertilizer analysis, and a **cancellation date**.
- **`percent` basis:** assumed to be % w/w active ingredient. This is not proven yet; the build checks it (section 6, case H11).
- Any active user can call the function (`requireActiveProfile`), with rate limits. It writes nothing.

---

## 2. Where the §7.4 outline is wrong against current code

| §7.4 says | Current code / this sheet |
|---|---|
| One table, `epa_chemistry_proposals` | **Three tables.** `epa_lookups` holds the request, so a failure and a proposal both bind to one lookup ID, the parent link and the registration version (this is §7.8's DM-1 item). `epa_lookup_failures` lists failures by number. `epa_chemistry_proposals` holds proposals. |
| Commit hands every accepted item to the chemistry writer | `_apply_parent_chemistry` in `'epa'` mode **raises** on a typed or epa-sourced difference, and that rolls back the whole commit. So commit re-sorts each item under locks and passes **only** add, fill and confirm items. Differences are kept on the proposal and shown, never passed (D-L). |
| A name-only ingredient is created through the resolver | `_resolve_active_ingredient` inserts a new provisional ingredient on **every** name-only call, so a second lookup would create a duplicate. DM-4 first matches a name-only result against the parent's own rows (case- and space-insensitive). Only an unmatched, name-only item may create a provisional ingredient, and only when the admin ticks it (section 3.4). |
| Commit writes the registration's label facts | Writing label facts needs REG-1 step 2's working registration writer and the seed. Until those exist, nothing can be written to a registration. DM-4 therefore **waits for step 2 and the seed** and does not ship chemistry-only first (section 9). |
| A cancelled registration is written as cancelled | REG-1 requires `cancelled_on` when the status is cancelled, and the lookup has no date. So "EPA says cancelled" is a difference item with a D-T warning. The admin sets the date on the registration screen. |
| The status list is proposed / committed / rejected / superseded / held | Kept. This sheet defines which status changes are allowed (section 3.2). |

---

## 3. Shared design

All three tables:
- have RLS on;
- have one `SELECT` policy for active users, `USING ((SELECT public.is_active_profile()))`;
- have no insert, update or delete grants to any client role.

Every function in this sheet:
- is `SECURITY DEFINER`, owned by `postgres`, with `SET search_path = public, pg_temp`;
- starts with `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role, metabase_ro`.

Grants:
- Only the four public RPCs grant `EXECUTE` to `authenticated`.
- Helpers and the re-issued gate get no grant.

Every public RPC's first statement is `v_actor := public._product_parent_require_admin();`. The actor recorded anywhere is `v_actor`, never a parameter.

Every mutating RPC:
- takes `p_idempotency_key text DEFAULT NULL`;
- refuses a missing key (`IDEMPOTENCY_KEY_REQUIRED`);
- calls `_product_parent_replay(p_idempotency_key, '<rpc name>', v_fp)` before any lock, where `v_fp` is the md5 of a jsonb of every argument plus `actor_id`;
- ends with `save_idempotency(p_idempotency_key, '<rpc name>', v_result)`.

### 3.1 Tables (all new; one migration)

**`epa_lookups`** (the request)
- `id uuid` PK, default `gen_random_uuid()`.
- `parent_id uuid NOT NULL` FK `product_parents(id)`.
- `epa_registration text NOT NULL`. FK `epa_registrations(epa_registration)`, so the registration must exist; after the seed, every linked number has one.
- `link_kind text NOT NULL` in (`parent`, `size`, `parent_brand`, `legacy_brand`).
- `link_id uuid NOT NULL`. This is the parent, size, parent-brand or legacy-brand row ID.
- `registration_version bigint NOT NULL`. The registration's version at start.
- `chemistry_version bigint NOT NULL`. The parent's `product_parent_chemistry_state` version at start (0 when there is no state row).
- `status text NOT NULL DEFAULT 'pending'` in (`pending`, `recorded`, `abandoned`).
- `requested_by uuid NOT NULL`, `requested_at timestamptz NOT NULL DEFAULT now()`, `recorded_at timestamptz`.
- `CHECK ((status = 'recorded') = (recorded_at IS NOT NULL))`.
- Index on `(parent_id, epa_registration, requested_at DESC)`.

**`epa_lookup_failures`** (one per failed lookup; this is §7.8's binding)
- `id uuid` PK.
- `lookup_id uuid NOT NULL UNIQUE` FK `epa_lookups(id)`.
- `parent_id`, `epa_registration`, `link_kind`, `link_id`, `registration_version`. Copied from the lookup and never changed.
- `reason text NOT NULL` in (`not_found`, `transferred`, `upstream_error`, `invalid_result`).
- `transferred_to text`, with the strict REG-1 number CHECK. `CHECK ((reason = 'transferred') = (transferred_to IS NOT NULL))`.
- `detail text` (at most 500 characters): the EPA error message, or which shape rule failed.
- `created_by uuid NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`.
- Index on `(epa_registration, created_at DESC)`.
- Rows are never updated or deleted (a trigger refuses both). Whether a failure is still current is worked out by query (section 4.F), never by a flag.

**`epa_chemistry_proposals`**
- `id uuid` PK.
- `lookup_id uuid NOT NULL UNIQUE` FK `epa_lookups(id)`.
- `parent_id`, `epa_registration`, `link_kind`, `link_id`, `registration_version`, `chemistry_version`. Copied from the lookup.
- `status text NOT NULL DEFAULT 'proposed'` in (`proposed`, `held`, `committed`, `rejected`, `superseded`).
- `proposal_version bigint NOT NULL DEFAULT 1`. It goes up by 1 on every status change.
- `hold_reason text`, in (`relinked`, `chemistry_changed`, `registration_changed`). Required when held, else null.
- `items jsonb NOT NULL`. An array, built only by `record_epa_lookup` (section 3.4).
- `epa_summary jsonb NOT NULL`: `productname`, `manufacturer`, `regType`, `productStatus`, `isCancelled`, `needsManual`, `latestLabelPdfUrl`, the newest `labelPdfs` accepted date, and `base_label_note` (true for a distributor result).
- `decided_by uuid`, `decided_at timestamptz`, `decision_reason text` (at most 500 characters; required on reject).
- `commit_result jsonb`: what was written, confirmed or kept, per item.
- `created_by`, `created_at`.
- **One open proposal per number and parent:** a unique partial index on `(epa_registration, parent_id) WHERE status IN ('proposed', 'held')`.
- `CHECK ((status = 'held') = (hold_reason IS NOT NULL))`.
- `CHECK (status IN ('proposed', 'held', 'superseded') OR decided_at IS NOT NULL)`.

### 3.2 Status changes (enforced by an update trigger on the proposals table)

The trigger allows only these changes:
- `proposed` → `held` | `committed` | `rejected` | `superseded`
- `held` → `rejected` | `superseded`

`committed`, `rejected` and `superseded` are final. Any other change raises `EPA_PROPOSAL_STATUS`. Only `items`-free columns may change (status, version, hold reason, the decision columns and `commit_result`). `items` and the binding columns are frozen once inserted.

### 3.3 Locking

Every DM-4 function that reads or writes an EPA number or label facts takes the REG-1 advisory pair first:
- **Exclusive** `pg_advisory_xact_lock(20261210, hashtext('crx_epa_registration'))` in `commit_epa_proposal`.
- **Shared** in `start_epa_lookup` and `record_epa_lookup` (they read numbers and versions, and write only DM-4's own rows).

Row order after that, following REG-1 §3.2 and then the DM-1 chemistry lock:
1. the registration (`FOR UPDATE` in commit, `FOR SHARE` otherwise);
2. `_lock_parent_chemistry` (parent → member sizes → chemistry state → ingredient advisory lock);
3. brands `FOR SHARE` in ID order (only to re-check the parent link);
4. DM-4's own rows (lookup, then proposal).

DM-4 rows are last, because no other writer touches them. `reject_epa_proposal` locks only the proposal row and takes no advisory lock (it writes nothing outside DM-4).

### 3.4 Items and how they are sorted

`record_epa_lookup` builds the items under the shared lock, and `commit_epa_proposal` sorts them again under the exclusive lock. The commit's sort is the one that counts. Each item is `{item_id, kind, class, epa, current, accept_default}`.

**Ingredient items** (one per `activeIngredients` entry):
- The EPA value is the ingredient name; the CAS (kept only if it passes the CAS pattern `^[0-9]{2,7}-[0-9]{2}-[0-9]$`, else null with a note); and the strength (`percent` → `strength_value`, `strength_unit = 'pct_ww'`, `strength_basis = 'active_ingredient'`, or null when `percent` is null).
- **Matching to the parent's rows:**
  - By CAS first, against `active_ingredients.cas` of the parent's current rows.
  - With no CAS, by name (lower case, spaces collapsed) against the names of the parent's current rows.
  - Never against ingredients not on this parent (D-AA: never link by name).

| Class | When | Commit does |
|---|---|---|
| `add` | No matching row on the parent, and EPA gave a CAS | Passes an `add` entry to `_apply_parent_chemistry(…, 'epa', …)`. The resolver reuses or creates the ingredient by CAS. |
| `add_name_only` | No matching row, and no CAS | `accept_default = false`. Only if the admin ticks it: same as `add` (the resolver creates one provisional ingredient). |
| `fill` | Matched epa-sourced row with an unknown strength; EPA has a strength | Passes `add`; the writer fills the value. |
| `confirm` | Matched row with an equal strength (both unknown counts as equal) | Passes `add`; the writer does nothing. Recorded as confirmed. |
| `differs_typed` | Matched row with a source other than `epa_lookup` whose strength differs, including a typed unknown against an EPA value | Not passed. Shown as "you typed X; EPA says Y" (D-L). |
| `differs_epa` | Matched epa-sourced row whose strength differs | Not passed. Shown; the fix is DM-1's chemistry correction. |
| `missing_from_epa` | A parent row with no matching EPA ingredient (generated per row, not per EPA entry) | Not passed. Shown only. |

**Label-fact items** (one per fact, against the registration row):

| Fact | EPA value | Class rule |
|---|---|---|
| `signal_word` | `signalWordCanonical` (null → no item) | Registration null → `fill`; equal → `confirm`; else `differs` |
| `rup_status` | `rupYn`: `Yes` → `yes`, `No` → `no`, null → no item | Registration `unknown` → `fill`; equal → `confirm`; else `differs` |
| `registration_status` | `isCancelled` true → cancelled | Registration not cancelled and EPA says cancelled → `differs`, with a D-T warning ("EPA lists this registration as cancelled; record the date on the registration"). Nothing is written. Selling is not blocked (D-T). |
| `label_url`, `label_accepted_on` | `latestLabelPdfUrl` (https, `www3.epa.gov`), newest `labelPdfs.acceptedDate` | Registration null, or EPA's date is newer → `fill`; same → `confirm`; EPA older → `differs` |

A `differs` label fact is never written (D-L applies to registration facts as well). `checked_at` and `source = 'epa_lookup'` are written on any commit that writes or confirms at least one label fact.

---

## 4. DM-4 DB · The database PR

**File:** `supabase/migrations/<stamp>_epa_chemistry_proposals.sql`. The stamp is chosen at build. It must sort after `20261214100000` and after REG-DB step 2's stamp; check `docs/changelog.d/` and the sibling stamp claims first.

### 4.A `start_epa_lookup(p_parent_id uuid, p_epa_registration text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`

1. Admin check, key check and replay (scope `start_epa_lookup`).
2. Refuse `EPA_REGISTRATION_NOT_SEEDED` unless `_epa_registrations_seeded()` (REG-1 step 2).
3. Normalize the number with `_normalize_epa_registration` (the gate uses the same helper), then check the strict pattern. On no match, refuse `EPA_NUMBER_INVALID`.
4. Take the shared advisory pair. Lock the registration `FOR SHARE`; if it is missing, refuse `EPA_REGISTRATION_MISSING`.
5. Lock the parent `FOR SHARE`; if it is missing or inactive (`is_active` false), refuse `PARENT_NOT_FOUND`. Find the parent link in this fixed order: parent generic number, member size (lowest ID), active parent brand (lowest ID), legacy brand on a member size (lowest ID). If none, refuse `EPA_NUMBER_NOT_ON_PARENT`.
6. Mark earlier `pending` lookups for the same number and parent as `abandoned`.
7. Insert the lookup with the registration version and the chemistry version (0 when there is no state row).
8. Return `{lookup_id, epa_registration, link_kind, link_id, registration_version, chemistry_version}`.

### 4.B `record_epa_lookup(p_lookup_id uuid, p_result jsonb, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`

1. Admin check, key check and replay (scope `record_epa_lookup`).
2. Take the shared advisory pair. Lock the lookup `FOR UPDATE`. Refuse if it is missing (`EPA_LOOKUP_NOT_FOUND`), if it is not `pending` (`EPA_LOOKUP_NOT_PENDING`), or if it is more than 30 minutes old (`EPA_LOOKUP_EXPIRED`). A refused lookup records nothing; the screen starts a new one.
3. Refuse `EPA_RESULT_TOO_LARGE` if `octet_length(p_result::text) > 262144`.
4. **Shape check.** This mirrors `isEpaLookupResult` as changed by PR #1648, plus the database's own limits. Any failure here records a failure row with reason `invalid_result` and `detail` = the rule that failed; it never raises.
   - The result is an object.
   - **Error shape:** if `error` is present and is a non-empty string, record a failure with reason `upstream_error` and `detail` = the message cut to 500 characters. Stop here.
   - `found` is boolean.
   - `regType` is `section3` or `distributor`.
   - `eparegno`, `productname`, `manufacturer`, `productStatus` and `latestLabelPdfUrl` are each a string or null.
   - `signalWordCanonical` is null, `Danger`, `Warning` or `Caution`.
   - `needsManual` and `isCancelled` are boolean.
   - `rupYn` is null, `Yes` or `No`.
   - `activeIngredients` is an array (at most 50 entries). Each entry has a non-empty `name` (at most 200 characters); a `percent` that is null or a finite number greater than 0 and at most 100; and `pcCode` and `casNumber` that are each a string or null.
   - `labelPdfs` is an array (at most 200 entries). Each entry has a string `fileName`, an `acceptedDate` that is a string or null, and a string `url`.
   - `transferredTo` is absent, null, or a string, and a string only when `found` is false (PR #1648's rule). As a database limit, a string must also pass the strict number CHECK.
   - `latestLabelPdfUrl`, when present, starts with `https://www3.epa.gov/`.
   - When `found` is true, the normalized `eparegno` equals the lookup's number.
5. **Classify:**
   - `found` false with `transferredTo` → failure `transferred`, with `transferred_to`.
   - `found` false without it → failure `not_found`.
   - `found` true → build the items (section 3.4) and the `epa_summary`.
6. **On a proposal:** mark the existing open proposal for the same number and parent (if any) `superseded`. Then insert the new one. If every item is `confirm` (or there are no items), the proposal is still inserted, so "EPA agrees" is visible and the failure gate (4.F) sees a success.
7. **On a failure:** insert the failure row. Leave any open proposal untouched; an error never removes a good proposal.
8. Mark the lookup `recorded`. Return `{lookup_id, outcome: 'proposal' | 'failure', proposal_id | failure_id, reason?}`.

**Trust note.** The browser passes the result. A tampered result can only become a proposal, which an admin must commit (D-I). Every row records the actor. Calling EPA from inside the database, or having the Edge Function write the result, would need an Edge Function change with a service-role write path; that is Question 2.

### 4.C `commit_epa_proposal(p_proposal_id uuid, p_expected_proposal_version bigint, p_decisions jsonb, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`

`p_decisions` is an array of `{item_id, accept: boolean}`. An unknown `item_id` refuses `EPA_DECISION_UNKNOWN_ITEM`. An item not listed uses its `accept_default`. Accepting a difference item refuses `EPA_DECISION_NOT_WRITABLE`.

1. Admin check, key check and replay (scope `commit_epa_proposal`).
2. Read the proposal (no lock yet) to get the parent and number.
3. Take the exclusive advisory pair. Lock the registration `FOR UPDATE`.
4. Call `_lock_parent_chemistry(parent_id, NULL)`. Then lock the proposal `FOR UPDATE`.
   - Refuse `EPA_PROPOSAL_STALE` if `proposal_version <> p_expected_proposal_version`.
   - Refuse `EPA_PROPOSAL_NOT_OPEN` if the status is not `proposed`.
5. **Hold checks**, in this order. The first one that fails sets `held` with that reason, writes nothing else, saves the idempotency result and **returns** `{status: 'held', hold_reason}`. It does not raise, so the hold is kept.
   - **Relinked:** the stored `link_kind`/`link_id` no longer carries this number on this parent (same four places, re-read under the locks).
   - **Registration changed:** the registration's version is not the stored `registration_version`.
   - **Chemistry changed:** the chemistry state version is not the stored `chemistry_version`.
6. **Sort the items again** against the locked rows. If any accepted item's class differs from the stored class, set `held` (`chemistry_changed`) as in step 5. This cannot normally happen once the version checks pass; it is a backstop.
7. **Chemistry:** build `p_changes` from the accepted `add`, `add_name_only`, `fill` and `confirm` items only. Call `_apply_parent_chemistry(parent_id, p_changes, 'epa', 'EPA lookup proposal ' || p_proposal_id, jsonb_build_object('proposal_id', p_proposal_id, 'lookup_id', lookup_id, 'epa_registration', epa_registration))`. Skip the call if `p_changes` is empty.
8. **Label facts:** build the changes from the accepted label-fact `fill` and `confirm` items, plus `checked_at = now()` and `source = 'epa_lookup'`. Write them through **REG-1 step 2's internal registration writer**, the same one REG-1 §4.B step 4 uses for a draft commit. Pass the locked registration version as the expected version, and the reason `EPA lookup proposal <id>`. Use the `updated` event type; DM-4 adds no event type to REG-1's CHECK. The writer copies the facts to sizes and brands under its own pass, as REG-1 defines. Skip the call if there are no label changes.
9. Set the proposal to `committed`, with `decided_by`/`decided_at` and `commit_result` = per item: `written` | `confirmed` | `kept_difference` | `skipped`.
10. Return `{status: 'committed', proposal_id, chemistry_version, registration_version, counts}`.

Any raise from the chemistry or registration writer rolls back the whole commit. Step 6 makes a writer refusal a bug, not a normal path.

### 4.D `reject_epa_proposal(p_proposal_id uuid, p_expected_proposal_version bigint, p_reason text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`

1. Admin check, key check and replay (scope `reject_epa_proposal`).
2. Trim `p_reason`; it must be 1 to 500 characters, else refuse `EPA_REJECT_REASON_REQUIRED`.
3. Lock the proposal `FOR UPDATE`. Refuse `EPA_PROPOSAL_STALE` on a version mismatch, and `EPA_PROPOSAL_NOT_OPEN` unless it is `proposed` or `held`.
4. Set it to `rejected` with the decision columns. Return `{status: 'rejected', proposal_id}`.

### 4.E Read RPC

Screens read the three tables directly through RLS. They show who requested and committed each one by joining `profiles`, as the existing chemistry screens do. No read RPC is needed.

### 4.F Re-issued `_parent_chemistry_epa_refusal(p_parent_id uuid) RETURNS text`

Same name, signature, owner, `search_path`, and no grants (as live). It is re-issued from the live body (md5 `c64e2bee…`); the build checks that md5 first. It keeps its four-place number scan. A usable number is **excused** only when **all** of these hold:
- The most recent `recorded` lookup for (number, parent) has a failure row with reason `not_found`. An `upstream_error` or `invalid_result` is temporary and never excuses. A `transferred` number is fixed by REG-1's Change EPA number, not by typing chemistry.
- That failure's `registration_version` equals the registration's current version.
- That failure's `link_kind`/`link_id` still carries this number on this parent.
- There is no `proposed`, `held` or `committed` proposal for (number, parent) at all. A committed one means EPA already supplied chemistry; an open one means a success is waiting.

The refusal returns null (typing allowed) only when **every** usable number on the parent is excused. Otherwise it returns today's `CHEMISTRY_FROM_EPA_ONLY` message, with the first unexcused number named. This follows the DM-1 carried-gate note (sibling notes folder, `DM1-to-DM4-carried-gate-2026-11-06.md`).

### 4.G Files, harness, risks

The PR checklist is Stage 2 §3 rule 9:
- the migration with a postflight block that checks the grant and owner of every function and table in this sheet (pattern: `20261210100000`'s postflight);
- `docs/changelog.d/<date>-dm4-epa-proposals.md` and the `migrations.d` ledger record;
- `src/types/index.ts` types for the three rows and the RPC results;
- `docs/reference/rpc-functions.md` entries;
- `.claude/schema-registry.json` refreshed (status values for all three tables);
- the db-sweeps allowlist if a sweep flags the new SECURITY DEFINER functions;
- the harness `scripts/smoke/prove-epa-chemistry-proposals-real-schema.mjs` (section 6).

**Risks:**

| Risk | Handling |
|---|---|
| A commit that raises loses the admin's decisions | The commit re-sorts first (step 6); the screen keeps the decisions on refusal |
| Lock inversion with REG-1 writers | Same advisory pair and row order as REG-1 §3.2; harness case H9 |
| Duplicate provisional ingredients | Name-only results match parent rows first and are not ticked by default; harness case H5 |
| `percent` is not % w/w on the active-ingredient basis | Build check H11; if it fails, stop and re-plan with Mason |
| A browser-supplied result | Proposals need an admin commit; Question 2 |
| The `epa_lookups` table grows over time | It only gets bigger slowly (one row per click). Pruning is not needed now. |

---

## 5. DM-4 UI · The screens PR (after the DB PR is live)

- **Where:** the parent's Chemistry section (`src/components/products/ProductChemistrySection.tsx`) gets an **EPA lookup** panel. A Products-level **EPA lookups** page lists every number with its latest outcome. Admin only: a new `appPages.tsx` entry (Sol list: `src/appPages.tsx`).
- **Run lookup** (per number on the parent, or "all numbers" in sequence through the existing `waitForEpaRequestSlot` throttle):
  1. `start_epa_lookup`;
  2. `lookupEpaRegistration` (on error, pass `{error: message}`);
  3. `record_epa_lookup`.
  
  Every call uses `assertRpcResult`, and each call has its own idempotency key, kept for retries.
- **Proposal view:**
  - Chemistry items and label facts are shown side by side: current value, EPA value, class badge.
  - Add, fill and confirm items have a tick box (name-only unticked by default).
  - Difference items show both values and a link to the correction path: DM-1's correction for chemistry, the registration screen for label facts. They have no tick box.
  - A distributor result shows "Label facts come from the base registration".
  - A cancelled result shows the D-T warning.
  - **Commit** opens a `ConfirmModal` listing what will be written, then calls `commit_epa_proposal` with the version read. A `held` reply shows the hold reason and a **Run lookup again** button.
  - **Reject** needs a reason.
- **Failures list:** grouped by number, showing the reason, the moved-to number for `transferred` (with a link to REG-1's Change EPA number), and the time. After a `not_found` failure the chemistry section says "EPA has no record of this number; you can type chemistry".
- **Differences on the product page:** the latest committed proposal's `kept_difference` items appear under the chemistry table as "EPA says …" (D-L: shown, never written).
- Uses toasts, Lucide icons, Tailwind, Sentry through `src/lib/sentry`, and `docs/workflows/UI_PATTERNS.md`. Tests: screen tests for the three flows, plus a mocked-RPC test that a refused commit keeps the ticks.

---

## 6. Done when (harness cases)

The harness is `scripts/smoke/prove-epa-chemistry-proposals-real-schema.mjs`, run against a real-schema container (REG-1 step 2 applied and seeded with fixture rows). Each case runs the RPCs as an admin role and checks the rows afterwards.

| # | Case | Expect |
|---|---|---|
| H1 | Parent with a usable number: start, then record a found result | One proposal with items; nothing written to chemistry or the registration |
| H2 | Each brand registration on the parent | Each gets its own lookup and proposal (bound to `parent_brand`/`legacy_brand`) |
| H3 | Not-found, transferred, error, wrong-shape results | One failure row each, listed by number, with the reason, lookup ID, registration version and link; no proposal; chemistry and registration unchanged |
| H4 | Commit with add/fill/confirm ticked | Chemistry rows written with `source = 'epa_lookup'`; one chemistry `set` event; label facts written through the registration writer; registration version +1; sizes and brands mirror it |
| H5 | Two lookups with a name-only ingredient, committing both | The second matches the first's row (`confirm`); one provisional ingredient, not two |
| H6 | Typed chemistry that disagrees | `differs_typed`; commit keeps the typed value; `commit_result` says `kept_difference`; no raise |
| H7 | Relink, registration change, or chemistry change after the lookup | Commit returns `held` with the reason; nothing written; the hold persists |
| H8 | Re-lookup with an open proposal | Old one `superseded`; only one open per (number, parent) |
| H9 | Commit running while a REG-1 writer runs (two sessions) | One waits for the other; no deadlock |
| H10 | Gate: after `not_found` (current version, same link, no proposals) | `set_parent_chemistry` accepts typed chemistry; after an `upstream_error`, a later proposal, or a registration version change, it refuses again |
| H11 | `percent` basis | Five real payloads from different label types are compared with their PDF labels; all % w/w active ingredient (build check, not a container case) |
| H12 | Grants and replays | Non-admin refused on all four RPCs; anon has no execute; the same key replays the same result; the same key with other arguments refuses |
| H13 | Stale and closed | Wrong expected version → `EPA_PROPOSAL_STALE`; commit on rejected → `EPA_PROPOSAL_NOT_OPEN`; record on an expired lookup refuses |

The grand plan's "Done when" maps to H1–H4 and H6. After the DB PR is live, a read-only live check confirms the tables, grants and the gate md5, and that no proposal rows exist until the first real lookup.

---

## 7. Data items that come with DM-4

- **DATA-2** (missing EPA numbers, about 123 products): Mason reviews this before DM-4's first live lookup. A product with no number gets no lookup.
- **DATA-5, DATA-6, DATA-7** (grand plan): run as the first real lookups after the screens PR, one number at a time, through the screen. There is no bulk commit.

---

## 8. How the §7.8 open items are settled here

- **A failure row stores the lookup ID, registration version and parent link (DM-1/DM-1b):** `epa_lookup_failures` (section 3.1), used by the gate (4.F).
- **One open proposal per number and parent:** unique partial index (3.1).
- **A relink holds the proposal:** commit step 5.
- **D-L for typed values:** item classes (3.4). Differences are never passed to the writer.

---

## 9. Dependencies, overlap and order (checked read-only 2026-11-08)

| Needs | Why | State |
|---|---|---|
| **REG-1 step 2 (REG-DB)** | It provides the following, and **DM-4 uses each exactly as the REG-1 sheet defines it; nothing here re-designs step 2**:<br>• the seed and `_epa_registrations_seeded()` (start refuses until seeded);<br>• the working `set_epa_registration` and its **internal registration writer** (commit step 8);<br>• the guards that make sizes and brands mirror the registration;<br>• the advisory lock pair and row order | Waiting on Taha's #1524 (do not touch) |
| **REG-1 seed** (Mason-gated live step, REG-1 §5) | Every number must have a registration before a lookup can bind to its version | Not run |
| **DM-1** (live: `20261209100000`, `20261211100000`) | Chemistry tables, lock, writer, gate | Live; the build re-checks both md5s |
| **PR #1648** (`transferredTo`) and its `epa-lookup` deploy | Without it a moved number looks "found" with another number's facts; `record_epa_lookup` would then fail it as `invalid_result` (eparegno mismatch), which is safe but less clear | Open; deploy is Mason-gated |
| **PR #1653 / KI-30** (`20261214100000`, live but not on `main`) | Stamp order: DM-4's stamp sorts after it | Open |
| **DATA-2 review** | No lookups before the numbers are right | Mason |

**Not chosen:** shipping chemistry-only DM-4 before the REG-1 seed. That would bind proposals to no registration version, need a second commit path later, and let failures excuse the gate without a version. It saves nothing, because §8 already orders DM-4 after REG-1.

**Order:**
1. #1524 merges.
2. REG-DB step 2.
3. Mason approves the seed.
4. #1648 merges and Mason approves its deploy.
5. DATA-2 review.
6. DM-4 DB PR (Sol list: migration).
7. Live apply through the migration-apply gate.
8. DM-4 screens PR (Sol list: `src/appPages.tsx`).
9. First real lookups (DATA-5/6/7).

---

## 10. Steps that need Mason

1. **Deploy `epa-lookup` with #1648** (Edge Function deploy: Mason's explicit yes).
2. **REG-1 seed** (already Mason-gated in the REG-1 sheet).
3. **DATA-2 review:** confirm the missing EPA numbers before the first lookup.
4. **Proposal review:** committing proposals is admin work in the screen; Mason or an admin he names commits each one. Nothing is written without that click (D-I).
5. **Apply the DM-4 migration live.** It is non-destructive with routine grants, so it goes through the normal apply gate with Sol proofs. If the gate classifies it otherwise, it needs Mason's yes.

---

## 11. Questions for Mason

1. **Name-only ingredients** (EPA gives a name but no CAS number): the plan leaves them **unticked**, so the admin must tick each one to create a new ingredient. Recommended. The alternative is ticking them by default, which is faster but risks duplicates.
2. **Who sends EPA's answer to the database:** the plan keeps the browser passing EPA's result to the database, and an admin must still approve every proposal. Recommended, because it needs no Edge Function rewrite. The alternative is having the Edge Function write the result itself; that is safer against a tampered browser, but it is a bigger change with its own deploy.
3. **Typing chemistry after "not found":** the plan lets an admin type chemistry only when EPA says the number does not exist. Recommended. It does not allow typing after a temporary EPA error.

---

## 12. Review record

(Filled in by the Luna rounds below.)
