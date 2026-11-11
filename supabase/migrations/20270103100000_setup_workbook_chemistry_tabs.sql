-- idempotency-body-check: exempt (every writer checks its key through _product_parent_replay, which calls check_idempotency, as DM-1 and DM-2 do)
-- DM-1b: the setup workbook's Weights and Ingredients tabs (docs/plans/2026-11-10-product-DM1b-BUILD-SHEET.md).
--
-- New, all admin-only, SECURITY DEFINER, search_path pinned:
--   * chemistry_change_proposals: one row per parent per Ingredients upload. RLS on, SELECT for admins, no
--     write grant: only commit_ingredients_tab inserts and promote_chemistry_proposal decides.
--   * get_setup_workbook_chemistry(): the download for both tabs.
--   * preview_weights_tab(rows) / commit_weights_tab(rows, key): weight per gallon (liquid parents) and net
--     weight (dry sizes stocked by the pack). Saves only through DM-2's private draft helpers, as DRAFTS that
--     approve_weights must still approve. All-or-nothing; a stale or invalid row refuses the whole save.
--   * preview_ingredients_tab(rows) / commit_ingredients_tab(rows, key): ingredient rows per parent. Commit
--     writes PROPOSALS only; nothing live changes. Absent rows change nothing; a delete needs __delete.
--   * promote_chemistry_proposal(id, version, decision, key): apply / apply_delete / reject. Applies through
--     DM-1's _lock_parent_chemistry and _apply_parent_chemistry, which re-run the EPA gate (D-Z).
-- No existing object is changed or re-issued; no grant on an existing object changes.
-- Rollback (its own reviewed migration): revoke EXECUTE on the six public functions and SELECT on the table,
-- then drop the functions. The table is kept, unreadable, as history.

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regclass('public.chemistry_change_proposals') IS NOT NULL
     OR to_regprocedure('public.get_setup_workbook_chemistry()') IS NOT NULL
     OR to_regprocedure('public.preview_weights_tab(jsonb)') IS NOT NULL
     OR to_regprocedure('public.commit_weights_tab(jsonb,text)') IS NOT NULL
     OR to_regprocedure('public.preview_ingredients_tab(jsonb)') IS NOT NULL
     OR to_regprocedure('public.commit_ingredients_tab(jsonb,text)') IS NOT NULL
     OR to_regprocedure('public.promote_chemistry_proposal(uuid,integer,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DM1B_ALREADY_EXISTS';
  END IF;
  IF to_regprocedure('public._save_parent_density_draft(uuid,bigint,numeric,text,text,text,text,text)') IS NULL
     OR to_regprocedure('public._save_size_net_weight_draft(uuid,bigint,numeric,text,text,text,text)') IS NULL
     OR to_regprocedure('public._weight_unit_factors()') IS NULL
     OR to_regprocedure('public._lock_parent_chemistry(uuid,bigint)') IS NULL
     OR to_regprocedure('public._apply_parent_chemistry(uuid,jsonb,text,text,text)') IS NULL
     OR to_regprocedure('public._parent_chemistry_epa_refusal(uuid)') IS NULL
     OR to_regprocedure('public._chemistry_strength(jsonb,text)') IS NULL
     OR to_regprocedure('public._chemistry_uuid(jsonb,text)') IS NULL
     OR to_regprocedure('public._product_parent_require_admin()') IS NULL
     OR to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regclass('public.product_parent_density_state') IS NULL
     OR to_regclass('public.product_size_net_weight_state') IS NULL
     OR to_regclass('public.product_parent_chemistry_state') IS NULL
     OR to_regclass('public.product_parent_ingredients') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DM1B_DEPENDENCY_MISSING';
  END IF;
END;
$preflight$;

CREATE TABLE public.chemistry_change_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  -- The change list in _apply_parent_chemistry's shape; each add or change carries its source and source note.
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 200),
  has_delete boolean NOT NULL,
  base_chemistry_version bigint NOT NULL CHECK (base_chemistry_version >= 0),
  proposal_version integer NOT NULL DEFAULT 1 CHECK (proposal_version >= 1),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'rejected')),
  applied_chemistry_version bigint,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chemistry_change_proposals_decision CHECK (
    (status = 'proposed' AND decided_by IS NULL AND decided_at IS NULL AND applied_chemistry_version IS NULL)
    OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND applied_chemistry_version IS NULL)
    OR (status = 'applied' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND applied_chemistry_version IS NOT NULL))
);
ALTER TABLE public.chemistry_change_proposals OWNER TO postgres;
CREATE INDEX chemistry_change_proposals_parent_idx ON public.chemistry_change_proposals (parent_id, created_at DESC);
CREATE INDEX chemistry_change_proposals_open_idx ON public.chemistry_change_proposals (created_at) WHERE status = 'proposed';
COMMENT ON TABLE public.chemistry_change_proposals IS
  'DM-1b: an Ingredients-tab upload for one parent, waiting for review. Written only by commit_ingredients_tab and promote_chemistry_proposal.';
