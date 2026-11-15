-- #1814: inactive rate history is visible on explicit request; only cleanup is allowed.
-- Mason, 2026-11-14: preserve approvals until explicit cleanup; older workbooks remain accepted.
-- The default-off read argument preserves the deployed app's active-only download.
-- No data backfill, role/policy expansion, quoting reader or rate cutover change.
-- idempotency-body-check: exempt — private helpers use commit_rate_review's existing receipt and child keys.
-- actor-binding-check: exempt — private helpers receive the actor from the existing admin-only commit wrapper.
-- The migration runner supplies the transaction, including its ledger write.

DO $preflight$
DECLARE expected record; actual record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public._product_rate_review_approve(uuid,bigint,uuid)', '071f7274c884a20d1ba7f05c12057f5c', '{postgres=X/postgres}'::aclitem[]),
    ('public._product_rate_review_lock(uuid)', '3df692b55902c2fe152d5fecbbe61b7c', '{postgres=X/postgres}'::aclitem[]),
    ('public._product_rate_review_outcome(uuid,bigint,text,text,uuid)', 'b6104042c243c0462898485526eb3142', '{postgres=X/postgres}'::aclitem[]),
    ('public.get_rate_review_workbook()', '1b7304a2afce681d57ef7fd177f86a69', '{postgres=X/postgres,authenticated=X/postgres}'::aclitem[])
  ) AS pins(signature, body_md5, acl) LOOP
    SELECT p.* INTO actual FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(expected.signature);
    IF NOT FOUND OR md5(actual.prosrc) IS DISTINCT FROM expected.body_md5
       OR actual.proowner <> 'postgres'::regrole OR NOT actual.prosecdef
       OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       OR actual.proacl IS DISTINCT FROM expected.acl THEN
      RAISE EXCEPTION 'INACTIVE_RATE_REVIEW_PREFLIGHT: unexpected definition or access for %', expected.signature;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        '_product_rate_review_lock', '_product_rate_review_approve', '_product_rate_review_outcome', 'get_rate_review_workbook'
      )) <> 4 THEN
    RAISE EXCEPTION 'INACTIVE_RATE_REVIEW_PREFLIGHT: unexpected function overload';
  END IF;
END;
$preflight$;

-- Retain a single download overload. Empty-argument callers resolve its false default.
DROP FUNCTION public.get_rate_review_workbook();

CREATE OR REPLACE FUNCTION public._product_rate_review_approve(p_rate_id uuid, p_expected_row_version bigint, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_old public.product_rates%ROWTYPE;
  v_new public.product_rates%ROWTYPE;
  v_form text;
  v_kind text;
  v_check jsonb;
BEGIN
  v_old := public._product_rate_review_lock(p_rate_id);
  IF NOT EXISTS (SELECT 1 FROM public.product_parents WHERE id = v_old.parent_id AND is_active) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_PARENT_INACTIVE: this product group is inactive; its rates are for history and cleanup only';
  END IF;
  IF v_old.status <> 'draft' THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_DRAFT: this rate is already approved'; END IF;
  IF p_expected_row_version IS DISTINCT FROM v_old.row_version THEN
    RAISE EXCEPTION 'PRODUCT_RATE_STALE: this rate changed since you opened it; reload and try again';
  END IF;
  IF NOT v_old.basis_confirmed THEN
    RAISE EXCEPTION 'PRODUCT_RATE_BASIS_UNCONFIRMED: check its basis and save it before approving';
  END IF;
  SELECT pp.product_form INTO v_form FROM public.product_parents pp WHERE pp.id = v_old.parent_id;
  SELECT u.kind INTO v_kind FROM public.product_rate_units u WHERE u.code = v_old.unit;
  IF NOT public._product_rate_unit_fits(v_form, v_old.basis, v_kind) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_NOT_FOR_BASIS: % is not allowed for % on a % product', v_old.unit, v_old.basis, v_form;
  END IF;
  v_check := public._product_rate_check_values(v_old.parent_id, v_old.source, v_old.basis, v_old.unit, v_old.low,
    v_old.recommended, v_old.high, v_old.basis_confirmed, v_old.over_label_reason);
  IF v_check->>'status' = 'above' AND v_old.over_label_reason IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED: above the label maximum on EPA %; save it with a reason or a lower rate first',
      v_check->'above'->0->>'epa_registration';
  END IF;
  UPDATE public.product_rates SET status = 'approved', approved_by = p_actor, approved_at = now(),
         row_version = row_version + 1, updated_by = p_actor
   WHERE id = p_rate_id
  RETURNING * INTO v_new;
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, after_values, changed_by)
  VALUES (v_new.parent_id, v_new.id, 'approved', to_jsonb(v_old),
    to_jsonb(v_new) || jsonb_build_object('label_check', v_check), p_actor);
  RETURN jsonb_build_object('rate_id', v_new.id, 'row_version', v_new.row_version, 'label_check', v_check);
