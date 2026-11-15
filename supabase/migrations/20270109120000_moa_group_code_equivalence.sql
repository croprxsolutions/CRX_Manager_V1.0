-- idempotency-body-check: exempt
-- set_active_ingredient_modes retains its existing required-key replay/fingerprint and save_idempotency flow.
-- MOA-2: compare group identity without rewriting official/source spelling. The private EPA branch remains exact.
SET LOCAL lock_timeout = '10s';

-- Refuse autocommit execution so a failed preflight cannot leave helper objects behind.
CREATE TEMP TABLE moa_group_equivalence_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;
DO $transaction_guard$
DECLARE v_tx text;
BEGIN
  IF to_regclass('pg_temp.moa_group_equivalence_tx') IS NOT NULL THEN
    SELECT transaction_id INTO v_tx FROM pg_temp.moa_group_equivalence_tx;
  END IF;
  IF v_tx IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_NOT_IN_TRANSACTION: apply this migration as one transaction';
  END IF;
END
$transaction_guard$;

DO $preflight$
DECLARE v_ing_count integer; v_ing_rows bigint; v_ing_ids text; v_product_count integer; v_product_rows bigint; v_product_ids text;
BEGIN
  IF to_regclass('public.active_ingredient_modes_of_action') IS NULL
     OR to_regclass('public.product_parent_modes_of_action') IS NULL
     OR to_regprocedure('public._moa_group_code_key(text)') IS NOT NULL
     OR to_regclass('public.active_ingredient_modes_of_action_canonical_one_active') IS NOT NULL
     OR to_regclass('public.product_parent_modes_of_action_canonical_one_active') IS NOT NULL THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_PREFLIGHT: missing dependency or candidate objects already exist';
  END IF;
  LOCK TABLE public.active_ingredient_modes_of_action IN SHARE MODE;
  LOCK TABLE public.product_parent_modes_of_action IN SHARE MODE;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='_ingredient_modes_input') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='_parent_mode_groups') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='set_active_ingredient_modes') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='_apply_parent_chemistry') <> 1
     OR to_regprocedure('public._ingredient_modes_input(jsonb,text)') IS NULL
     OR to_regprocedure('public._parent_mode_groups(uuid)') IS NULL
     OR to_regprocedure('public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text)') IS NULL
     OR to_regprocedure('public._apply_parent_chemistry(uuid,jsonb,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_PREFLIGHT: required function overload count/signature drift';
  END IF;
  -- Pin the exact prior implementations, not just their signatures. Live plain-catalog and source hashes
  -- matched on 2026-11-14; normalize CRLF so the same body compares across migration line endings.
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid='public._ingredient_modes_input(jsonb,text)'::regprocedure), chr(13), ''))
        IS DISTINCT FROM 'c8833aee7021ae4cbabb82f71cf5aaec'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid='public._parent_mode_groups(uuid)'::regprocedure), chr(13), ''))
        IS DISTINCT FROM '8ea6f6f6f1684f487a382f46c9d9cfec'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid='public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text)'::regprocedure), chr(13), ''))
        IS DISTINCT FROM 'c2eef4d73dcc094fa651e1740bf86637'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid='public._apply_parent_chemistry(uuid,jsonb,text,text,text)'::regprocedure), chr(13), ''))
        IS DISTINCT FROM '4499d74183e546ade4e039a0e0596ca7' THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_SOURCE_DRIFT: one or more targeted function bodies differ from the verified prior implementation';
  END IF;
  IF to_regclass('public.active_ingredient_modes_of_action_one_active') IS NULL
     OR to_regclass('public.product_parent_modes_of_action_one_active') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.active_ingredient_modes_of_action_one_active'::regclass
                  AND indisunique AND indisvalid)
     OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.product_parent_modes_of_action_one_active'::regclass
                    AND indisunique AND indisvalid) THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_PREFLIGHT: existing exact indexes missing or invalid';
  END IF;
  -- Unchanged ON CONFLICT clauses infer these exact indexes; refuse a same-named index with a drifted definition.
  -- 'public.' is stripped because pg_get_indexdef qualifies names according to the current search_path.
  IF replace(pg_get_indexdef('public.active_ingredient_modes_of_action_one_active'::regclass), 'public.', '')
        IS DISTINCT FROM 'CREATE UNIQUE INDEX active_ingredient_modes_of_action_one_active ON active_ingredient_modes_of_action USING btree (ingredient_id, scheme, group_code) WHERE (status = ''active''::text)'
     OR replace(pg_get_indexdef('public.product_parent_modes_of_action_one_active'::regclass), 'public.', '')
        IS DISTINCT FROM 'CREATE UNIQUE INDEX product_parent_modes_of_action_one_active ON product_parent_modes_of_action USING btree (parent_id, ingredient_id, scheme, group_code) WHERE (status = ''active''::text)' THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_PREFLIGHT: existing exact index definition drift';
  END IF;

  SELECT count(*), COALESCE(sum(cardinality(ids)),0), left(string_agg(ingredient_id::text || '/' || scheme || ':' || array_to_string(ids, ','), '; '), 3500)
    INTO v_ing_count, v_ing_rows, v_ing_ids
    FROM (SELECT ingredient_id, scheme, array_agg(id::text ORDER BY id) ids
            FROM public.active_ingredient_modes_of_action
           WHERE status='active'
           GROUP BY ingredient_id, scheme,
             (CASE WHEN group_code COLLATE "C" ~ '^[A-Za-z0-9]+$'
                   THEN replace(regexp_replace(regexp_replace(group_code COLLATE "C", '(^|[^0-9])0+([0-9])', E'\\1\\2', 'g'),
                                                '(^|[^0-9])0+([^0-9]|$)', E'\\1\001\\2', 'g'), chr(1), '0')
                   ELSE group_code COLLATE "C" END) COLLATE "C"
          HAVING count(*) > 1) c;
  SELECT count(*), COALESCE(sum(cardinality(ids)),0), left(string_agg(parent_id::text || '/' || ingredient_id::text || '/' || scheme || ':' || array_to_string(ids, ','), '; '), 3500)
    INTO v_product_count, v_product_rows, v_product_ids
    FROM (SELECT parent_id, ingredient_id, scheme, array_agg(id::text ORDER BY id) ids
            FROM public.product_parent_modes_of_action
           WHERE status='active'
           GROUP BY parent_id, ingredient_id, scheme,
             (CASE WHEN group_code COLLATE "C" ~ '^[A-Za-z0-9]+$'
                   THEN replace(regexp_replace(regexp_replace(group_code COLLATE "C", '(^|[^0-9])0+([0-9])', E'\\1\\2', 'g'),
                                                '(^|[^0-9])0+([^0-9]|$)', E'\\1\001\\2', 'g'), chr(1), '0')
                   ELSE group_code COLLATE "C" END) COLLATE "C"
          HAVING count(*) > 1) c;
  IF v_ing_count > 0 OR v_product_count > 0 THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_COLLISIONS: ingredient groups=% rows=% ids=[%]; product groups=% rows=% ids=[%]',
      v_ing_count, v_ing_rows, COALESCE(v_ing_ids,''), v_product_count, v_product_rows, COALESCE(v_product_ids,'');
  END IF;
