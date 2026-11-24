**APPLIED LIVE 2026-11-21 05:56:19 UTC (11:56 PM Central)**, ledger version `20261121055619` carrying name `20270115100000_moa_group_code_equivalence` (release v0.1.0, #1990; read-only ledger check 2026-11-23). `20270115100000_moa_group_code_equivalence.sql` (SQL sha256: `7b54d17d319ca706b9fa87eb2db039bcb362df8e108cad24e5bc6f367a0a1890`). Adds comparison-only MOA group equivalence, collision refusal, raw spelling preservation, and canonical active uniqueness while retaining existing exact indexes and the dormant EPA branch.

Compatibility note: an exact same-code duplicate typed in one product save previously reached the active-row lookup and raised `CHEMISTRY_ROW_EXISTS`; the candidate identifies the duplicate earlier and raises `CHEMISTRY_DUPLICATE_CHANGE`. This intentionally changes the error prefix, while keeping the same codes and refusal outcome. Current `src` has no matcher for either prefix.

Proof: `node scripts/smoke/prove-moa-group-code-equivalence-shared-container.mjs` uses an already-running network-none PostgreSQL 17 proof container only. Set `CRX_MOA_PROOF_CONTAINER` to another prepared proof container to repeat the focused cases; it still requires the pinned PostgreSQL image, network isolation, no active proof session, and the existing prerequisite schema. It does not bootstrap a fresh database. The standard MOA runner below independently rebuilds its complete fixture. The focused real SQL cases and limitations are recorded in `docs/plans/2026-11-13-moa-equivalence-CONTRACT.md`. It switches actual PostgreSQL roles for admin, sales_rep, driver, applicator and anon; checks differing typed/derived sets, summary separation, swap/consolidation spelling, stale-list refusal, and same-request ingredient-writer alias refusal with rows/versions/events/receipt unchanged; and proves retries, collision preflight, source-drift refusal before reissue/index creation, and guarded rollback. Rollback refuses later public/nonpublic helper consumers by a case-insensitive `pg_proc.prosrc` scan (including a nonpublic caller with no `pg_depend` edge), and preserves function/index metadata after both later-caller and changed-body refusals. It also compares the cost-exposure predicate before/after and observed no changed violation keys on this older schema.

Existing MOA regression: `node scripts/smoke/prove-ingredient-modes-of-action-real-schema.mjs --moa-equivalence` passed in its own disposable network-none PostgreSQL 17 container. It replayed 283 post-baseline migrations before MOA-1, applied the exact chronological `20270109100000_delivery_receipt_brands.sql` interstitial and this candidate, passed all ingredient-mode cases including concurrency, verified the four candidate function bodies against source-derived hashes, and rolled this candidate back before the original MOA-1 rollback. The runner cleaned up its owned container. The legacy default MOA mode still refuses at the newly later delivery-receipt migration through its unchanged `TOUCHED` guard.

Existing product chemistry regression: `node scripts/smoke/prove-product-chemistry-real-schema.mjs --moa-equivalence` passed in its own disposable network-none PostgreSQL 17 container. It applied the 2026-12-10 EPA prerequisite, the confirmed-swaps migration, then 35 exact chronological SQL migrations through this frozen candidate; the standard MOA fixture records two live-policy migrations as ledger-only (`20261217100000_job_access_ends_with_the_job.sql` and `20261220100000_applicator_keeps_own_record_fields.sql`). All existing DM-1 chemistry, fertilizer, EPA, version/history, writer, read, cost, and concurrency cases passed with the candidate's source-derived `_apply_parent_chemistry` body installed. Before the current grouping switch, the fixture moved only its synthetic `Legacy4`/`100-99` row from grouped size E4G to parent PEPA4 and asserted the identical EPA refusal before and after. The grouped-size brand race uses the current `upsert_parent_brand` path in this mode; default DM-1 mode retains its original writer. The candidate's guarded rollback restored all four prior function bodies and removed its helper/indexes; the standard MOA-1 rollback then removed its functions while retaining unreadable history. The runner cleaned up its owned container.

The DM-1 default planner remains fail-closed at its existing `TOUCHED` guard for later chemistry migrations; the candidate-specific mode applies the exact pinned prerequisite sequence instead. This proof does not claim every later production migration was executed: it uses the two standard ledger-only policy entries and the planner's existing one-shot handling. A full latest-schema replay, current live ledger/collision refresh, and eventual production apply remain unverified.

Source fidelity: the temporary base dependency is `20270108100000_ingredient_modes_of_action.sql`. On 2026-11-14, a supported read-only `pg_proc` catalogue capture and client-side LF-normalized hashes confirmed all four reissued prior function bodies exactly match their source definitions; those same four hashes are pinned in the migration preflight before any function is reissued. Current live migration ledger and collision state must be refreshed again at eventual apply time. The proof container predates unrelated schema changes and is not a full latest-schema replay.

Rollback (run in one transaction after the calling UI is reverted). The first guard requires the whole rollback to be in one transaction, before any persistent DDL. Before changing functions or indexes, a source scan of every public and nonpublic `pg_proc` refuses if any function or procedure beyond the four reissued callers mentions `_moa_group_code_key`. PostgreSQL does not track every string-bodied PL/pgSQL/SQL helper call as a dependency, so this conservative source check is required. Function-body guards compare LF-normalized source, matching the forward migration. It restores the exact four previous function definitions from their original migration sources, then removes only the new indexes and helper. The body guards refuse if any target function was changed after this candidate. Original exact indexes, rows, metadata, and history remain.

````sql

CREATE TEMP TABLE moa_equivalence_rollback_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;
DO $rollback_transaction_guard$
DECLARE v_tx text;
BEGIN
  IF to_regclass('pg_temp.moa_equivalence_rollback_tx') IS NOT NULL THEN
    SELECT transaction_id INTO v_tx FROM pg_temp.moa_equivalence_rollback_tx;
  END IF;
  IF v_tx IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_ROLLBACK_NOT_IN_TRANSACTION: run the rollback as one transaction';
  END IF;
END
$rollback_transaction_guard$;
SET LOCAL lock_timeout = '5s';
DO $helper_consumer_guard$
DECLARE v_consumers text[];
BEGIN
  SELECT array_agg(format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) ORDER BY n.nspname, p.proname, p.oid)
    INTO v_consumers
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE position('_moa_group_code_key' IN lower(COALESCE(p.prosrc, ''))) > 0
     AND p.oid NOT IN (
       'public._ingredient_modes_input(jsonb,text)'::regprocedure,
       'public._parent_mode_groups(uuid)'::regprocedure,
       'public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text)'::regprocedure,
       'public._apply_parent_chemistry(uuid,jsonb,text,text,text)'::regprocedure
     );
  IF COALESCE(cardinality(v_consumers), 0) > 0 THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_ROLLBACK_REFUSED: helper has later pg_proc source consumers: %', array_to_string(v_consumers, ', ');
  END IF;