ALTER TABLE public.chemistry_change_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY chemistry_change_proposals_admin_select ON public.chemistry_change_proposals
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
REVOKE ALL ON TABLE public.chemistry_change_proposals FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.chemistry_change_proposals TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Download
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.get_setup_workbook_chemistry() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_units jsonb;
BEGIN
  PERFORM public._product_parent_require_admin();
  v_units := public._weight_unit_factors()->'factors';
  RETURN jsonb_build_object(
    'densities', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('parent_id', pp.id, 'parent_name', pp.name,
          'version', COALESCE(s.density_version, 0),
          'approved', (SELECT jsonb_build_object('lb_per_gal', v.lb_per_gal::text, 'source', v.source, 'source_note', v.source_note)
                         FROM public.product_parent_density_values v WHERE v.parent_id = pp.id AND v.review_state = 'approved'),
          'draft', (SELECT jsonb_build_object('lb_per_gal', v.lb_per_gal::text, 'source', v.source, 'source_note', v.source_note)
                      FROM public.product_parent_density_values v WHERE v.parent_id = pp.id AND v.review_state = 'draft'))
        ORDER BY lower(pp.name), pp.id)
        FROM public.product_parents pp
        LEFT JOIN public.product_parent_density_state s ON s.parent_id = pp.id
       WHERE pp.is_active AND pp.product_form = 'liquid'), '[]'::jsonb),
    'net_weights', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('product_id', p.id, 'product_name', p.product_name,
          'inventory_unit', p.inventory_unit, 'version', COALESCE(s.net_weight_version, 0),
          'approved', (SELECT jsonb_build_object('net_lb', v.net_lb::text, 'source', v.source, 'source_note', v.source_note)
                         FROM public.product_size_net_weight_values v WHERE v.product_id = p.id AND v.review_state = 'approved'),
          'draft', (SELECT jsonb_build_object('net_lb', v.net_lb::text, 'source', v.source, 'source_note', v.source_note)
                      FROM public.product_size_net_weight_values v WHERE v.product_id = p.id AND v.review_state = 'draft'))
        ORDER BY lower(p.product_name), p.id)
        FROM public.products p
        LEFT JOIN public.product_size_net_weight_state s ON s.product_id = p.id
       WHERE COALESCE(p.is_active, false) AND p.product_form = 'dry'
         AND v_units->lower(btrim(COALESCE(p.inventory_unit, '')))->>'kind' = 'count'), '[]'::jsonb),
    'parents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('parent_id', pp.id, 'parent_name', pp.name,
          'chemistry_version', COALESCE(s.chemistry_version, 0),
          'epa_refusal', public._parent_chemistry_epa_refusal(pp.id),
          'ingredients', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('row_id', r.id, 'name', a.name, 'cas', a.cas,
                'strength_value', r.strength_value::text, 'strength_unit', r.strength_unit,
                'strength_basis', r.strength_basis, 'source', r.source, 'source_note', r.source_note)
              ORDER BY lower(a.name), r.id)
              FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id
             WHERE r.parent_id = pp.id AND r.status = 'active'), '[]'::jsonb))
        ORDER BY lower(pp.name), pp.id)
        FROM public.product_parents pp
        LEFT JOIN public.product_parent_chemistry_state s ON s.parent_id = pp.id
       WHERE pp.is_active), '[]'::jsonb));
END;
$function$;
ALTER FUNCTION public.get_setup_workbook_chemistry() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_setup_workbook_chemistry() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_setup_workbook_chemistry() TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Weights tab
-- ---------------------------------------------------------------------------------------------

-- Optional text field of a row: absent or JSON null is NULL; anything but a string is refused.
CREATE FUNCTION public._workbook_text(p_row jsonb, p_key text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
BEGIN
  IF COALESCE(jsonb_typeof(p_row->p_key), 'null') = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_row->p_key) <> 'string' THEN RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: % must be text', p_key; END IF;
  RETURN NULLIF(btrim(p_row->>p_key), '');
