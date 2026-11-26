-- Better Product Labels Step 2. Prepare the brand-aware liquid weight workflow.
-- The switch remains closed until the new screens and legacy writer guards are ready.

DO $preflight$
BEGIN
  IF to_regclass('public.brand_document_links') IS NULL
     OR to_regprocedure('public.change_brand_document_links(uuid,boolean,integer,jsonb,text)') IS NULL
     OR (SELECT count(*) FROM pg_attribute
         WHERE attrelid = to_regclass('public.brand_document_links')
           AND attnum > 0 AND NOT attisdropped
           AND attname IN ('id', 'parent_brand_id', 'document_kind', 'hidden_at', 'url')) <> 5 THEN
    RAISE EXCEPTION 'PREFLIGHT_LIQUID_DENSITY_DOCUMENTS: apply the manufacturer brand document migration first';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.liquid_density_review_open() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
  SELECT false;
$function$;
ALTER FUNCTION public.liquid_density_review_open() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.liquid_density_review_open() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.liquid_density_review_open() TO authenticated;

CREATE FUNCTION public.get_liquid_density_review(p_parent_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE
  v_brands jsonb;
BEGIN
  IF NOT public.is_active_profile() THEN RAISE EXCEPTION 'ACTIVE_PROFILE_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_parents WHERE id = p_parent_id AND is_active AND product_form = 'liquid') THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_ELIGIBLE: the group is no longer an active liquid group';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'brand_id', b.id, 'brand_name', b.brand_name, 'epa_registration', b.epa_registration,
           'manufacturer', b.manufacturer, 'sds_link_id', d.id, 'sds_url', d.url
         ) ORDER BY lower(b.brand_name), b.id), '[]'::jsonb)
    INTO v_brands
    FROM public.product_parent_brands b
    LEFT JOIN public.brand_document_links d
      ON d.parent_brand_id = b.id AND d.document_kind = 'sds' AND d.hidden_at IS NULL
   WHERE b.parent_id = p_parent_id AND b.status = 'active';

  RETURN jsonb_build_object('review_open', public.liquid_density_review_open(), 'brands', v_brands);
