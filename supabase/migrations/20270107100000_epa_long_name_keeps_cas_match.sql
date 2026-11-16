-- Written 2026-11-12. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270107100000_epa_long_name_keeps_cas_match.md.
-- Re-read the live ledger before applying.
--
-- WHY: Taha's post-merge LOW on #1810 (2026-11-12). When EPA lists an ingredient under a name longer than 200
--   characters, _epa_proposal_items shows that entry as an unticked conflict (right: the name cannot be stored) but
--   skips the CAS lookup, so the parent's own row for that chemical is also listed as "missing from EPA", which it
--   is not. Display only: nothing is written either way.
--
-- WHAT: re-issues public._epa_proposal_items (same signature, owner postgres, SECURITY DEFINER, search_path, no
--   grants). In the over-long-name branch it first looks the entry's CAS up among the parent's active rows; a row it
--   finds is shown as the conflict's "current" and counted as matched, so it is no longer reported missing. The
--   entry stays an unticked epa_conflict with no change. Nothing else in the function changes.
--
-- NOT CHANGED: every other function, table, row and grant. commit_epa_proposal never accepts a conflict, so open
--   proposals commit or hold exactly as before.
--
-- PREFLIGHT: refuses unless the live body is the one 20270105110000 applied (md5 pinned below); a second run refuses.
-- ROLLBACK (its own reviewed migration): re-issue the function body from 20270105110000 (lines 467-666).
--
-- Proof: node scripts/smoke/prove-epa-chemistry-proposals-real-schema.mjs (case H28).