END
$helper_consumer_guard$;
DO $rb_guard$
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public._ingredient_modes_input(jsonb,text)'::regprocedure), chr(13), '')) <> '2eae285abe59b151c7bfa6e0145f3ecb' THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_ROLLBACK_REFUSED: _ingredient_modes_input body changed';
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public._parent_mode_groups(uuid)'::regprocedure), chr(13), '')) <> 'e0989b07e5773f19db3b12e1fe9cfad1' THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_ROLLBACK_REFUSED: _parent_mode_groups body changed';
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text)'::regprocedure), chr(13), '')) <> '5eba773ccda8fc45a7124d0b83072728' THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_ROLLBACK_REFUSED: set_active_ingredient_modes body changed';
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public._apply_parent_chemistry(uuid,jsonb,text,text,text)'::regprocedure), chr(13), '')) <> '983fe84c21497b64fe328afe11ec9b01' THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_ROLLBACK_REFUSED: _apply_parent_chemistry body changed';
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public._moa_group_code_key(text)'::regprocedure), chr(13), '')) <> 'cfd63332abd9f542216b555de3015474' THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_ROLLBACK_REFUSED: _moa_group_code_key body changed';
  END IF;
  IF replace(pg_get_indexdef('public.active_ingredient_modes_of_action_canonical_one_active'::regclass), 'public.', '')
        IS DISTINCT FROM 'CREATE UNIQUE INDEX active_ingredient_modes_of_action_canonical_one_active ON active_ingredient_modes_of_action USING btree (ingredient_id, scheme, _moa_group_code_key(group_code) COLLATE "C") WHERE (status = ''active''::text)'
     OR replace(pg_get_indexdef('public.product_parent_modes_of_action_canonical_one_active'::regclass), 'public.', '')
        IS DISTINCT FROM 'CREATE UNIQUE INDEX product_parent_modes_of_action_canonical_one_active ON product_parent_modes_of_action USING btree (parent_id, ingredient_id, scheme, _moa_group_code_key(group_code) COLLATE "C") WHERE (status = ''active''::text)' THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_ROLLBACK_REFUSED: canonical index definition changed';
  END IF;
END
$rb_guard$;
CREATE OR REPLACE FUNCTION public._ingredient_modes_input(p_modes jsonb, p_label text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_entry jsonb;
  v_out jsonb := '[]'::jsonb;
  v_scheme text;
  v_code text;
  v_note text;
BEGIN
  IF jsonb_typeof(p_modes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'CHEMISTRY_MOA_INVALID: % must be a list of groups', p_label;
  END IF;
  IF jsonb_array_length(p_modes) > 10 THEN
    RAISE EXCEPTION 'CHEMISTRY_MOA_INVALID: an ingredient has at most 10 groups';
  END IF;
  FOR v_entry IN SELECT e FROM jsonb_array_elements(p_modes) e LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_entry) k) IS DISTINCT FROM ARRAY['group_code', 'scheme', 'source_note']
       OR jsonb_typeof(v_entry->'scheme') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_entry->'group_code') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_entry->'source_note') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'CHEMISTRY_MOA_INVALID: each group in % is {scheme, group_code, source_note} and nothing else', p_label;
    END IF;
    v_scheme := v_entry->>'scheme';
    -- btrim strips only spaces; tabs and line breaks are trimmed too, and a code is letters and digits only.
    v_code := upper(regexp_replace(v_entry->>'group_code', '^[[:space:]]+|[[:space:]]+$', '', 'g'));
    v_note := regexp_replace(v_entry->>'source_note', '^[[:space:]]+|[[:space:]]+$', '', 'g');
    IF v_scheme NOT IN ('HRAC', 'FRAC', 'IRAC') OR v_code !~ '^[A-Z0-9]{1,10}$' THEN
      RAISE EXCEPTION 'CHEMISTRY_MOA_INVALID: scheme is HRAC, FRAC or IRAC and the group code is 1 to 10 letters or digits';
    END IF;
    IF v_note !~ '[^[:space:]]' OR char_length(v_note) > 1000 THEN
      RAISE EXCEPTION 'CHEMISTRY_MOA_INVALID: say where % % came from (1 to 1000 characters)', v_scheme, v_code;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_out) o WHERE o->>'scheme' = v_scheme AND o->>'group_code' = v_code) THEN
      RAISE EXCEPTION 'CHEMISTRY_MOA_INVALID: % % is listed twice', v_scheme, v_code;
    END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object('scheme', v_scheme, 'group_code', v_code, 'source_note', v_note));
  END LOOP;
  RETURN (SELECT COALESCE(jsonb_agg(o ORDER BY array_position(ARRAY['HRAC', 'FRAC', 'IRAC'], o->>'scheme'),
                                      regexp_replace(o->>'group_code', '[0-9].*$', ''), substring(o->>'group_code' FROM '[0-9]+')::numeric, o->>'group_code'), '[]'::jsonb)
            FROM jsonb_array_elements(v_out) o);
END;
$function$;

