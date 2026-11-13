-- idempotency-body-check: exempt
-- (set_active_ingredient_modes requires p_idempotency_key and checks it before any write with PAR-1's
--  _product_parent_replay(key, scope, fingerprint), which calls check_idempotency, then saves its receipt with
--  save_idempotency last, on every path, in the same transaction. The hook only recognises check_idempotency.)
-- Written 2026-11-12. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270108100000_ingredient_modes_of_action.md.
-- Re-read the live ledger before applying.
--
-- WHY: Product Master MOA-1, part 1 (database). docs/plans/2026-11-12-product-MOA1-BUILD-SHEET.md sections 3 and 4.
--   Each shared active ingredient carries one reviewed list of its resistance groups (FRAC, HRAC, IRAC); every
--   product containing it shows those groups, worked out when read, never copied onto the product. A salt or ester
--   with no list of its own shows its acid's list. A group typed on a product that disagrees stays showing and is
--   flagged (the D-L rule). Only admins edit; everyone with an active profile reads.
--
-- WHAT:
--   - active_ingredient_modes_of_action: one row per ingredient, scheme and group; retired, never deleted. RLS on;
--     active profiles read active rows, admins read all; no write grant to any role.
--   - set_active_ingredient_modes: admin, EXECUTE for authenticated. Replaces one ingredient's list, refuses a stale
--     list, logs one active_ingredient_events 'updated' row per change.
--   - get_parent_mode_groups: any active profile. A product parent's groups (sheet 3.3).
--   - get_ingredient_mode_users: admin. An ingredient's list and how many parents and sizes it feeds.
--   - Private helpers (no grants): _parent_mode_groups (CMP-2's filter will read it), _ingredient_mode_list,
--     _ingredient_modes_input, _ingredient_mode_reach.
--
-- NOT CHANGED: every existing table, column, row, grant, policy and trigger; DM-1, DM-1b and DM-4's functions
--   (the postflight proves fifteen of them unchanged); the EPA gate. Typed groups keep working as today.
--
-- LOCKS: the writer takes the ingredient-list advisory lock (hashtext('crx.active_ingredients'), the lock every
--   DM-1 ingredient and chemistry writer takes) BEFORE its replay check, so identical requests sent at once are
--   serialized. It takes no parent or product lock, so it cannot invert DM-1's order (parents, sizes, this lock).
--   It then locks the ingredient row FOR NO KEY UPDATE (not FOR UPDATE: that would also wait on any writer whose
--   foreign key holds a KEY SHARE lock on the row; the advisory lock already serializes every ingredient writer).
--   DM-1 writers take their retry-key lock before this lock, so one key sent at the same moment to this writer and
--   a DM-1 writer can end in Postgres's deadlock refusal instead of IDEMPOTENCY_CROSS_OP_KEY_REUSE; both refuse.
--
-- ROLLBACK (its own reviewed migration; SQL in the migrations.d record): revert the screen PR first; revoke EXECUTE
--   on the three public functions and SELECT on the table; drop the seven new functions (never CASCADE); keep the
--   table, unreadable, as history. Nothing outside the new table is written, except append-only ingredient events.
--
-- ORDERING: after 20270107100000_epa_long_name_keeps_cas_match (live) and every older migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE ingredient_modes_of_action_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

-- What MOA-1 must not touch (sheet 4.A): body, settings, owner, security mode and grants of each function, by name.
CREATE TEMP TABLE ingredient_modes_of_action_guard ON COMMIT DROP AS
SELECT p.proname::text AS name,
       md5(string_agg(p.oid::regprocedure::text || '|' || replace(p.prosrc, chr(13), '') || '|'
             || COALESCE(array_to_string(p.proconfig, ','), '') || '|' || p.proowner::regrole::text || '|'
             || p.prosecdef::text || '|' || COALESCE(p.proacl::text, ''), '#' ORDER BY p.oid::regprocedure::text)) AS fingerprint
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('_apply_parent_chemistry', '_parent_chemistry_values', '_check_parent_chemistry',
                     '_chemistry_kept_modes', '_parent_chemistry_epa_refusal', 'get_parent_chemistry',
                     'set_parent_chemistry', 'correct_parent_chemistry', '_ingredient_users',
                     '_ingredient_usage_fingerprint', 'get_active_ingredient_worklist', 'retire_active_ingredient',
                     'reactivate_active_ingredient', 'promote_chemistry_proposal', 'commit_epa_proposal')
 GROUP BY p.proname;

CREATE TEMP TABLE ingredient_modes_of_action_rows ON COMMIT DROP AS
SELECT 'product_parent_modes_of_action'::text AS tbl, count(*) AS n,
       md5(COALESCE(string_agg(m.id::text || ':' || m.status || ':' || m.row_version, ',' ORDER BY m.id), '')) AS fingerprint
  FROM public.product_parent_modes_of_action m
UNION ALL
SELECT 'active_ingredients', count(*),
       md5(COALESCE(string_agg(a.id::text || ':' || a.status || ':' || a.row_version, ',' ORDER BY a.id), ''))
  FROM public.active_ingredients a;

DO $preflight$
DECLARE v_tx text;
BEGIN
  -- Outside one transaction the ON COMMIT DROP table is already gone; read it dynamically so that case refuses
  -- by name instead of failing to plan.
  IF to_regclass('pg_temp.ingredient_modes_of_action_tx') IS NOT NULL THEN
    EXECUTE 'SELECT transaction_id FROM pg_temp.ingredient_modes_of_action_tx' INTO v_tx;
  END IF;
  IF v_tx IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'INGREDIENT_MODES_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.active_ingredient_modes_of_action') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                 AND proname IN ('set_active_ingredient_modes', 'get_parent_mode_groups', 'get_ingredient_mode_users',
                                 '_parent_mode_groups', '_ingredient_mode_list', '_ingredient_modes_input',
                                 '_ingredient_mode_reach')) THEN
    RAISE EXCEPTION 'INGREDIENT_MODES_PREFLIGHT: this file was already applied';
  END IF;
  IF to_regclass('public.active_ingredients') IS NULL OR to_regclass('public.active_ingredient_events') IS NULL
     OR to_regclass('public.product_parent_ingredients') IS NULL OR to_regclass('public.product_parent_modes_of_action') IS NULL
     OR to_regclass('public.product_parent_chemistry_state') IS NULL OR to_regclass('public.product_parent_members') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = 'product_parent_modes_of_action' AND column_name = 'source')
     OR to_regprocedure('public._product_parent_require_admin()') IS NULL
     OR to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public._active_ingredient_event(uuid,text,text,text,jsonb,jsonb)') IS NULL
     OR to_regprocedure('public.is_active_profile()') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'INGREDIENT_MODES_PREFLIGHT: DM-1 or PAR-1 objects missing';
  END IF;
  IF (SELECT count(*) FROM pg_temp.ingredient_modes_of_action_guard) <> 15 THEN
    RAISE EXCEPTION 'INGREDIENT_MODES_PREFLIGHT: expected the fifteen DM-1/DM-1b/DM-4 functions, found %',
      (SELECT count(*) FROM pg_temp.ingredient_modes_of_action_guard);
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. The table (sheet 3.1)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.active_ingredient_modes_of_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id uuid NOT NULL REFERENCES public.active_ingredients(id) ON DELETE RESTRICT,
  -- the same CHECKs as product_parent_modes_of_action, so the two compare exactly
  scheme text NOT NULL CHECK (scheme IN ('HRAC', 'FRAC', 'IRAC')),
  group_code text NOT NULL CHECK (group_code = upper(btrim(group_code)) AND group_code <> '' AND char_length(group_code) <= 10),
  source_note text NOT NULL CHECK (source_note = btrim(source_note) AND source_note <> '' AND char_length(source_note) <= 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.active_ingredient_modes_of_action OWNER TO postgres;
CREATE UNIQUE INDEX active_ingredient_modes_of_action_one_active
  ON public.active_ingredient_modes_of_action (ingredient_id, scheme, group_code) WHERE status = 'active';
CREATE INDEX active_ingredient_modes_of_action_ingredient_idx ON public.active_ingredient_modes_of_action (ingredient_id);
COMMENT ON TABLE public.active_ingredient_modes_of_action IS
  'MOA-1: one reviewed resistance group (FRAC, HRAC or IRAC) of one active ingredient. Every product containing the ingredient shows it, worked out when read. Retired, never deleted. Written only by set_active_ingredient_modes.';

ALTER TABLE public.active_ingredient_modes_of_action ENABLE ROW LEVEL SECURITY;
CREATE POLICY active_ingredient_modes_of_action_select ON public.active_ingredient_modes_of_action
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()) AND (status = 'active' OR (SELECT public.is_admin())));
REVOKE ALL ON TABLE public.active_ingredient_modes_of_action FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.active_ingredient_modes_of_action TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Private helpers
-- ---------------------------------------------------------------------------------------------

