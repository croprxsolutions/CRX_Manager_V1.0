-- idempotency-body-check: exempt
-- (set_parent_cost_reference keeps its retry key, checked through _product_parent_replay and saved with
--  save_idempotency last; the other replaced functions are private helpers called by the keyed writers.)
--
-- DM-1 landing fixes (docs/plans/2026-11-06-product-DM1-BUILD-SHEET.md, "Landing review"), on top of the
-- applied 20261209100000_product_chemistry:
--   * Swap copies nothing (Mason, 2026-11-07): a swap states the new row's strength, unit, basis and source
--     and lists the old row's modes of action that stay (modes_of_action, [] for none); the screen pre-fills
--     both. Consolidate lists the duplicate's modes of action that move. A listed mode must be one of the
--     replaced row's; a new one is added separately.
--   * product_parent_modes_of_action.source ('typed' or 'epa_lookup'). Existing rows are 'typed' (the EPA
--     writer, DM-4, is not live). On an EPA-gated parent, retiring a typed ingredient row is refused while
--     the EPA lookup has confirmed one of its modes of action (CHEMISTRY_EPA_ROW_KEPT); swaps and
--     mode-of-action retires were already refused there.
--   * Every chemistry writer refuses a liquid whose ingredients outweigh its approved weight per gallon,
--     by the cost read's own sum (the read still refuses when the weight changes later).
--   * _unit_factor_oz refuses a unit when any of its spellings has an unusable factor.
--   * product_parent_cost_reference.updated_at, set by set_parent_cost_reference.
-- New: one private helper, _chemistry_kept_modes (owned by postgres, no grants).
-- Replaced (CREATE OR REPLACE keeps each owner and grant): _unit_factor_oz, _parent_chemistry_values,
--   _check_parent_chemistry, _apply_parent_chemistry, set_parent_cost_reference. Signatures unchanged.
-- No existing row is changed; no grant, revoke or policy changes.
--
-- Rollback: re-run the CREATE FUNCTION bodies of those five functions from 20261209100000 as CREATE OR
-- REPLACE (none references the new columns), then DROP FUNCTION public._chemistry_kept_modes(jsonb, uuid, uuid).
-- Keep both new columns: their defaults let the old bodies write as before.

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regprocedure('public._apply_parent_chemistry(uuid,jsonb,text,text,text)') IS NULL
     OR to_regprocedure('public.set_parent_cost_reference(uuid,uuid,integer,text)') IS NULL
     OR to_regclass('public.product_parent_modes_of_action') IS NULL
     OR to_regclass('public.product_parent_cost_reference') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DM1_MISSING: apply 20261209100000_product_chemistry first';
  END IF;
  IF to_regprocedure('public._chemistry_kept_modes(jsonb,uuid,uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                 AND ((table_name = 'product_parent_modes_of_action' AND column_name = 'source')
                   OR (table_name = 'product_parent_cost_reference' AND column_name = 'updated_at'))) THEN
    RAISE EXCEPTION 'PREFLIGHT_DM1_FIXES_ALREADY_PRESENT: this migration has already run';
  END IF;
END;
$preflight$;

ALTER TABLE public.product_parent_modes_of_action
  ADD COLUMN source text NOT NULL DEFAULT 'typed'
  CONSTRAINT product_parent_modes_of_action_source CHECK (source IN ('typed', 'epa_lookup'));