END;
$function$;

CREATE OR REPLACE FUNCTION public._product_rate_review_lock(p_rate_id uuid) RETURNS public.product_rates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent_id uuid;
  v_row public.product_rates%ROWTYPE;
BEGIN
  -- parent_id never changes (guard trigger), so this read names the parent to lock first.
  SELECT parent_id INTO v_parent_id FROM public.product_rates WHERE id = p_rate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  PERFORM 1 FROM public.product_parents WHERE id = v_parent_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_NOT_FOUND: the rate''s parent is missing'; END IF;
  SELECT * INTO v_row FROM public.product_rates WHERE id = p_rate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public._product_rate_review_outcome(p_parent_id uuid, p_expected_version bigint, p_outcome text,
  p_note text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_note text := NULLIF(btrim(COALESCE(p_note, ''), E' \t\r\n '), '');
  v_name text;
  v_old public.product_parent_rate_outcomes%ROWTYPE;
  v_version bigint;
  v_drafts int;
  v_default public.product_rates%ROWTYPE;
  v_new public.product_parent_rate_outcomes%ROWTYPE;
  v_form text;
  v_bad text;
BEGIN
  IF p_outcome IS NOT NULL AND p_outcome NOT IN ('approved_default', 'no_per_acre_default', 'needs_label_data') THEN
    RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: the outcome is approved_default, no_per_acre_default, needs_label_data or blank';
  END IF;
  IF length(v_note) > 500 THEN RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: keep the note to 500 characters'; END IF;
  IF p_outcome IS NULL AND v_note IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: a note needs an outcome';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  SELECT pp.name, pp.product_form INTO v_name, v_form FROM public.product_parents pp
   WHERE pp.id = p_parent_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_NOT_FOUND: the parent is missing'; END IF;
  -- Check before the unchanged early return: inactive history cannot be re-confirmed.
  IF p_outcome IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_parents WHERE id = p_parent_id AND is_active
  ) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_PARENT_INACTIVE: this product group is inactive; only clearing its review decision is allowed';
  END IF;
  PERFORM 1 FROM public.product_rates WHERE parent_id = p_parent_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_old FROM public.product_parent_rate_outcomes WHERE parent_id = p_parent_id FOR UPDATE;
  v_version := COALESCE(v_old.outcome_version, 0);
  IF p_expected_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_STALE: % changed since you opened it; reload and try again', v_name;
  END IF;
  IF p_outcome IN ('approved_default', 'no_per_acre_default') THEN
    SELECT count(*) INTO v_drafts FROM public.product_rates WHERE parent_id = p_parent_id AND status = 'draft';
    IF v_drafts > 0 THEN
      RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_DRAFTS_LEFT: % has % rate(s) not yet approved; approve or delete them first', v_name, v_drafts;
    END IF;
    SELECT * INTO v_default FROM public.product_rates WHERE parent_id = p_parent_id AND is_quoting_default;
    IF p_outcome = 'approved_default' AND v_default.id IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_NO_DEFAULT: % has no quoting default; mark one, or choose no_per_acre_default', v_name;
    END IF;
    IF p_outcome = 'no_per_acre_default' AND v_default.id IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_HAS_DEFAULT: % has a quoting default; clear it, or choose approved_default', v_name;
    END IF;
    -- Every approved row must still pass R1 now (the parent's form or label maximum may have changed since).
    v_bad := public._product_rate_review_row_problems(p_parent_id, v_form);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_ROW_INVALID: % no longer passes approval (%); reopen and fix it first', v_name, v_bad;
    END IF;
  END IF;
  -- Unchanged only after the re-check: an outcome that no longer holds is never re-confirmed silently.
  IF v_old.outcome IS NOT DISTINCT FROM p_outcome AND v_old.note IS NOT DISTINCT FROM v_note THEN
    RETURN jsonb_build_object('parent_id', p_parent_id, 'changed', false, 'outcome_version', v_version);
  END IF;

  INSERT INTO public.product_parent_rate_outcomes AS o (parent_id, outcome, note, decided_by, decided_at)
  VALUES (p_parent_id, p_outcome, CASE WHEN p_outcome IS NOT NULL THEN v_note END,
    CASE WHEN p_outcome IS NOT NULL THEN p_actor END, CASE WHEN p_outcome IS NOT NULL THEN now() END)
  ON CONFLICT (parent_id) DO UPDATE SET outcome = EXCLUDED.outcome, note = EXCLUDED.note,
    decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at,
    outcome_version = o.outcome_version + 1, updated_at = now()
  RETURNING * INTO v_new;
  -- The event names the exact rows the decision covers (a hold covers its drafts as they are now).
  INSERT INTO public.product_rate_draft_events (parent_id, event_type, before_values, after_values, reason, changed_by)
  VALUES (p_parent_id, CASE WHEN p_outcome IS NULL THEN 'outcome_cleared' ELSE 'outcome_set' END,
    CASE WHEN v_old.parent_id IS NOT NULL THEN to_jsonb(v_old) END,
    to_jsonb(v_new) || jsonb_build_object('rates', COALESCE((SELECT jsonb_agg(jsonb_build_object('rate_id', r.id,
      'status', r.status, 'row_version', r.row_version) ORDER BY r.id) FROM public.product_rates r WHERE r.parent_id = p_parent_id), '[]'::jsonb)),
    CASE WHEN p_outcome IS NULL THEN 'cleared by an admin' END, p_actor);
  RETURN jsonb_build_object('parent_id', p_parent_id, 'changed', true, 'outcome_version', v_new.outcome_version);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_rate_review_workbook(p_include_inactive boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();
  RETURN jsonb_build_object(
    'parents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'parent_id', pp.id, 'parent_name', pp.name, 'product_form', pp.product_form,
          'sizes', COALESCE((SELECT jsonb_agg(p.product_name ORDER BY lower(p.product_name), p.id)
                               FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
                              WHERE m.parent_id = pp.id), '[]'::jsonb),
          'outcome', o.outcome, 'outcome_note', o.note, 'outcome_version', COALESCE(o.outcome_version, 0),
          'outcome_decided_by', (SELECT pr.full_name FROM public.profiles pr WHERE pr.id = o.decided_by),
          'outcome_decided_at', o.decided_at,
          -- A recorded promotable outcome whose approved rows no longer pass (form or label maximum changed since).
          'outcome_problem', CASE WHEN o.outcome IN ('approved_default', 'no_per_acre_default')
                                  THEN public._product_rate_review_row_problems(pp.id, pp.product_form) END,
          'rates', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('rate_id', r.id, 'basis', r.basis, 'source', r.source,
                'low', r.low::text, 'recommended', r.recommended::text, 'high', r.high::text, 'unit', r.unit,
                'unit_label', u.label, 'is_quoting_default', r.is_quoting_default, 'status', r.status,
                'origin', r.origin, 'basis_confirmed', r.basis_confirmed, 'source_text', r.source_text,
                'over_label_reason', r.over_label_reason, 'row_version', r.row_version,
                'approved_by', (SELECT pr.full_name FROM public.profiles pr WHERE pr.id = r.approved_by),
                'approved_at', r.approved_at,
                'label_check', public._product_rate_check_values(r.parent_id, r.source, r.basis, r.unit, r.low,
                  r.recommended, r.high, r.basis_confirmed, r.over_label_reason))
              ORDER BY r.source, r.basis, r.id)
              FROM public.product_rates r JOIN public.product_rate_units u ON u.code = r.unit
             WHERE r.parent_id = pp.id), '[]'::jsonb),
          -- Only notes of the parent's latest derivation (rows or notes; one derivation is one transaction, so one
          -- changed_at): a later derivation that wrote rows and no notes hides an older derivation's notes.
          'notes', COALESCE((
            SELECT jsonb_agg(e.after_values ORDER BY e.id)
              FROM public.product_rate_draft_events e
             WHERE e.parent_id = pp.id AND e.event_type = 'derive_note'
               AND e.changed_at = (SELECT max(e2.changed_at) FROM public.product_rate_draft_events e2
                                    WHERE e2.parent_id = pp.id AND e2.event_type IN ('derived', 'derive_note'))), '[]'::jsonb)) || CASE WHEN p_include_inactive THEN jsonb_build_object('is_active', pp.is_active) ELSE '{}'::jsonb END
        ORDER BY pp.is_active DESC, lower(pp.name), pp.id)
        FROM public.product_parents pp
        LEFT JOIN public.product_parent_rate_outcomes o ON o.parent_id = pp.id
       WHERE pp.is_active OR (p_include_inactive AND (
         o.outcome IS NOT NULL OR EXISTS (SELECT 1 FROM public.product_rates history WHERE history.parent_id = pp.id)
       ))), '[]'::jsonb),
    'units', (SELECT jsonb_agg(jsonb_build_object('code', u.code, 'label', u.label, 'kind', u.kind) ORDER BY u.kind, u.factor)
                FROM public.product_rate_units u),
    'totals', jsonb_build_object(
      'rates', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id WHERE pp.is_active),
      'drafts', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id
                  WHERE pp.is_active AND r.status = 'draft'),
      'approved', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id
                    WHERE pp.is_active AND r.status = 'approved'),
      'per_100_gal', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id
                       WHERE pp.is_active AND r.basis = 'per_100_gal'),
      'per_100_gal_approved', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id
                                WHERE pp.is_active AND r.basis = 'per_100_gal' AND r.status = 'approved'),
      'parents', (SELECT count(*) FROM public.product_parents WHERE is_active),
      'parents_undecided', (SELECT count(*) FROM public.product_parents pp
                              LEFT JOIN public.product_parent_rate_outcomes o ON o.parent_id = pp.id
                             WHERE pp.is_active AND o.outcome IS NULL),
      'approved_default', (SELECT count(*) FROM public.product_parent_rate_outcomes o JOIN public.product_parents pp ON pp.id = o.parent_id
                            WHERE pp.is_active AND o.outcome = 'approved_default'),
      'no_per_acre_default', (SELECT count(*) FROM public.product_parent_rate_outcomes o JOIN public.product_parents pp ON pp.id = o.parent_id
                               WHERE pp.is_active AND o.outcome = 'no_per_acre_default'),
      'needs_label_data', (SELECT count(*) FROM public.product_parent_rate_outcomes o JOIN public.product_parents pp ON pp.id = o.parent_id
                            WHERE pp.is_active AND o.outcome = 'needs_label_data'),
      'outcomes_no_longer_valid', (SELECT count(*) FROM public.product_parent_rate_outcomes o JOIN public.product_parents pp ON pp.id = o.parent_id
                            WHERE pp.is_active AND o.outcome IN ('approved_default', 'no_per_acre_default')
                              AND public._product_rate_review_row_problems(pp.id, pp.product_form) IS NOT NULL)) || CASE WHEN p_include_inactive THEN jsonb_build_object(
      'inactive_parents', (SELECT count(*) FROM public.product_parents history
        WHERE NOT history.is_active AND (EXISTS (SELECT 1 FROM public.product_rates r WHERE r.parent_id = history.id)
          OR EXISTS (SELECT 1 FROM public.product_parent_rate_outcomes o WHERE o.parent_id = history.id AND o.outcome IS NOT NULL))),
      'inactive_rates', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id WHERE NOT pp.is_active),
      'inactive_approved', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id WHERE NOT pp.is_active AND r.status = 'approved'),
      'inactive_outcomes', (SELECT count(*) FROM public.product_parent_rate_outcomes o JOIN public.product_parents pp ON pp.id = o.parent_id WHERE NOT pp.is_active AND o.outcome IS NOT NULL)
    ) ELSE '{}'::jsonb END);
