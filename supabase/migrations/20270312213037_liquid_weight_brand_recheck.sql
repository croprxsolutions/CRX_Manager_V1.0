-- Prepare the liquid Weight review without opening the switch or rewriting existing approvals.
-- Replacements retain the existing owners, signatures, and execute grants.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF public.liquid_density_review_open() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PREFLIGHT_LIQUID_WEIGHT_BRAND_RECHECK: the weight review switch must be closed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.approve_weights(jsonb,text)', 'adda6f0854f3de86bca3e5d50ae88113'),
      ('public.return_liquid_density_to_draft_for_brand()', 'f4a558214d47daf8d0bc2c2785e2f113')
    ) AS expected(signature, body_md5)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = to_regprocedure(expected.signature)
    WHERE md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM expected.body_md5
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_LIQUID_WEIGHT_BRAND_RECHECK: existing weight functions differ from the reviewed versions';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.return_liquid_density_to_draft_for_brand() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_approved public.product_parent_density_values%ROWTYPE;
  v_existing_draft boolean;
  v_before jsonb;
  v_after jsonb;
  v_reason text := 'An active brand joined the product group';
BEGIN
  IF NOT public.liquid_density_review_open() OR NEW.status <> 'active' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND OLD.parent_id = NEW.parent_id THEN
    IF lower(btrim(regexp_replace(OLD.brand_name, '[[:space:]]+', ' ', 'g')))
        IS DISTINCT FROM lower(btrim(regexp_replace(NEW.brand_name, '[[:space:]]+', ' ', 'g'))) THEN
      v_reason := 'An active brand changed its name';
    ELSIF (OLD.epa_registration, OLD.manufacturer) IS DISTINCT FROM (NEW.epa_registration, NEW.manufacturer) THEN
      v_reason := 'An active brand changed its EPA registration or manufacturer';
    ELSE
      RETURN NULL;
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_parents WHERE id = NEW.parent_id AND product_form = 'liquid') THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM public.product_parent_density_state WHERE parent_id = NEW.parent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_approved FROM public.product_parent_density_values
   WHERE parent_id = NEW.parent_id AND review_state = 'approved' FOR UPDATE;
  v_existing_draft := EXISTS (
    SELECT 1 FROM public.product_parent_density_values WHERE parent_id = NEW.parent_id AND review_state = 'draft'
  );
  IF v_approved.id IS NULL AND NOT v_existing_draft THEN RETURN NULL; END IF;

  UPDATE public.product_parent_density_state SET density_version = density_version + 1
   WHERE parent_id = NEW.parent_id;
  IF v_approved.id IS NULL THEN RETURN NULL; END IF;

  v_before := jsonb_build_object(
    'value_id', v_approved.id, 'review_state', 'approved', 'value', v_approved.lb_per_gal,
    'basis', v_approved.basis, 'reviewed_by', v_approved.reviewed_by, 'reviewed_at', v_approved.reviewed_at
  );
  IF v_existing_draft THEN
    UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now()
     WHERE id = v_approved.id;
    v_after := v_before || jsonb_build_object('review_state', 'superseded');
  ELSE
    UPDATE public.product_parent_density_values SET review_state = 'draft', reviewed_by = NULL, reviewed_at = NULL
     WHERE id = v_approved.id;
    v_after := v_before || jsonb_build_object('review_state', 'draft', 'reviewed_by', NULL, 'reviewed_at', NULL);
  END IF;
  PERFORM public._product_weight_event('parent_density', NEW.parent_id, NULL, 'returned_to_draft', v_approved.id,
    jsonb_build_array(v_before), jsonb_build_array(v_after), v_reason, NULL);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE TRIGGER return_liquid_density_to_draft_for_brand
  AFTER INSERT OR UPDATE OF status, parent_id, brand_name, epa_registration, manufacturer ON public.product_parent_brands
  FOR EACH ROW EXECUTE FUNCTION public.return_liquid_density_to_draft_for_brand();

