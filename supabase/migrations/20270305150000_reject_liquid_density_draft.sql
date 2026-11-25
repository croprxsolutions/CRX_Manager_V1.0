-- Better Product Labels Step 2: a second admin can reject a waiting liquid density
-- draft with a reason. The value and audit events stay available after rejection.
-- The definer writes the protected density and history tables after an admin check.

ALTER TABLE public.product_weight_events
  DROP CONSTRAINT product_weight_events_event_type_check,
  ADD CONSTRAINT product_weight_events_event_type_check CHECK (
    event_type IN ('draft_saved', 'draft_replaced', 'approved', 'corrected', 'returned_to_draft', 'draft_rejected')
  );

CREATE FUNCTION public.reject_liquid_density_draft(
  p_parent_id uuid,
  p_draft_id uuid,
  p_expected_version bigint,
  p_reason text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_reason text := public._product_parent_reason(p_reason, 'reason', true);
  v_fingerprint text := md5(jsonb_build_object(
    'actor_id', v_actor, 'parent_id', p_parent_id, 'draft_id', p_draft_id,
    'expected_version', p_expected_version, 'reason', v_reason
  )::text);
  v_receipt jsonb;
  v_version bigint;
  v_draft public.product_parent_density_values%ROWTYPE;
  v_before jsonb;
  v_event bigint;
BEGIN
  v_receipt := public._product_parent_replay(p_idempotency_key, 'reject_liquid_density_draft', v_fingerprint);
  IF v_receipt IS NOT NULL THEN RETURN v_receipt; END IF;

  -- Use the same parent then state lock order as the existing writers and approval batch.
  PERFORM 1 FROM public.product_parents
   WHERE id = p_parent_id AND is_active AND product_form = 'liquid' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
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
  IF v_draft.created_by = v_actor THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_SECOND_ADMIN_REQUIRED: ask another admin to review this draft';
  END IF;

  v_before := jsonb_build_object(
    'value_id', v_draft.id, 'review_state', v_draft.review_state, 'value', v_draft.lb_per_gal,
    'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at
  );
  UPDATE public.product_parent_density_values
     SET review_state = 'superseded', superseded_at = now()
   WHERE id = v_draft.id;

  UPDATE public.product_parent_density_state SET density_version = density_version + 1
   WHERE parent_id = p_parent_id RETURNING density_version INTO v_version;

  v_event := public._product_weight_event('parent_density', p_parent_id, NULL, 'draft_rejected', v_draft.id,
    jsonb_build_array(v_before), jsonb_build_array(v_before || jsonb_build_object('review_state', 'superseded')),
    v_reason, NULL);
  v_receipt := jsonb_build_object(
    'kind', 'density', 'subject_id', p_parent_id, 'value_id', v_draft.id,
    'review_state', 'superseded', 'version', v_version, 'event_id', v_event
  );
  PERFORM public.save_idempotency(p_idempotency_key, 'reject_liquid_density_draft',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fingerprint, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;

ALTER FUNCTION public.reject_liquid_density_draft(uuid, uuid, bigint, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_liquid_density_draft(uuid, uuid, bigint, text, text)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.reject_liquid_density_draft(uuid, uuid, bigint, text, text) TO authenticated;