ALTER TABLE public.product_parent_cost_reference ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Ounces per unit of one unit type: case ignored, that type only; NULL unless every spelling has the same
-- factor with 0 < factor < infinity (a NULL or NaN factor on any spelling refuses the unit).
CREATE OR REPLACE FUNCTION public._unit_factor_oz(p_unit text, p_unit_type text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT CASE WHEN count(*) > 0
               AND bool_and(COALESCE(u.factor_oz > 0 AND u.factor_oz < 'Infinity'::numeric, false))
               AND count(DISTINCT u.factor_oz) = 1
              THEN min(u.factor_oz) END
    FROM public.unit_conversions u
   WHERE lower(u.unit) = lower(btrim(p_unit)) AND u.unit_type = p_unit_type;
$function$;

-- The modes of action a swap or consolidate keeps, as 'SCHEME:CODE' keys. The entry must list them
-- (modes_of_action, [] for none); each must be an active mode of action of the replaced row's ingredient on
-- this parent, listed once. Nothing new enters this way.
CREATE FUNCTION public._chemistry_kept_modes(p_entry jsonb, p_parent_id uuid, p_ingredient_id uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_item jsonb;
  v_key text;
  v_keep text[] := '{}';
BEGIN
  IF NOT (p_entry ? 'modes_of_action') OR jsonb_typeof(p_entry->'modes_of_action') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'CHEMISTRY_MODES_REQUIRED: list the modes of action that stay (modes_of_action, [] for none)';
  END IF;
  FOR v_item IN SELECT e FROM jsonb_array_elements(p_entry->'modes_of_action') e LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('scheme', 'group_code'))
       OR jsonb_typeof(v_item->'scheme') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item->'group_code') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'CHEMISTRY_MODES_INVALID: each mode of action that stays is {scheme, group_code}';
    END IF;
    v_key := (v_item->>'scheme') || ':' || upper(btrim(v_item->>'group_code'));
    IF v_key = ANY (v_keep) THEN
      RAISE EXCEPTION 'CHEMISTRY_MODES_INVALID: % is listed twice', v_key;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.product_parent_modes_of_action m
                    WHERE m.parent_id = p_parent_id AND m.ingredient_id = p_ingredient_id AND m.status = 'active'
                      AND m.scheme || ':' || m.group_code = v_key) THEN
      RAISE EXCEPTION 'CHEMISTRY_MODES_INVALID: % is not a mode of action of the row being replaced; add a new one separately', v_key;
    END IF;
    v_keep := v_keep || v_key;
  END LOOP;
  RETURN v_keep;