CREATE OR REPLACE FUNCTION public.approve_weights(p_items jsonb, p_idempotency_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', v_actor, 'items', p_items)::text);
  v_existing jsonb;
  v_n int;
  v_i int;
  v_it jsonb;
  v_id uuid;
  v_subject uuid;
  v_draft_id uuid;
  v_expected bigint;
  v_version bigint;
  v_parent public.product_parents%ROWTYPE;
  v_p public.products%ROWTYPE;
  v_basis jsonb;
  v_d_appr public.product_parent_density_values%ROWTYPE;
  v_d_draft public.product_parent_density_values%ROWTYPE;
  v_n_appr public.product_size_net_weight_values%ROWTYPE;
  v_n_draft public.product_size_net_weight_values%ROWTYPE;
  v_has_appr boolean;
  v_before jsonb;
  v_after jsonb;
  v_event bigint;
  v_done jsonb := '[]'::jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('crx.product_parent:approve_weights:' || p_idempotency_key));
  v_existing := public.check_idempotency(p_idempotency_key, 'approve_weights');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- Shape first, before any subject or version row is locked.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_REQUEST: send a list of 1 to 200 items';
  END IF;
  v_n := jsonb_array_length(p_items);
  IF v_n < 1 OR v_n > 200 THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_REQUEST: send a list of 1 to 200 items';
  END IF;
  FOR v_i IN 0 .. v_n - 1 LOOP
    IF NOT public._approve_weight_item_ok(p_items->v_i) THEN
      RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_REQUEST: item % must be exactly {kind, subject_id, draft_id, expected_version}', v_i + 1;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) e
              GROUP BY e->>'kind', (e->>'subject_id')::uuid HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_DUPLICATE_ITEM: each weight may appear once per approval';
  END IF;

  -- Subject rows, all parents before all sizes, each in ID order; then version rows in the same order.
  FOR v_id IN SELECT (e->>'subject_id')::uuid FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'density' ORDER BY 1 LOOP
    PERFORM 1 FROM public.product_parents WHERE id = v_id FOR NO KEY UPDATE;
  END LOOP;
  -- Check after the parent locks so an in-flight legacy approval and cutover cannot cross.
  IF public.liquid_density_review_open() AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'density'
  ) THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_REVIEW_RELOAD: check the whole brand group on its weight card before approving';
  END IF;

  FOR v_id IN SELECT (e->>'subject_id')::uuid FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'net_weight' ORDER BY 1 LOOP
    PERFORM 1 FROM public.products WHERE id = v_id FOR NO KEY UPDATE;
  END LOOP;
  FOR v_id IN SELECT (e->>'subject_id')::uuid FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'density' ORDER BY 1 LOOP
    IF EXISTS (SELECT 1 FROM public.product_parents WHERE id = v_id) THEN
      INSERT INTO public.product_parent_density_state (parent_id) VALUES (v_id) ON CONFLICT DO NOTHING;
      PERFORM 1 FROM public.product_parent_density_state WHERE parent_id = v_id FOR UPDATE;
    END IF;
  END LOOP;
  FOR v_id IN SELECT (e->>'subject_id')::uuid FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'net_weight' ORDER BY 1 LOOP
    IF EXISTS (SELECT 1 FROM public.products WHERE id = v_id) THEN
      INSERT INTO public.product_size_net_weight_state (product_id) VALUES (v_id) ON CONFLICT DO NOTHING;
      PERFORM 1 FROM public.product_size_net_weight_state WHERE product_id = v_id FOR UPDATE;
    END IF;
  END LOOP;

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_it := p_items->v_i;
    v_subject := (v_it->>'subject_id')::uuid;
    v_draft_id := (v_it->>'draft_id')::uuid;
    v_expected := (v_it->'expected_version')::numeric::bigint;
    v_before := '[]'::jsonb;
    v_after := '[]'::jsonb;
    IF v_it->>'kind' = 'density' THEN
      SELECT * INTO v_parent FROM public.product_parents WHERE id = v_subject;
      IF NOT FOUND OR NOT v_parent.is_active OR v_parent.product_form <> 'liquid' THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_ELIGIBLE: item % is not an active liquid parent', v_i + 1;
      END IF;
      SELECT density_version INTO v_version FROM public.product_parent_density_state WHERE parent_id = v_subject;
      IF v_version <> v_expected THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the weight of "%" changed since you opened it; reload', v_parent.name;
      END IF;
      SELECT * INTO v_d_draft FROM public.product_parent_density_values
       WHERE id = v_draft_id AND parent_id = v_subject AND review_state = 'draft' FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the draft weight of "%" was replaced; reload', v_parent.name;
      END IF;
      v_basis := jsonb_build_object('product_form', v_parent.product_form, 'formulation_type', v_parent.formulation_type,
        'safener', v_parent.safener, 'generic_epa_registration', v_parent.generic_epa_registration);
      IF v_d_draft.basis IS DISTINCT FROM v_basis THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_BASIS_CHANGED: the draft weight of "%" was entered for a different formulation; enter it again', v_parent.name;
      END IF;
      SELECT * INTO v_d_appr FROM public.product_parent_density_values
       WHERE parent_id = v_subject AND review_state = 'approved' FOR UPDATE;
      v_has_appr := FOUND;
      IF v_has_appr AND public._product_weight_trust_rank(v_d_draft.source) < public._product_weight_trust_rank(v_d_appr.source)
         AND (v_d_draft.reason IS NULL OR v_d_draft.evidence IS NULL) THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_LOWER_TRUST: the approved value of "%" is from the %; the draft needs a reason and evidence', v_parent.name, v_d_appr.source;
      END IF;
      IF v_has_appr THEN
        v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_d_appr.id, 'review_state', v_d_appr.review_state,
          'value', v_d_appr.lb_per_gal, 'basis', v_d_appr.basis, 'reviewed_by', v_d_appr.reviewed_by, 'reviewed_at', v_d_appr.reviewed_at));
        UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now()
         WHERE id = v_d_appr.id RETURNING * INTO v_d_appr;
        v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_d_appr.id, 'review_state', v_d_appr.review_state,
          'value', v_d_appr.lb_per_gal, 'basis', v_d_appr.basis, 'reviewed_by', v_d_appr.reviewed_by, 'reviewed_at', v_d_appr.reviewed_at));
      END IF;
      v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_d_draft.id, 'review_state', v_d_draft.review_state,
        'value', v_d_draft.lb_per_gal, 'basis', v_d_draft.basis, 'reviewed_by', v_d_draft.reviewed_by, 'reviewed_at', v_d_draft.reviewed_at));
      UPDATE public.product_parent_density_values SET review_state = 'approved', reviewed_by = v_actor, reviewed_at = now()
       WHERE id = v_d_draft.id RETURNING * INTO v_d_draft;
      v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_d_draft.id, 'review_state', v_d_draft.review_state,
        'value', v_d_draft.lb_per_gal, 'basis', v_d_draft.basis, 'reviewed_by', v_d_draft.reviewed_by, 'reviewed_at', v_d_draft.reviewed_at));
      UPDATE public.product_parent_density_state SET density_version = density_version + 1
       WHERE parent_id = v_subject RETURNING density_version INTO v_version;
      v_event := public._product_weight_event('parent_density', v_subject, NULL, 'approved', v_d_draft.id,
        v_before, v_after, v_d_draft.reason, v_d_draft.evidence);
    ELSE
      SELECT * INTO v_p FROM public.products WHERE id = v_subject;
      IF NOT FOUND OR NOT COALESCE(v_p.is_active, false) OR v_p.product_form IS DISTINCT FROM 'dry'
         OR public._weight_unit_factors()->'factors'->lower(btrim(COALESCE(v_p.inventory_unit, '')))->>'kind' IS DISTINCT FROM 'count' THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_ELIGIBLE: item % is not an active dry size stocked in a count unit', v_i + 1;
      END IF;
      SELECT net_weight_version INTO v_version FROM public.product_size_net_weight_state WHERE product_id = v_subject;
      IF v_version <> v_expected THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the weight of "%" changed since you opened it; reload', v_p.product_name;
      END IF;
      SELECT * INTO v_n_draft FROM public.product_size_net_weight_values
       WHERE id = v_draft_id AND product_id = v_subject AND review_state = 'draft' FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the draft weight of "%" was replaced; reload', v_p.product_name;
      END IF;
      v_basis := jsonb_build_object('container_size', v_p.container_size, 'container_type', v_p.container_type,
        'container_unit', v_p.container_unit, 'inventory_unit', v_p.inventory_unit, 'unit_size', v_p.unit_size);
      IF v_n_draft.basis IS DISTINCT FROM v_basis THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_BASIS_CHANGED: the draft weight of "%" was entered for a different pack; enter it again', v_p.product_name;
      END IF;
      SELECT * INTO v_n_appr FROM public.product_size_net_weight_values
       WHERE product_id = v_subject AND review_state = 'approved' FOR UPDATE;
      v_has_appr := FOUND;
      IF v_has_appr AND public._product_weight_trust_rank(v_n_draft.source) < public._product_weight_trust_rank(v_n_appr.source)
         AND (v_n_draft.reason IS NULL OR v_n_draft.evidence IS NULL) THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_LOWER_TRUST: the approved value of "%" is from the %; the draft needs a reason and evidence', v_p.product_name, v_n_appr.source;
      END IF;
      IF v_has_appr THEN
        v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_n_appr.id, 'review_state', v_n_appr.review_state,
          'value', v_n_appr.net_lb, 'basis', v_n_appr.basis, 'reviewed_by', v_n_appr.reviewed_by, 'reviewed_at', v_n_appr.reviewed_at));
        UPDATE public.product_size_net_weight_values SET review_state = 'superseded', superseded_at = now()
         WHERE id = v_n_appr.id RETURNING * INTO v_n_appr;
        v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_n_appr.id, 'review_state', v_n_appr.review_state,
          'value', v_n_appr.net_lb, 'basis', v_n_appr.basis, 'reviewed_by', v_n_appr.reviewed_by, 'reviewed_at', v_n_appr.reviewed_at));
      END IF;
      v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_n_draft.id, 'review_state', v_n_draft.review_state,
        'value', v_n_draft.net_lb, 'basis', v_n_draft.basis, 'reviewed_by', v_n_draft.reviewed_by, 'reviewed_at', v_n_draft.reviewed_at));
      UPDATE public.product_size_net_weight_values SET review_state = 'approved', reviewed_by = v_actor, reviewed_at = now()
       WHERE id = v_n_draft.id RETURNING * INTO v_n_draft;
      v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_n_draft.id, 'review_state', v_n_draft.review_state,
        'value', v_n_draft.net_lb, 'basis', v_n_draft.basis, 'reviewed_by', v_n_draft.reviewed_by, 'reviewed_at', v_n_draft.reviewed_at));
      UPDATE public.product_size_net_weight_state SET net_weight_version = net_weight_version + 1
       WHERE product_id = v_subject RETURNING net_weight_version INTO v_version;
      v_event := public._product_weight_event('size_net_weight', NULL, v_subject, 'approved', v_n_draft.id,
        v_before, v_after, v_n_draft.reason, v_n_draft.evidence);
    END IF;
    v_done := v_done || jsonb_build_array(jsonb_build_object('kind', v_it->>'kind', 'subject_id', v_subject,
      'value_id', v_draft_id, 'version', v_version, 'event_id', v_event));
  END LOOP;

  v_existing := jsonb_build_object('approved', v_done);
  PERFORM public.save_idempotency(p_idempotency_key, 'approve_weights',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_existing));
  RETURN v_existing;
END;
$function$;