-- One ingredient's active list, [{scheme, group_code, source_note}], in display order: HRAC, FRAC, IRAC, then codes
-- sorted naturally (leading number, then text). The writer's input is sorted the same way, so the two compare exactly.
CREATE FUNCTION public._ingredient_mode_list(p_ingredient_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scheme', o.scheme, 'group_code', o.group_code, 'source_note', o.source_note)
           ORDER BY array_position(ARRAY['HRAC', 'FRAC', 'IRAC'], o.scheme),
                    regexp_replace(o.group_code, '[0-9].*$', ''), substring(o.group_code FROM '[0-9]+')::numeric, o.group_code), '[]'::jsonb)
    FROM public.active_ingredient_modes_of_action o
   WHERE o.ingredient_id = p_ingredient_id AND o.status = 'active';
$function$;

-- Natural order everywhere: letter prefix, then the first number, then the code (5 < 27; M3 < M10; 4A < 4B).
-- Checks and normalizes a list sent by the screen: an array of at most 10 {scheme, group_code, source_note}
-- objects, no other keys, no repeated scheme and code. Codes are upper-cased and trimmed (as DM-1 does); notes
-- trimmed. Returns it in _ingredient_mode_list's order.
CREATE FUNCTION public._ingredient_modes_input(p_modes jsonb, p_label text) RETURNS jsonb
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

