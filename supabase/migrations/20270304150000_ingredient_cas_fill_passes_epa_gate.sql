-- ============================================================================
-- 20270304150000_ingredient_cas_fill_passes_epa_gate
-- Product Master ingredient fill follow-up (Mason, 2026-11-24).
--
-- WHY: an ingredient the EPA lookup added without a CAS (EPA gave none; e.g. zeta-cypermethrin from 91234-259) can
--   never get one. Ingredient review -> Needs CAS calls save_active_ingredient, and _edit_active_ingredient refuses any
--   edit while a product using the ingredient has an EPA number (CHEMISTRY_FROM_EPA_ONLY ... DM-4 will update it). DM-4
--   never fills a CAS, so the ingredient stays unlinked, though the EPA review itself says
--   "Your ingredient has no CAS number; EPA gives ... Correct the ingredient to link them."
-- WHAT: re-issues public._edit_active_ingredient (same signature, owner postgres, SECURITY DEFINER, search_path, no
--   grants). One change: an edit of the CAS alone (fill, correct or clear) skips the per-product EPA gate. It changes
--   no product row (strengths, sources, modes of action stay as EPA wrote them). Limits (Sol, 2026-11-24): a CAS that
--   an EPA proposal (proposed, held or committed) gives stays gated; and, by the newest proposal per product and
--   number, the new value must be the CAS EPA gives the ingredient and must not be a CAS EPA lists under another name
--   (INGREDIENT_CAS_NOT_EPA). So a typed CAS never contradicts EPA and a mistyped one can be corrected.
-- NOT CHANGED: an EPA-given CAS, the acid fields, or any mix of fields still refuse on an EPA product. Admin only
--   (preview_active_ingredient_change and save_active_ingredient keep _product_parent_require_admin), reason and
--   evidence still required when products use it, CAS format/check digit and CAS-taken checks, the ingredient event and
--   one 'corrected' chemistry event per affected product, row_version/usage-fingerprint staleness checks.
--   EPA matching: _epa_proposal_items matches a CAS-less EPA entry by name whatever the stored CAS, and an EPA entry
--   with a CAS now finds this row by CAS instead of reporting it as differs_identity.
-- PREFLIGHT: refuses autocommit, and unless the live body is the 20261209100000 one (md5 pinned, carriage returns
--   ignored so a CRLF rebuild matches); a second run refuses.
-- ROLLBACK: a NEW forward migration re-issuing the 20261209100000 body (lines 1773-1958). CAS values filled meanwhile
--   stay (valid data; correct or clear one with the same screen only on a product without an EPA number).
-- Proof: node scripts/smoke/prove-ingredient-cas-fill-epa-gate-real-schema.mjs (INGREDIENT_CAS_FILL_PROOF_PASS).
-- ============================================================================