CREATE OR REPLACE FUNCTION public._parent_mode_groups(p_parent_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  WITH ing AS (
    SELECT r.ingredient_id, a.name, a.canonical_ingredient_id,
           EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action o
                    WHERE o.ingredient_id = a.id AND o.status = 'active') AS has_own
      FROM public.product_parent_ingredients r
      JOIN public.active_ingredients a ON a.id = r.ingredient_id
     WHERE r.parent_id = p_parent_id AND r.status = 'active'
  ), src AS (
    SELECT i.ingredient_id, i.name, i.has_own,
           CASE WHEN i.has_own THEN i.ingredient_id
                WHEN i.canonical_ingredient_id IS NOT NULL
                     AND EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action o
                                  WHERE o.ingredient_id = i.canonical_ingredient_id AND o.status = 'active')
                  THEN i.canonical_ingredient_id END AS list_id,
           CASE WHEN NOT i.has_own THEN i.canonical_ingredient_id END AS acid_id
      FROM ing i
  ), derived AS (
    SELECT s.ingredient_id, o.scheme, o.group_code
      FROM src s JOIN public.active_ingredient_modes_of_action o ON o.ingredient_id = s.list_id AND o.status = 'active'
  ), typed AS (
    SELECT m.ingredient_id, m.scheme, m.group_code, m.id, m.source
      FROM public.product_parent_modes_of_action m
      JOIN src s ON s.ingredient_id = m.ingredient_id
     WHERE m.parent_id = p_parent_id AND m.status = 'active'
  ), pairs AS (
    SELECT ingredient_id, scheme FROM derived UNION SELECT ingredient_id, scheme FROM typed
  ), per AS (
    SELECT p.ingredient_id, p.scheme,
           (SELECT array_agg(d.group_code ORDER BY regexp_replace(d.group_code, '[0-9].*$', ''), substring(d.group_code FROM '[0-9]+')::numeric, d.group_code)
              FROM derived d WHERE d.ingredient_id = p.ingredient_id AND d.scheme = p.scheme) AS derived_codes,
           (SELECT array_agg(t.group_code ORDER BY regexp_replace(t.group_code, '[0-9].*$', ''), substring(t.group_code FROM '[0-9]+')::numeric, t.group_code)
              FROM typed t WHERE t.ingredient_id = p.ingredient_id AND t.scheme = p.scheme) AS typed_codes,
           (SELECT jsonb_agg(jsonb_build_object('row_id', t.id, 'group_code', t.group_code, 'source', t.source)
                     ORDER BY regexp_replace(t.group_code, '[0-9].*$', ''), substring(t.group_code FROM '[0-9]+')::numeric, t.group_code, t.id)
              FROM typed t WHERE t.ingredient_id = p.ingredient_id AND t.scheme = p.scheme) AS typed_rows
      FROM pairs p
  ), st AS (
    SELECT per.*,
           CASE WHEN typed_codes IS NULL THEN 'derived'
                WHEN derived_codes IS NULL THEN 'typed'
                WHEN typed_codes = derived_codes THEN 'matches'
                ELSE 'differs' END AS status,
           COALESCE(typed_codes, derived_codes) AS live
      FROM per
  ), summary AS (
    SELECT st.scheme, c.code, bool_or(st.status = 'differs') AS differs
      FROM st CROSS JOIN LATERAL unnest(st.live) AS c(code)
     GROUP BY st.scheme, c.code
  )
  SELECT jsonb_build_object(
    'chemistry_version', COALESCE((SELECT cs.chemistry_version FROM public.product_parent_chemistry_state cs
                                    WHERE cs.parent_id = p_parent_id), 0),
    'ingredients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'ingredient_id', s.ingredient_id, 'name', s.name,
          'derived_from', CASE WHEN s.has_own THEN 'from_ingredient' WHEN s.list_id IS NOT NULL THEN 'from_acid' END,
          'acid_name', CASE WHEN s.list_id IS NOT NULL AND NOT s.has_own
                            THEN (SELECT a.name FROM public.active_ingredients a WHERE a.id = s.acid_id) END,
          'schemes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('scheme', st.scheme, 'live', to_jsonb(st.live),
                       'derived', COALESCE(to_jsonb(st.derived_codes), '[]'::jsonb),
                       'typed', COALESCE(st.typed_rows, '[]'::jsonb), 'status', st.status)
                     ORDER BY array_position(ARRAY['HRAC', 'FRAC', 'IRAC'], st.scheme))
              FROM st WHERE st.ingredient_id = s.ingredient_id), '[]'::jsonb),
          'not_recorded', NOT EXISTS (SELECT 1 FROM st WHERE st.ingredient_id = s.ingredient_id))
        ORDER BY s.name, s.ingredient_id)
        FROM src s), '[]'::jsonb),
    'summary', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('scheme', sm.scheme, 'group_code', sm.code, 'differs', sm.differs)
               ORDER BY array_position(ARRAY['HRAC', 'FRAC', 'IRAC'], sm.scheme),
                        regexp_replace(sm.code, '[0-9].*$', ''), substring(sm.code FROM '[0-9]+')::numeric, sm.code)
        FROM summary sm), '[]'::jsonb),
    'not_recorded_count', (SELECT count(*) FROM src s WHERE NOT EXISTS (SELECT 1 FROM st WHERE st.ingredient_id = s.ingredient_id)));
$function$;