DO $preflight$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public._epa_proposal_items(uuid,text,jsonb)');
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'EPA_LONG_NAME_PREFLIGHT: public._epa_proposal_items(uuid,text,jsonb) does not exist';
  END IF;
  IF v_md5 <> 'e9b00f48efc055db73ebd03940ba1702' THEN
    RAISE EXCEPTION 'EPA_LONG_NAME_PREFLIGHT: _epa_proposal_items is not the 20270105110000 body (md5 %); this file was already applied or another change landed first', v_md5;
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._epa_proposal_items(p_parent_id uuid, p_number text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_items jsonb := '[]'::jsonb;
  v_reg public.epa_registrations;
  v_ing jsonb;
  v_row record;
  v_matched uuid[] := '{}';
  v_ids uuid[];
  v_class text;
  v_s numeric;
  v_note text := 'EPA lookup of ' || p_number;
  v_label jsonb := p_input->'label';
  v_date date;
  v_url text;
  v_dclass text;
  v_change jsonb;
BEGIN
  -- Ingredients. CAS matches first, then names (lower case, spaces collapsed) against the parent's own rows only.
  FOR v_ing IN SELECT e FROM jsonb_array_elements(p_input->'ingredients') e ORDER BY (e->>'cas') IS NULL, e->>'key' LOOP
    v_s := (v_ing->>'strength')::numeric;
    IF char_length(v_ing->>'name') > 200 THEN
      -- Longer than an ingredient name can be stored (Sol, 2026-11-11): shown, never written. Its CAS still finds the
      -- parent's row, so that row is shown beside it and not reported missing from EPA (Taha, #1810, 2026-11-12).
      -- With no CAS the lookup finds nothing (cas = NULL), which also clears the previous entry's row.
      SELECT ppi.id, ppi.ingredient_id, ppi.strength_value, ppi.strength_unit, ppi.strength_basis, ppi.source, a.name, a.cas
        INTO v_row
        FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id
       WHERE ppi.parent_id = p_parent_id AND ppi.status = 'active' AND a.cas = v_ing->>'cas';
      IF v_row.id IS NOT NULL THEN v_matched := v_matched || v_row.id; END IF;
      v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'ing:' || (v_ing->>'key'), 'kind', 'ingredient',
        'class', 'epa_conflict', 'epa', v_ing, 'current', CASE WHEN v_row.id IS NOT NULL THEN to_jsonb(v_row) END,
        'accept_default', false, 'note', 'EPA''s ingredient name is longer than 200 characters.'));
      CONTINUE;
    END IF;
    IF (v_ing->>'ambiguous')::boolean THEN
      -- EPA gives this name with several CAS numbers and once with none: that entry names no one chemical.
      v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'ing:' || (v_ing->>'key'), 'kind', 'ingredient',
        'class', 'epa_conflict', 'epa', v_ing, 'current', NULL, 'accept_default', false,
        'note', 'EPA lists ' || (v_ing->>'name') || ' under more than one CAS number and once with none.'));
      CONTINUE;
    END IF;
    IF v_ing->>'cas' IS NOT NULL THEN
      SELECT ppi.id, ppi.ingredient_id, ppi.strength_value, ppi.strength_unit, ppi.strength_basis, ppi.source, a.name, a.cas
        INTO v_row
        FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id
       WHERE ppi.parent_id = p_parent_id AND ppi.status = 'active' AND a.cas = v_ing->>'cas';
      IF v_row.id IS NULL THEN
        -- A same-name row with no CAS would become a second row for one chemical: shown, not written.
        SELECT ppi.id, ppi.ingredient_id, ppi.strength_value, ppi.strength_unit, ppi.strength_basis, ppi.source, a.name, a.cas
          INTO v_row
          FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id
         WHERE ppi.parent_id = p_parent_id AND ppi.status = 'active' AND a.cas IS NULL
           AND lower(regexp_replace(btrim(a.name), '\s+', ' ', 'g')) = lower(v_ing->>'name')
           AND ppi.id <> ALL (v_matched)
         ORDER BY ppi.id LIMIT 1;
        IF v_row.id IS NOT NULL THEN
          v_matched := v_matched || v_row.id;
          v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'ing:' || (v_ing->>'key'), 'kind', 'ingredient',
            'class', 'differs_identity', 'epa', v_ing, 'current', to_jsonb(v_row), 'accept_default', false,
            'note', 'Your ingredient has no CAS number; EPA gives ' || (v_ing->>'cas') || '. Correct the ingredient to link them.'));
          CONTINUE;
        END IF;
      END IF;
    ELSE
      v_ids := ARRAY(SELECT ppi.id
        FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id
       WHERE ppi.parent_id = p_parent_id AND ppi.status = 'active'
         AND lower(regexp_replace(btrim(a.name), '\s+', ' ', 'g')) = lower(v_ing->>'name'));
      IF cardinality(v_ids) > 1 THEN
        -- Several of the parent's rows share this name and EPA gives no CAS: no row can be chosen, so none is written
        -- and none is reported missing (Codex App, 2026-11-11).
        v_matched := v_matched || v_ids;
        v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'ing:' || (v_ing->>'key'), 'kind', 'ingredient',
          'class', 'epa_conflict', 'epa', v_ing, 'current', NULL, 'accept_default', false,
          'note', 'More than one of your ingredients is named ' || (v_ing->>'name') || ' and EPA gives no CAS number.'));
        CONTINUE;
      END IF;
      SELECT ppi.id, ppi.ingredient_id, ppi.strength_value, ppi.strength_unit, ppi.strength_basis, ppi.source, a.name, a.cas
        INTO v_row
        FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id
       WHERE ppi.id = v_ids[1];
    END IF;

    v_change := NULL;
    IF v_row.id IS NOT NULL AND v_row.id = ANY (v_matched) THEN
      v_class := 'epa_conflict';  -- two EPA entries land on one row
    ELSIF (v_ing->>'conflict')::boolean THEN
      v_class := 'epa_conflict';
    ELSIF v_row.id IS NULL THEN
      IF v_ing->>'cas' IS NOT NULL AND EXISTS (SELECT 1 FROM public.active_ingredients WHERE cas = v_ing->>'cas' AND status <> 'active') THEN
        v_class := 'ingredient_retired';
      ELSE
        v_class := CASE WHEN v_ing->>'cas' IS NOT NULL THEN 'add' ELSE 'add_name_only' END;
        v_change := jsonb_build_object('kind', 'ingredient', 'name', v_ing->>'name')
                 || CASE WHEN v_ing->>'cas' IS NOT NULL THEN jsonb_build_object('cas', v_ing->'cas') ELSE '{}'::jsonb END;
      END IF;
    ELSIF v_row.strength_value IS NOT DISTINCT FROM v_s AND v_row.strength_unit = 'pct_ww' AND v_row.strength_basis = 'active_ingredient' THEN
      v_class := 'confirm';
      v_change := jsonb_build_object('kind', 'ingredient', 'ingredient_id', v_row.ingredient_id);
    ELSIF v_row.source <> 'epa_lookup' THEN
      v_class := 'differs_typed';
    ELSIF v_row.strength_value IS NULL AND v_s IS NOT NULL THEN
      v_class := 'fill';
      v_change := jsonb_build_object('kind', 'ingredient', 'ingredient_id', v_row.ingredient_id);
    ELSE
      v_class := 'differs_epa';
    END IF;
    IF v_row.id IS NOT NULL THEN v_matched := v_matched || v_row.id; END IF;
    IF v_change IS NOT NULL THEN
      v_change := v_change || jsonb_build_object('strength_value', v_s, 'strength_unit', 'pct_ww',
        'strength_basis', 'active_ingredient', 'source', 'epa_lookup', 'source_note', v_note);
    END IF;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'ing:' || (v_ing->>'key'), 'kind', 'ingredient',
      'class', v_class, 'epa', v_ing, 'current', CASE WHEN v_row.id IS NOT NULL THEN to_jsonb(v_row) END,
      'accept_default', v_class IN ('add', 'fill', 'confirm'), 'note', v_ing->>'cas_note', 'change', v_change));
  END LOOP;

  -- Every entry that lands on a row another entry also landed on is a conflict, the first one too (Codex App,
  -- 2026-11-11): nothing is written for that row.
  SELECT COALESCE(jsonb_agg(CASE WHEN e->'current'->>'id' IN (
             SELECT e2->'current'->>'id' FROM jsonb_array_elements(v_items) e2
              WHERE e2->'current'->>'id' IS NOT NULL GROUP BY 1 HAVING count(*) > 1)
           THEN e || jsonb_build_object('class', 'epa_conflict', 'accept_default', false, 'change', NULL)
           ELSE e END ORDER BY o), '[]'::jsonb)
    INTO v_items FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(e, o);

  -- Parent rows EPA does not list: shown only.
  FOR v_row IN
    SELECT ppi.id, ppi.ingredient_id, ppi.strength_value, ppi.strength_unit, ppi.strength_basis, ppi.source, a.name, a.cas
      FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id
     WHERE ppi.parent_id = p_parent_id AND ppi.status = 'active' AND ppi.id <> ALL (v_matched)
     ORDER BY ppi.ingredient_id
  LOOP
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'missing:' || v_row.ingredient_id, 'kind', 'ingredient',
      'class', 'missing_from_epa', 'epa', NULL, 'current', to_jsonb(v_row), 'accept_default', false));
  END LOOP;

  -- Label facts, against the registration.
  SELECT * INTO v_reg FROM public.epa_registrations WHERE epa_registration = p_number;
  IF NOT FOUND THEN RAISE EXCEPTION 'EPA_REGISTRATION_MISSING: EPA registration % does not exist', p_number; END IF;

  IF jsonb_typeof(v_label->'signal_word') = 'string' THEN
    v_class := CASE WHEN v_reg.signal_word IS NULL THEN 'fill' WHEN v_reg.signal_word = v_label->>'signal_word' THEN 'confirm' ELSE 'differs' END;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'label:signal_word', 'kind', 'label', 'class', v_class,
      'epa', v_label->'signal_word', 'current', to_jsonb(v_reg.signal_word), 'accept_default', v_class <> 'differs',
      'change', CASE WHEN v_class = 'fill' THEN jsonb_build_object('signal_word', v_label->'signal_word')
                     WHEN v_class = 'confirm' THEN '{}'::jsonb END));
  END IF;
  IF v_label->>'rup_status' IS NOT NULL THEN
    -- Mason 2026-11-11: EPA "yes" over our "no" may be ticked (unticked by default); "no" over "yes" is never written.
    v_class := CASE WHEN v_reg.rup_status = 'unknown' THEN 'fill' WHEN v_reg.rup_status = v_label->>'rup_status' THEN 'confirm'
                    WHEN v_reg.rup_status = 'no' AND v_label->>'rup_status' = 'yes' THEN 'rup_upgrade' ELSE 'differs' END;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'label:rup_status', 'kind', 'label', 'class', v_class,
      'epa', v_label->'rup_status', 'current', to_jsonb(v_reg.rup_status), 'accept_default', v_class IN ('fill', 'confirm'),
      'note', CASE WHEN v_class = 'rup_upgrade' THEN 'EPA lists this product as restricted use; ticking records yes and lists past sales that need records.' END,
      'change', CASE WHEN v_class IN ('fill', 'rup_upgrade') THEN jsonb_build_object('rup_status', v_label->'rup_status')
                     WHEN v_class = 'confirm' THEN '{}'::jsonb END));
  END IF;
  -- Status is never written: the lookup has no cancellation date (D-T); shown as matches or differs.
  -- An unknown status never "matches" (Luna, 2026-11-11): EPA's answer is shown beside it as a difference.
  v_class := CASE WHEN v_reg.registration_status = 'unknown' THEN 'differs'
                  WHEN (v_label->>'is_cancelled')::boolean = (v_reg.registration_status = 'cancelled') THEN 'matches' ELSE 'differs' END;
  v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'label:registration_status', 'kind', 'label', 'class', v_class,
    'epa', v_label->'is_cancelled', 'current', to_jsonb(v_reg.registration_status), 'accept_default', false,
    'note', CASE WHEN v_class = 'matches' THEN NULL
                 WHEN (v_label->>'is_cancelled')::boolean
                 THEN 'EPA lists this registration as cancelled; record the date on the registration. Selling is not blocked.'
                 ELSE 'EPA lists this registration as active.' END));
  -- One tick box for the label date and its link (sheet 3.4).
  v_date := (v_label->>'label_accepted_on')::date;
  v_url := v_label->>'label_url';
  v_dclass := CASE WHEN v_date IS NULL THEN NULL
                   WHEN v_reg.label_accepted_on IS NULL OR v_date > v_reg.label_accepted_on THEN 'fill'
                   WHEN v_date = v_reg.label_accepted_on THEN 'confirm' ELSE 'differs' END;
  v_change := NULL;
  IF v_dclass = 'fill' THEN
    v_class := 'fill';
    v_change := jsonb_build_object('label_accepted_on', v_date::text)
             || CASE WHEN v_url IS NOT NULL THEN jsonb_build_object('label_url', v_url) ELSE '{}'::jsonb END;
  ELSIF v_dclass = 'differs' THEN
    v_class := 'differs';
  ELSIF v_url IS NULL THEN
    v_class := v_dclass;  -- confirm, or no item when EPA gave neither
  ELSIF v_reg.label_url IS NULL AND v_dclass IS NULL AND v_reg.label_accepted_on IS NULL THEN
    -- An undated link is filled only onto a registration with no date either (Luna, 2026-11-11).
    v_class := 'fill';
    v_change := jsonb_build_object('label_url', v_url);
  ELSIF v_reg.label_url = v_url THEN
    v_class := 'confirm';
  ELSE
    v_class := 'differs';
  END IF;
  IF v_class IS NOT NULL THEN
    IF v_class = 'confirm' THEN v_change := '{}'::jsonb; END IF;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'label:label_document', 'kind', 'label', 'class', v_class,
      'epa', jsonb_build_object('label_accepted_on', v_date, 'label_url', v_url),
      'current', jsonb_build_object('label_accepted_on', v_reg.label_accepted_on, 'label_url', v_reg.label_url),
      'accept_default', v_class <> 'differs', 'note', v_label->>'date_note', 'change', v_change));
  ELSIF v_label->>'date_note' IS NOT NULL THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'label:label_document', 'kind', 'label', 'class', 'differs',
      'epa', NULL, 'current', jsonb_build_object('label_accepted_on', v_reg.label_accepted_on, 'label_url', v_reg.label_url),
      'accept_default', false, 'note', v_label->>'date_note'));
  END IF;
  RETURN v_items;
END;
$function$;

ALTER FUNCTION public._epa_proposal_items(uuid, text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._epa_proposal_items(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

DO $postflight$
DECLARE
  f constant regprocedure := 'public._epa_proposal_items(uuid,text,jsonb)'::regprocedure;
BEGIN
  IF (SELECT proowner FROM pg_proc WHERE oid = f) <> 'postgres'::regrole
     OR (SELECT proconfig FROM pg_proc WHERE oid = f) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = f)
     OR (SELECT provolatile FROM pg_proc WHERE oid = f) <> 's'
     OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('service_role', f, 'EXECUTE')
     OR has_function_privilege('metabase_ro', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_EPA_LONG_NAME_FUNCTION_WRONG';
  END IF;
  IF position('longer than 200 characters' in (SELECT prosrc FROM pg_proc WHERE oid = f)) = 0
     OR position('Taha, #1810' in (SELECT prosrc FROM pg_proc WHERE oid = f)) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_EPA_LONG_NAME_BODY_WRONG';
  END IF;
END
$postflight$;