END;
$function$;
ALTER FUNCTION public._chemistry_kept_modes(jsonb, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._chemistry_kept_modes(jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE OR REPLACE FUNCTION public._parent_chemistry_values(p_parent_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT jsonb_build_object(
    'ingredients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('row_id', r.id, 'ingredient_id', r.ingredient_id, 'name', a.name, 'cas', a.cas,
          'provisional', a.cas IS NULL, 'is_parent_form', a.is_parent_form,
          'canonical_ingredient_id', a.canonical_ingredient_id,
          'canonical_name', (SELECT c.name FROM public.active_ingredients c WHERE c.id = a.canonical_ingredient_id),
          'canonical_fraction', a.canonical_fraction,
          'strength_value', r.strength_value, 'strength_unknown', r.strength_unknown, 'strength_unit', r.strength_unit,
          'strength_basis', r.strength_basis, 'source', r.source, 'source_note', r.source_note, 'row_version', r.row_version)
        ORDER BY a.name, r.id)
        FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id
       WHERE r.parent_id = p_parent_id AND r.status = 'active'), '[]'::jsonb),
    'modes_of_action', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('row_id', m.id, 'ingredient_id', m.ingredient_id, 'name', a.name,
          'scheme', m.scheme, 'group_code', m.group_code, 'source', m.source, 'row_version', m.row_version)
        ORDER BY a.name, m.scheme, m.group_code, m.id)
        FROM public.product_parent_modes_of_action m JOIN public.active_ingredients a ON a.id = m.ingredient_id
       WHERE m.parent_id = p_parent_id AND m.status = 'active'), '[]'::jsonb),
    'fertilizer', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('row_id', f.id, 'nutrient', f.nutrient, 'basis', f.basis, 'percent', f.percent,
          'percent_unknown', f.percent_unknown, 'source', f.source, 'source_note', f.source_note, 'row_version', f.row_version)
        ORDER BY f.nutrient, f.id)
        FROM public.product_parent_fertilizer_analysis f
       WHERE f.parent_id = p_parent_id AND f.status = 'active'), '[]'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION public._check_parent_chemistry(p_parent_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_form text;
  v_names text;
  v_total numeric;
  v_lb_per_gal numeric;
  v_weight_row uuid;
BEGIN
  SELECT product_form INTO v_form FROM public.product_parents WHERE id = p_parent_id;
  SELECT string_agg(a.name, ', ' ORDER BY a.name) INTO v_names
    FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id
   WHERE r.parent_id = p_parent_id AND r.status = 'active' AND r.strength_unit = 'lb_per_gal'
     AND v_form IS DISTINCT FROM 'liquid';
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'CHEMISTRY_UNIT_NOT_FOR_FORM: lb/gal is for liquid products; enter % as %% w/w', v_names;
  END IF;
  SELECT string_agg(a.name, ', ' ORDER BY a.name) INTO v_names
    FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id
   WHERE r.parent_id = p_parent_id AND r.status = 'active' AND r.strength_basis = 'acid_equivalent'
     AND a.canonical_ingredient_id IS NULL AND NOT a.is_parent_form;
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'CHEMISTRY_AE_NEEDS_CANONICAL: % has no acid named, so an acid-equivalent strength cannot be stored', v_names;
  END IF;
  SELECT COALESCE(sum(public._chemistry_form_mass(r.strength_value, r.strength_basis, r.ingredient_id)), 0) INTO v_total
    FROM public.product_parent_ingredients r
   WHERE r.parent_id = p_parent_id AND r.status = 'active' AND r.strength_unit = 'pct_ww';
  IF v_total > 100 THEN
    RAISE EXCEPTION 'CHEMISTRY_TOTAL_IMPOSSIBLE: the ingredients add up to more than 100%% w/w';
  END IF;
  SELECT COALESCE(sum(public._chemistry_form_mass(r.strength_value, r.strength_basis, r.ingredient_id)), 0) INTO v_total
    FROM public.product_parent_ingredients r
   WHERE r.parent_id = p_parent_id AND r.status = 'active' AND r.strength_unit = 'lb_per_gal';
  IF v_total > 20 THEN
    RAISE EXCEPTION 'CHEMISTRY_TOTAL_IMPOSSIBLE: the ingredients add up to more than 20 lb/gal';
  END IF;
  -- A liquid with a usable approved weight per gallon (DM-2): % w/w and lb/gal rows together may not outweigh it.
  -- Same sum and same usable-weight rule as the cost read (_parent_active_cost_rows), which stays the authority
  -- when the weight changes after the chemistry was saved.
  IF v_form = 'liquid' THEN
    SELECT d.lb_per_gal, d.weight_row_id INTO v_lb_per_gal, v_weight_row FROM public._approved_parent_lb_per_gal(p_parent_id) d;
    IF v_lb_per_gal IS NOT NULL AND v_weight_row IS NOT NULL AND v_lb_per_gal <> 'NaN'::numeric
       AND v_lb_per_gal > 0 AND v_lb_per_gal <= 20
       AND (SELECT COALESCE(sum(CASE r.strength_unit
                     WHEN 'lb_per_gal' THEN public._chemistry_form_mass(r.strength_value, r.strength_basis, r.ingredient_id)
                     ELSE public._chemistry_form_mass(r.strength_value, r.strength_basis, r.ingredient_id) * v_lb_per_gal * 0.01 END), 0)
              FROM public.product_parent_ingredients r
             WHERE r.parent_id = p_parent_id AND r.status = 'active') > v_lb_per_gal THEN
      RAISE EXCEPTION 'CHEMISTRY_TOTAL_IMPOSSIBLE: the ingredients weigh more than the product''s approved % lb/gal', v_lb_per_gal;
    END IF;
  END IF;
  SELECT COALESCE(sum(CASE WHEN f.basis = 'oxide'
                           THEN trunc(f.percent::numeric(1000, 40) * x.num / x.den, 30) ELSE f.percent END), 0) INTO v_total
    FROM public.product_parent_fertilizer_analysis f
    LEFT JOIN LATERAL public._oxide_factor(f.nutrient) x ON true
   WHERE f.parent_id = p_parent_id AND f.status = 'active' AND f.percent IS NOT NULL;
  IF v_total > 100 THEN
    RAISE EXCEPTION 'CHEMISTRY_TOTAL_IMPOSSIBLE: the nutrients add up to more than 100%% (elemental)';
  END IF;
  SELECT string_agg(DISTINCT a.name, ', ') INTO v_names
    FROM public.product_parent_modes_of_action m JOIN public.active_ingredients a ON a.id = m.ingredient_id
   WHERE m.parent_id = p_parent_id AND m.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM public.product_parent_ingredients r
                      WHERE r.parent_id = p_parent_id AND r.ingredient_id = m.ingredient_id AND r.status = 'active');
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'CHEMISTRY_MOA_NEEDS_INGREDIENT: % must be an ingredient of this product before it gets a mode of action', v_names;
  END IF;
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

