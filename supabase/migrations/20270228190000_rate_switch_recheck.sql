-- idempotency-body-check: exempt
-- (commit_parent_rate_cutover keeps the 20270125100000 receipt path: _product_parent_replay checks the key first and
--  save_idempotency stores the receipt last, in the same transaction.)
-- actor-binding-check: exempt — both public functions take the actor from _product_parent_require_admin() (auth.uid()).
--
-- Written 2026-11-24. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270228190000_rate_switch_recheck.md.
--
-- WHY (#2379, #1813; Mason's decisions D1 and D2, 2026-11-23): the rate switch publishes the rate approved in Rate
--   Review as the group's catalog rate, trusting the stored approval. Two things can change after approval:
--   * the product's label maximum (a lower maximum makes the approved rate over-label, with no over-label reason);
--   * the group's form, so an approved row's unit no longer fits it, or a row's basis is no longer confirmed.
--   Contract: docs/plans/2026-11-23-product-RT4a-cutover-button-CONTRACT.md, amendment "Re-check at the switch".
--
-- WHAT: a new private _rate_cutover_recheck runs after _rate_cutover_plan (unchanged, 20270227160000) inside the same
--   transaction and locks, on a switch to the approved rate only (switching back is never refused by it):
--   * D2: any approved RT-3 row of the group whose basis is not confirmed, or whose unit does not fit the group's
--     form as it is now (_product_rate_unit_fits, the rule approval and Rate Review's outcome check use), refuses
--     PRODUCT_PARENT_CUTOVER_REAPPROVE ("re-approve this rate in Rate Review").
--   * D1: the approved quoting default's recommended rate is checked against the current label maximum with
--     _product_rate_check_values (Rate Review's own check). When it is above, the switch needs a typed over-label
--     reason (trimmed, at most 500 characters, as Rate Review stores it); without one, preview and commit refuse
--     PRODUCT_PARENT_CUTOVER_OVER_LABEL. The reason and the label check are recorded in the rates_promoted event.
--   preview_parent_rate_cutover and commit_parent_rate_cutover gain p_over_label_reason text DEFAULT NULL as their
--   last argument, so existing calls keep their meaning (the old signatures are dropped, so a call without the new
--   argument still resolves to exactly one function). Their bodies
--   are the 20270125100000 bodies plus the re-check; commit's retry fingerprint also covers the over-label reason.
--
-- NOT CHANGED: every table, row and policy; _rate_cutover_plan and every other function. No parent switches.
--   Live read 2026-11-24: 413 active groups have a promotable outcome; 0 have an approved row failing the form or
--   basis check; 0 approved defaults carry an over-label reason.
--
-- ROLLBACK (its own reviewed migration): drop the three functions and re-create the two public ones from
--   20270125100000 (bodies md5 a923a78b5329538c1d7e7d76902349a6 and 1d199caeea7f94b0b7b1f94d99768694) with their
--   grants. Events already written keep their extra keys, which nothing reads.
--
-- ORDERING: after 20270227160000. Not re-runnable (preflight refuses).

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regprocedure('public._rate_cutover_recheck(uuid,jsonb,text)') IS NOT NULL
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public._rate_cutover_plan(uuid,text)')) IS DISTINCT FROM '61322113ae88a29b0a1d4986f161cd3d'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.preview_parent_rate_cutover(uuid,text)')) IS DISTINCT FROM 'a923a78b5329538c1d7e7d76902349a6'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.commit_parent_rate_cutover(uuid,text,jsonb,text,text)')) IS DISTINCT FROM '1d199caeea7f94b0b7b1f94d99768694'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public._product_rate_check_values(uuid,text,text,text,numeric,numeric,numeric,boolean,text)')) IS DISTINCT FROM '24d3e1454ff18158ab990fab9c6882d6'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public._product_rate_unit_fits(text,text,text)')) IS DISTINCT FROM '47ba416ac1c343a470cd59c616400c64'
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('preview_parent_rate_cutover', 'commit_parent_rate_cutover')) <> 2 THEN
    RAISE EXCEPTION 'RATE_SWITCH_RECHECK_PREFLIGHT: the rate switch functions are not the reviewed versions';
  END IF;
END;
$preflight$;

