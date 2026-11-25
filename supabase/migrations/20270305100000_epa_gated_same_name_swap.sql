-- ============================================================================
-- 20270305100000_epa_gated_same_name_swap
-- Product Master ingredient review follow-up (Mason, 2026-11-24).
--
-- WHY: duplicate ingredient records (same name, e.g. three "Zeta-Cypermethrin" rows the EPA lookup added without a CAS)
--   cannot be merged. Ingredient review -> Duplicates -> "Replace on <product>" opens a correction with a swap, and
--   _apply_parent_chemistry refuses every swap on a product with an EPA number (CHEMISTRY_FROM_EPA_ONLY). The
--   resistance-group load matches a name only when it is unique, so the duplicates get no group.
-- WHAT: re-issues public._apply_parent_chemistry (same signature, owner postgres, SECURITY DEFINER, search_path, no
--   grants). One change: on an EPA-gated product a correction may swap an ingredient row to an EXISTING ingredient
--   with the same name_key (refused when both records carry a CAS, which is unique). The new row copies the old row's strength, unit, basis, source and note, and every mode
--   of action of the old row moves over with its own source (EPA-confirmed stays EPA-confirmed); the request's
--   strength and mode list are not used. Only which shared active_ingredients row the product points at changes.
-- NOT CHANGED: every other swap, consolidate, change or mode-of-action edit on a gated product still refuses with
--   CHEMISTRY_FROM_EPA_ONLY, including a same-name swap that would create a new ingredient. Admin only (callers
--   preview_parent_chemistry_correction / correct_parent_chemistry / the setup workbook keep
--   _product_parent_require_admin), reason and evidence still required, preview fingerprint, one 'corrected'
--   chemistry event with before/after values.
-- PREFLIGHT: refuses autocommit, and unless the live body is the 20270115100000 one (md5 pinned); a second run refuses.
-- ROLLBACK: a NEW forward migration re-issuing the 20270115100000 body (lines 349-774). Swaps made meanwhile stay
--   (each is a normal correction; reverse one with another same-name swap).
-- Proof: node scripts/smoke/prove-epa-gated-same-name-swap-real-schema.mjs (EPA_SAME_NAME_SWAP_PROOF_PASS).
-- ============================================================================

CREATE TEMP TABLE epa_same_name_swap_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_md5 text;
  v_tx text;
BEGIN
  IF to_regclass('pg_temp.epa_same_name_swap_tx') IS NOT NULL THEN
    SELECT transaction_id INTO v_tx FROM pg_temp.epa_same_name_swap_tx;
  END IF;
  IF v_tx IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_apply_parent_chemistry') <> 1 THEN
    RAISE EXCEPTION 'EPA_SAME_NAME_SWAP_BASELINE_DRIFT: expected exactly one _apply_parent_chemistry';
  END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc
   WHERE oid = to_regprocedure('public._apply_parent_chemistry(uuid,jsonb,text,text,text)');
  IF v_md5 IS DISTINCT FROM '983fe84c21497b64fe328afe11ec9b01' THEN
    RAISE EXCEPTION 'EPA_SAME_NAME_SWAP_BASELINE_DRIFT: _apply_parent_chemistry is not the 20270115100000 body (md5 %); already applied or another change landed first', v_md5;
  END IF;
END
$preflight$;

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
  v_same_name boolean;
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
    -- An ingredient swap is checked once its ingredient is resolved: only a same-name swap passes (below).
    IF v_gate IS NOT NULL AND NOT (p_mode = 'correct' AND ((v_action = 'retire' AND v_kind <> 'mode_of_action')
                                                          OR (v_action = 'swap' AND v_kind = 'ingredient'))) THEN
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
      IF v_gate IS NOT NULL AND v_row.source = 'epa_lookup' AND v_action <> 'swap' THEN RAISE EXCEPTION '%', v_gate; END IF;
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
      -- On a gated parent only a swap to an existing ingredient with the same name passes: it merges a duplicate
      -- ingredient record. Everything is carried over unchanged, so no EPA-written value changes (Mason, 2026-11-24).
      v_same_name := v_gate IS NOT NULL;
      IF v_same_name AND (COALESCE(jsonb_typeof(v_entry->'ingredient_id'), 'null') = 'null'
          OR (SELECT name_key FROM public.active_ingredients WHERE id = v_ing)
             IS DISTINCT FROM (SELECT name_key FROM public.active_ingredients WHERE id = v_row.ingredient_id)
          -- CAS is unique, so two records that both carry one are different chemicals despite the name.
          OR (SELECT count(*) FROM public.active_ingredients WHERE id IN (v_ing, v_row.ingredient_id) AND cas IS NOT NULL) = 2) THEN
        RAISE EXCEPTION '%', v_gate;
      END IF;
      IF v_same_name THEN
        -- The entry's strength and mode list are not used: strength, source, note and every mode of action
        -- (with its own source, so EPA-confirmed stays EPA-confirmed) move to the replacement as they are.
        v_s := jsonb_build_object('value', v_row.strength_value, 'unknown', v_row.strength_unknown, 'unit', v_row.strength_unit,
          'basis', v_row.strength_basis, 'source', v_row.source, 'note', v_row.source_note);
        v_keep := ARRAY(SELECT m.scheme || ':' || m.group_code FROM public.product_parent_modes_of_action m
                         WHERE m.parent_id = p_parent_id AND m.ingredient_id = v_row.ingredient_id AND m.status = 'active');
      ELSE
        -- Nothing is copied (Mason, 2026-11-07): the admin states the new row's strength, unit, basis and source,
        -- and lists which of the old row's modes of action stay; the screen pre-fills both from the old row.
        v_s := public._chemistry_strength(v_entry, p_mode);
        v_keep := public._chemistry_kept_modes(v_entry, p_parent_id, v_row.ingredient_id);
      END IF;
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
          VALUES (p_parent_id, v_ing, v_moa.scheme, v_moa.group_code, CASE WHEN v_same_name THEN v_moa.source ELSE 'typed' END, v_actor, v_actor)
          -- Typed again: the EPA lookup confirmed it for the old ingredient, not this one; a later lookup re-confirms it (Sol, 2026-11-08).
          -- A same-name swap keeps the source: it is the same ingredient under a merged record.
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

ALTER FUNCTION public._apply_parent_chemistry(uuid, jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._apply_parent_chemistry(uuid, jsonb, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

DO $postflight$
DECLARE
  v_fn oid := to_regprocedure('public._apply_parent_chemistry(uuid,jsonb,text,text,text)');
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_apply_parent_chemistry') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected one _apply_parent_chemistry';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_fn) <> 'postgres' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: _apply_parent_chemistry lost SECURITY DEFINER, search_path or owner';
  END IF;
  IF EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = v_fn)) a
              WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 'postgres'::regrole) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: _apply_parent_chemistry is executable by a role other than its owner';
  END IF;
  IF position('v_same_name' IN (SELECT prosrc FROM pg_proc WHERE oid = v_fn)) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: the same-name swap exception is missing';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