END
$preflight$;

-- Snapshot function ACL/config/ownership and row contents for postflight; no business rows are written.
CREATE TEMP TABLE moa_group_equivalence_function_before ON COMMIT DROP AS
SELECT p.proname, p.oid::regprocedure::text AS signature, md5(p.prosrc) AS body_md5,
       p.proowner, p.prosecdef, p.proconfig, p.proacl
  FROM pg_proc p
 WHERE p.pronamespace='public'::regnamespace
   AND p.proname IN ('_ingredient_modes_input','_parent_mode_groups','set_active_ingredient_modes','_apply_parent_chemistry');
CREATE TEMP TABLE moa_group_equivalence_rows_before ON COMMIT DROP AS
SELECT 'ingredient'::text AS scope, count(*)::bigint AS row_count,
       md5(COALESCE(string_agg(to_jsonb(m)::text, E'\n' ORDER BY m.id),'')) AS row_md5
  FROM public.active_ingredient_modes_of_action m
UNION ALL
SELECT 'product', count(*)::bigint, md5(COALESCE(string_agg(to_jsonb(m)::text, E'\n' ORDER BY m.id),''))
  FROM public.product_parent_modes_of_action m;

-- Comparison-only ASCII key; non-ASCII, punctuation, and whitespace-containing legacy codes remain exact.
CREATE FUNCTION public._moa_group_code_key(p_code text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = public, pg_temp AS $function$
  SELECT (CASE WHEN p_code COLLATE "C" ~ '^[A-Za-z0-9]+$'
               THEN replace(regexp_replace(regexp_replace(p_code COLLATE "C", '(^|[^0-9])0+([0-9])', E'\\1\\2', 'g'),
                                            '(^|[^0-9])0+([^0-9]|$)', E'\\1\001\\2', 'g'), chr(1), '0')
               ELSE p_code COLLATE "C" END) COLLATE "C";
$function$;
ALTER FUNCTION public._moa_group_code_key(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._moa_group_code_key(text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE OR REPLACE FUNCTION public._ingredient_modes_input(p_modes jsonb, p_label text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_entry jsonb;
  v_out jsonb := '[]'::jsonb;
  v_scheme text;
  v_code text;
  v_note text;
  v_prior_code text;
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
    SELECT o->>'group_code' INTO v_prior_code
      FROM jsonb_array_elements(v_out) o
     WHERE o->>'scheme' = v_scheme
       AND public._moa_group_code_key(o->>'group_code') = public._moa_group_code_key(v_code)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'CHEMISTRY_MOA_INVALID: % % is listed twice (same group as % %)',
        v_scheme, v_code, v_scheme, v_prior_code;
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
              FROM typed t WHERE t.ingredient_id = p.ingredient_id AND t.scheme = p.scheme) AS typed_rows,
           (SELECT array_agg(public._moa_group_code_key(d.group_code)
                      ORDER BY regexp_replace(public._moa_group_code_key(d.group_code), '[0-9].*$', ''),
                               substring(public._moa_group_code_key(d.group_code) FROM '[0-9]+')::numeric,
                               public._moa_group_code_key(d.group_code))
              FROM derived d WHERE d.ingredient_id = p.ingredient_id AND d.scheme = p.scheme) AS derived_keys,
           (SELECT array_agg(public._moa_group_code_key(t.group_code)
                      ORDER BY regexp_replace(public._moa_group_code_key(t.group_code), '[0-9].*$', ''),
                               substring(public._moa_group_code_key(t.group_code) FROM '[0-9]+')::numeric,
                               public._moa_group_code_key(t.group_code))
              FROM typed t WHERE t.ingredient_id = p.ingredient_id AND t.scheme = p.scheme) AS typed_keys
      FROM pairs p
  ), st AS (
    SELECT per.*,
           CASE WHEN typed_codes IS NULL THEN 'derived'
                WHEN derived_codes IS NULL THEN 'typed'
                WHEN typed_keys = derived_keys THEN 'matches'
                ELSE 'differs' END AS status,
           COALESCE(typed_codes, derived_codes) AS live
      FROM per
  ), summary AS (
    SELECT st.scheme, min(c.code COLLATE "C") AS code, bool_or(st.status = 'differs') AS differs
      FROM st CROSS JOIN LATERAL unnest(st.live) AS c(code)
     GROUP BY st.scheme, public._moa_group_code_key(c.code)
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
  v_current_code text;
  v_entry jsonb;
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

  -- A full replacement request may omit the existing spelling. Refuse a canonical alias before retiring or inserting rows.
  FOR v_entry IN SELECT e FROM jsonb_array_elements(v_modes) e LOOP
    SELECT m.group_code INTO v_current_code
      FROM public.active_ingredient_modes_of_action m
     WHERE m.ingredient_id = p_ingredient_id AND m.status = 'active' AND m.scheme = v_entry->>'scheme'
       AND public._moa_group_code_key(m.group_code) = public._moa_group_code_key(v_entry->>'group_code')
     LIMIT 1;
    IF FOUND AND v_current_code IS DISTINCT FROM v_entry->>'group_code' THEN
      RAISE EXCEPTION 'CHEMISTRY_MOA_INVALID: % % is already recorded as % %; retire the stored spelling before adding this spelling',
        v_entry->>'scheme', v_entry->>'group_code', v_entry->>'scheme', v_current_code;
    END IF;
  END LOOP;

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
  v_moa_key text;
  v_prior_code text;
  v_moa_seen jsonb := '{}'::jsonb;
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

  -- Same-request typed MOA duplicates refuse before any active-row lookup, so both submitted spellings are named.
  IF p_mode <> 'epa' THEN
    FOR v_entry IN SELECT e FROM jsonb_array_elements(p_changes) e
        WHERE e->>'kind' = 'mode_of_action' AND COALESCE(e->>'action', 'add') = 'add' LOOP
      v_code := upper(btrim(v_entry->>'group_code'));
      CONTINUE WHEN v_code IS NULL OR v_code = '' OR (v_entry->>'scheme') IS NULL; -- the main loop refuses the shape
      v_moa_key := CASE WHEN v_entry ? 'ingredient_ref' THEN v_refs->>(v_entry->>'ingredient_ref')
                        ELSE public._chemistry_uuid(v_entry->'ingredient_id', 'ingredient_id')::text END
        || ':' || (v_entry->>'scheme') || ':' || public._moa_group_code_key(v_code);
      IF v_moa_seen ? v_moa_key THEN
        RAISE EXCEPTION 'CHEMISTRY_DUPLICATE_CHANGE: % % and % % name the same mode of action in this save',
          v_entry->>'scheme', v_moa_seen->>v_moa_key, v_entry->>'scheme', v_code;
      END IF;
      v_moa_seen := v_moa_seen || jsonb_build_object(v_moa_key, v_code);
    END LOOP;
    v_moa_seen := '{}'::jsonb; -- the main loop rebuilds it as each add is applied
  END IF;

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
          -- If the kept row already has a canonically equivalent group, preserve that destination spelling and do not insert a duplicate.
          IF NOT EXISTS (SELECT 1 FROM public.product_parent_modes_of_action d
                          WHERE d.parent_id = p_parent_id AND d.ingredient_id = v_into.ingredient_id
                            AND d.scheme = v_moa.scheme AND d.status = 'active'
                            AND public._moa_group_code_key(d.group_code) = public._moa_group_code_key(v_moa.group_code)) THEN
            INSERT INTO public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code, source, created_by, updated_by)
            VALUES (p_parent_id, v_into.ingredient_id, v_moa.scheme, v_moa.group_code, 'typed', v_actor, v_actor)
            -- Typed again: the EPA lookup confirmed it for the old ingredient, not this one; a later lookup re-confirms it (Sol, 2026-11-08).
            ON CONFLICT (parent_id, ingredient_id, scheme, group_code) WHERE status = 'active' DO NOTHING;
          END IF;
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
      v_moa_key := v_ing::text || ':' || v_scheme || ':' ||
        CASE WHEN p_mode = 'epa' THEN v_code ELSE public._moa_group_code_key(v_code) END;
      IF p_mode <> 'epa' THEN
        IF v_moa_seen ? v_moa_key THEN
          v_prior_code := v_moa_seen->>v_moa_key;
          RAISE EXCEPTION 'CHEMISTRY_DUPLICATE_CHANGE: % % and % % name the same mode of action in this save',
            v_scheme, v_prior_code, v_scheme, v_code;
        END IF;
        v_moa_seen := v_moa_seen || jsonb_build_object(v_moa_key, v_code);
      END IF;
      v_touched := v_touched || ('moa:' || v_moa_key);
      -- EPA keeps its established exact-spelling lookup. Typed additions also look up canonical aliases and refuse them.
      SELECT * INTO v_moa FROM public.product_parent_modes_of_action WHERE parent_id = p_parent_id AND ingredient_id = v_ing
         AND scheme = v_scheme AND group_code = v_code AND status = 'active' FOR UPDATE;
      IF NOT FOUND AND p_mode <> 'epa' THEN
        SELECT * INTO v_moa FROM public.product_parent_modes_of_action WHERE parent_id = p_parent_id AND ingredient_id = v_ing
           AND scheme = v_scheme AND public._moa_group_code_key(group_code) = public._moa_group_code_key(v_code)
           AND status = 'active' FOR UPDATE;
      END IF;
      IF FOUND THEN
        IF p_mode <> 'epa' THEN
          IF v_moa.group_code IS DISTINCT FROM v_code THEN
            RAISE EXCEPTION 'CHEMISTRY_ROW_EXISTS: % % is already recorded as % %; retire the stored spelling before adding this spelling',
              v_scheme, v_code, v_scheme, v_moa.group_code;
          END IF;
          RAISE EXCEPTION 'CHEMISTRY_ROW_EXISTS: % % is already recorded', v_scheme, v_code;
        END IF;
        -- Preserve existing EPA behavior: only an exact spelling match confirms the stored row's source.
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

-- Existing exact-spelling indexes remain available to unchanged ON CONFLICT clauses.
CREATE UNIQUE INDEX active_ingredient_modes_of_action_canonical_one_active
  ON public.active_ingredient_modes_of_action (ingredient_id, scheme, (public._moa_group_code_key(group_code) COLLATE "C"))
  WHERE status = 'active';
CREATE UNIQUE INDEX product_parent_modes_of_action_canonical_one_active
  ON public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, (public._moa_group_code_key(group_code) COLLATE "C"))
  WHERE status = 'active';

ALTER FUNCTION public._ingredient_modes_input(jsonb,text) OWNER TO postgres;
ALTER FUNCTION public._parent_mode_groups(uuid) OWNER TO postgres;
ALTER FUNCTION public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text) OWNER TO postgres;
ALTER FUNCTION public._apply_parent_chemistry(uuid,jsonb,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._ingredient_modes_input(jsonb,text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public._parent_mode_groups(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public._apply_parent_chemistry(uuid,jsonb,text,text,text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text) TO authenticated;

DO $postflight$
DECLARE v_bad text;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='_moa_group_code_key') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
       ('_ingredient_modes_input','_parent_mode_groups','set_active_ingredient_modes','_apply_parent_chemistry')) <> 4 THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_POSTFLIGHT_OVERLOADS';
  END IF;
  IF (SELECT proowner FROM pg_proc WHERE oid='public._moa_group_code_key(text)'::regprocedure) <> 'postgres'::regrole
     OR (SELECT prosecdef FROM pg_proc WHERE oid='public._moa_group_code_key(text)'::regprocedure)
     OR (SELECT proconfig FROM pg_proc WHERE oid='public._moa_group_code_key(text)'::regprocedure) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('anon','public._moa_group_code_key(text)','EXECUTE')
     OR has_function_privilege('authenticated','public._moa_group_code_key(text)','EXECUTE')
     OR has_function_privilege('service_role','public._moa_group_code_key(text)','EXECUTE')
     OR has_function_privilege('metabase_ro','public._moa_group_code_key(text)','EXECUTE')
     OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(
          (SELECT proacl FROM pg_proc WHERE oid='public._moa_group_code_key(text)'::regprocedure),
          acldefault('f', 'postgres'::regrole))) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_POSTFLIGHT_HELPER_GRANTS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_temp.moa_group_equivalence_function_before b JOIN pg_proc p ON p.oid=b.signature::regprocedure
              WHERE p.proowner IS DISTINCT FROM b.proowner OR p.prosecdef IS DISTINCT FROM b.prosecdef
                 OR p.proconfig IS DISTINCT FROM b.proconfig OR p.proacl IS DISTINCT FROM b.proacl) THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_POSTFLIGHT_FUNCTION_SECURITY';
  END IF;
  IF EXISTS (
    SELECT scope,row_count,row_md5 FROM pg_temp.moa_group_equivalence_rows_before
    EXCEPT
    (SELECT 'ingredient'::text,count(*)::bigint,md5(COALESCE(string_agg(to_jsonb(m)::text,E'\n' ORDER BY m.id),'')) FROM public.active_ingredient_modes_of_action m
     UNION ALL SELECT 'product',count(*)::bigint,md5(COALESCE(string_agg(to_jsonb(m)::text,E'\n' ORDER BY m.id),'')) FROM public.product_parent_modes_of_action m)
  ) THEN RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_POSTFLIGHT_ROWS_CHANGED'; END IF;
  IF NOT (SELECT indisunique AND indisvalid FROM pg_index WHERE indexrelid='public.active_ingredient_modes_of_action_canonical_one_active'::regclass)
     OR NOT (SELECT indisunique AND indisvalid FROM pg_index WHERE indexrelid='public.product_parent_modes_of_action_canonical_one_active'::regclass)
     OR NOT (SELECT indisunique AND indisvalid FROM pg_index WHERE indexrelid='public.active_ingredient_modes_of_action_one_active'::regclass)
     OR NOT (SELECT indisunique AND indisvalid FROM pg_index WHERE indexrelid='public.product_parent_modes_of_action_one_active'::regclass) THEN
    RAISE EXCEPTION 'MOA_GROUP_EQUIVALENCE_POSTFLIGHT_INDEXES';
  END IF;
END
$postflight$;