CREATE OR REPLACE FUNCTION public.set_parent_cost_reference(p_parent_id uuid, p_reference_product_id uuid,
  p_expected_row_version integer, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id,
    'reference_product_id', p_reference_product_id, 'expected_row_version', p_expected_row_version)::text);
  v_existing jsonb;
  v_name text;
  v_row public.product_parent_cost_reference;
  v_version integer;
  v_member record;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_parent_cost_reference', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  SELECT name INTO v_name FROM public.product_parents WHERE id = p_parent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.products p
   WHERE p.id IN (SELECT m.product_id FROM public.product_parent_members m WHERE m.parent_id = p_parent_id)
   ORDER BY p.id FOR SHARE;
  SELECT * INTO v_row FROM public.product_parent_cost_reference WHERE parent_id = p_parent_id FOR UPDATE;
  v_version := COALESCE(v_row.row_version, 0);
  IF p_expected_row_version IS NULL OR v_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'COST_REFERENCE_STALE: the reference size of "%" changed since you opened it; reload and try again', v_name;
  END IF;
  IF p_reference_product_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
                WHERE m.parent_id = p_parent_id AND m.size_role = 'bulk' AND p.is_active) THEN
      RAISE EXCEPTION 'COST_REFERENCE_BULK_WINS: "%" has an active bulk size, which is always its reference', v_name;
    END IF;
    SELECT m.parent_id, p.is_active INTO v_member
      FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
     WHERE m.product_id = p_reference_product_id AND m.parent_id = p_parent_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'COST_REFERENCE_NOT_MEMBER: that size is not a size of "%"', v_name; END IF;
    IF NOT v_member.is_active THEN RAISE EXCEPTION 'COST_REFERENCE_INACTIVE: that size is inactive; pick an active size'; END IF;
  END IF;
  IF v_row.parent_id IS NULL THEN
    IF p_reference_product_id IS NULL THEN
      v_result := jsonb_build_object('parent_id', p_parent_id, 'reference_product_id', NULL, 'row_version', 0, 'changed', false);
    ELSE
      INSERT INTO public.product_parent_cost_reference (parent_id, reference_product_id, row_version, set_by)
      VALUES (p_parent_id, p_reference_product_id, 1, auth.uid()) RETURNING * INTO v_row;
      v_result := to_jsonb(v_row) || jsonb_build_object('changed', true);
    END IF;
  ELSIF v_row.reference_product_id IS NOT DISTINCT FROM p_reference_product_id THEN
    v_result := to_jsonb(v_row) || jsonb_build_object('changed', false);
  ELSE
    UPDATE public.product_parent_cost_reference
       SET reference_product_id = p_reference_product_id, row_version = row_version + 1, set_by = auth.uid(), set_at = now(), updated_at = now()
     WHERE parent_id = p_parent_id
    RETURNING * INTO v_row;
    v_result := to_jsonb(v_row) || jsonb_build_object('changed', true);
  END IF;
  PERFORM public.save_idempotency(p_idempotency_key, 'set_parent_cost_reference',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- Postflight: the replaced and new functions are owned by postgres with the pinned search_path; only
-- set_parent_cost_reference is executable, and only by authenticated; both new columns exist.
DO $postflight$
DECLARE
  c_fns CONSTANT text[] := ARRAY['public._unit_factor_oz(text,text)', 'public._chemistry_kept_modes(jsonb,uuid,uuid)',
    'public._parent_chemistry_values(uuid)', 'public._check_parent_chemistry(uuid)',
    'public._apply_parent_chemistry(uuid,jsonb,text,text,text)', 'public.set_parent_cost_reference(uuid,uuid,integer,text)'];
  v_sig text;
  v_oid oid;
BEGIN
  FOREACH v_sig IN ARRAY c_fns LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'DM-1 fixes postflight: % is missing', v_sig; END IF;
    IF (SELECT proowner FROM pg_proc WHERE oid = v_oid) <> 'postgres'::regrole
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'DM-1 fixes postflight: % lost its owner, search_path or definer setting', v_sig;
    END IF;
    IF (SELECT proacl FROM pg_proc WHERE oid = v_oid) IS NULL
       OR EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = v_oid)) a WHERE a.grantee = 0)
       OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'DM-1 fixes postflight: % is executable by PUBLIC, anon or service_role', v_sig;
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') <> (v_sig LIKE 'public.set_parent_cost_reference%') THEN
      RAISE EXCEPTION 'DM-1 fixes postflight: % has the wrong authenticated EXECUTE', v_sig;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'product_parent_modes_of_action' AND column_name = 'source' AND is_nullable = 'NO')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'product_parent_cost_reference' AND column_name = 'updated_at' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'DM-1 fixes postflight: a new column is missing';
  END IF;
END;
$postflight$;