-- Re-checks a promote plan as the group is now. Returns the plan plus label_check and over_label_reason, or raises.
CREATE FUNCTION public._rate_cutover_recheck(p_parent_id uuid, p_plan jsonb, p_over_label_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_form text;
  v_bad text;
  v_rate public.product_rates%ROWTYPE;
  v_check jsonb;
  -- Trimmed like product_rates.over_label_reason (space, tab, CR, LF, no-break space); a reason needs a letter or digit.
  v_reason text := NULLIF(btrim(COALESCE(p_over_label_reason, ''), E' \t\r\n' || chr(160)), '');
BEGIN
  IF p_plan->>'direction' IS DISTINCT FROM 'promote' THEN
    RETURN p_plan;
  END IF;
  IF v_reason !~ '[[:alnum:]]' THEN v_reason := NULL; END IF;
  -- The plan holds the parent, size and RT-3 row locks to commit, so the form and rows read here stay as read.
  SELECT product_form INTO v_form FROM public.product_parents WHERE id = p_parent_id;

  -- D2: the approval's checks on every approved row, against the form as it is now.
  SELECT string_agg(r.source || ' ' || r.basis || ': ' || CASE WHEN NOT r.basis_confirmed THEN 'basis not confirmed'
                      ELSE r.unit || ' does not fit a ' || v_form || ' product' END, '; ' ORDER BY r.id)
    INTO v_bad
    FROM public.product_rates r LEFT JOIN public.product_rate_units u ON u.code = r.unit
   WHERE r.parent_id = p_parent_id AND r.status = 'approved'
     AND (NOT r.basis_confirmed OR NOT COALESCE(public._product_rate_unit_fits(v_form, r.basis, u.kind), false));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_REAPPROVE: the form or rate basis of "%" changed since its rate was approved (%); re-approve this rate in Rate Review',
      p_plan->>'name', v_bad;
  END IF;

  -- D1: the rate being published (the quoting default's recommended rate) against the label maximum as it is now.
  IF p_plan->>'outcome' = 'approved_default' THEN
    SELECT * INTO v_rate FROM public.product_rates WHERE id = (p_plan->'snapshot'->'approved'->>'rate_id')::uuid
      AND parent_id = p_parent_id AND status = 'approved' AND is_quoting_default;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_STALE: "%" has no approved quoting default to check; preview again', p_plan->>'name';
    END IF;
    v_check := public._product_rate_check_values(p_parent_id, v_rate.source, v_rate.basis, v_rate.unit, NULL,
      v_rate.recommended, NULL, v_rate.basis_confirmed, v_reason);
    IF v_check->>'status' = 'above' AND v_reason IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_OVER_LABEL: the approved rate of "%" (% %/acre) is above the current label maximum on EPA % (% %); type an over-label reason to switch',
        p_plan->>'name', trim_scale(v_rate.recommended), p_plan->'target'->>'rate_unit',
        v_check->'above'->0->>'epa_registration', v_check->'above'->0->>'max_label_rate', v_check->'above'->0->>'max_label_rate_unit';
    END IF;
    IF v_check->>'status' = 'above' AND length(v_reason) > 500 THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_OVER_LABEL_REASON_TOO_LONG: keep the over-label reason to 500 characters';
    END IF;
  END IF;
  -- The label check joins `expected`, so commit refuses as stale when the label or its maximum changed after the
  -- preview, even if a reason was given for the maximum the admin saw.
  RETURN p_plan || jsonb_build_object('label_check', v_check,
      'over_label_reason', CASE WHEN v_check->>'status' = 'above' THEN v_reason END)
    || CASE WHEN v_check IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('expected', (p_plan->'expected') || jsonb_build_object('label_check', v_check)) END;
END;
$function$;
ALTER FUNCTION public._rate_cutover_recheck(uuid, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._rate_cutover_recheck(uuid, jsonb, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

DROP FUNCTION public.preview_parent_rate_cutover(uuid, text);
DROP FUNCTION public.commit_parent_rate_cutover(uuid, text, jsonb, text, text);

-- Advisory: what commit would do, or why it is refused. Takes the same row locks for the length of the call.
CREATE FUNCTION public.preview_parent_rate_cutover(p_parent_id uuid, p_direction text, p_over_label_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_plan jsonb;
BEGIN
  PERFORM public._product_parent_require_admin();
  BEGIN
    v_plan := public._rate_cutover_recheck(p_parent_id, public._rate_cutover_plan(p_parent_id, p_direction), p_over_label_reason);
  EXCEPTION WHEN raise_exception OR check_violation THEN
    RETURN jsonb_build_object('parent_id', p_parent_id, 'direction', p_direction, 'eligible', false, 'refusal', SQLERRM);
  END;
  RETURN v_plan || jsonb_build_object('eligible', true);
END;
$function$;
ALTER FUNCTION public.preview_parent_rate_cutover(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_parent_rate_cutover(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.preview_parent_rate_cutover(uuid, text, text) TO authenticated;

CREATE FUNCTION public.commit_parent_rate_cutover(p_parent_id uuid, p_direction text, p_expected jsonb, p_reason text,
  p_idempotency_key text DEFAULT NULL, p_over_label_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  -- With no over-label reason the fingerprint is the 20270125100000 one, so a retry of a switch made before this
  -- migration replays its receipt.
  v_fp text := md5((jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id, 'direction', p_direction,
    'expected', p_expected, 'reason', btrim(p_reason))
    || CASE WHEN NULLIF(btrim(COALESCE(p_over_label_reason, ''), E' \t\r\n' || chr(160)), '') IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('over_label_reason', btrim(p_over_label_reason, E' \t\r\n' || chr(160))) END)::text);
  v_existing jsonb;
  v_reason text;
  v_plan jsonb;
  v_before public.product_parents%ROWTYPE;
  v_parent public.product_parents%ROWTYPE;
  v_apply jsonb;
  v_event bigint;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'commit_parent_rate_cutover', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  v_plan := public._rate_cutover_recheck(p_parent_id, public._rate_cutover_plan(p_parent_id, p_direction), p_over_label_reason);
  -- Strict: the whole expected object (versions, RT-3 rows, every size's snapshot and prices) must equal today's.
  IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object' OR p_expected IS DISTINCT FROM v_plan->'expected' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_STALE: "%" changed since the preview; preview again', v_plan->>'name';
  END IF;

  INSERT INTO public.product_rate_cutover_passes (txid, parent_id) VALUES (txid_current(), p_parent_id);
  SELECT * INTO v_before FROM public.product_parents WHERE id = p_parent_id;
  IF (v_plan->>'changes')::boolean THEN
    v_apply := public._apply_parent_rates(p_parent_id, v_before.parent_version,
      (v_plan->'target'->>'rate_per_acre')::numeric, v_plan->'target'->>'rate_unit', v_plan->'target'->>'suggested_rate',
      v_plan->'expected'->'sizes', true, v_reason);
  END IF;
  IF p_direction = 'promote' THEN
    -- The snapshot (v 1) keeps its keys; the label check and any over-label reason ride beside them.
    v_event := public._product_parent_event(NULL, p_parent_id, 'rates_promoted', v_reason, NULL,
      public._product_parent_values(v_before),
      v_plan->'snapshot' || jsonb_build_object('label_check', v_plan->'label_check', 'over_label_reason', v_plan->'over_label_reason'),
      COALESCE(v_apply->'sizes', '[]'::jsonb));
    UPDATE public.product_parents SET rate_source = 'approved', rate_source_event_id = v_event,
      parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
    WHERE id = p_parent_id RETURNING * INTO v_parent;
  ELSE
    v_event := public._product_parent_event(NULL, p_parent_id, 'rates_restored', v_reason, NULL,
      public._product_parent_values(v_before),
      jsonb_build_object('v', 1, 'promoted_event_id', v_before.rate_source_event_id, 'restored', v_plan->'target'),
      COALESCE(v_apply->'sizes', '[]'::jsonb));
    UPDATE public.product_parents SET rate_source = 'legacy', rate_source_event_id = NULL,
      parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
    WHERE id = p_parent_id RETURNING * INTO v_parent;
  END IF;
  DELETE FROM public.product_rate_cutover_passes WHERE txid = txid_current() AND parent_id = p_parent_id;

  v_receipt := jsonb_build_object('parent_id', p_parent_id, 'name', v_parent.name, 'direction', p_direction,
    'rate_source', v_parent.rate_source, 'parent_version', v_parent.parent_version, 'event_id', v_event,
    'changed', (v_plan->>'changes')::boolean, 'rate_per_acre', v_parent.rate_per_acre::text,
    'rate_unit', v_parent.rate_unit, 'sizes', COALESCE(v_apply->'sizes', '[]'::jsonb),
    'label_check', v_plan->'label_check', 'over_label_reason', v_plan->'over_label_reason', 'done_at', now());
  PERFORM public.save_idempotency(p_idempotency_key, 'commit_parent_rate_cutover',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.commit_parent_rate_cutover(uuid, text, jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.commit_parent_rate_cutover(uuid, text, jsonb, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.commit_parent_rate_cutover(uuid, text, jsonb, text, text, text) TO authenticated;

DO $postflight$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'service_role', 'metabase_ro']) r(role)
              CROSS JOIN unnest(ARRAY['public.preview_parent_rate_cutover(uuid,text,text)',
                                      'public.commit_parent_rate_cutover(uuid,text,jsonb,text,text,text)',
                                      'public._rate_cutover_recheck(uuid,jsonb,text)']) f(sig)
              WHERE has_function_privilege(r.role, f.sig, 'EXECUTE'))
     OR has_function_privilege('authenticated', 'public._rate_cutover_recheck(uuid,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_parent_rate_cutover(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.commit_parent_rate_cutover(uuid,text,jsonb,text,text,text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('public._rate_cutover_recheck(uuid,jsonb,text)'::regprocedure,
                  'public.preview_parent_rate_cutover(uuid,text,text)'::regprocedure,
                  'public.commit_parent_rate_cutover(uuid,text,jsonb,text,text,text)'::regprocedure)
                AND NOT (prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']))
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('preview_parent_rate_cutover', 'commit_parent_rate_cutover')) <> 2 THEN
    RAISE EXCEPTION 'RATE_SWITCH_RECHECK_POSTFLIGHT_WRONG';
  END IF;
END;
$postflight$;