-- The active parents, and the active sizes of those parents, whose shown groups this ingredient's list feeds:
-- parents with an active row of it, plus parents with an active row of a form naming it as acid that has no list
-- of its own (sheet 3.2 step 8, 3.3).
CREATE FUNCTION public._ingredient_mode_reach(p_ingredient_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  WITH parents AS (
    SELECT DISTINCT r.parent_id
      FROM public.product_parent_ingredients r
      JOIN public.product_parents pp ON pp.id = r.parent_id AND pp.is_active
     WHERE r.status = 'active'
       AND (r.ingredient_id = p_ingredient_id
            OR r.ingredient_id IN (SELECT f.id FROM public.active_ingredients f
                                    WHERE f.canonical_ingredient_id = p_ingredient_id
                                      AND NOT EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action o
                                                       WHERE o.ingredient_id = f.id AND o.status = 'active')))
  )
  SELECT jsonb_build_object(
    'parents_affected', (SELECT count(*) FROM parents),
    'products_affected', (SELECT count(DISTINCT m.product_id)
                            FROM public.product_parent_members m
                            JOIN public.products p ON p.id = m.product_id AND p.is_active
                           WHERE m.parent_id IN (SELECT parent_id FROM parents)));
$function$;

-- A product parent's groups (sheet 3.3 and 3.4). For each active ingredient row and each scheme: derived groups are
-- the ingredient's own list, or, when it has no list at all and names an acid, the acid's list (one step only);
-- typed groups are the parent's active product_parent_modes_of_action rows. Typed groups stay live; a typed set
-- that differs from the derived set is flagged. Active rows only. No grants: callers are the RPC below and CMP-2.
CREATE FUNCTION public._parent_mode_groups(p_parent_id uuid) RETURNS jsonb
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