END;
$function$;
ALTER FUNCTION public.get_liquid_density_review(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_liquid_density_review(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_liquid_density_review(uuid) TO authenticated;

-- The definer writes through the existing private helper, retaining its conversion and trust checks.
CREATE FUNCTION public.submit_liquid_density_draft(
  p_parent_id uuid,
  p_expected_version bigint,
  p_value numeric,
  p_unit text,
  p_source text,
  p_source_note text,
  p_reason text,
  p_evidence text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fingerprint text := md5(jsonb_build_object(
    'actor_id', v_actor, 'parent_id', p_parent_id, 'expected_version', p_expected_version,
    'value', p_value::text, 'unit', p_unit, 'source', p_source, 'source_note', p_source_note,
    'reason', p_reason, 'evidence', p_evidence
  )::text);
  v_receipt jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('crx.product_parent:submit_liquid_density_draft:' || p_idempotency_key));
  v_receipt := public.check_idempotency(p_idempotency_key, 'submit_liquid_density_draft');
  IF v_receipt IS NOT NULL THEN
    IF v_receipt->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_receipt->>'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_receipt->'response';
  END IF;
  IF NOT public.liquid_density_review_open() THEN RAISE EXCEPTION 'PRODUCT_WEIGHT_REVIEW_NOT_OPEN'; END IF;

  v_receipt := public._save_parent_density_draft(p_parent_id, p_expected_version, p_value, p_unit, p_source,
    p_source_note, p_reason, p_evidence);
  PERFORM public.save_idempotency(p_idempotency_key, 'submit_liquid_density_draft',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fingerprint, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.submit_liquid_density_draft(uuid, bigint, numeric, text, text, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.submit_liquid_density_draft(uuid, bigint, numeric, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.submit_liquid_density_draft(uuid, bigint, numeric, text, text, text, text, text, text) TO authenticated;

-- The definer publishes a pinned draft only after re-reading the brand and SDS roster under the parent lock.
CREATE FUNCTION public.approve_liquid_density_draft(
  p_parent_id uuid,
  p_draft_id uuid,
  p_expected_version bigint,
  p_reviewed_brands jsonb,
  p_all_brands_match boolean,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fingerprint text := md5(jsonb_build_object(
    'actor_id', v_actor, 'parent_id', p_parent_id, 'draft_id', p_draft_id, 'expected_version', p_expected_version,
    'reviewed_brands', p_reviewed_brands, 'all_brands_match', p_all_brands_match
  )::text);
  v_receipt jsonb;
  v_parent public.product_parents%ROWTYPE;
  v_version bigint;
  v_draft public.product_parent_density_values%ROWTYPE;
  v_approved public.product_parent_density_values%ROWTYPE;
  v_brands jsonb;
  v_draft_snapshot jsonb;
  v_approved_snapshot jsonb;
  v_before jsonb;
  v_after jsonb;
  v_event bigint;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('crx.product_parent:approve_liquid_density_draft:' || p_idempotency_key));
  v_receipt := public.check_idempotency(p_idempotency_key, 'approve_liquid_density_draft');
  IF v_receipt IS NOT NULL THEN
    IF v_receipt->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_receipt->>'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_receipt->'response';
  END IF;
  IF NOT public.liquid_density_review_open() THEN RAISE EXCEPTION 'PRODUCT_WEIGHT_REVIEW_NOT_OPEN'; END IF;
  IF p_all_brands_match IS NOT TRUE THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BRAND_CHECK_REQUIRED: confirm that every current brand matches before approving';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_REVIEW_RELOAD: reopen the review before approving';
  END IF;

  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT v_parent.is_active OR v_parent.product_form <> 'liquid' THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_ELIGIBLE: the group is no longer an active liquid group';
  END IF;
  SELECT density_version INTO v_version FROM public.product_parent_density_state
   WHERE parent_id = p_parent_id FOR UPDATE;
  IF NOT FOUND OR p_expected_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the weight changed since you opened it; reload';
  END IF;
  SELECT * INTO v_draft FROM public.product_parent_density_values
   WHERE id = p_draft_id AND parent_id = p_parent_id AND review_state = 'draft' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: this draft is no longer waiting for review; reload';
  END IF;
  IF v_draft.created_by IS NULL OR v_draft.created_by = v_actor THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_SECOND_ADMIN_REQUIRED: a different admin must approve this draft';
  END IF;
  IF v_draft.basis IS DISTINCT FROM jsonb_build_object(
    'product_form', v_parent.product_form, 'formulation_type', v_parent.formulation_type,
    'safener', v_parent.safener, 'generic_epa_registration', v_parent.generic_epa_registration
  ) THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BASIS_CHANGED: the draft was entered for a different formulation';
  END IF;

  v_brands := public.get_liquid_density_review(p_parent_id)->'brands';
  IF p_reviewed_brands IS DISTINCT FROM v_brands THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BRANDS_CHANGED: the brands or SDS links changed; reload and check them again';
  END IF;
  SELECT * INTO v_approved FROM public.product_parent_density_values
   WHERE parent_id = p_parent_id AND review_state = 'approved' FOR UPDATE;
  IF FOUND AND public._product_weight_trust_rank(v_draft.source) < public._product_weight_trust_rank(v_approved.source)
     AND (v_draft.reason IS NULL OR v_draft.evidence IS NULL) THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_LOWER_TRUST: the draft needs a reason and evidence to replace the approved source';
  END IF;

  v_draft_snapshot := jsonb_build_object(
    'value_id', v_draft.id, 'review_state', v_draft.review_state, 'value', v_draft.lb_per_gal,
    'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at
  );
  v_before := '[]'::jsonb;
  v_after := '[]'::jsonb;
  IF v_approved.id IS NOT NULL THEN
    v_approved_snapshot := jsonb_build_object(
      'value_id', v_approved.id, 'review_state', v_approved.review_state, 'value', v_approved.lb_per_gal,
      'basis', v_approved.basis, 'reviewed_by', v_approved.reviewed_by, 'reviewed_at', v_approved.reviewed_at
    );
    v_before := jsonb_build_array(v_approved_snapshot);
    v_after := jsonb_build_array(v_approved_snapshot || jsonb_build_object('review_state', 'superseded'));
    UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now()
     WHERE id = v_approved.id;
  END IF;

  UPDATE public.product_parent_density_values SET review_state = 'approved', reviewed_by = v_actor, reviewed_at = now()
   WHERE id = p_draft_id;
  v_before := v_before || jsonb_build_array(v_draft_snapshot);
  v_after := v_after || jsonb_build_array(v_draft_snapshot || jsonb_build_object(
    'review_state', 'approved', 'reviewed_by', v_actor, 'reviewed_at', now(), 'reviewed_brands', v_brands
  ));

  UPDATE public.product_parent_density_state SET density_version = density_version + 1
   WHERE parent_id = p_parent_id RETURNING density_version INTO v_version;
  v_event := public._product_weight_event('parent_density', p_parent_id, NULL, 'approved', p_draft_id,
    v_before, v_after, v_draft.reason, v_draft.evidence);
  v_receipt := jsonb_build_object(
    'kind', 'density', 'subject_id', p_parent_id, 'value_id', p_draft_id,
    'review_state', 'approved', 'lb_per_gal', v_draft.lb_per_gal, 'version', v_version, 'event_id', v_event
  );
  PERFORM public.save_idempotency(p_idempotency_key, 'approve_liquid_density_draft',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fingerprint, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.approve_liquid_density_draft(uuid, uuid, bigint, jsonb, boolean, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.approve_liquid_density_draft(uuid, uuid, bigint, jsonb, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.approve_liquid_density_draft(uuid, uuid, bigint, jsonb, boolean, text) TO authenticated;

-- The parent is already pinned by the brand writer. Reuse the density state lock
-- without upgrading the brand writer's parent lock.
CREATE FUNCTION public.return_liquid_density_to_draft_for_brand() RETURNS trigger
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
    IF (OLD.epa_registration, OLD.manufacturer) IS NOT DISTINCT FROM (NEW.epa_registration, NEW.manufacturer) THEN
      RETURN NULL;
    END IF;
    v_reason := 'An active brand changed its EPA registration or manufacturer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_parents WHERE id = NEW.parent_id AND is_active AND product_form = 'liquid') THEN
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
ALTER FUNCTION public.return_liquid_density_to_draft_for_brand() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.return_liquid_density_to_draft_for_brand()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER return_liquid_density_to_draft_for_brand
  AFTER INSERT OR UPDATE OF status, parent_id, epa_registration, manufacturer ON public.product_parent_brands
  FOR EACH ROW EXECUTE FUNCTION public.return_liquid_density_to_draft_for_brand();


-- Install switch-aware guards while the legacy application still works: the flag remains off.
CREATE OR REPLACE FUNCTION public._write_parent_density(p_mode text, p_parent_id uuid, p_expected bigint, p_value numeric,
  p_unit text, p_source text, p_note text, p_reason text, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_lb numeric;
  v_note text;
  v_reason text;
  v_evidence text;
  v_parent public.product_parents%ROWTYPE;
  v_version bigint;
  v_appr public.product_parent_density_values%ROWTYPE;
  v_draft public.product_parent_density_values%ROWTYPE;
  v_has_appr boolean;
  v_has_draft boolean;
  v_new public.product_parent_density_values%ROWTYPE;
  v_before jsonb := '[]'::jsonb;
  v_after jsonb := '[]'::jsonb;
  v_type text;
  v_event bigint;
BEGIN
  IF p_unit IS NULL OR p_unit NOT IN ('lb_per_gal', 'specific_gravity') THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_UNIT: enter the weight in lb_per_gal or specific_gravity';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('measured', 'sds', 'label', 'supplier') THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_SOURCE: the source must be measured, sds, label or supplier';
  END IF;
  IF p_value IS NULL OR p_value::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_VALUE: enter a number';
  END IF;
  -- Rounded first (half-up, 4 decimals), then range-checked, so a value that rounds to 0 is refused by name.
  v_lb := round(CASE p_unit WHEN 'specific_gravity' THEN p_value * 8.345404 ELSE p_value END, 4);
  IF v_lb <= 0 OR v_lb > 20 THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_OUT_OF_RANGE: weight per gallon must be above 0 and at most 20 lb/gal (this is % lb/gal)', v_lb;
  END IF;
  v_note := public._product_parent_reason(p_note, 'note', false);
  IF p_mode = 'correct' THEN
    v_reason := public._product_parent_reason(p_reason, 'reason', true);
    v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
  ELSIF p_mode = 'draft' AND public.liquid_density_review_open() THEN
    v_reason := public._product_parent_reason(p_reason, 'reason', false);
    v_evidence := public._product_parent_reason(p_evidence, 'evidence', false);
  END IF;

  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT v_parent.is_active OR v_parent.product_form <> 'liquid' THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_LIQUID: weight per gallon is recorded only for an active liquid parent';
  END IF;
  INSERT INTO public.product_parent_density_state (parent_id) VALUES (p_parent_id) ON CONFLICT DO NOTHING;
  SELECT density_version INTO v_version FROM public.product_parent_density_state WHERE parent_id = p_parent_id FOR UPDATE;
  IF p_expected IS NULL OR v_version <> p_expected THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the weight of "%" changed since you opened it; reload', v_parent.name;
  END IF;

  SELECT * INTO v_appr FROM public.product_parent_density_values
   WHERE parent_id = p_parent_id AND review_state = 'approved' FOR UPDATE;
  v_has_appr := FOUND;
  SELECT * INTO v_draft FROM public.product_parent_density_values
   WHERE parent_id = p_parent_id AND review_state = 'draft' FOR UPDATE;
  v_has_draft := FOUND;

  IF public.liquid_density_review_open() THEN
    IF p_mode IN ('set', 'correct') THEN
      RAISE EXCEPTION 'PRODUCT_WEIGHT_REVIEW_RELOAD: reopen this product to submit a liquid weight draft';
    END IF;
    IF p_mode = 'draft' AND v_has_draft THEN
      RAISE EXCEPTION 'PRODUCT_WEIGHT_DRAFT_WAITING: a draft is already waiting for a different admin to review';
    END IF;
  END IF;

  IF v_has_appr AND public._product_weight_trust_rank(p_source) < public._product_weight_trust_rank(v_appr.source) THEN
    IF p_mode = 'set' THEN
      RAISE EXCEPTION 'PRODUCT_WEIGHT_LOWER_TRUST: the approved value is from the %; use Correct weight with a reason and evidence', v_appr.source;
    ELSIF p_mode = 'draft' THEN
      v_reason := public._product_parent_reason(p_reason, 'reason', true);
      v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
    END IF;
  END IF;

  IF p_mode IN ('set', 'correct') AND v_has_appr THEN
    v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_appr.id, 'review_state', v_appr.review_state,
      'value', v_appr.lb_per_gal, 'basis', v_appr.basis, 'reviewed_by', v_appr.reviewed_by, 'reviewed_at', v_appr.reviewed_at));
    UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now()
     WHERE id = v_appr.id RETURNING * INTO v_appr;
    v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_appr.id, 'review_state', v_appr.review_state,
      'value', v_appr.lb_per_gal, 'basis', v_appr.basis, 'reviewed_by', v_appr.reviewed_by, 'reviewed_at', v_appr.reviewed_at));
  END IF;
  IF v_has_draft THEN
    v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_draft.id, 'review_state', v_draft.review_state,
      'value', v_draft.lb_per_gal, 'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at));
    UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now()
     WHERE id = v_draft.id RETURNING * INTO v_draft;
    v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_draft.id, 'review_state', v_draft.review_state,
      'value', v_draft.lb_per_gal, 'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at));
  END IF;

  INSERT INTO public.product_parent_density_values (parent_id, lb_per_gal, entered_value, entered_unit, source, source_note,
    basis, review_state, reason, evidence, created_by, reviewed_by, reviewed_at)
  VALUES (p_parent_id, v_lb, p_value, p_unit, p_source, v_note,
    jsonb_build_object('product_form', v_parent.product_form, 'formulation_type', v_parent.formulation_type,
      'safener', v_parent.safener, 'generic_epa_registration', v_parent.generic_epa_registration),
    CASE WHEN p_mode = 'draft' THEN 'draft' ELSE 'approved' END, v_reason, v_evidence, auth.uid(),
    CASE WHEN p_mode = 'draft' THEN NULL ELSE auth.uid() END, CASE WHEN p_mode = 'draft' THEN NULL ELSE now() END)
  RETURNING * INTO v_new;
  v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_new.id, 'review_state', v_new.review_state,
    'value', v_new.lb_per_gal, 'basis', v_new.basis, 'reviewed_by', v_new.reviewed_by, 'reviewed_at', v_new.reviewed_at));

  UPDATE public.product_parent_density_state SET density_version = density_version + 1
   WHERE parent_id = p_parent_id RETURNING density_version INTO v_version;
  v_type := CASE p_mode WHEN 'set' THEN 'approved' WHEN 'correct' THEN 'corrected'
                        ELSE CASE WHEN v_has_draft THEN 'draft_replaced' ELSE 'draft_saved' END END;
  v_event := public._product_weight_event('parent_density', p_parent_id, NULL, v_type, v_new.id,
    v_before, v_after, v_reason, v_evidence);
  RETURN jsonb_build_object('kind', 'density', 'subject_id', p_parent_id, 'value_id', v_new.id,
    'review_state', v_new.review_state, 'lb_per_gal', v_new.lb_per_gal, 'version', v_version, 'event_id', v_event);
END;
$function$;

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

  IF public.liquid_density_review_open() AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'density'
  ) THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_REVIEW_RELOAD: check the whole brand group on its weight card before approving';
  END IF;

  -- Subject rows, all parents before all sizes, each in ID order; then version rows in the same order.
  FOR v_id IN SELECT (e->>'subject_id')::uuid FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'density' ORDER BY 1 LOOP
    PERFORM 1 FROM public.product_parents WHERE id = v_id FOR NO KEY UPDATE;
  END LOOP;
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
