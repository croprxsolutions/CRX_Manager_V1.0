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
- have one `SELECT` policy for admins only, `TO authenticated USING ((SELECT public.is_admin()))`, because the screens are admin-only and an uncommitted proposal is not for other users;
- `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role, metabase_ro`, then `GRANT SELECT … TO authenticated` (the policy limits it to admins); `epa_lookups` also gets `GRANT SELECT … TO service_role`, because the Edge Function reads the lookup row with its service-role client (4.B), and bypassing RLS does not bypass table privileges;
- have no insert, update or delete grants to any client role.

Every function in this sheet:
- is `SECURITY DEFINER`, owned by `postgres`, with `SET search_path = public, pg_temp`;
- starts with `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role, metabase_ro`.

Grants:
- `start_epa_lookup`, `commit_epa_proposal` and `reject_epa_proposal` grant `EXECUTE` to `authenticated`.
- `record_epa_lookup` grants `EXECUTE` to `service_role` **only**. No browser can call it; only the `epa-lookup` Edge Function can (section 4.B).
- Helpers and the re-issued gate get no grant.

The first statement of the three browser RPCs is `v_actor := public._product_parent_require_admin();`. The actor recorded anywhere is `v_actor`, never a parameter. The one exception is `record_epa_lookup`, which the Edge Function calls with the service role, so `auth.uid()` is empty there. It takes no actor parameter: it records the lookup's `requested_by` (written from `auth.uid()` by `start_epa_lookup`) and refuses unless that profile is still an active admin. The Edge Function separately refuses a caller who is not `requested_by` (section 4.B step 2).

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
- `requested_by uuid NOT NULL`, `requested_at timestamptz NOT NULL DEFAULT now()`, `recorded_at timestamptz`, `updated_at timestamptz NOT NULL DEFAULT now()` (set on every status change, including `abandoned`).
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
- `created_by`, `created_at`, `updated_at timestamptz NOT NULL DEFAULT now()` (set on every status change, including `held` and `superseded`; a superseded proposal also records `superseded_by_lookup_id uuid`).
- **One open proposal per number and parent:** a unique partial index on `(epa_registration, parent_id) WHERE status IN ('proposed', 'held')`.
- `CHECK ((status = 'held') = (hold_reason IS NOT NULL))`.
- `CHECK (status IN ('proposed', 'held', 'superseded') OR decided_at IS NOT NULL)`.

### 3.2 Status changes (enforced by an update trigger on the proposals table)

The trigger allows only these changes:
- `proposed` → `held` | `committed` | `rejected` | `superseded`
- `held` → `rejected` | `superseded`

`committed`, `rejected` and `superseded` are final. Any other change raises `EPA_PROPOSAL_STATUS`. Only these columns may change: `status`, `proposal_version`, `hold_reason`, `decided_by`, `decided_at`, `decision_reason`, `commit_result`, `updated_at` and `superseded_by_lookup_id`. `items` and the binding columns are frozen once inserted.

### 3.3 Locking