CREATE TEMP TABLE ingredient_cas_fill_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_md5 text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.ingredient_cas_fill_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.ingredient_cas_fill_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  SELECT md5(replace(prosrc, E'\r', '')) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public._edit_active_ingredient(uuid,jsonb,text,text,boolean)');
  IF to_regclass('public.epa_chemistry_proposals') IS NULL THEN
    RAISE EXCEPTION 'INGREDIENT_CAS_FILL_BASELINE_DRIFT: public.epa_chemistry_proposals (20270105110000) is missing';
  END IF;
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'INGREDIENT_CAS_FILL_BASELINE_DRIFT: public._edit_active_ingredient(uuid,jsonb,text,text,boolean) does not exist';
  END IF;
  IF v_md5 <> 'e920183a75ba3d2f259b18a82f031e0c' THEN
    RAISE EXCEPTION 'INGREDIENT_CAS_FILL_BASELINE_DRIFT: _edit_active_ingredient is not the 20261209100000 body (md5 %); already applied or another change landed first', v_md5;
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._edit_active_ingredient(p_ingredient_id uuid, p_fields jsonb, p_reason text, p_evidence text,
  p_preview boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_old public.active_ingredients;
  v_new public.active_ingredients;
  v_key text;
  v_changed text[] := '{}';
  v_established boolean := false;
  v_parents uuid[];
  v_needs_reason boolean;
  v_reason text;
  v_evidence text;
  v_names text;
  v_conflict text;
  v_gate text;
  v_cas_edit boolean;
  v_epa_cas text;
  v_epa_name text;
  v_parent uuid;
  v_before jsonb := '{}'::jsonb;
  v_version bigint;
  v_event bigint;
BEGIN
  IF p_fields IS NULL OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INGREDIENT_ENTRY_INVALID: say which fields change';
  END IF;
  IF p_fields ? 'name' THEN
    RAISE EXCEPTION 'INGREDIENT_NAME_FIXED: an ingredient''s name never changes; add the right ingredient and swap it in';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_fields) LOOP
    IF v_key NOT IN ('cas', 'canonical_ingredient_id', 'canonical_fraction', 'fraction_basis', 'is_parent_form') THEN
      RAISE EXCEPTION 'INGREDIENT_ENTRY_INVALID: % cannot be changed here', v_key;
    END IF;
  END LOOP;
  SELECT * INTO v_old FROM public.active_ingredients WHERE id = p_ingredient_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INGREDIENT_NOT_FOUND'; END IF;
  IF v_old.status <> 'active' THEN RAISE EXCEPTION 'INGREDIENT_RETIRED: % was retired; reactivate it', v_old.name; END IF;
  v_new := v_old;

  IF p_fields ? 'cas' THEN
    IF jsonb_typeof(p_fields->'cas') = 'null' OR (jsonb_typeof(p_fields->'cas') = 'string' AND btrim(p_fields->>'cas') = '') THEN
      v_new.cas := NULL;
    ELSIF jsonb_typeof(p_fields->'cas') IS DISTINCT FROM 'string' OR NOT public._ingredient_cas_valid(btrim(p_fields->>'cas')) THEN
      RAISE EXCEPTION 'INGREDIENT_CAS_INVALID: % is not a valid CAS number (format or check digit)', p_fields->>'cas';
    ELSE
      v_new.cas := btrim(p_fields->>'cas');
    END IF;
  END IF;
  IF p_fields ? 'canonical_ingredient_id' THEN
    v_new.canonical_ingredient_id := CASE WHEN jsonb_typeof(p_fields->'canonical_ingredient_id') = 'null' THEN NULL
      ELSE public._chemistry_uuid(p_fields->'canonical_ingredient_id', 'canonical_ingredient_id') END;
  END IF;
  IF p_fields ? 'canonical_fraction' THEN
    IF jsonb_typeof(p_fields->'canonical_fraction') = 'null' THEN
      v_new.canonical_fraction := NULL;
    ELSIF jsonb_typeof(p_fields->'canonical_fraction') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction must be a number';
    ELSE
      v_new.canonical_fraction := (p_fields->>'canonical_fraction')::numeric;
    END IF;
  END IF;
  IF p_fields ? 'fraction_basis' THEN
    IF COALESCE(jsonb_typeof(p_fields->'fraction_basis'), 'missing') NOT IN ('null', 'string') THEN
      RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction basis can only be acid_equivalent';
    END IF;
    v_new.fraction_basis := p_fields->>'fraction_basis';
  END IF;
  IF p_fields ? 'is_parent_form' THEN
    IF jsonb_typeof(p_fields->'is_parent_form') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: is_parent_form must be true or false';
    END IF;
    v_new.is_parent_form := (p_fields->>'is_parent_form')::boolean;
  END IF;

  -- Final shape (the table CHECKs again).
  IF v_new.fraction_basis IS NOT NULL AND v_new.fraction_basis <> 'acid_equivalent' THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction basis can only be acid_equivalent';
  END IF;
  IF (v_new.canonical_fraction IS NULL) <> (v_new.fraction_basis IS NULL) THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: a fraction needs its basis (acid_equivalent), and the basis needs a fraction';
  END IF;
  IF v_new.canonical_fraction IS NOT NULL AND NOT (v_new.canonical_fraction > 0 AND v_new.canonical_fraction <= 1) THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction must be above 0 and at most 1';
  END IF;
  IF v_new.canonical_fraction IS NOT NULL AND v_new.canonical_ingredient_id IS NULL THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: a fraction needs the acid it is measured as';
  END IF;
  IF v_new.is_parent_form AND (v_new.canonical_ingredient_id IS NOT NULL OR v_new.canonical_fraction IS NOT NULL) THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: an acid (parent form) has no acid of its own and no fraction';
  END IF;
  IF v_new.canonical_ingredient_id IS DISTINCT FROM v_old.canonical_ingredient_id AND v_new.canonical_ingredient_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.active_ingredients c WHERE c.id = v_new.canonical_ingredient_id
                        AND c.id <> p_ingredient_id AND c.status = 'active' AND c.is_parent_form) THEN
    RAISE EXCEPTION 'INGREDIENT_CANONICAL_INVALID: the acid named must be another active ingredient marked as the acid';
  END IF;
  -- D-AA-3, as _resolve_active_ingredient: a same-name ingredient that claims a different acid refuses the edit.
  IF v_new.canonical_ingredient_id IS DISTINCT FROM v_old.canonical_ingredient_id AND v_new.canonical_ingredient_id IS NOT NULL THEN
    SELECT string_agg(a.name, ', ' ORDER BY a.name) INTO v_conflict
      FROM public.active_ingredients a
     WHERE a.status = 'active' AND a.id <> p_ingredient_id AND a.name_key = v_old.name_key
       AND a.canonical_ingredient_id IS DISTINCT FROM v_new.canonical_ingredient_id;
    IF v_conflict IS NOT NULL THEN
      RAISE EXCEPTION 'INGREDIENT_PARENT_CONFLICT: % already exists with a different acid; correct that ingredient first', v_conflict;
    END IF;
  END IF;

  IF v_new.cas IS DISTINCT FROM v_old.cas THEN v_changed := v_changed || 'cas'::text; END IF;
  IF v_new.canonical_ingredient_id IS DISTINCT FROM v_old.canonical_ingredient_id THEN v_changed := v_changed || 'canonical_ingredient_id'::text; END IF;
  IF v_new.canonical_fraction IS DISTINCT FROM v_old.canonical_fraction THEN v_changed := v_changed || 'canonical_fraction'::text; END IF;
  IF v_new.fraction_basis IS DISTINCT FROM v_old.fraction_basis THEN v_changed := v_changed || 'fraction_basis'::text; END IF;
  IF v_new.is_parent_form IS DISTINCT FROM v_old.is_parent_form THEN v_changed := v_changed || 'is_parent_form'::text; END IF;
  IF cardinality(v_changed) = 0 THEN RAISE EXCEPTION 'INGREDIENT_NO_CHANGE: nothing differs on %', v_old.name; END IF;
  v_established := ('cas' = ANY(v_changed) AND v_old.cas IS NOT NULL)
    OR ('canonical_ingredient_id' = ANY(v_changed) AND v_old.canonical_ingredient_id IS NOT NULL)
    OR ('canonical_fraction' = ANY(v_changed) AND v_old.canonical_fraction IS NOT NULL)
    OR ('fraction_basis' = ANY(v_changed) AND v_old.fraction_basis IS NOT NULL)
    OR ('is_parent_form' = ANY(v_changed) AND v_old.is_parent_form);

  IF v_new.cas IS NOT NULL AND v_new.cas IS DISTINCT FROM v_old.cas THEN
    SELECT name INTO v_names FROM public.active_ingredients WHERE cas = v_new.cas AND id <> p_ingredient_id;
    IF FOUND THEN
      RAISE EXCEPTION 'INGREDIENT_CAS_TAKEN: this CAS belongs to %; swap this ingredient to % on its products, then retire it',
        v_names, v_names;
    END IF;
  END IF;

  -- What depends on it, in its final state.
  IF v_old.is_parent_form AND NOT v_new.is_parent_form THEN
    SELECT string_agg(f.name, ', ' ORDER BY f.name) INTO v_names FROM public.active_ingredients f
     WHERE f.canonical_ingredient_id = p_ingredient_id AND f.status = 'active';
    IF v_names IS NOT NULL THEN
      RAISE EXCEPTION 'INGREDIENT_IN_USE: % name % as their acid; correct those first', v_names, v_old.name;
    END IF;
  END IF;
  IF NOT v_new.is_parent_form AND v_new.canonical_ingredient_id IS NULL THEN
    SELECT string_agg(DISTINCT pp.name, ', ') INTO v_names
      FROM public.product_parent_ingredients r JOIN public.product_parents pp ON pp.id = r.parent_id
     WHERE r.ingredient_id = p_ingredient_id AND r.status = 'active' AND r.strength_basis = 'acid_equivalent';
    IF v_names IS NOT NULL THEN
      RAISE EXCEPTION 'INGREDIENT_IN_USE: % state % as acid equivalent, which needs its acid; correct those first', v_names, v_old.name;
    END IF;
  END IF;

  v_parents := public._ingredient_usage_parents(p_ingredient_id);
  v_needs_reason := v_established OR cardinality(v_parents) > 0;
  IF NOT p_preview THEN
    v_reason := public._product_parent_reason(p_reason, 'reason', v_needs_reason);
    v_evidence := public._product_parent_reason(p_evidence, 'evidence', v_needs_reason);
  END IF;
  -- A CAS-only edit passes the EPA gate (Mason, 2026-11-24): it changes no product row, and EPA asks for exactly this
  -- ("Correct the ingredient to link them"). Two limits (Sol, 2026-11-24): a CAS that EPA itself gave stays gated, so
  -- only a typed one can be corrected; and the new CAS must be the one EPA gives for this ingredient, when it gives one.
  v_cas_edit := v_changed = ARRAY['cas']::text[]
    AND NOT (v_old.cas IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.epa_chemistry_proposals p, jsonb_array_elements(p.items) i
       WHERE p.status IN ('proposed', 'held', 'committed') AND i->'epa'->>'cas' = v_old.cas));
  IF v_cas_edit AND cardinality(v_parents) > 0 THEN
    -- EPA's current word (the newest proposal per product and number, not rejected or superseded) wins both ways:
    -- the CAS EPA gives this ingredient, and the name EPA gives the new CAS (Sol, 2026-11-24).
    WITH cur AS (
      SELECT DISTINCT ON (p.parent_id, p.epa_registration) p.parent_id, p.items
        FROM public.epa_chemistry_proposals p
       WHERE p.status IN ('proposed', 'held', 'committed')
       ORDER BY p.parent_id, p.epa_registration, p.created_at DESC, p.id DESC),
    epa AS (
      SELECT c.parent_id, i FROM cur c, jsonb_array_elements(c.items) i
       WHERE i->>'kind' = 'ingredient' AND i->'epa'->>'cas' IS NOT NULL)
    SELECT string_agg(DISTINCT i->'epa'->>'cas', ', ') FILTER (WHERE parent_id = ANY(v_parents)
             AND i->'current'->>'ingredient_id' = p_ingredient_id::text AND i->'epa'->>'cas' IS DISTINCT FROM v_new.cas),
           string_agg(DISTINCT i->'epa'->>'name', ', ') FILTER (WHERE i->'epa'->>'cas' = v_new.cas
             AND lower(regexp_replace(btrim(i->'epa'->>'name'), '\s+', ' ', 'g')) <> lower(regexp_replace(btrim(v_old.name), '\s+', ' ', 'g')))
      INTO v_epa_cas, v_epa_name FROM epa;
    IF v_epa_cas IS NOT NULL THEN
      RAISE EXCEPTION 'INGREDIENT_CAS_NOT_EPA: EPA gives % for %; enter EPA''s number', v_epa_cas, v_old.name;
    END IF;
    IF v_epa_name IS NOT NULL THEN
      RAISE EXCEPTION 'INGREDIENT_CAS_NOT_EPA: EPA lists % as %, not %', v_new.cas, v_epa_name, v_old.name;
    END IF;
  END IF;
  FOREACH v_parent IN ARRAY v_parents LOOP
    v_gate := CASE WHEN v_cas_edit THEN NULL ELSE public._parent_chemistry_epa_refusal(v_parent) END;
    IF v_gate IS NOT NULL THEN
      RAISE EXCEPTION '%', v_gate || format(' (product "%s" uses %s; DM-4 will update it)',
        (SELECT name FROM public.product_parents WHERE id = v_parent), v_old.name);
    END IF;
    v_before := v_before || jsonb_build_object(v_parent::text, public._parent_chemistry_values(v_parent));
  END LOOP;

  UPDATE public.active_ingredients
     SET cas = v_new.cas, canonical_ingredient_id = v_new.canonical_ingredient_id,
         canonical_fraction = v_new.canonical_fraction, fraction_basis = v_new.fraction_basis,
         is_parent_form = v_new.is_parent_form, row_version = row_version + 1, updated_by = auth.uid(), updated_at = now()
   WHERE id = p_ingredient_id
  RETURNING * INTO v_new;
  v_event := public._active_ingredient_event(p_ingredient_id, 'updated', v_reason, v_evidence,
    public._active_ingredient_values(v_old), public._active_ingredient_values(v_new));

  FOREACH v_parent IN ARRAY v_parents LOOP
    PERFORM public._check_parent_chemistry(v_parent);
    INSERT INTO public.product_parent_chemistry_state (parent_id, chemistry_version, updated_by)
    VALUES (v_parent, 0, auth.uid()) ON CONFLICT (parent_id) DO NOTHING;
    UPDATE public.product_parent_chemistry_state
       SET chemistry_version = chemistry_version + 1, updated_by = auth.uid(), updated_at = now()
     WHERE parent_id = v_parent
    RETURNING chemistry_version INTO v_version;
    INSERT INTO public.product_chemistry_events (parent_id, event_type, chemistry_version, reason, evidence,
      before_values, after_values, changed_by)
    VALUES (v_parent, 'corrected', v_version, v_reason, v_evidence, v_before->v_parent::text,
      public._parent_chemistry_values(v_parent) || jsonb_build_object('source_path', 'ingredient_edit',
        'ingredient_id', p_ingredient_id, 'ingredient_event_id', v_event, 'changed_fields', to_jsonb(v_changed)),
      auth.uid());
  END LOOP;

  RETURN jsonb_build_object('ingredient', public._active_ingredient_values(v_new), 'before', public._active_ingredient_values(v_old),
    'changed_fields', to_jsonb(v_changed), 'needs_reason', v_needs_reason, 'affected_parents', to_jsonb(v_parents),
    'event_id', v_event);
END;
$function$;
ALTER FUNCTION public._edit_active_ingredient(uuid, jsonb, text, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._edit_active_ingredient(uuid, jsonb, text, text, boolean) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

DO $postflight$
DECLARE
  v_fn oid := to_regprocedure('public._edit_active_ingredient(uuid,jsonb,text,text,boolean)');
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_edit_active_ingredient') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected one _edit_active_ingredient';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_fn) <> 'postgres' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: _edit_active_ingredient lost SECURITY DEFINER, search_path or owner';
  END IF;
  IF EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = v_fn)) a
              WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 'postgres'::regrole) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: _edit_active_ingredient is executable by a role other than its owner';
  END IF;
  IF position('v_cas_edit' IN (SELECT prosrc FROM pg_proc WHERE oid = v_fn)) = 0
     OR position('INGREDIENT_CAS_NOT_EPA' IN (SELECT prosrc FROM pg_proc WHERE oid = v_fn)) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: the CAS-fill exception is missing';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