CREATE OR REPLACE FUNCTION public.set_active_ingredient_modes(p_ingredient_id uuid, p_expected_modes jsonb, p_modes jsonb,
  p_reason text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text;
  v_existing jsonb;
  v_ingredient public.active_ingredients;
  v_modes jsonb;
  v_expected jsonb;
  v_current jsonb;
  v_reason text;
  v_unchanged boolean;
  v_result jsonb;
BEGIN
  -- Lock first, so two identical requests sent at once are serialized and the second finds the first's receipt.
  PERFORM pg_advisory_xact_lock(hashtext('crx.active_ingredients'));
  v_fp := md5(jsonb_build_object('actor_id', v_actor, 'ingredient_id', p_ingredient_id, 'expected_modes', p_expected_modes,
    'modes', p_modes, 'reason', p_reason)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_active_ingredient_modes', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT * INTO v_ingredient FROM public.active_ingredients WHERE id = p_ingredient_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INGREDIENT_NOT_FOUND'; END IF;
  IF v_ingredient.status <> 'active' THEN
    RAISE EXCEPTION 'INGREDIENT_RETIRED: % is retired; reactivate it first', v_ingredient.name;
  END IF;
  v_modes := public._ingredient_modes_input(p_modes, 'the new list');
  v_expected := public._ingredient_modes_input(p_expected_modes, 'the list you opened');
  IF p_reason IS NULL OR p_reason !~ '[^[:space:]]' OR char_length(btrim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'MOA_REASON_REQUIRED: say why the groups change (up to 1000 characters)';
  END IF;
  v_reason := btrim(p_reason);

  v_current := public._ingredient_mode_list(p_ingredient_id);
  IF v_current IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'MOA_LIST_STALE: the groups of "%" changed since you opened them; reload', v_ingredient.name;
  END IF;

  v_unchanged := v_current = v_modes;
  IF NOT v_unchanged THEN
    UPDATE public.active_ingredient_modes_of_action m
       SET status = 'retired', row_version = m.row_version + 1, updated_by = v_actor, updated_at = now()
     WHERE m.ingredient_id = p_ingredient_id AND m.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_modes) e
                        WHERE e->>'scheme' = m.scheme AND e->>'group_code' = m.group_code);
    UPDATE public.active_ingredient_modes_of_action m
       SET source_note = e->>'source_note', row_version = m.row_version + 1, updated_by = v_actor, updated_at = now()
      FROM jsonb_array_elements(v_modes) e
     WHERE m.ingredient_id = p_ingredient_id AND m.status = 'active'
       AND m.scheme = e->>'scheme' AND m.group_code = e->>'group_code' AND m.source_note <> e->>'source_note';
    INSERT INTO public.active_ingredient_modes_of_action (ingredient_id, scheme, group_code, source_note, created_by, updated_by)
    SELECT p_ingredient_id, e->>'scheme', e->>'group_code', e->>'source_note', v_actor, v_actor
      FROM jsonb_array_elements(v_modes) e
     WHERE NOT EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action m
                        WHERE m.ingredient_id = p_ingredient_id AND m.status = 'active'
                          AND m.scheme = e->>'scheme' AND m.group_code = e->>'group_code');
    PERFORM public._active_ingredient_event(p_ingredient_id, 'updated', v_reason, NULL,
      jsonb_build_object('modes_of_action', v_current), jsonb_build_object('modes_of_action', v_modes));
  END IF;

  v_result := jsonb_build_object('ingredient_id', p_ingredient_id, 'modes', public._ingredient_mode_list(p_ingredient_id),
    'unchanged', v_unchanged) || public._ingredient_mode_reach(p_ingredient_id);
  -- Saved on every path, a no-change one included, so the key can never be reused for a different request.
  PERFORM public.save_idempotency(p_idempotency_key, 'set_active_ingredient_modes',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._apply_parent_chemistry(p_parent_id uuid, p_changes jsonb, p_mode text, p_reason text, p_evidence text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_parent record;
  v_version bigint;
  v_gate text;
  v_before jsonb;
  v_after jsonb;
  v_entry jsonb;
  v_ord bigint;
  v_kind text;
  v_action text;
  v_refs jsonb := '{}'::jsonb;
  v_resolved jsonb := '{}'::jsonb;
  v_created jsonb := '[]'::jsonb;
  v_res jsonb;
  v_touched text[] := '{}';
  v_keys text[];
  v_ing uuid;
  v_row public.product_parent_ingredients;
  v_into public.product_parent_ingredients;
  v_moa public.product_parent_modes_of_action;
  v_fert public.product_parent_fertilizer_analysis;
  v_s jsonb;
  v_scheme text;
  v_code text;
  v_nutrient text;
  v_keep text[];
  v_changed boolean := false;
  v_event bigint;
  c_identity CONSTANT text[] := ARRAY['ingredient_id', 'ref', 'name', 'cas', 'canonical_ingredient_id',
    'canonical_fraction', 'fraction_basis', 'is_parent_form'];
  c_strength CONSTANT text[] := ARRAY['strength_value', 'strength_unit', 'strength_basis', 'source', 'source_note'];
  c_nutrient CONSTANT text[] := ARRAY['basis', 'percent', 'source', 'source_note'];
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_mode NOT IN ('set', 'correct', 'epa') THEN RAISE EXCEPTION 'CHEMISTRY_MODE_INVALID'; END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes) = 0 THEN
    RAISE EXCEPTION 'CHEMISTRY_EMPTY: nothing to save';
  END IF;
  IF jsonb_array_length(p_changes) > 200 THEN RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: at most 200 changes in one save'; END IF;
  SELECT id, name, product_form, is_active INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  SELECT chemistry_version INTO v_version FROM public.product_parent_chemistry_state WHERE parent_id = p_parent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHEMISTRY_NOT_LOCKED: lock the parent''s chemistry first'; END IF;
  v_before := public._parent_chemistry_values(p_parent_id);
  IF p_mode <> 'epa' THEN v_gate := public._parent_chemistry_epa_refusal(p_parent_id); END IF;

  -- Shape, actions, refs: all checked before any write.
  FOR v_entry, v_ord IN SELECT e, o FROM jsonb_array_elements(p_changes) WITH ORDINALITY AS t(e, o) LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: each change is an object'; END IF;
    v_kind := v_entry->>'kind';
    v_action := COALESCE(v_entry->>'action', 'add');
    IF v_kind IS NULL OR v_kind NOT IN ('ingredient', 'mode_of_action', 'fertilizer') THEN
      RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: kind is ingredient, mode_of_action or fertilizer';
    END IF;
    IF p_mode IN ('set', 'epa') AND v_action <> 'add' THEN
      RAISE EXCEPTION 'CHEMISTRY_CHANGE_NEEDS_CORRECTION: changing, retiring or swapping a row needs a correction with reason and evidence';
    END IF;
    IF p_mode = 'correct' AND (v_action NOT IN ('change', 'retire', 'swap', 'consolidate')
        OR (v_kind = 'mode_of_action' AND v_action <> 'retire')
        OR (v_kind = 'fertilizer' AND v_action NOT IN ('change', 'retire'))) THEN
      RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: a correction changes, retires, swaps or consolidates rows; add new rows with fast entry';
    END IF;
    v_keys := CASE
      WHEN v_kind = 'ingredient' AND v_action = 'add' THEN c_identity || c_strength
      WHEN v_kind = 'ingredient' AND v_action = 'change' THEN ARRAY['row_id'] || c_strength
      WHEN v_action = 'retire' THEN ARRAY['row_id']
      WHEN v_kind = 'ingredient' AND v_action = 'swap' THEN ARRAY['row_id', 'modes_of_action'] || c_identity || c_strength
      WHEN v_kind = 'ingredient' AND v_action = 'consolidate' THEN ARRAY['row_id', 'into_row_id', 'modes_of_action'] || c_strength
      WHEN v_kind = 'mode_of_action' THEN ARRAY['ingredient_id', 'ingredient_ref', 'scheme', 'group_code']
      WHEN v_kind = 'fertilizer' AND v_action = 'add' THEN ARRAY['nutrient'] || c_nutrient
      ELSE ARRAY['row_id'] || c_nutrient END;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_entry) k WHERE k NOT IN ('kind', 'action') AND k <> ALL (v_keys)) THEN
      RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: unexpected field(s) % on a % % change',
        (SELECT string_agg(k, ', ') FROM jsonb_object_keys(v_entry) k WHERE k NOT IN ('kind', 'action') AND k <> ALL (v_keys)),
        v_kind, v_action;
    END IF;
    IF v_entry ? 'ref' THEN
      IF jsonb_typeof(v_entry->'ref') IS DISTINCT FROM 'string' OR btrim(v_entry->>'ref') = '' OR v_entry ? 'ingredient_id' THEN
        RAISE EXCEPTION 'CHEMISTRY_REF_INVALID: ref is a short label on a new ingredient';
      END IF;
      IF v_refs ? (v_entry->>'ref') THEN RAISE EXCEPTION 'CHEMISTRY_REF_DUPLICATE: ref "%" is used twice', v_entry->>'ref'; END IF;
      v_refs := v_refs || jsonb_build_object(v_entry->>'ref', v_ord);
    END IF;
    -- D-Z: on a gated parent only a typed row may be retired; on an inactive parent nothing new or changed.
    IF v_gate IS NOT NULL AND NOT (p_mode = 'correct' AND v_action = 'retire' AND v_kind <> 'mode_of_action') THEN
      RAISE EXCEPTION '%', v_gate;
    END IF;
    IF NOT v_parent.is_active AND NOT (p_mode = 'correct' AND v_action IN ('retire', 'swap', 'consolidate')) THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_INACTIVE: "%" is inactive; only swaps, consolidations and retirements are allowed', v_parent.name;
    END IF;
  END LOOP;
  FOR v_entry IN SELECT e FROM jsonb_array_elements(p_changes) e WHERE e ? 'ingredient_ref' LOOP
    IF jsonb_typeof(v_entry->'ingredient_ref') IS DISTINCT FROM 'string' OR NOT v_refs ? (v_entry->>'ingredient_ref') OR v_entry ? 'ingredient_id' THEN
      RAISE EXCEPTION 'CHEMISTRY_REF_UNKNOWN: ingredient_ref "%" names no new ingredient in this save', v_entry->>'ingredient_ref';
    END IF;
  END LOOP;

  -- Resolve every ingredient named on an add or swap, new forms in sorted (CAS, then name) order (D-AA-4).
  FOR v_entry, v_ord IN
    SELECT e, o FROM jsonb_array_elements(p_changes) WITH ORDINALITY AS t(e, o)
     WHERE e->>'kind' = 'ingredient' AND COALESCE(e->>'action', 'add') IN ('add', 'swap')
     ORDER BY (e ? 'ingredient_id') DESC, btrim(e->>'cas') NULLS LAST,
              lower(regexp_replace(btrim(e->>'name'), '\s+', ' ', 'g')), o
  LOOP
    v_res := public._resolve_active_ingredient(v_entry - ARRAY['kind', 'action', 'row_id', 'ref', 'modes_of_action'] - c_strength);
    v_resolved := v_resolved || jsonb_build_object(v_ord::text, v_res->'ingredient_id');
    IF (v_res->>'created')::boolean THEN
      v_created := v_created || jsonb_build_array(jsonb_build_object('ref', v_entry->>'ref', 'ingredient_id', v_res->'ingredient_id'));
    END IF;
    IF v_entry ? 'ref' THEN v_refs := v_refs || jsonb_build_object(v_entry->>'ref', v_res->'ingredient_id'); END IF;
  END LOOP;

  FOR v_entry, v_ord IN SELECT e, o FROM jsonb_array_elements(p_changes) WITH ORDINALITY AS t(e, o) LOOP
    v_kind := v_entry->>'kind';
    v_action := COALESCE(v_entry->>'action', 'add');

    IF v_kind = 'ingredient' AND v_action IN ('change', 'retire', 'swap', 'consolidate') THEN
      SELECT * INTO v_row FROM public.product_parent_ingredients
       WHERE id = public._chemistry_uuid(v_entry->'row_id', 'row_id') AND parent_id = p_parent_id AND status = 'active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'CHEMISTRY_ROW_NOT_FOUND: that ingredient row is not active on this product; reload'; END IF;
      IF v_gate IS NOT NULL AND v_row.source = 'epa_lookup' THEN RAISE EXCEPTION '%', v_gate; END IF;
      v_touched := v_touched || ('row:' || v_row.id) || ('ing:' || v_row.ingredient_id);
    END IF;

    IF v_kind = 'ingredient' AND v_action = 'add' THEN
      v_ing := (v_resolved->>(v_ord::text))::uuid;
      v_touched := v_touched || ('ing:' || v_ing);
      v_s := public._chemistry_strength(v_entry, p_mode);
      SELECT * INTO v_row FROM public.product_parent_ingredients
       WHERE parent_id = p_parent_id AND ingredient_id = v_ing AND status = 'active' FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.product_parent_ingredients (parent_id, ingredient_id, strength_value, strength_unknown, strength_unit,
          strength_basis, source, source_note, created_by, updated_by)
        VALUES (p_parent_id, v_ing, (v_s->>'value')::numeric, (v_s->>'unknown')::boolean, v_s->>'unit', v_s->>'basis',
          v_s->>'source', v_s->>'note', v_actor, v_actor);
        v_changed := true;
      ELSIF v_row.strength_unknown AND (v_s->>'value') IS NOT NULL THEN
        IF p_mode = 'epa' AND v_row.source <> 'epa_lookup' THEN
          RAISE EXCEPTION 'CHEMISTRY_TYPED_ROW_KEPT: % was typed in; the EPA value goes to review', (SELECT name FROM public.active_ingredients WHERE id = v_ing);
        END IF;
        -- A typed fill sets the value only: a different unit, basis, source or note is a correction (sheet section 3).
        IF p_mode <> 'epa' AND (v_row.strength_unit IS DISTINCT FROM v_s->>'unit' OR v_row.strength_basis IS DISTINCT FROM v_s->>'basis'
            OR v_row.source IS DISTINCT FROM v_s->>'source' OR (v_s->>'note' IS NOT NULL AND v_row.source_note IS DISTINCT FROM v_s->>'note')) THEN
          RAISE EXCEPTION 'CHEMISTRY_CHANGE_NEEDS_CORRECTION: filling the unknown strength of % keeps its unit, basis and source; change those with a correction',
            (SELECT name FROM public.active_ingredients WHERE id = v_ing);
        END IF;
        UPDATE public.product_parent_ingredients
           SET strength_value = (v_s->>'value')::numeric, strength_unknown = false, strength_unit = v_s->>'unit',
               strength_basis = v_s->>'basis', source = v_s->>'source',
               source_note = CASE WHEN p_mode = 'epa' THEN v_s->>'note' ELSE COALESCE(v_s->>'note', source_note) END,
               row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_row.id;
        v_changed := true;
      ELSIF p_mode = 'epa' AND v_row.strength_value IS NOT DISTINCT FROM (v_s->>'value')::numeric
            AND v_row.strength_unit = v_s->>'unit' AND v_row.strength_basis = v_s->>'basis' THEN
        NULL; -- the lookup agrees with what is stored
      ELSIF p_mode = 'epa' AND v_row.source <> 'epa_lookup' THEN
        RAISE EXCEPTION 'CHEMISTRY_TYPED_ROW_KEPT: % was typed in; the EPA value goes to review', (SELECT name FROM public.active_ingredients WHERE id = v_ing);
      ELSE
        RAISE EXCEPTION 'CHEMISTRY_CHANGE_NEEDS_CORRECTION: % is already on this product; change it with a correction',
          (SELECT name FROM public.active_ingredients WHERE id = v_ing);
      END IF;

    ELSIF v_kind = 'ingredient' AND v_action = 'change' THEN
      v_s := public._chemistry_strength(v_entry, p_mode);
      IF v_row.strength_value IS NOT DISTINCT FROM (v_s->>'value')::numeric AND v_row.strength_unit = v_s->>'unit'
         AND v_row.strength_basis = v_s->>'basis' AND v_row.source = v_s->>'source'
         AND v_row.source_note IS NOT DISTINCT FROM v_s->>'note' THEN
        RAISE EXCEPTION 'CHEMISTRY_NO_CHANGE: nothing differs on that ingredient row';
      END IF;
      UPDATE public.product_parent_ingredients
         SET strength_value = (v_s->>'value')::numeric, strength_unknown = (v_s->>'unknown')::boolean, strength_unit = v_s->>'unit',
             strength_basis = v_s->>'basis', source = v_s->>'source', source_note = v_s->>'note',
             row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_row.id;
      v_changed := true;

    ELSIF v_kind = 'ingredient' AND v_action = 'retire' THEN
      -- On a gated parent a typed row may go, but never a mode of action the EPA lookup confirmed (D-Z, D-L).
      IF v_gate IS NOT NULL AND EXISTS (SELECT 1 FROM public.product_parent_modes_of_action
                                         WHERE parent_id = p_parent_id AND ingredient_id = v_row.ingredient_id
                                           AND status = 'active' AND source = 'epa_lookup') THEN
        RAISE EXCEPTION 'CHEMISTRY_EPA_ROW_KEPT: the EPA lookup confirmed a mode of action of %, so it stays on this product',
          (SELECT name FROM public.active_ingredients WHERE id = v_row.ingredient_id);
      END IF;
      UPDATE public.product_parent_ingredients SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_row.id;
      UPDATE public.product_parent_modes_of_action SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE parent_id = p_parent_id AND ingredient_id = v_row.ingredient_id AND status = 'active';
      v_changed := true;

    ELSIF v_kind = 'ingredient' AND v_action = 'swap' THEN
      v_ing := (v_resolved->>(v_ord::text))::uuid;
      IF v_ing = v_row.ingredient_id THEN RAISE EXCEPTION 'CHEMISTRY_NO_CHANGE: that row already uses this ingredient'; END IF;
      IF EXISTS (SELECT 1 FROM public.product_parent_ingredients WHERE parent_id = p_parent_id AND ingredient_id = v_ing AND status = 'active') THEN
        RAISE EXCEPTION 'INGREDIENT_ALREADY_ON_PARENT: % is already on this product; consolidate the two rows instead',
          (SELECT name FROM public.active_ingredients WHERE id = v_ing);
      END IF;
      v_touched := v_touched || ('ing:' || v_ing);
      -- Nothing is copied (Mason, 2026-11-07): the admin states the new row's strength, unit, basis and source,
      -- and lists which of the old row's modes of action stay; the screen pre-fills both from the old row.
      v_s := public._chemistry_strength(v_entry, p_mode);
      v_keep := public._chemistry_kept_modes(v_entry, p_parent_id, v_row.ingredient_id);
      UPDATE public.product_parent_ingredients SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_row.id;
      INSERT INTO public.product_parent_ingredients (parent_id, ingredient_id, strength_value, strength_unknown, strength_unit,
        strength_basis, source, source_note, created_by, updated_by)
      VALUES (p_parent_id, v_ing, (v_s->>'value')::numeric, (v_s->>'unknown')::boolean, v_s->>'unit', v_s->>'basis',
        v_s->>'source', v_s->>'note', v_actor, v_actor);
      -- Every mode of action of the old row is retired; the ones listed are recorded again on the new ingredient.
      FOR v_moa IN SELECT * FROM public.product_parent_modes_of_action
                    WHERE parent_id = p_parent_id AND ingredient_id = v_row.ingredient_id AND status = 'active' ORDER BY id FOR UPDATE LOOP
        UPDATE public.product_parent_modes_of_action SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_moa.id;
        IF (v_moa.scheme || ':' || v_moa.group_code) = ANY (v_keep) THEN
          INSERT INTO public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code, source, created_by, updated_by)
          VALUES (p_parent_id, v_ing, v_moa.scheme, v_moa.group_code, 'typed', v_actor, v_actor)
          -- Typed again: the EPA lookup confirmed it for the old ingredient, not this one; a later lookup re-confirms it (Sol, 2026-11-08).
          ON CONFLICT (parent_id, ingredient_id, scheme, group_code) WHERE status = 'active' DO NOTHING;
        END IF;
      END LOOP;
      v_changed := true;

    ELSIF v_kind = 'ingredient' AND v_action = 'consolidate' THEN
      SELECT * INTO v_into FROM public.product_parent_ingredients
       WHERE id = public._chemistry_uuid(v_entry->'into_row_id', 'into_row_id') AND parent_id = p_parent_id AND status = 'active' FOR UPDATE;
      IF NOT FOUND OR v_into.id = v_row.id THEN
        RAISE EXCEPTION 'CHEMISTRY_ROW_NOT_FOUND: the row to keep must be another active ingredient row of this product; reload';
      END IF;
      IF v_gate IS NOT NULL THEN RAISE EXCEPTION '%', v_gate; END IF;
      v_touched := v_touched || ('row:' || v_into.id) || ('ing:' || v_into.ingredient_id);
      v_s := public._chemistry_strength(v_entry, p_mode);
      v_keep := public._chemistry_kept_modes(v_entry, p_parent_id, v_row.ingredient_id);
      UPDATE public.product_parent_ingredients SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_row.id;
      UPDATE public.product_parent_ingredients
         SET strength_value = (v_s->>'value')::numeric, strength_unknown = (v_s->>'unknown')::boolean, strength_unit = v_s->>'unit',
             strength_basis = v_s->>'basis', source = v_s->>'source', source_note = v_s->>'note',
             row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_into.id;
      -- The duplicate's modes of action are retired; the ones listed move to the kept ingredient (one already there is not doubled).
      FOR v_moa IN SELECT * FROM public.product_parent_modes_of_action
                    WHERE parent_id = p_parent_id AND ingredient_id = v_row.ingredient_id AND status = 'active' ORDER BY id FOR UPDATE LOOP
        UPDATE public.product_parent_modes_of_action SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_moa.id;
        IF (v_moa.scheme || ':' || v_moa.group_code) = ANY (v_keep) THEN
          INSERT INTO public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code, source, created_by, updated_by)
          VALUES (p_parent_id, v_into.ingredient_id, v_moa.scheme, v_moa.group_code, 'typed', v_actor, v_actor)
          -- Typed again: the EPA lookup confirmed it for the old ingredient, not this one; a later lookup re-confirms it (Sol, 2026-11-08).
          ON CONFLICT (parent_id, ingredient_id, scheme, group_code) WHERE status = 'active' DO NOTHING;
        END IF;
      END LOOP;
      v_changed := true;

    ELSIF v_kind = 'mode_of_action' AND v_action = 'add' THEN
      IF v_entry ? 'ingredient_ref' THEN
        v_ing := (v_refs->>(v_entry->>'ingredient_ref'))::uuid;
      ELSE
        v_ing := public._chemistry_uuid(v_entry->'ingredient_id', 'ingredient_id');
      END IF;
      v_scheme := v_entry->>'scheme';
      v_code := upper(btrim(v_entry->>'group_code'));
      IF v_scheme IS NULL OR v_scheme NOT IN ('HRAC', 'FRAC', 'IRAC') OR v_code IS NULL OR v_code = '' OR char_length(v_code) > 10 THEN
        RAISE EXCEPTION 'CHEMISTRY_MOA_INVALID: scheme is HRAC, FRAC or IRAC and the group code is 1 to 10 characters';
      END IF;
      v_touched := v_touched || ('moa:' || v_ing || ':' || v_scheme || ':' || v_code);
      SELECT * INTO v_moa FROM public.product_parent_modes_of_action WHERE parent_id = p_parent_id AND ingredient_id = v_ing
         AND scheme = v_scheme AND group_code = v_code AND status = 'active' FOR UPDATE;
      IF FOUND THEN
        IF p_mode <> 'epa' THEN RAISE EXCEPTION 'CHEMISTRY_ROW_EXISTS: that mode of action is already recorded'; END IF;
        -- The EPA lookup confirming a typed mode of action marks it as confirmed (where it came from, nothing else).
        IF v_moa.source <> 'epa_lookup' THEN
          UPDATE public.product_parent_modes_of_action SET source = 'epa_lookup', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
           WHERE id = v_moa.id;
          v_changed := true;
        END IF;
      ELSE
        INSERT INTO public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code, source, created_by, updated_by)
        VALUES (p_parent_id, v_ing, v_scheme, v_code, CASE WHEN p_mode = 'epa' THEN 'epa_lookup' ELSE 'typed' END, v_actor, v_actor);
        v_changed := true;
      END IF;

    ELSIF v_kind = 'mode_of_action' AND v_action = 'retire' THEN
      SELECT * INTO v_moa FROM public.product_parent_modes_of_action
       WHERE id = public._chemistry_uuid(v_entry->'row_id', 'row_id') AND parent_id = p_parent_id AND status = 'active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'CHEMISTRY_ROW_NOT_FOUND: that mode of action is not active on this product; reload'; END IF;
      v_touched := v_touched || ('moa:' || v_moa.ingredient_id || ':' || v_moa.scheme || ':' || v_moa.group_code);
      UPDATE public.product_parent_modes_of_action SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_moa.id;
      v_changed := true;

    ELSIF v_kind = 'fertilizer' AND v_action = 'add' THEN
      v_nutrient := v_entry->>'nutrient';
      IF v_nutrient IS NULL OR v_nutrient NOT IN ('N', 'P', 'K', 'S', 'Ca', 'Mg', 'B', 'Cl', 'Co', 'Cu', 'Fe', 'Mn', 'Mo', 'Ni', 'Zn') THEN
        RAISE EXCEPTION 'CHEMISTRY_FERTILIZER_INVALID: nutrient is one of N, P, K, S, Ca, Mg, B, Cl, Co, Cu, Fe, Mn, Mo, Ni, Zn';
      END IF;
      v_touched := v_touched || ('fert:' || v_nutrient);
      v_s := public._chemistry_nutrient(v_entry, v_nutrient, p_mode);
      SELECT * INTO v_fert FROM public.product_parent_fertilizer_analysis
       WHERE parent_id = p_parent_id AND nutrient = v_nutrient AND status = 'active' FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.product_parent_fertilizer_analysis (parent_id, nutrient, basis, percent, percent_unknown, source,
          source_note, created_by, updated_by)
        VALUES (p_parent_id, v_nutrient, v_s->>'basis', (v_s->>'percent')::numeric, (v_s->>'unknown')::boolean, v_s->>'source',
          v_s->>'note', v_actor, v_actor);
        v_changed := true;
      ELSIF v_fert.percent_unknown AND (v_s->>'percent') IS NOT NULL THEN
        IF p_mode = 'epa' AND v_fert.source <> 'epa_lookup' THEN
          RAISE EXCEPTION 'CHEMISTRY_TYPED_ROW_KEPT: % was typed in; the EPA value goes to review', v_nutrient;
        END IF;
        IF p_mode <> 'epa' AND (v_fert.basis IS DISTINCT FROM v_s->>'basis' OR v_fert.source IS DISTINCT FROM v_s->>'source'
            OR (v_s->>'note' IS NOT NULL AND v_fert.source_note IS DISTINCT FROM v_s->>'note')) THEN
          RAISE EXCEPTION 'CHEMISTRY_CHANGE_NEEDS_CORRECTION: filling the unknown % keeps its basis and source; change those with a correction', v_nutrient;
        END IF;
        UPDATE public.product_parent_fertilizer_analysis
           SET basis = v_s->>'basis', percent = (v_s->>'percent')::numeric, percent_unknown = false, source = v_s->>'source',
               source_note = CASE WHEN p_mode = 'epa' THEN v_s->>'note' ELSE COALESCE(v_s->>'note', source_note) END, row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_fert.id;
        v_changed := true;
      ELSIF p_mode = 'epa' AND v_fert.percent IS NOT DISTINCT FROM (v_s->>'percent')::numeric AND v_fert.basis = v_s->>'basis' THEN
        NULL;
      ELSIF p_mode = 'epa' AND v_fert.source <> 'epa_lookup' THEN
        RAISE EXCEPTION 'CHEMISTRY_TYPED_ROW_KEPT: % was typed in; the EPA value goes to review', v_nutrient;
      ELSE
        RAISE EXCEPTION 'CHEMISTRY_CHANGE_NEEDS_CORRECTION: % is already recorded; change it with a correction', v_nutrient;
      END IF;

    ELSE -- fertilizer change or retire
      SELECT * INTO v_fert FROM public.product_parent_fertilizer_analysis
       WHERE id = public._chemistry_uuid(v_entry->'row_id', 'row_id') AND parent_id = p_parent_id AND status = 'active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'CHEMISTRY_ROW_NOT_FOUND: that nutrient row is not active on this product; reload'; END IF;
      IF v_gate IS NOT NULL AND v_fert.source = 'epa_lookup' THEN RAISE EXCEPTION '%', v_gate; END IF;
      v_touched := v_touched || ('fert:' || v_fert.nutrient);
      IF v_action = 'retire' THEN
        UPDATE public.product_parent_fertilizer_analysis SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_fert.id;
      ELSE
        v_s := public._chemistry_nutrient(v_entry, v_fert.nutrient, p_mode);
        IF v_fert.percent IS NOT DISTINCT FROM (v_s->>'percent')::numeric AND v_fert.basis = v_s->>'basis'
           AND v_fert.source = v_s->>'source' AND v_fert.source_note IS NOT DISTINCT FROM v_s->>'note' THEN
          RAISE EXCEPTION 'CHEMISTRY_NO_CHANGE: nothing differs on that nutrient row';
        END IF;
        UPDATE public.product_parent_fertilizer_analysis
           SET basis = v_s->>'basis', percent = (v_s->>'percent')::numeric, percent_unknown = (v_s->>'unknown')::boolean,
               source = v_s->>'source', source_note = v_s->>'note', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_fert.id;
      END IF;
      v_changed := true;
    END IF;

    IF (SELECT count(*) <> count(DISTINCT t) FROM unnest(v_touched) t) THEN
      RAISE EXCEPTION 'CHEMISTRY_DUPLICATE_CHANGE: two changes in this save touch the same row or ingredient';
    END IF;
  END LOOP;

  IF NOT v_changed THEN
    RETURN jsonb_build_object('parent_id', p_parent_id, 'changed', false, 'chemistry_version', v_version,
      'created_ingredients', v_created);
  END IF;
  PERFORM public._check_parent_chemistry(p_parent_id);
  v_after := public._parent_chemistry_values(p_parent_id);
  UPDATE public.product_parent_chemistry_state
     SET chemistry_version = v_version + 1, updated_by = v_actor, updated_at = now()
   WHERE parent_id = p_parent_id;
  INSERT INTO public.product_chemistry_events (parent_id, event_type, chemistry_version, reason, evidence, before_values,
    after_values, changed_by)
  VALUES (p_parent_id, CASE p_mode WHEN 'correct' THEN 'corrected' ELSE 'set' END, v_version + 1, p_reason, p_evidence,
    v_before, v_after || jsonb_build_object('source_path', p_mode), v_actor)
  RETURNING id INTO v_event;
  RETURN jsonb_build_object('parent_id', p_parent_id, 'changed', true, 'chemistry_version', v_version + 1,
    'event_id', v_event, 'created_ingredients', v_created, 'chemistry', v_after);
END;
$function$;
ALTER FUNCTION public._ingredient_modes_input(jsonb,text) OWNER TO postgres;
ALTER FUNCTION public._parent_mode_groups(uuid) OWNER TO postgres;
ALTER FUNCTION public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text) OWNER TO postgres;
ALTER FUNCTION public._apply_parent_chemistry(uuid,jsonb,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._ingredient_modes_input(jsonb,text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public._parent_mode_groups(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public._apply_parent_chemistry(uuid,jsonb,text,text,text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text) TO authenticated;
DROP INDEX public.active_ingredient_modes_of_action_canonical_one_active;
DROP INDEX public.product_parent_modes_of_action_canonical_one_active;
DROP FUNCTION public._moa_group_code_key(text);
````