Every DM-4 function that reads or writes an EPA number or label facts takes the REG-1 advisory pair first:
- **Exclusive** `pg_advisory_xact_lock(20261210, hashtext('crx_epa_registration'))` in `commit_epa_proposal`.
- **Shared** in `start_epa_lookup` and `record_epa_lookup` (they read numbers and versions, and write only DM-4's own rows). Both also lock the parent row `FOR UPDATE`, so starts and records for one parent run one at a time (step 2 below).

Row order after that, following REG-1 §3.2 and then the DM-1 chemistry lock:
1. the registration (`FOR UPDATE` in commit, `FOR SHARE` otherwise);
2. in commit, `_lock_parent_chemistry` (parent → member sizes → chemistry state → ingredient advisory lock); in `record_epa_lookup`, the parent row `FOR UPDATE` (the same first step), so two results for the same parent run one after the other and cannot both see "no open proposal" and collide on the unique index;
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
  - **Within one result first:** entries with the same CAS, or (with no CAS) the same normalized name, are merged into one item before matching. If the merged entries' strengths differ, the item's class is `epa_conflict` (not writable, shown), so the resolver is never called twice for one ingredient.

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
| `rup_status` | `rupYn`: `Yes` → `yes`, `No` → `no`, null → no item | Registration `unknown` → `fill`; equal → `confirm`; registration `no` and EPA `yes` → `rup_upgrade` (writable, `accept_default = false`; Mason 2026-11-11, "Yes, tickable"; a commit that ticks it lists the posted sales that now need records, as H20); else `differs` |
| `registration_status` | `isCancelled` | Registration `unknown` → `differs` with EPA's answer as the note (Luna 2026-11-11; every live registration is `unknown` today). Both agree → `matches` (shown, never written). Registration not cancelled and EPA says cancelled → `differs`, with a D-T warning ("EPA lists this registration as cancelled; record the date on the registration"). Registration cancelled and EPA says not cancelled → `differs` ("EPA lists this registration as active"). Nothing is written either way (the lookup has no cancellation date). Selling is not blocked (D-T). |
| `label_document` (one item: `label_accepted_on` and `label_url` together) | **One `labelPdfs` entry** supplies both: the entry with the newest valid `acceptedDate` (ties: the first in EPA's list), and its own `url` (must start `https://www3.epa.gov/`). `latestLabelPdfUrl` is not used for this pair, because the function picks it by the file-name date, which can be a different document. Only if no entry has a valid date: `latestLabelPdfUrl` with no date. | **One tick box for both**, so the admin can never accept the URL without its date or the date without its URL. The class is worked out date first. Date: registration date null or EPA's date newer → `fill`; same → `confirm`; EPA older → `differs` (never written, so an older EPA date never replaces a newer one). URL: a null EPA URL is never written (the date is then written alone). A non-null URL is written only together with a date `fill` (the link belongs to that label), or as a `fill` on its own when both the registration's URL and EPA's date are null; otherwise equal → `confirm`, different → `differs`. A date counts only if it parses to a real calendar date (`YYYY-MM-DD` or `MM/DD/YYYY`, round-tripped through `to_date`; the build confirms the format on real payloads). Unparseable dates are ignored and named in the item's note, so a bad date can never reach the registration writer. |

A `differs` label fact is never written (D-L applies to registration facts as well). `checked_at` and `source = 'epa_lookup'` are written on any commit that writes or confirms at least one label fact.

---

## 4. DM-4 DB · The database PR

**File:** `supabase/migrations/<stamp>_epa_chemistry_proposals.sql`. The stamp is chosen at build. It must sort after `20261214100000` and after REG-DB step 2's stamp; check `docs/changelog.d/` and the sibling stamp claims first.

### 4.A `start_epa_lookup(p_parent_id uuid, p_epa_registration text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`

1. Admin check, key check and replay (scope `start_epa_lookup`).
2. Refuse `EPA_REGISTRATION_NOT_SEEDED` unless `_epa_registrations_seeded()` (REG-1 step 2).
3. Normalize the number with `_normalize_epa_registration` (the gate uses the same helper), then check the strict pattern. On no match, refuse `EPA_NUMBER_INVALID`.
4. Take the shared advisory pair. Lock the registration `FOR SHARE`; if it is missing, refuse `EPA_REGISTRATION_MISSING`.
5. Lock the parent `FOR UPDATE` (the first step of the DM-1 order, so no inversion with commit); if it is missing or inactive (`is_active` false), refuse `PARENT_NOT_FOUND`. Find the parent link in this fixed order: parent generic number, member size (lowest ID), active parent brand (lowest ID), legacy brand on a member size (lowest ID). If none, refuse `EPA_NUMBER_NOT_ON_PARENT`.
6. Mark earlier `pending` lookups for the same number and parent as `abandoned`.
7. Insert the lookup with the registration version and the chemistry version (0 when there is no state row).
8. Return `{lookup_id, epa_registration, link_kind, link_id, registration_version, chemistry_version}`.

### 4.B `record_epa_lookup(p_lookup_id uuid, p_result jsonb, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`

**Who calls it: only the `epa-lookup` Edge Function.** The browser never sends EPA's answer to the database, so an admin cannot type a fake "EPA result" and then commit it as `epa_lookup` chemistry (D-Z). The flow:
1. The screen calls `start_epa_lookup` and gets a `lookup_id`.
2. The screen calls `epa-lookup` with `{lookupId}`. When `lookupId` is present, the function ignores any `regNumber`: it reads the lookup row with its service-role client, refuses unless its `requested_by` is the verified caller, and then:
   - if the row is `pending`, fetches EPA for **the stored number**;
   - if the row is already `recorded` (a retry after a lost reply), does **not** fetch EPA again and calls `record_epa_lookup` with the same key and `p_result = '{}'`. The replay in step 1 runs before any status or shape check and returns the first saved result;
   - if the row is `abandoned`, refuses. So a failure (or success) can never be recorded against a number other than the one the lookup was started for.
3. **Only when `lookupId` is present**, the function requires an admin (`requireActiveProfile(…, ['admin'])`). A call without `lookupId` keeps today's check (any active user), so existing screens are unchanged for non-admins. It fetches EPA, then calls `record_epa_lookup` with its service-role client, passing:
   - no actor: the database records the lookup's `requested_by` (the caller step 2 already matched to it). An actor parameter was dropped on 2026-11-11, because the rls-security reviewer flags any caller-supplied actor the database cannot bind to `auth.uid()`;
   - `p_result` = the exact `EpaLookupResult` it built, or `{error}` when the EPA fetch failed;
   - `p_idempotency_key` = `'epa-record:' || lookupId`, so a retry replays.
4. The function returns its usual result plus `{record: <the RPC result>}`.

A call without `lookupId` behaves as today and records nothing, so the other screens that use the lookup keep working. This function change ships with the DM-4 screens PR and needs a Mason-approved deploy (section 10).

1. Key check and replay (scope `record_epa_lookup`). It **cannot** use `_product_parent_replay`, because that helper compares the saved `actor_id` with `auth.uid()`, and `auth.uid()` is empty under the service role (`20261108120000:501-503`). Instead it does the same steps by hand: refuse a missing key; take `pg_advisory_xact_lock(hashtext('crx.product_parent:record_epa_lookup:' || key))`; read `check_idempotency(key, 'record_epa_lookup')`; and replay only when the saved `request_fingerprint` (of the lookup ID) matches, else refuse `IDEMPOTENCY_PAYLOAD_MISMATCH`. The result saved through `save_idempotency` uses the same envelope (`actor_id` = the lookup's `requested_by`, `request_fingerprint`, `response`). The fingerprint is md5 of `{lookup_id}` only, **not** `p_result`: the first recorded answer for a lookup wins, and a retry with a different EPA answer replays the saved result instead of refusing. (A fresh answer needs a new lookup.)
2. Take the shared advisory pair. Lock the registration `FOR SHARE`, then the parent `FOR UPDATE`, then the lookup `FOR UPDATE`.
   - **Newest lookup only:** if a later lookup exists for the same number and parent (by `requested_at`, then `id`), refuse `EPA_LOOKUP_SUPERSEDED` (it is already `abandoned`: the newer start marked it). Because start and record both hold the parent lock, an older lookup can never be recorded after a newer one starts, and its proposal can never be left open over a newer result.
   - The actor is the lookup's `requested_by`; refuse `EPA_LOOKUP_ACTOR` unless that profile is still active with role `admin`. Refuse if it is missing (`EPA_LOOKUP_NOT_FOUND`), if it is not `pending` (`EPA_LOOKUP_NOT_PENDING`), or if it is more than 30 minutes old (`EPA_LOOKUP_EXPIRED`). A refused lookup records nothing; the screen starts a new one.
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
6. **On a proposal:** mark the existing open proposal for the same number and parent (if any) `superseded`, setting `superseded_by_lookup_id` and `updated_at`. Then insert the new one. If every item is `confirm` (or there are no items), the proposal is still inserted, so "EPA agrees" is visible and the failure gate (4.F) sees a success.
7. **On a failure:** insert the failure row. Leave any open proposal untouched; an error, a bad shape or a not-found never removes a good proposal. A `transferred` result supersedes the open proposal (by this lookup), because EPA says the number moved and its facts are stale (Sol, 2026-11-11).
8. Mark the lookup `recorded`. Return `{lookup_id, outcome: 'proposal' | 'failure', proposal_id | failure_id, reason?}`.

**Trust note.** EPA's answer travels only from the Edge Function to the database, under the service role. A browser cannot call `record_epa_lookup`, so it cannot submit a made-up result. The shape check still runs, as a guard against a function bug. Every proposal still needs an admin commit (D-I).

### 4.C `commit_epa_proposal(p_proposal_id uuid, p_expected_proposal_version bigint, p_decisions jsonb, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`

`p_decisions` is an array of `{item_id, accept: boolean}`. An unknown `item_id` refuses `EPA_DECISION_UNKNOWN_ITEM`. An item not listed uses its `accept_default`. Accepting a difference item refuses `EPA_DECISION_NOT_WRITABLE`.

1. Admin check, key check and replay (scope `commit_epa_proposal`).
2. Read the proposal (no lock yet) to get the parent and number.
3. Take the exclusive advisory pair. Lock the registration `FOR UPDATE`.
4. Call `_lock_parent_chemistry(parent_id, <version read in step 2>)` (it refuses NULL; a typed save in between raises `CHEMISTRY_STALE`, safe, and a retry holds). Then lock the proposal `FOR UPDATE`.
   - Refuse `EPA_PROPOSAL_STALE` if `proposal_version <> p_expected_proposal_version`.
   - Refuse `EPA_PROPOSAL_NOT_OPEN` if the status is not `proposed`.
5. **Hold checks**, in this order. The first one that fails sets `held` with that reason, writes nothing else, saves the idempotency result and **returns** `{status: 'held', hold_reason}`. It does not raise, so the hold is kept.
   - **Relinked:** the stored `link_kind`/`link_id` no longer carries this number on this parent (same four places, re-read under the locks).
   - **Registration changed:** an accepted label item, re-sorted against the registration now, is neither unchanged nor a `confirm` (Taha, 2026-11-11: compare facts, not `registration_version`, because another product's commit of the same number bumps the version without changing a fact). Checked before chemistry.
   - **Chemistry changed:** the chemistry state version is not the stored `chemistry_version`.
6. **Sort the items again** against the locked rows. If any accepted item's class differs from the stored class, set `held` (`chemistry_changed`) as in step 5. This cannot normally happen once the version checks pass; it is a backstop.
7. **Chemistry:** build `p_changes` from the accepted `add`, `add_name_only`, `fill` and `confirm` items only. Call `_apply_parent_chemistry(parent_id, p_changes, 'epa', 'EPA lookup proposal ' || p_proposal_id, jsonb_build_object('proposal_id', p_proposal_id, 'lookup_id', lookup_id, 'epa_registration', epa_registration))`. Skip the call if `p_changes` is empty.
8. **Label facts:** build the changes from the accepted label-fact `fill` and `confirm` items, plus `checked_at = now()` and `source = 'epa_lookup'`. Write them through **REG-1 step 2's internal registration writer**, the same one REG-1 §4.B step 4 uses for a draft commit. Pass the locked registration version as the expected version, and the reason `EPA lookup proposal <id>`. Use the `updated` event type; DM-4 adds no event type to REG-1's CHECK. Nothing is copied to sizes or brands (REG-1 simplified, 2026-11-09; see the settlement note). Skip the call if there are no label changes.
9. Set the proposal to `committed`, with `decided_by`/`decided_at` and `commit_result` = per item: `written` | `confirmed` | `kept_difference` | `skipped` (a status that `matches` EPA is `confirmed`).
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
- The most recent lookup for (number, parent) that is not `abandoned` (so a newer `pending` lookup counts and cancels the excuse until it is recorded) has a failure row with reason `not_found`. An `upstream_error` or `invalid_result` is temporary and never excuses. A `transferred` number is fixed by REG-1's Change EPA number, not by typing chemistry.
- That failure's `registration_version` equals the registration's current version.
- That failure's `link_kind`/`link_id` still carries this number on this parent.
- There is no proposal for (number, parent) at all, in any status (security review 2026-11-11, M2: once EPA has found the number, a later empty answer is treated as temporary). A pending lookup older than 30 minutes is ignored, since it can never be recorded.

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
| A made-up EPA result | Only the Edge Function (service role) can record a result; harness case H14 |
| The `epa_lookups` table grows over time | It only gets bigger slowly (one row per click). Pruning is not needed now. |

---

## 5. DM-4 UI · The screens PR (after the DB PR is live)

- **Where:** the parent's Chemistry section (`src/components/products/ProductChemistrySection.tsx`) gets an **EPA lookup** panel. A Products-level **EPA lookups** page lists every number with its latest outcome. Admin only: a new `appPages.tsx` entry (Sol list: `src/appPages.tsx`).
- **Run lookup** (per number on the parent, or "all numbers" in sequence through the existing `waitForEpaRequestSlot` throttle):
  1. `start_epa_lookup` (with `assertRpcResult` and its own idempotency key, kept for retries);
  2. `lookupEpaRegistration(regNumber, …, lookupId)`. The Edge Function records the result itself (section 4.B) and returns `record`; the screen never calls `record_epa_lookup`.

  **Request ownership:** while a lookup for a number is in flight, its Run button is disabled. The screen keeps the latest `lookup_id` per number and ignores any reply (success or error) whose `lookup_id` is not the latest, so a slow older reply can never replace a newer result on screen. After each reply, the screen re-reads the rows from the database rather than trusting the reply; each re-read carries the `lookup_id` that triggered it and is dropped if a newer lookup has started for that number.

  **Commit and reject:** the buttons are disabled while the request runs. The idempotency key is made when the admin confirms and kept until a confirmed reply, so a retry after a lost reply reuses it and replays the saved result instead of hitting `EPA_PROPOSAL_NOT_OPEN`.
- **Proposal view:**
  - Chemistry items and label facts are shown side by side: current value, EPA value, class badge.
  - Add, fill and confirm items have a tick box (name-only unticked by default).
  - Difference items show both values and a link to the correction path: DM-1's correction for chemistry, the registration screen for label facts. They have no tick box.
  - A distributor result shows "Label facts come from the base registration".
  - A cancelled result shows the D-T warning.
  - **Commit** opens a `ConfirmModal` listing what will be written, then calls `commit_epa_proposal` with the version read. A `held` reply shows the hold reason and a **Run lookup again** button.
  - **Reject** needs a reason.
- **Failures list:** grouped by number, showing the reason, the moved-to number for `transferred` (with a link to REG-1's Change EPA number), and the time. The chemistry section says "EPA has no record of this number; you can type chemistry" only when the gate's whole rule (4.F) holds for every number on the parent, including no proposed, held or committed proposal. Otherwise it says which proposal is waiting or committed. The database gate stays the authority; the screen only mirrors it.
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
| H4 | Commit with add/fill/confirm ticked | Chemistry rows written with `source = 'epa_lookup'`; one chemistry `set` event; label facts written through the registration writer; registration version +1; sizes and brands are not touched (REG-1 simplified) |
| H5 | Two lookups with a name-only ingredient, committing both | The second matches the first's row (`confirm`); one provisional ingredient, not two |
| H6 | Typed chemistry that disagrees | `differs_typed`; commit keeps the typed value; `commit_result` says `kept_difference`; no raise |
| H7 | Relink, registration change, or chemistry change after the lookup | Commit returns `held` with the reason; nothing written; the hold persists |
| H8 | Re-lookup with an open proposal | Old one `superseded`; only one open per (number, parent) |
| H9 | Commit running while a REG-1 writer runs (two sessions) | One waits for the other; no deadlock |
| H10 | Gate: after `not_found` (current version, same link, no proposals) | `set_parent_chemistry` accepts typed chemistry; after an `upstream_error`, a later proposal, or a registration version change, it refuses again |
| H11 | `percent` basis | Five real payloads from different label types are compared with their PDF labels; all % w/w active ingredient (build check, not a container case) |
| H12 | Grants and replays | Non-admin refused on all four RPCs; anon has no execute; the same key replays the same result; the same key with other arguments refuses |
| H13 | Stale and closed | Wrong expected version → `EPA_PROPOSAL_STALE`; commit on rejected → `EPA_PROPOSAL_NOT_OPEN`; record on an expired lookup refuses |
| H14 | Provenance | `authenticated` (even an admin) cannot execute `record_epa_lookup`; `service_role` records as the lookup's requester and refuses `EPA_LOOKUP_ACTOR` when that admin is no longer active. Edge Function test: a call with `lookupId` records once; a retry replays |
| H15 | Two results for the same parent at once (two sessions) | The second waits on the parent lock, then supersedes the first; no unique-index error |
| H16 | Bad `acceptedDate`; EPA "active" against a cancelled registration | The date is ignored with a note and the commit succeeds; the status shows as a `differs` item |
| H18 | Older lookup recorded after a newer start | Refused `EPA_LOOKUP_SUPERSEDED`; the older lookup is `abandoned`; no proposal from it |
| H19 | Record retry with a different result | Replays the first result; no second row |
| H17 | Read access | A non-admin active user reads 0 rows from all three tables |

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
| **REG-1 step 2 (REG-DB)** | It provides the following, and **DM-4 uses each exactly as the REG-1 sheet defines it; nothing here re-designs step 2**:<br>• the seed and `_epa_registrations_seeded()` (start refuses until seeded);<br>• the working `set_epa_registration` and its **internal registration writer** (commit step 8);<br>• (cut 2026-11-09: sizes and brands no longer mirror the registration);<br>• the advisory lock pair and row order | Waiting on Taha's #1524 (do not touch) |
| **REG-1 seed** (Mason-gated live step, REG-1 §5) | Every number must have a registration before a lookup can bind to its version | Not run |
| **DM-1** (live: `20261209100000`, `20261211100000`) | Chemistry tables, lock, writer, gate | Live; the build re-checks both md5s |
| **PR #1648** (`transferredTo`) and its `epa-lookup` deploy | Without it a moved number looks "found" with another number's facts; `record_epa_lookup` would then fail it as `invalid_result` (eparegno mismatch), which is safe but less clear | Open; deploy is Mason-gated |
| **PR #1653 / KI-30** (`20261214100000`, live but not on `main`) | Stamp order: DM-4's stamp sorts after it. Migration stamps in this repo are ordering numbers set ahead of the calendar, not the date written; `20261214…` being later than today is expected. | Open |
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
8. DM-4 screens PR (Sol list: `src/appPages.tsx`) with the `epa-lookup` record step; Mason approves that deploy.
9. First real lookups (DATA-5/6/7).

---

## 10. Steps that need Mason

1. **Deploy `epa-lookup` with #1648** (Edge Function deploy: Mason's explicit yes).
2. **Deploy `epa-lookup` again with the DM-4 record step** (section 4.B), after the DM-4 migration is live and with the screens PR (Edge Function deploy: Mason's explicit yes).
3. **REG-1 seed** (already Mason-gated in the REG-1 sheet).
4. **DATA-2 review:** confirm the missing EPA numbers before the first lookup.
5. **Proposal review:** committing proposals is admin work in the screen; Mason or an admin he names commits each one. Nothing is written without that click (D-I).
6. **Apply the DM-4 migration live.** It is non-destructive with routine grants, so it goes through the normal apply gate with Sol proofs. If the gate classifies it otherwise, it needs Mason's yes.

---

## 11. Questions for Mason

1. **Name-only ingredients** (EPA gives a name but no CAS number): the plan leaves them **unticked**, so the admin must tick each one to create a new ingredient. Recommended. The alternative is ticking them by default, which is faster but risks duplicates.
2. **Typing chemistry after "not found":** the plan lets an admin type chemistry only when EPA says the number does not exist. Recommended. It does not allow typing after a temporary EPA error.

---

## 12. Review record

**Luna round 1** (`gpt-6-luna` xhigh, head `18c090e13`): 1 HIGH, 6 MED, 1 LOW. All handled in the next commit:
- HIGH: a browser could submit a made-up EPA result and commit it as EPA chemistry. **Fixed:** `record_epa_lookup` is now service-role only and is called by the `epa-lookup` Edge Function with the verified caller (4.B, H14). The former Question 2 is withdrawn.
- MED: active non-admins could read proposals, and no SELECT grant was named. **Fixed:** admin-only policy plus an explicit grant (section 3, H17).
- MED: two results for the same parent could collide on the unique index. **Fixed:** record locks the parent `FOR UPDATE` (3.3, H15).
- MED: no timestamp on status changes. **Fixed:** `updated_at` on lookups and proposals, plus `superseded_by_lookup_id`.
- MED: `acceptedDate` was not checked as a date. **Fixed:** only real dates count (3.4, H16).
- MED: "EPA says active" against a cancelled registration made no item. **Fixed:** it is now a `differs` item.
- MED: stale screen replies. **Fixed:** request ownership in section 5.
- LOW: the stamp `20261214100000` is later than the check date. **Refuted:** stamps are ordering numbers set ahead of the calendar (noted in section 9).

**Luna round 2** (head `d4de117ac`): 3 HIGH, 3 MED. All fixed in the next commit:
- HIGH: an older lookup could be recorded after a newer one started. **Fixed:** start and record both lock the parent `FOR UPDATE`, and record refuses `EPA_LOOKUP_SUPERSEDED` for any lookup that is not the newest (4.B, H18).
- HIGH: the admin-only Edge Function check would block non-admins on existing screens. **Fixed:** the admin check applies only to calls with `lookupId`.
- HIGH: the status trigger's column list left out `updated_at` and `superseded_by_lookup_id`. **Fixed** (3.2).
- MED: a retry with a different EPA answer would conflict with its own key. **Fixed:** the record fingerprint is the lookup and the actor only; the first answer wins (H19).
- MED: an older EPA date could overwrite a newer one through the combined URL/date item. **Fixed:** date and URL are classified separately; an older date is a difference.
- MED: the "you can type chemistry" message could contradict the gate. **Fixed:** the screen mirrors the gate's whole rule.

**Luna round 3** (head `6dcf844f3`): no BLOCKER or HIGH; 4 MED, 1 LOW, all fixed in one findings-only commit (no rule file touched, so no whole-branch rerun under the codex-review rule):
- MED: a newer date with a null EPA URL could clear the stored URL. **Fixed:** a null EPA URL is never written.
- MED: a newer pending lookup did not cancel an older `not_found` excuse. **Fixed:** the gate reads the newest non-abandoned lookup (4.F).
- MED: a slow re-read could overwrite newer screen state. **Fixed:** re-reads carry their `lookup_id` and stale ones are dropped.
- MED: commit/reject retries with a new key. **Fixed:** buttons disabled in flight; the key is kept until a confirmed reply.
- LOW: two entries for one ingredient in one EPA result. **Fixed:** merged before matching; differing strengths become a non-writable `epa_conflict` item.

**Codex GitHub App review, third pass** (head `1ba715116`): 1 P2, fixed:
- The newest date and `latestLabelPdfUrl` could come from different PDFs. **Fixed:** both now come from the single `labelPdfs` entry with the newest valid date.

**Codex GitHub App review, second pass** (head `1d0961934`): 2 P2 findings, both fixed:
- The Edge Function could not read `epa_lookups` because `service_role` had no SELECT grant. **Fixed:** `GRANT SELECT` on `epa_lookups` to `service_role` (section 3).
- A retry after a lost reply hit the `pending` check before it could replay. **Fixed:** for a `recorded` lookup the function skips EPA and calls the record RPC with the same key, and the replay runs first (4.B).

**Codex GitHub App review** (head `511676768`): 3 P2 findings, all fixed:
- `_product_parent_replay` compares the saved actor with `auth.uid()`, which is empty under the service role, so a retry would refuse. **Fixed:** `record_epa_lookup` does the same replay steps by hand and checks against `p_actor` (4.B step 1).
- The Edge Function took `regNumber` separately from `lookupId`, so a failure could be recorded against the wrong number. **Fixed:** with `lookupId` the function reads the number from the lookup row and checks the requester first.
- Date and URL could be accepted separately. **Fixed:** they are now one `label_document` item with one tick box.

---

## 13. Behavior contract for the build (2026-11-11)

This sheet is the settled contract; it went through three Luna rounds and four Codex App passes. The build starts from `main` `822d783de` and the live database read on 2026-11-11 (read-only). Only what changed since 2026-11-08 is listed here.

**Facts now (live, read-only, 2026-11-11):**
- REG-1 step 2 and its seed are live: `epa_registrations` has 347 rows; `epa_registration_seed_run` has its row; the seed migration `20261231220000` is applied.
- REG-1 step 2 was cut down on 2026-11-09 (Mason: "Drop them"): a registration's facts are **not** copied to sizes or brands. The registration writer is `_epa_registration_facts` (checks keys and types), `_epa_registration_update` (writes the keys given, version +1, `updated_by = auth.uid()`) and `_epa_registration_event(…, 'updated', …)`, called under the exclusive REG-1 lock with the row `FOR UPDATE`, exactly as `set_epa_registration` does.
- DM-1 is live. DM-1b is live (`20270103160000_setup_workbook_chemistry_tabs`, PR #1776) and calls `_parent_chemistry_epa_refusal` for its workbook chemistry gate.
- `_parent_chemistry_epa_refusal` live body equals `20261209100000`'s: `md5(replace(prosrc, chr(13), ''))` is still `c64e2bee1c7499cf6ff509168885a0f9`, which the preflight pins.
- 456 product parents; 0 parent ingredient rows; 0 active ingredients. No typed chemistry exists yet.
- `epa-lookup` is live at version 9, which includes #1648 (`transferredTo`).

**Changes to the sheet, all from those facts:**
1. **Commit step 8** writes label facts with the three REG-1 helpers above (no copy pass). H4 checks the registration row and one `updated` event; it no longer checks sizes or brands.
2. **Re-issued gate (4.F)** also governs DM-1b's workbook, since DM-1b calls it. That is intended: the grand plan lets a number that EPA does not know be entered through the reviewed manual path.
3. **Order (section 9):** steps 1–4 are done. The DATA-2 review gates the **first live lookup**, not the build.
4. **Questions (section 11):** the build uses both recommendations (name-only ingredients unticked; typing allowed only after "not found"). Posted to Mason as the plan; he can redirect.
5. **Commit can still raise** when DM-1's own checks refuse the result (for example, ingredients that outweigh a liquid's approved weight per gallon). That rolls the whole commit back; the screen keeps the ticks.

**Delivery:** DB PR first (`20270105110000_epa_chemistry_proposals.sql`), compatible with the deployed app (it adds tables and functions and re-issues the gate; nothing calls the new functions until the screens PR). Then the screens PR plus the `epa-lookup` record step, whose deploy needs Mason's typed approval.

### 13.1 Cold challenge (Astra `gpt-6-astra` high, 2026-11-11): 19 findings, how each is settled

Live facts read for it (read-only, 2026-11-11): every one of the 347 registrations has `rup_status` `no` (322) or `yes` (25), never `unknown`; 205 have a signal word; none has a label date or link; all are `registration_status = 'unknown'`. 347 distinct numbers are linked to products, every one has a registration, none is malformed. `main` now contains DM-1b (#1776, `eda8b1597`).

| # | Label | Settled by |
|---|---|---|
| 1 | DEFECT | **Fixed.** When a commit turns `rup_status` to `yes`, the result carries `posted_sales_to_record` from `_epa_registration_unrecorded_posted_lines`, exactly as `set_epa_registration` does; it sits in the saved receipt, so a replay returns it. Proof case H20. |
| 2 | DECISION | Already decided: REG-1 simplification (DECISION_LOG, Mason 2026-11-09, "Drop them"): sizes and brands keep their own facts, posting reads registrations. DM-4's screens say "registration updated", never "product updated". |
| 3 | MISSING-EVIDENCE | Disproved: DM-4 changes no ordinary-user surface. Its three tables are admin-read only; no existing policy, grant or read path changes (postflight checks). |
| 4 | DEFECT | Corrected: a number without a registration is refused at start with `EPA_REGISTRATION_MISSING` ("add it on the registration screen"). The existing `set_epa_registration` create mode (expected version NULL) is the recovery, then look up again. Today all 347 linked numbers have one. Proof case H21. |
| 5 | DEFECT | Corrected: REG-1's assign tools were dropped. Recovery for `transferred` is: change the number on the size, brand or parent in the existing product edit (no guards since 2026-11-09), create the new number's registration if missing, look up the new number. The failure row shows the new number. |
| 6 | MISSING-EVIDENCE | Answered by the live facts above: RUP is never `unknown`, so EPA "yes" against a stored "no" is a **difference** under the current rule. Sent to Mason as a decision (13.2). Label date and link are always a fill today. |
| 7 | MISSING-EVIDENCE | Disproved: DM-1b's apply path (`promote_chemistry_proposal` → `_apply_chemistry_proposal` → `_lock_parent_chemistry` → `_workbook_apply_items` → `_apply_parent_chemistry`) re-runs the gate under the parent lock (`20261211100000` line 247). Proof case H22 (excuse lost between workbook upload and apply → apply refused). |
| 8 | MISSING-EVIDENCE | Disproved: the gate is one SQL statement (one snapshot). `start_epa_lookup` and `record_epa_lookup` take the parent `FOR UPDATE`, and every chemistry writer takes the same parent lock before calling the gate, so a lookup or proposal and a chemistry save are serialized. A concurrent registration or brand edit lands entirely before or after the save's snapshot; a save that read the earlier state is ordered before that edit. No REG-1 lock is added to the gate (keeps DM-4's REG-first order). |
| 9 | DECISION | Already decided: sheet 4.F (reviewed). A not-found excuse makes the parent behave like a product without an EPA number in DM-1, which is all typed chemistry operations. Other numbers on the same parent still refuse. |
| 10 | DEFECT | Corrected: repair for `differs_typed` is retire the typed row (a DM-1 correction; retire is allowed under the gate, `20261211100000` line 287), then a new lookup proposes `add`. Proof case H23. |
| 11 | DECISION → technical | Re-labelled: the commit fails as a whole with DM-1's own message (for example the ingredients-outweigh-the-liquid check); the screen shows it and keeps the ticks; recovery is untick the item or reject the proposal. Nothing to decide. |
| 12 | MISSING-EVIDENCE | Proof case H24: a mixed proposal (one fill accepted, one fill unticked, one difference, a null EPA link) changes only the accepted key; the others are byte-for-byte unchanged. |
| 13 | MISSING-EVIDENCE | Proof case H25: a commit refused by DM-1's checks leaves no ingredient, chemistry change, registration version, event, proposal decision or receipt; the corrected retry succeeds; a replay of the success returns the same result; the event's before, after and `changed_by` are checked. |
| 14 | MISSING-EVIDENCE | Not changed by DM-4: `commit_ingredients_tab` is all-or-nothing (`WORKBOOK_INGREDIENTS_REFUSED`), apply is per parent (DM-1b migration). DM-4 changes only whether the gate refuses. |
| 15 | MISSING-EVIDENCE | Preflight pins the gate body md5, owner `postgres`, `SECURITY DEFINER`, and that no app role can execute it; the live read on 2026-11-11 matched. |
| 16 | DECISION → process | Corrected: the enablement point is the `epa-lookup` record-mode deploy, which needs Mason's typed yes anyway. Before asking, the agent confirms the DATA-2 review is done. |
| 17 | DECISION → technical | Corrected: order is DB live → `epa-lookup` record mode deployed and checked → screens merged. The screen shows a lookup as done only after `record_epa_lookup` returns. |
| 18 | DECISION → technical | Corrected: rollback = re-issue the DM-1 gate first, then revoke the four RPCs; tables are kept unreadable as history (as DM-1b does). Committed chemistry is undone by a DM-1 correction; a committed label fact by `set_epa_registration`. |
| 19 | SUGGESTION | Declined: calling `set_epa_registration` would nest a second receipt and fingerprint inside the commit; the helpers are exactly what it composes, and #1 restores its one missing output. |

### 13.2 Decision sent to Mason (2026-11-11)

RUP from EPA when we stored "no": (a) show it as a difference only, fixed by hand on the registration screen; or (b) let the admin tick it on the proposal (unticked by default) so the commit writes "yes" and lists posted sales to record. Recommendation (b). **Answer (Mason, 2026-11-11): "Yes, tickable" — (b) is built** (item class `rup_upgrade`).