END;
$function$;
ALTER FUNCTION public._workbook_text(jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._workbook_text(jsonb, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- A whole JSON number from 0 to the bigint maximum, checked before any cast (1.2 or 1e30 refused, never rounded).
CREATE FUNCTION public._workbook_version(p_row jsonb, p_key text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v numeric;
BEGIN
  IF jsonb_typeof(p_row->p_key) IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: % must be the number from the download', p_key;
  END IF;
  v := (p_row->p_key)::numeric;
  IF v <> trunc(v) OR v < 0 OR v > 9223372036854775807 THEN
    RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: % must be the number from the download', p_key;
  END IF;
  RETURN v::bigint;
END;
$function$;
ALTER FUNCTION public._workbook_version(jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._workbook_version(jsonb, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- One Weights-tab row: {kind, subject_id, expected_version, value, unit (density only), source, source_note,
-- reason, evidence}. Returns its status: unchanged / change / stale / invalid / not_found. The change is
-- rehearsed through the real DM-2 draft helper and always rolled back, so "invalid" carries DM-2's own refusal.
CREATE FUNCTION public._workbook_weight_row(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_kind text;
  v_id uuid;
  v_expected bigint;
  v_value numeric;
  v_unit text;
  v_source text;
  v_note text;
  v_reason text;
  v_evidence text;
  v_name text;
  v_version bigint;
  v_cur_value numeric;
  v_cur_source text;
  v_cur_note text;
  v_new numeric;
  v_out jsonb;
BEGIN
  BEGIN
    IF p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: each row is an object'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_row) k WHERE k NOT IN ('kind', 'subject_id', 'expected_version', 'value',
                 'unit', 'source', 'source_note', 'reason', 'evidence')) THEN
      RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: unexpected field';
    END IF;
    v_kind := p_row->>'kind';
    IF jsonb_typeof(p_row->'kind') IS DISTINCT FROM 'string' OR v_kind NOT IN ('density', 'net_weight') THEN
      RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: kind is density or net_weight';
    END IF;
    v_id := public._chemistry_uuid(p_row->'subject_id', 'subject_id');
    v_expected := public._workbook_version(p_row, 'expected_version');
    IF jsonb_typeof(p_row->'value') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_VALUE: enter a number'; END IF;
    v_value := (p_row->'value')::numeric;
    v_unit := public._workbook_text(p_row, 'unit');
    IF v_kind = 'net_weight' AND v_unit IS NOT NULL THEN RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: a net weight is always in lb'; END IF;
    -- The download stores lb/gal, so a density row with the unit left blank means lb/gal.
    IF v_kind = 'density' THEN v_unit := COALESCE(v_unit, 'lb_per_gal'); END IF;
    v_source := public._workbook_text(p_row, 'source');
    v_note := public._workbook_text(p_row, 'source_note');
    v_reason := public._workbook_text(p_row, 'reason');
    v_evidence := public._workbook_text(p_row, 'evidence');
  EXCEPTION WHEN raise_exception OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
    RETURN jsonb_build_object('kind', v_kind, 'subject_id', v_id, 'status', 'invalid', 'problem', SQLERRM);
  END;

  IF v_kind = 'density' THEN
    SELECT pp.name, COALESCE(s.density_version, 0) INTO v_name, v_version
      FROM public.product_parents pp LEFT JOIN public.product_parent_density_state s ON s.parent_id = pp.id WHERE pp.id = v_id;
    SELECT v.lb_per_gal, v.source, v.source_note INTO v_cur_value, v_cur_source, v_cur_note
      FROM public.product_parent_density_values v WHERE v.parent_id = v_id AND v.review_state IN ('draft', 'approved')
     ORDER BY (v.review_state = 'draft') DESC LIMIT 1;
    v_new := round(CASE v_unit WHEN 'specific_gravity' THEN v_value * 8.345404 ELSE v_value END, 4);
  ELSE
    SELECT p.product_name, COALESCE(s.net_weight_version, 0) INTO v_name, v_version
      FROM public.products p LEFT JOIN public.product_size_net_weight_state s ON s.product_id = p.id WHERE p.id = v_id;
    SELECT v.net_lb, v.source, v.source_note INTO v_cur_value, v_cur_source, v_cur_note
      FROM public.product_size_net_weight_values v WHERE v.product_id = v_id AND v.review_state IN ('draft', 'approved')
     ORDER BY (v.review_state = 'draft') DESC LIMIT 1;
    v_new := round(v_value, 4);
  END IF;
  v_out := jsonb_build_object('kind', v_kind, 'subject_id', v_id, 'name', v_name, 'expected_version', v_expected,
    'before', CASE WHEN v_cur_value IS NOT NULL THEN jsonb_build_object('value', v_cur_value::text, 'source', v_cur_source, 'source_note', v_cur_note) END,
    'after', jsonb_build_object('value', v_new::text, 'source', v_source, 'source_note', v_note));
  IF v_name IS NULL THEN RETURN v_out || jsonb_build_object('status', 'not_found', 'problem', 'no such product'); END IF;
  IF v_version <> v_expected THEN
    RETURN v_out || jsonb_build_object('status', 'stale', 'problem', 'changed by someone else since you downloaded it');
  END IF;
  -- The value the download showed (the open draft, else the approved one), same source and note: nothing to save.
  IF v_cur_value IS NOT NULL AND v_cur_value = v_new AND v_cur_source IS NOT DISTINCT FROM v_source
     AND v_cur_note IS NOT DISTINCT FROM v_note AND (v_kind = 'net_weight' OR COALESCE(v_unit, '') IN ('lb_per_gal', 'specific_gravity')) THEN
    RETURN v_out || jsonb_build_object('status', 'unchanged');
  END IF;
  BEGIN
    IF v_kind = 'density' THEN
      PERFORM public._save_parent_density_draft(v_id, v_expected, v_value, v_unit, v_source, v_note, v_reason, v_evidence);
    ELSE
      PERFORM public._save_size_net_weight_draft(v_id, v_expected, v_value, v_source, v_note, v_reason, v_evidence);
    END IF;
    RAISE EXCEPTION 'CRX_PREVIEW_ROLLBACK' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN NULL;
    WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation
         OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
      RETURN v_out || jsonb_build_object('status', 'invalid', 'problem', SQLERRM);
  END;
  RETURN v_out || jsonb_build_object('status', 'change', 'request', jsonb_build_object('value', v_value, 'unit', v_unit,
    'source', v_source, 'source_note', v_note, 'reason', v_reason, 'evidence', v_evidence));
END;
$function$;
ALTER FUNCTION public._workbook_weight_row(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._workbook_weight_row(jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public._workbook_weight_rows(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_res jsonb;
  v_row jsonb;
  v_seen text[] := '{}';
  v_key text;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'WORKBOOK_ROWS_REQUIRED: send 1 to 2000 rows';
  END IF;
  FOR v_row IN SELECT e FROM jsonb_array_elements(p_rows) e LOOP
    v_res := public._workbook_weight_row(v_row);
    v_key := (v_res->>'kind') || ':' || (v_res->>'subject_id');
    IF v_res->>'subject_id' IS NOT NULL AND v_key = ANY (v_seen) THEN
      v_res := v_res || jsonb_build_object('status', 'invalid', 'problem', 'this product is on the tab twice');
    END IF;
    v_seen := v_seen || v_key;
    v_out := v_out || jsonb_build_array(v_res);
  END LOOP;
  RETURN v_out;
END;
$function$;
ALTER FUNCTION public._workbook_weight_rows(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._workbook_weight_rows(jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Read-only (every rehearsal is rolled back). VOLATILE because of the rehearsal.
CREATE FUNCTION public.preview_weights_tab(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();
  RETURN jsonb_build_object('rows', (SELECT COALESCE(jsonb_agg(r - 'request'), '[]'::jsonb)
                                       FROM jsonb_array_elements(public._workbook_weight_rows(p_rows)) r));
END;
$function$;
ALTER FUNCTION public.preview_weights_tab(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_weights_tab(jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.preview_weights_tab(jsonb) TO authenticated;

-- All or nothing. Subjects are locked in DM-2's order (every parent, then every size, each in ID order) before
-- any version row; the helpers then re-check each version under that lock.
CREATE FUNCTION public.commit_weights_tab(p_rows jsonb, p_idempotency_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', v_actor, 'rows', p_rows)::text);
  v_existing jsonb;
  v_rows jsonb;
  v_bad text;
  v_r jsonb;
  v_q jsonb;
  v_saved jsonb := '[]'::jsonb;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'commit_weights_tab', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_rows := public._workbook_weight_rows(p_rows);
  -- Lock every subject on the tab (unchanged rows too), then evaluate again under the lock, so a row that went
  -- stale after the first look refuses the whole save instead of slipping through.
  PERFORM 1 FROM public.product_parents WHERE id IN (
    SELECT (r->>'subject_id')::uuid FROM jsonb_array_elements(v_rows) r WHERE r->>'subject_id' IS NOT NULL AND r->>'kind' = 'density')
   ORDER BY id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.products WHERE id IN (
    SELECT (r->>'subject_id')::uuid FROM jsonb_array_elements(v_rows) r WHERE r->>'subject_id' IS NOT NULL AND r->>'kind' = 'net_weight')
   ORDER BY id FOR NO KEY UPDATE;
  v_rows := public._workbook_weight_rows(p_rows);
  SELECT string_agg(COALESCE(r->>'name', r->>'subject_id', 'a row') || ': ' || (r->>'problem'), '; ')
    INTO v_bad FROM jsonb_array_elements(v_rows) r WHERE r->>'status' NOT IN ('unchanged', 'change');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'WORKBOOK_WEIGHTS_REFUSED: nothing was saved. %', v_bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'status' = 'change') THEN
    RAISE EXCEPTION 'WORKBOOK_NOTHING_TO_SAVE: no weight in this tab differs from the download';
  END IF;
  FOR v_r IN SELECT r FROM jsonb_array_elements(v_rows) r WHERE r->>'status' = 'change'
              ORDER BY (r->>'kind' = 'net_weight'), (r->>'subject_id')::uuid LOOP
    v_q := v_r->'request';
    v_saved := v_saved || jsonb_build_array(CASE v_r->>'kind'
      WHEN 'density' THEN public._save_parent_density_draft((v_r->>'subject_id')::uuid, (v_r->>'expected_version')::bigint,
        (v_q->>'value')::numeric, v_q->>'unit', v_q->>'source', v_q->>'source_note', v_q->>'reason', v_q->>'evidence')
      ELSE public._save_size_net_weight_draft((v_r->>'subject_id')::uuid, (v_r->>'expected_version')::bigint,
        (v_q->>'value')::numeric, v_q->>'source', v_q->>'source_note', v_q->>'reason', v_q->>'evidence')
      END || jsonb_build_object('name', v_r->>'name'));
  END LOOP;
  v_receipt := jsonb_build_object('saved_count', jsonb_array_length(v_saved), 'saved', v_saved);
  PERFORM public.save_idempotency(p_idempotency_key, 'commit_weights_tab',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.commit_weights_tab(jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.commit_weights_tab(jsonb, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.commit_weights_tab(jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Ingredients tab
-- ---------------------------------------------------------------------------------------------

-- Applies a change list to a parent the caller has locked with _lock_parent_chemistry: corrections (change,
-- retire) first, then adds. _apply_parent_chemistry runs the EPA gate and the inactive-parent rule itself.
CREATE FUNCTION public._workbook_apply_items(p_parent_id uuid, p_items jsonb, p_reason text, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_fix jsonb := (SELECT jsonb_agg(i ORDER BY o) FROM jsonb_array_elements(p_items) WITH ORDINALITY t(i, o) WHERE i->>'action' <> 'add');
  v_add jsonb := (SELECT jsonb_agg(i ORDER BY o) FROM jsonb_array_elements(p_items) WITH ORDINALITY t(i, o) WHERE i->>'action' = 'add');
  v_res jsonb;
BEGIN
  IF v_fix IS NOT NULL THEN v_res := public._apply_parent_chemistry(p_parent_id, v_fix, 'correct', p_reason, p_evidence); END IF;
  IF v_add IS NOT NULL THEN v_res := public._apply_parent_chemistry(p_parent_id, v_add, 'set', p_reason, p_evidence); END IF;
  RETURN v_res;
END;
$function$;
ALTER FUNCTION public._workbook_apply_items(uuid, jsonb, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._workbook_apply_items(uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- One parent's rows: {parent_id, expected_chemistry_version, row_id (null = new), delete, name, cas,
-- strength_value (number, or null = unknown), strength_unit, strength_basis, source, source_note}.
-- Returns unchanged / proposal (with items) / stale / refused / invalid / not_found. A proposal is rehearsed
-- through the real apply and rolled back, so "invalid" carries DM-1's own refusal.
CREATE FUNCTION public._workbook_ingredient_parent(p_parent_id uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent record;
  v_version bigint;
  v_expected bigint;
  v_refusal text;
  v_row jsonb;
  v_rid uuid;
  v_delete boolean;
  v_cur record;
  v_items jsonb := '[]'::jsonb;
  v_seen uuid[] := '{}';
  v_name text;
  v_cas text;
  v_note text;
  v_strength jsonb;
  v_out jsonb;
BEGIN
  SELECT id, name INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('parent_id', p_parent_id, 'status', 'not_found', 'problem', 'no such product');
  END IF;
  v_version := COALESCE((SELECT chemistry_version FROM public.product_parent_chemistry_state WHERE parent_id = p_parent_id), 0);
  v_out := jsonb_build_object('parent_id', p_parent_id, 'parent_name', v_parent.name, 'chemistry_version', v_version);
  BEGIN
    FOR v_row IN SELECT e FROM jsonb_array_elements(p_rows) e LOOP
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN ('parent_id', 'expected_chemistry_version', 'row_id',
                   'delete', 'name', 'cas', 'strength_value', 'strength_unit', 'strength_basis', 'source', 'source_note')) THEN
        RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: unexpected field';
      END IF;
      IF v_expected IS NULL THEN
        v_expected := public._workbook_version(v_row, 'expected_chemistry_version');
      ELSIF public._workbook_version(v_row, 'expected_chemistry_version') <> v_expected THEN
        RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: its rows carry different versions; download a fresh workbook';
      END IF;
      IF COALESCE(jsonb_typeof(v_row->'delete'), 'null') NOT IN ('null', 'boolean') THEN
        RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: delete must be true or false';
      END IF;
      v_delete := COALESCE((v_row->>'delete')::boolean, false);
      v_name := public._workbook_text(v_row, 'name');
      v_cas := public._workbook_text(v_row, 'cas');
      v_note := public._workbook_text(v_row, 'source_note');
      IF COALESCE(jsonb_typeof(v_row->'row_id'), 'null') = 'null' THEN
        IF v_delete THEN RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: __delete needs a row from the download'; END IF;
        IF v_note IS NULL THEN
          RAISE EXCEPTION 'WORKBOOK_SOURCE_REQUIRED: % needs its source document in the source note', COALESCE(v_name, 'a new row');
        END IF;
        v_strength := public._chemistry_strength(v_row, 'set');
        v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('kind', 'ingredient', 'action', 'add',
          'name', COALESCE(v_name, ''), 'cas', v_cas))
          || jsonb_build_object('strength_value', v_row->'strength_value', 'strength_unit', v_strength->>'unit',
               'strength_basis', v_strength->>'basis', 'source', v_strength->>'source', 'source_note', v_note));
      ELSE
        v_rid := public._chemistry_uuid(v_row->'row_id', 'row_id');
        IF v_rid = ANY (v_seen) THEN RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: an ingredient row is on the tab twice'; END IF;
        v_seen := v_seen || v_rid;
        SELECT r.id, r.strength_value, r.strength_unit, r.strength_basis, r.source, r.source_note, a.name, a.cas INTO v_cur
          FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id
         WHERE r.id = v_rid AND r.parent_id = p_parent_id AND r.status = 'active';
        IF NOT FOUND THEN RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: an ingredient row is no longer on this product'; END IF;
        IF v_delete THEN
          v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'ingredient', 'action', 'retire', 'row_id', v_rid));
        ELSE
          IF v_name IS DISTINCT FROM v_cur.name OR v_cas IS DISTINCT FROM v_cur.cas THEN
            RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: % cannot be renamed here; mark the row __delete and add the new ingredient as a new row', v_cur.name;
          END IF;
          -- A row filled by the EPA lookup comes back unchanged on a whole-tab re-upload; it cannot be edited here.
          IF v_cur.source = 'epa_lookup' THEN
            IF NOT ((v_row->>'strength_value')::numeric IS NOT DISTINCT FROM v_cur.strength_value
                    AND public._workbook_text(v_row, 'strength_unit') IS NOT DISTINCT FROM v_cur.strength_unit
                    AND public._workbook_text(v_row, 'strength_basis') IS NOT DISTINCT FROM v_cur.strength_basis
                    AND public._workbook_text(v_row, 'source') = 'epa_lookup' AND v_note IS NOT DISTINCT FROM v_cur.source_note) THEN
              RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: % was filled from the EPA lookup; change it on the product page', v_cur.name;
            END IF;
            CONTINUE;
          END IF;
          v_strength := public._chemistry_strength(v_row, 'correct');
          IF NOT ((v_strength->>'value')::numeric IS NOT DISTINCT FROM v_cur.strength_value
                  AND v_strength->>'unit' = v_cur.strength_unit AND v_strength->>'basis' = v_cur.strength_basis
                  AND v_strength->>'source' = v_cur.source AND v_note IS NOT DISTINCT FROM v_cur.source_note) THEN
            IF v_note IS NULL THEN
              RAISE EXCEPTION 'WORKBOOK_SOURCE_REQUIRED: % needs its source document in the source note', v_cur.name;
            END IF;
            v_items := v_items || jsonb_build_array(jsonb_build_object('kind', 'ingredient', 'action', 'change', 'row_id', v_rid,
              'strength_value', v_row->'strength_value', 'strength_unit', v_strength->>'unit',
              'strength_basis', v_strength->>'basis', 'source', v_strength->>'source', 'source_note', v_note));
          END IF;
        END IF;
      END IF;
    END LOOP;
  EXCEPTION WHEN raise_exception OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
    RETURN v_out || jsonb_build_object('status', 'invalid', 'problem', SQLERRM);
  END;
  IF v_expected <> v_version THEN
    RETURN v_out || jsonb_build_object('status', 'stale', 'problem', 'its chemistry changed since you downloaded it');
  END IF;
  IF jsonb_array_length(v_items) = 0 THEN RETURN v_out || jsonb_build_object('status', 'unchanged'); END IF;
  v_refusal := public._parent_chemistry_epa_refusal(p_parent_id);
  IF v_refusal IS NOT NULL THEN RETURN v_out || jsonb_build_object('status', 'refused', 'problem', v_refusal); END IF;
  IF jsonb_array_length(v_items) > 200 THEN
    RETURN v_out || jsonb_build_object('status', 'invalid', 'problem', 'at most 200 ingredient changes per product');
  END IF;
  BEGIN
    PERFORM public._lock_parent_chemistry(p_parent_id, v_expected);
    PERFORM public._workbook_apply_items(p_parent_id, v_items, 'rehearsal', 'rehearsal');
    RAISE EXCEPTION 'CRX_PREVIEW_ROLLBACK' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN NULL;
    WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation
         OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
      RETURN v_out || jsonb_build_object('status', 'invalid', 'problem', SQLERRM, 'items', v_items);
  END;
  RETURN v_out || jsonb_build_object('status', 'proposal', 'items', v_items,
    'has_delete', EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) i WHERE i->>'action' = 'retire'));
END;
$function$;
ALTER FUNCTION public._workbook_ingredient_parent(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._workbook_ingredient_parent(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Groups the rows by parent (in parent-ID order) and evaluates each parent.
CREATE FUNCTION public._workbook_ingredient_rows(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_pid uuid;
  v_group jsonb;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'WORKBOOK_ROWS_REQUIRED: send 1 to 2000 rows';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e
              WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e->'parent_id') IS DISTINCT FROM 'string'
                 OR (e->>'parent_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'WORKBOOK_ROW_INVALID: every row needs the parent ID from the download';
  END IF;
  FOR v_pid, v_group IN SELECT (e->>'parent_id')::uuid, jsonb_agg(e ORDER BY o)
                          FROM jsonb_array_elements(p_rows) WITH ORDINALITY t(e, o)
                         GROUP BY (e->>'parent_id')::uuid ORDER BY 1 LOOP
    v_out := v_out || jsonb_build_array(public._workbook_ingredient_parent(v_pid, v_group));
  END LOOP;
  RETURN v_out;
END;
$function$;
ALTER FUNCTION public._workbook_ingredient_rows(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._workbook_ingredient_rows(jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Read-only (every rehearsal is rolled back, including any ingredient it would create).
CREATE FUNCTION public.preview_ingredients_tab(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();
  RETURN jsonb_build_object('parents', public._workbook_ingredient_rows(p_rows));
END;
$function$;
ALTER FUNCTION public.preview_ingredients_tab(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_ingredients_tab(jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.preview_ingredients_tab(jsonb) TO authenticated;

-- Writes proposals only (one per changed parent); live chemistry is untouched. All or nothing.
CREATE FUNCTION public.commit_ingredients_tab(p_rows jsonb, p_idempotency_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', v_actor, 'rows', p_rows)::text);
  v_existing jsonb;
  v_parents jsonb;
  v_bad text;
  v_proposals jsonb;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'commit_ingredients_tab', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_parents := public._workbook_ingredient_rows(p_rows);
  -- Take the chemistry writers' parent lock (FOR UPDATE, ID order), then evaluate again under it, so no proposal
  -- is written against a version that moved after the first look.
  PERFORM 1 FROM public.product_parents WHERE id IN (
    SELECT (p->>'parent_id')::uuid FROM jsonb_array_elements(v_parents) p WHERE p->>'parent_id' IS NOT NULL)
   ORDER BY id FOR UPDATE;
  v_parents := public._workbook_ingredient_rows(p_rows);
  SELECT string_agg(COALESCE(p->>'parent_name', p->>'parent_id') || ': ' || (p->>'problem'), '; ')
    INTO v_bad FROM jsonb_array_elements(v_parents) p WHERE p->>'status' NOT IN ('unchanged', 'proposal');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'WORKBOOK_INGREDIENTS_REFUSED: nothing was saved. %', v_bad; END IF;
  WITH ins AS (
    INSERT INTO public.chemistry_change_proposals (parent_id, items, has_delete, base_chemistry_version, created_by)
    SELECT (p->>'parent_id')::uuid, p->'items', (p->>'has_delete')::boolean, (p->>'chemistry_version')::bigint, v_actor
      FROM jsonb_array_elements(v_parents) p WHERE p->>'status' = 'proposal'
    RETURNING id, parent_id, has_delete, base_chemistry_version, proposal_version, jsonb_array_length(items) AS n)
  SELECT jsonb_agg(jsonb_build_object('proposal_id', id, 'parent_id', parent_id, 'has_delete', has_delete,
           'base_chemistry_version', base_chemistry_version, 'proposal_version', proposal_version, 'item_count', n)
           ORDER BY parent_id)
    INTO v_proposals FROM ins;
  IF v_proposals IS NULL THEN
    RAISE EXCEPTION 'WORKBOOK_NOTHING_TO_SAVE: no ingredient row in this tab differs from the download';
  END IF;
  v_receipt := jsonb_build_object('proposal_count', jsonb_array_length(v_proposals), 'proposals', v_proposals);
  PERFORM public.save_idempotency(p_idempotency_key, 'commit_ingredients_tab',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.commit_ingredients_tab(jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.commit_ingredients_tab(jsonb, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.commit_ingredients_tab(jsonb, text) TO authenticated;

-- Private: applies a proposal the caller holds FOR UPDATE. Re-checks status, decision and base version.
CREATE FUNCTION public._apply_chemistry_proposal(p_proposal_id uuid, p_decision text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_p public.chemistry_change_proposals;
  v_evidence text;
BEGIN
  SELECT * INTO v_p FROM public.chemistry_change_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND OR v_p.status <> 'proposed' THEN RAISE EXCEPTION 'CHEMISTRY_PROPOSAL_DECIDED: this proposal was already decided'; END IF;
  IF p_decision IS DISTINCT FROM (CASE WHEN v_p.has_delete THEN 'apply_delete' ELSE 'apply' END) THEN
    RAISE EXCEPTION 'CHEMISTRY_PROPOSAL_DECISION_INVALID';
  END IF;
  PERFORM public._lock_parent_chemistry(v_p.parent_id, v_p.base_chemistry_version);
  SELECT left('Workbook upload ' || v_p.id || '. Sources: ' || string_agg(DISTINCT (i->>'source') || ': ' || (i->>'source_note'), '; '), 1000)
    INTO v_evidence FROM jsonb_array_elements(v_p.items) i WHERE i ? 'source_note';
  RETURN public._workbook_apply_items(v_p.parent_id, v_p.items, 'Workbook upload reviewed and applied',
    COALESCE(v_evidence, 'Workbook upload ' || v_p.id || ': removal only'));
END;
$function$;
ALTER FUNCTION public._apply_chemistry_proposal(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._apply_chemistry_proposal(uuid, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public.promote_chemistry_proposal(p_proposal_id uuid, p_expected_proposal_version integer,
  p_decision text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', v_actor, 'proposal_id', p_proposal_id,
    'expected_proposal_version', p_expected_proposal_version, 'decision', p_decision)::text);
  v_existing jsonb;
  v_p public.chemistry_change_proposals;
  v_result jsonb;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'promote_chemistry_proposal', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('apply', 'apply_delete', 'reject') THEN
    RAISE EXCEPTION 'CHEMISTRY_PROPOSAL_DECISION_INVALID: the decision is apply, apply_delete or reject';
  END IF;
  SELECT * INTO v_p FROM public.chemistry_change_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHEMISTRY_PROPOSAL_NOT_FOUND'; END IF;
  IF v_p.status <> 'proposed' THEN RAISE EXCEPTION 'CHEMISTRY_PROPOSAL_DECIDED: this proposal was already %', v_p.status; END IF;
  IF p_expected_proposal_version IS DISTINCT FROM v_p.proposal_version THEN
    RAISE EXCEPTION 'CHEMISTRY_PROPOSAL_STALE: this proposal changed since you opened it; reload';
  END IF;
  IF v_p.has_delete AND p_decision = 'apply' THEN
    RAISE EXCEPTION 'CHEMISTRY_PROPOSAL_HAS_DELETE: this proposal removes an ingredient; choose Apply with removal';
  END IF;
  IF NOT v_p.has_delete AND p_decision = 'apply_delete' THEN
    RAISE EXCEPTION 'CHEMISTRY_PROPOSAL_NO_DELETE: this proposal removes nothing; choose Apply';
  END IF;
  IF p_decision = 'reject' THEN
    UPDATE public.chemistry_change_proposals
       SET status = 'rejected', proposal_version = proposal_version + 1, decided_by = v_actor, decided_at = now(), updated_at = now()
     WHERE id = p_proposal_id RETURNING * INTO v_p;
  ELSE
    v_result := public._apply_chemistry_proposal(p_proposal_id, p_decision);
    UPDATE public.chemistry_change_proposals
       SET status = 'applied', proposal_version = proposal_version + 1, decided_by = v_actor, decided_at = now(), updated_at = now(),
           applied_chemistry_version = (v_result->>'chemistry_version')::bigint
     WHERE id = p_proposal_id RETURNING * INTO v_p;
  END IF;
  v_receipt := jsonb_build_object('proposal_id', v_p.id, 'parent_id', v_p.parent_id, 'status', v_p.status,
    'proposal_version', v_p.proposal_version, 'applied_chemistry_version', v_p.applied_chemistry_version,
    'chemistry', v_result->'chemistry');
  PERFORM public.save_idempotency(p_idempotency_key, 'promote_chemistry_proposal',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.promote_chemistry_proposal(uuid, integer, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.promote_chemistry_proposal(uuid, integer, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.promote_chemistry_proposal(uuid, integer, text, text) TO authenticated;

DO $postflight$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.get_setup_workbook_chemistry()', 'public.preview_weights_tab(jsonb)',
    'public.commit_weights_tab(jsonb,text)', 'public.preview_ingredients_tab(jsonb)', 'public.commit_ingredients_tab(jsonb,text)',
    'public.promote_chemistry_proposal(uuid,integer,text,text)'] LOOP
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') OR has_function_privilege('metabase_ro', v_fn, 'EXECUTE')
       OR (SELECT NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] OR proowner <> 'postgres'::regrole
             FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'POSTFLIGHT_DM1B_PUBLIC_FUNCTION_WRONG: %', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public._workbook_text(jsonb,text)', 'public._workbook_version(jsonb,text)',
    'public._workbook_weight_row(jsonb)', 'public._workbook_weight_rows(jsonb)', 'public._workbook_apply_items(uuid,jsonb,text,text)',
    'public._workbook_ingredient_parent(uuid,jsonb)', 'public._workbook_ingredient_rows(jsonb)',
    'public._apply_chemistry_proposal(uuid,text)'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') OR has_function_privilege('metabase_ro', v_fn, 'EXECUTE')
       OR (SELECT proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] OR proowner <> 'postgres'::regrole
             FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'POSTFLIGHT_DM1B_PRIVATE_FUNCTION_WRONG: %', v_fn;
    END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.chemistry_change_proposals'::regclass)
     OR has_table_privilege('anon', 'public.chemistry_change_proposals', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('service_role', 'public.chemistry_change_proposals', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('metabase_ro', 'public.chemistry_change_proposals', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', 'public.chemistry_change_proposals', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.chemistry_change_proposals', 'SELECT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_DM1B_TABLE_GRANTS_WRONG';
  END IF;
END;
$postflight$;