END;
$function$;

ALTER FUNCTION public.get_rate_review_workbook(boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_rate_review_workbook(boolean) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_rate_review_workbook(boolean) TO authenticated;

DO $postflight$
DECLARE expected record; actual record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public._product_rate_review_approve(uuid,bigint,uuid)', '1d7154c09d25622387df2981852aa801', '{postgres=X/postgres}'::aclitem[]),
    ('public._product_rate_review_lock(uuid)', '0de104d0d2850d92532381f0a4682dd2', '{postgres=X/postgres}'::aclitem[]),
    ('public._product_rate_review_outcome(uuid,bigint,text,text,uuid)', '515b028a4f4a2cdc61420aeab540a634', '{postgres=X/postgres}'::aclitem[]),
    ('public.get_rate_review_workbook(boolean)', '1d725c2c158555b980cba67548ddf397', '{postgres=X/postgres,authenticated=X/postgres}'::aclitem[])
  ) AS pins(signature, body_md5, acl) LOOP
    SELECT p.* INTO actual FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(expected.signature);
    IF NOT FOUND OR md5(actual.prosrc) IS DISTINCT FROM expected.body_md5
       OR actual.proowner <> 'postgres'::regrole OR NOT actual.prosecdef
       OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       OR actual.proacl IS DISTINCT FROM expected.acl THEN
      RAISE EXCEPTION 'INACTIVE_RATE_REVIEW_POSTFLIGHT: unexpected definition or access for %', expected.signature;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        '_product_rate_review_lock', '_product_rate_review_approve', '_product_rate_review_outcome', 'get_rate_review_workbook'
      )) <> 4 THEN
    RAISE EXCEPTION 'INACTIVE_RATE_REVIEW_POSTFLIGHT: unexpected function overload';
  END IF;
  IF to_regprocedure('public.get_rate_review_workbook()') IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc WHERE oid = 'public.get_rate_review_workbook(boolean)'::regprocedure
      AND pronargdefaults = 1 AND pg_get_expr(proargdefaults, 0) = 'false'
  ) THEN RAISE EXCEPTION 'INACTIVE_RATE_REVIEW_POSTFLIGHT: defaulted download signature differs'; END IF;
END;
$postflight$;

NOTIFY pgrst, 'reload schema';