-- ---------------------------------------------------------------------------------------------
-- 3. The writer (sheet 3.2)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.set_active_ingredient_modes(p_ingredient_id uuid, p_expected_modes jsonb, p_modes jsonb,
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

-- ---------------------------------------------------------------------------------------------
-- 4. Reads (sheet 3.4)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.get_parent_mode_groups(p_parent_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_profile() THEN RAISE EXCEPTION 'ACTIVE_USER_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_parents WHERE id = p_parent_id) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND';
  END IF;
  RETURN jsonb_build_object('parent_id', p_parent_id) || public._parent_mode_groups(p_parent_id);
END;
$function$;

CREATE FUNCTION public.get_ingredient_mode_users(p_ingredient_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_ingredient public.active_ingredients;
BEGIN
  PERFORM public._product_parent_require_admin();
  SELECT * INTO v_ingredient FROM public.active_ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'INGREDIENT_NOT_FOUND'; END IF;
  RETURN jsonb_build_object('ingredient_id', v_ingredient.id, 'name', v_ingredient.name, 'status', v_ingredient.status,
    'modes', public._ingredient_mode_list(p_ingredient_id)) || public._ingredient_mode_reach(p_ingredient_id);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. Owners and grants
-- ---------------------------------------------------------------------------------------------

DO $grants$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public._ingredient_mode_list(uuid)', 'public._ingredient_modes_input(jsonb,text)',
    'public._ingredient_mode_reach(uuid)', 'public._parent_mode_groups(uuid)',
    'public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text)', 'public.get_parent_mode_groups(uuid)',
    'public.get_ingredient_mode_users(uuid)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, metabase_ro', f);
  END LOOP;
END
$grants$;
GRANT EXECUTE ON FUNCTION public.set_active_ingredient_modes(uuid, jsonb, jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_parent_mode_groups(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ingredient_mode_users(uuid) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. Postflight (sheet 4.F)
-- ---------------------------------------------------------------------------------------------

DO $postflight$
DECLARE
  v_bad text;
  r text;
BEGIN
  -- The table: RLS on, owner postgres, one policy, SELECT for authenticated only, no write for anyone.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.active_ingredient_modes_of_action'::regclass)
     OR (SELECT relowner FROM pg_class WHERE oid = 'public.active_ingredient_modes_of_action'::regclass) <> 'postgres'::regrole
     OR (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.active_ingredient_modes_of_action'::regclass) <> 1
     OR NOT has_table_privilege('authenticated', 'public.active_ingredient_modes_of_action', 'SELECT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_INGREDIENT_MODES_TABLE_WRONG';
  END IF;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role', 'metabase_ro'] LOOP
    IF has_table_privilege(r, 'public.active_ingredient_modes_of_action', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_any_column_privilege(r, 'public.active_ingredient_modes_of_action', 'INSERT,UPDATE,REFERENCES')
       OR (r <> 'authenticated' AND has_table_privilege(r, 'public.active_ingredient_modes_of_action', 'SELECT')) THEN
      RAISE EXCEPTION 'POSTFLIGHT_INGREDIENT_MODES_TABLE_GRANTS_WRONG: %', r;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
             WHERE c.oid = 'public.active_ingredient_modes_of_action'::regclass AND a.grantee = 0)
     OR EXISTS (SELECT 1 FROM pg_attribute t, aclexplode(t.attacl) a
                WHERE t.attrelid = 'public.active_ingredient_modes_of_action'::regclass AND t.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTFLIGHT_INGREDIENT_MODES_TABLE_GRANTS_WRONG: PUBLIC or column grant';
  END IF;

  -- Functions: owner postgres, search_path pinned, the five that read or write as postgres are SECURITY DEFINER;
  -- EXECUTE only for authenticated, and only on the three public ones.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_ingredient_mode_list', '_ingredient_modes_input', '_ingredient_mode_reach', '_parent_mode_groups',
                       'set_active_ingredient_modes', 'get_parent_mode_groups', 'get_ingredient_mode_users')
     AND (p.proowner <> 'postgres'::regrole
          OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
          OR (p.proname <> '_ingredient_modes_input' AND NOT p.prosecdef)
          OR (p.proname IN ('set_active_ingredient_modes', 'get_parent_mode_groups', 'get_ingredient_mode_users')
              AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
          OR (p.proname NOT IN ('set_active_ingredient_modes', 'get_parent_mode_groups', 'get_ingredient_mode_users')
              AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
          OR has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('service_role', p.oid, 'EXECUTE')
          OR has_function_privilege('metabase_ro', p.oid, 'EXECUTE')
          OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
                      WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE'));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_INGREDIENT_MODES_FUNCTION_GRANTS_WRONG: %', v_bad; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('_ingredient_mode_list', '_ingredient_modes_input', '_ingredient_mode_reach', '_parent_mode_groups',
                       'set_active_ingredient_modes', 'get_parent_mode_groups', 'get_ingredient_mode_users')) <> 7 THEN
    RAISE EXCEPTION 'POSTFLIGHT_INGREDIENT_MODES_OVERLOADS';
  END IF;

  -- The fifteen DM-1/DM-1b/DM-4 functions and both row captures are unchanged.
  SELECT string_agg(g.name, ', ') INTO v_bad
    FROM pg_temp.ingredient_modes_of_action_guard g
   WHERE g.fingerprint IS DISTINCT FROM (
     SELECT md5(string_agg(p.oid::regprocedure::text || '|' || replace(p.prosrc, chr(13), '') || '|'
              || COALESCE(array_to_string(p.proconfig, ','), '') || '|' || p.proowner::regrole::text || '|'
              || p.prosecdef::text || '|' || COALESCE(p.proacl::text, ''), '#' ORDER BY p.oid::regprocedure::text))
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = g.name);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_INGREDIENT_MODES_TOUCHED_FUNCTIONS: %', v_bad; END IF;
  IF EXISTS (
    SELECT tbl, n, fingerprint FROM pg_temp.ingredient_modes_of_action_rows
    EXCEPT
    (SELECT 'product_parent_modes_of_action'::text, count(*),
            md5(COALESCE(string_agg(m.id::text || ':' || m.status || ':' || m.row_version, ',' ORDER BY m.id), ''))
       FROM public.product_parent_modes_of_action m
     UNION ALL
     SELECT 'active_ingredients', count(*),
            md5(COALESCE(string_agg(a.id::text || ':' || a.status || ':' || a.row_version, ',' ORDER BY a.id), ''))
       FROM public.active_ingredients a)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_INGREDIENT_MODES_ROWS_CHANGED';
  END IF;
END
$postflight$;
