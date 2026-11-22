-- #1722 item 4: approving a draft rate whose parent's rate differs from the value the draft was derived from WARNS,
-- never refuses (Mason, 2026-11-21: "yes i agree warn but allow it").
-- Contract: docs/plans/2026-11-21-rate-review-stale-parent-warning-CONTRACT.md.
-- * _product_rate_review_approve: same refusals as before. After them, a derived row's source_text (the parent's value
--   when it was derived; written only by _product_rate_insert_derived) is compared with the parent now, under the
--   parent lock the approval already holds. When it differs, the return and the approved event carry
--   parent_changed {was, now} (now is null when the parent has no value). Manual rows never warn.
-- * _product_rate_review_run: the approve phase copies parent_changed onto its preview/commit row (one line).
-- No data change, no new function or grant (both stay private, postgres only).
-- idempotency-body-check: exempt — private helpers use commit_rate_review's existing receipt and child keys.
-- actor-binding-check: exempt — private helpers receive the actor from the existing admin-only commit wrapper.
-- Rollback: a new migration re-emitting the 20270110110000 approve body (md5 1d7154c09d25622387df2981852aa801) and
-- the 20270104110000 run body (md5 dace0490169cb60c416c4703f031558a). Events already written keep their key.
-- The migration runner supplies the transaction, including its ledger write.

DO $preflight$
DECLARE expected record; actual record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public._product_rate_review_approve(uuid,bigint,uuid)', '1d7154c09d25622387df2981852aa801'),
    ('public._product_rate_review_run(jsonb,jsonb,text,uuid)', 'dace0490169cb60c416c4703f031558a')
  ) AS pins(signature, body_md5) LOOP
    SELECT p.* INTO actual FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(expected.signature);
    IF NOT FOUND OR md5(actual.prosrc) IS DISTINCT FROM expected.body_md5
       OR actual.proowner <> 'postgres'::regrole OR NOT actual.prosecdef
       OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       OR actual.proacl IS DISTINCT FROM '{postgres=X/postgres}'::aclitem[] THEN
      RAISE EXCEPTION 'RATE_REVIEW_PARENT_CHANGED_PREFLIGHT: unexpected definition or access for %', expected.signature;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('_product_rate_review_approve', '_product_rate_review_run')) <> 2 THEN
    RAISE EXCEPTION 'RATE_REVIEW_PARENT_CHANGED_PREFLIGHT: unexpected function overload';
  END IF;
END;
$preflight$;

-- The 20270110110000 body plus the parent comparison (after every refusal, so it never blocks).
CREATE OR REPLACE FUNCTION public._product_rate_review_approve(p_rate_id uuid, p_expected_row_version bigint, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_old public.product_rates%ROWTYPE;
  v_new public.product_rates%ROWTYPE;
  v_form text;
  v_kind text;
  v_check jsonb;
  v_parent public.product_parents%ROWTYPE;
  v_was text;
  v_now text;
  v_num text;
  v_unit_was text;
  v_unit_now text;
  v_same boolean;
  v_warn jsonb := '{}'::jsonb;
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
  -- #1722: does the parent still carry the value this draft was derived from? Read under the parent lock taken by
  -- _product_rate_review_lock, so it describes the parent this approval commits against. A house row compares the
  -- number as a number (1.5 = 1.50) and, for liquid/dry, the unit (a seed/each house unit is its sizes' stock unit);
  -- a text row compares the trimmed text. Warn only: nothing below refuses.
  v_was := NULLIF(btrim(v_old.source_text), '');
  IF v_old.origin IN ('derived_house', 'derived_text') AND v_was IS NOT NULL THEN
    SELECT * INTO v_parent FROM public.product_parents WHERE id = v_old.parent_id;
    IF v_old.origin = 'derived_text' THEN
      v_now := NULLIF(btrim(v_parent.suggested_rate), '');
      v_same := v_now IS NOT DISTINCT FROM v_was;
    ELSE
      v_num := split_part(v_was, ' ', 1);
      v_unit_was := NULLIF(btrim(substr(v_was, length(v_num) + 2)), '');
      v_unit_now := CASE WHEN v_parent.product_form IN ('liquid', 'dry') THEN NULLIF(btrim(v_parent.rate_unit), '') ELSE v_unit_was END;
      v_same := (CASE WHEN v_num ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v_num::numeric END) = v_parent.rate_per_acre
                AND v_unit_now IS NOT DISTINCT FROM v_unit_was;
      v_now := CASE WHEN v_parent.rate_per_acre IS NOT NULL THEN concat_ws(' ', v_parent.rate_per_acre::text, v_unit_now) END;
    END IF;
    IF NOT COALESCE(v_same, false) THEN
      v_warn := jsonb_build_object('parent_changed', jsonb_build_object('was', v_was, 'now', v_now));
    END IF;
  END IF;
  UPDATE public.product_rates SET status = 'approved', approved_by = p_actor, approved_at = now(),
         row_version = row_version + 1, updated_by = p_actor
   WHERE id = p_rate_id
  RETURNING * INTO v_new;
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, after_values, changed_by)
  VALUES (v_new.parent_id, v_new.id, 'approved', to_jsonb(v_old),
    to_jsonb(v_new) || jsonb_build_object('label_check', v_check) || v_warn, p_actor);
  RETURN jsonb_build_object('rate_id', v_new.id, 'row_version', v_new.row_version, 'label_check', v_check) || v_warn;
END;
$function$;

-- The 20270104110000 body; only the approve phase also copies parent_changed onto its row.
CREATE OR REPLACE FUNCTION public._product_rate_review_run(p_rates jsonb, p_outcomes jsonb, p_key text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_rates jsonb := COALESCE(p_rates, '[]'::jsonb);
  v_outcomes jsonb := COALESCE(p_outcomes, '[]'::jsonb);
  v_n int;
  v_m int;
  v_row jsonb;
  v_plan jsonb := '[]'::jsonb;   -- one entry per rate row, in upload order
  v_p jsonb;
  v_cur public.product_rates%ROWTYPE;
  v_rate_id uuid;
  v_parent_id uuid;
  v_expected bigint;
  v_decision text;
  v_reason text;
  v_vals jsonb;
  v_changed boolean;
  v_seen uuid[] := '{}';
  v_parents uuid[] := '{}';
  v_phase int;
  v_i int;
  v_res jsonb;
  v_status text;
  v_out_rows jsonb := '[]'::jsonb;
  v_name text;
  v_o_parent uuid;
  v_o_version bigint;
  v_o_outcome text;
  v_o_note text;
  v_before_versions jsonb;
BEGIN
  IF jsonb_typeof(v_rates) <> 'array' OR jsonb_typeof(v_outcomes) <> 'array'
     OR jsonb_array_length(v_rates) > 3000 OR jsonb_array_length(v_outcomes) > 1000
     OR jsonb_array_length(v_rates) + jsonb_array_length(v_outcomes) = 0 THEN
    RAISE EXCEPTION 'RATE_REVIEW_ROWS_REQUIRED: send up to 3000 rate rows and 1000 outcome rows, at least one row';
  END IF;

  -- Plan each rate row (no writes).
  FOR v_n IN 0 .. jsonb_array_length(v_rates) - 1 LOOP
    v_row := v_rates->v_n;
    v_p := jsonb_build_object('index', v_n);
    BEGIN
      IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: each row is an object'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN ('rate_id', 'parent_id', 'expected_row_version',
                   'basis', 'source', 'low', 'recommended', 'high', 'unit', 'is_quoting_default', 'over_label_reason',
                   'decision', 'reason')) THEN
        RAISE EXCEPTION 'PRODUCT_RATE_INVALID: unexpected field';
      END IF;
      v_rate_id := public._product_rate_review_text(v_row, 'rate_id')::uuid;
      v_parent_id := public._product_rate_review_text(v_row, 'parent_id')::uuid;
      IF v_parent_id IS NULL THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: parent_id is required'; END IF;
      v_p := v_p || jsonb_build_object('rate_id', v_rate_id, 'parent_id', v_parent_id);
      v_expected := public._product_rate_review_version(v_row, 'expected_row_version');
      v_decision := lower(public._product_rate_review_text(v_row, 'decision'));
      IF v_decision IS NOT NULL AND v_decision NOT IN ('approve', 'reopen', 'delete') THEN
        RAISE EXCEPTION 'PRODUCT_RATE_INVALID: decision is approve, reopen, delete or blank';
      END IF;
      v_reason := public._product_rate_review_text(v_row, 'reason');
      IF jsonb_typeof(v_row->'is_quoting_default') NOT IN ('boolean', 'null') THEN
        RAISE EXCEPTION 'PRODUCT_RATE_INVALID: is_quoting_default must be true or false';
      END IF;
      v_vals := jsonb_build_object(
        'basis', public._product_rate_review_text(v_row, 'basis'), 'source', public._product_rate_review_text(v_row, 'source'),
        'low', public._product_rate_review_number(v_row, 'low'),
        'recommended', public._product_rate_review_number(v_row, 'recommended'),
        'high', public._product_rate_review_number(v_row, 'high'), 'unit', public._product_rate_review_text(v_row, 'unit'),
        -- JSON true/false; left out means "not the default" only on a new row (an existing row must say).
        'is_quoting_default', COALESCE(v_row->'is_quoting_default', 'null'::jsonb),
        'over_label_reason', public._product_rate_review_text(v_row, 'over_label_reason'));
      IF v_vals->'is_quoting_default' = 'null'::jsonb THEN
        IF v_rate_id IS NOT NULL THEN
          RAISE EXCEPTION 'PRODUCT_RATE_INVALID: is_quoting_default must be true or false';
        END IF;
        v_vals := v_vals || jsonb_build_object('is_quoting_default', false);
      END IF;
      v_p := v_p || jsonb_build_object('vals', v_vals, 'decision', v_decision, 'reason', v_reason);

      IF v_rate_id IS NULL THEN
        -- A new row; only a wholly blank row is skipped (anything typed in it makes it a row to check).
        IF v_decision IS NULL AND v_reason IS NULL AND v_vals->>'basis' IS NULL AND v_vals->>'source' IS NULL
           AND v_vals->>'unit' IS NULL AND v_vals->'low' = 'null' AND v_vals->'recommended' = 'null'
           AND v_vals->'high' = 'null' AND v_vals->>'over_label_reason' IS NULL
           AND NOT (v_vals->>'is_quoting_default')::boolean THEN
          v_p := v_p || jsonb_build_object('status', 'skip');
        ELSIF v_decision IN ('reopen', 'delete') THEN
          RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a new rate can only be added, or added and approved';
        ELSE
          SELECT name INTO v_name FROM public.product_parents WHERE id = v_parent_id;
          IF NOT FOUND THEN
            v_p := v_p || jsonb_build_object('status', 'not_found', 'problem', 'no such parent');
          ELSE
            v_p := v_p || jsonb_build_object('name', v_name, 'status', 'change', 'actions',
              jsonb_build_array('save') || CASE WHEN v_decision = 'approve' THEN '["approve"]'::jsonb ELSE '[]'::jsonb END);
          END IF;
        END IF;
      ELSE
        IF v_rate_id = ANY (v_seen) THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: this rate is on the tab twice'; END IF;
        v_seen := v_seen || v_rate_id;
        SELECT * INTO v_cur FROM public.product_rates WHERE id = v_rate_id;
        IF NOT FOUND THEN
          v_p := v_p || jsonb_build_object('status', 'not_found', 'problem', 'this rate no longer exists');
        ELSIF v_cur.parent_id <> v_parent_id THEN
          RAISE EXCEPTION 'PRODUCT_RATE_INVALID: this rate belongs to a different parent';
        ELSE
          SELECT name INTO v_name FROM public.product_parents WHERE id = v_cur.parent_id;
          v_p := v_p || jsonb_build_object('name', v_name, 'before', to_jsonb(v_cur));
          v_changed := (v_vals->>'basis', v_vals->>'source', (v_vals->>'low')::numeric, (v_vals->>'recommended')::numeric,
                        (v_vals->>'high')::numeric, v_vals->>'unit', (v_vals->>'is_quoting_default')::boolean, v_vals->>'over_label_reason')
            IS DISTINCT FROM (v_cur.basis, v_cur.source, v_cur.low, v_cur.recommended, v_cur.high, v_cur.unit,
                              v_cur.is_quoting_default, v_cur.over_label_reason);
          -- An approve of a row someone else approved since the download is stale, not unchanged.
          IF NOT v_changed AND (v_decision IS NULL OR (v_decision = 'approve' AND v_cur.status = 'approved'
                                                       AND v_expected IS NOT DISTINCT FROM v_cur.row_version)) THEN
            v_p := v_p || jsonb_build_object('status', 'unchanged');
          ELSIF v_expected IS DISTINCT FROM v_cur.row_version THEN
            v_p := v_p || jsonb_build_object('status', 'stale', 'problem', 'changed by someone else since you downloaded it');
          ELSIF v_cur.status = 'approved' THEN
            IF v_decision = 'reopen' THEN
              v_p := v_p || jsonb_build_object('status', 'change', 'actions',
                jsonb_build_array('reopen') || CASE WHEN v_changed THEN '["save"]'::jsonb ELSE '[]'::jsonb END);
            ELSE
              RAISE EXCEPTION 'PRODUCT_RATE_APPROVED: this rate is approved; put reopen in decision (with a reason) to change or delete it';
            END IF;
          ELSIF v_decision = 'reopen' THEN
            RAISE EXCEPTION 'PRODUCT_RATE_NOT_APPROVED: this rate is already a draft';
          ELSIF v_decision = 'delete' THEN
            v_p := v_p || jsonb_build_object('status', 'change', 'actions', '["delete"]'::jsonb);
          ELSE
            -- Approving a row whose basis was unconfirmed confirms it: the row is saved as shown (the save re-runs every
            -- check and sets basis_confirmed), then approved; otherwise an unchanged row could never be confirmed here.
            v_p := v_p || jsonb_build_object('status', 'change', 'actions',
              CASE WHEN v_changed OR (v_decision = 'approve' AND NOT v_cur.basis_confirmed) THEN '["save"]'::jsonb ELSE '[]'::jsonb END
              || CASE WHEN v_decision = 'approve' THEN '["approve"]'::jsonb ELSE '[]'::jsonb END);
          END IF;
          v_p := v_p || jsonb_build_object('version', v_cur.row_version);
        END IF;
      END IF;
    EXCEPTION WHEN raise_exception OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
      v_p := v_p || jsonb_build_object('status', 'invalid', 'problem', SQLERRM);
    END;
    IF v_p->>'status' = 'change' THEN v_parents := v_parents || (v_p->>'parent_id')::uuid; END IF;
    v_plan := v_plan || jsonb_build_array(v_p);
  END LOOP;

  -- Outcome rows name their parents too: lock every touched parent once, in ID order (RT-1's order).
  FOR v_m IN 0 .. jsonb_array_length(v_outcomes) - 1 LOOP
    BEGIN
      v_parents := v_parents || public._product_rate_review_text(v_outcomes->v_m, 'parent_id')::uuid;
    EXCEPTION WHEN raise_exception OR invalid_text_representation OR data_exception THEN NULL;
    END;
  END LOOP;
  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  PERFORM 1 FROM public.product_parents WHERE id = ANY (v_parents) ORDER BY id FOR NO KEY UPDATE;
  -- Outcome versions under the lock, before this save's own rate changes clear any outcome (R4), so an outcome
  -- row downloaded at that version is not refused as stale because of this same upload.
  v_before_versions := COALESCE((SELECT jsonb_object_agg(o.parent_id::text, o.outcome_version)
                                   FROM public.product_parent_rate_outcomes o WHERE o.parent_id = ANY (v_parents)), '{}'::jsonb);

  -- Run the rate actions phase by phase (1 reopen, 2 delete, 3 save ending without default, 4 save ending as default, 5 approve).
  FOR v_phase IN 1 .. 5 LOOP
    FOR v_i IN SELECT i FROM generate_series(0, jsonb_array_length(v_plan) - 1) i
                WHERE v_plan->i->>'status' = 'change'
                ORDER BY (v_plan->i->>'parent_id'), (v_plan->i->>'rate_id') NULLS LAST, i LOOP
      v_p := v_plan->v_i;
      IF NOT (CASE v_phase
                WHEN 1 THEN v_p->'actions' ? 'reopen'
                WHEN 2 THEN v_p->'actions' ? 'delete'
                WHEN 3 THEN v_p->'actions' ? 'save' AND NOT (v_p->'vals'->>'is_quoting_default')::boolean
                WHEN 4 THEN v_p->'actions' ? 'save' AND (v_p->'vals'->>'is_quoting_default')::boolean
                ELSE v_p->'actions' ? 'approve' END) THEN
        CONTINUE;
      END IF;
      BEGIN
        IF v_phase = 1 THEN
          v_res := public._product_rate_review_reopen((v_p->>'rate_id')::uuid, (v_p->>'version')::bigint, v_p->>'reason', p_actor);
          v_p := v_p || jsonb_build_object('version', (v_res->>'row_version')::bigint);
        ELSIF v_phase = 2 THEN
          v_res := public.delete_draft_product_rate((v_p->>'rate_id')::uuid, (v_p->>'version')::bigint, v_p->>'reason',
            p_key || ':d:' || v_i);
        ELSIF v_phase IN (3, 4) THEN
          v_res := public.save_draft_product_rate((v_p->>'parent_id')::uuid, (v_p->>'rate_id')::uuid, (v_p->>'version')::bigint,
            v_p->'vals'->>'basis', v_p->'vals'->>'source', (v_p->'vals'->>'low')::numeric, (v_p->'vals'->>'recommended')::numeric,
            (v_p->'vals'->>'high')::numeric, v_p->'vals'->>'unit', (v_p->'vals'->>'is_quoting_default')::boolean,
            v_p->'vals'->>'over_label_reason', p_key || ':s:' || v_i);
          v_p := v_p || jsonb_build_object('rate_id', v_res->>'rate_id', 'version', (v_res->>'row_version')::bigint,
            'label_check', v_res->'label_check');
        ELSE
          v_res := public._product_rate_review_approve((v_p->>'rate_id')::uuid, (v_p->>'version')::bigint, p_actor);
          v_p := v_p || jsonb_build_object('version', (v_res->>'row_version')::bigint, 'label_check', v_res->'label_check')
            -- #1722: the parent's rate changed since this draft was derived (a warning; the approval still saves).
            || CASE WHEN v_res ? 'parent_changed' THEN jsonb_build_object('parent_changed', v_res->'parent_changed') ELSE '{}'::jsonb END;
        END IF;
      EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation
                     OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
        v_status := CASE WHEN SQLERRM LIKE 'PRODUCT_RATE_STALE%' THEN 'stale' ELSE 'invalid' END;
        v_p := v_p || jsonb_build_object('status', v_status, 'problem', SQLERRM);
      END;
      v_plan := jsonb_set(v_plan, ARRAY[v_i::text], v_p);
    END LOOP;
  END LOOP;

  -- Outcomes, after every rate action.
  FOR v_m IN 0 .. jsonb_array_length(v_outcomes) - 1 LOOP
    v_row := v_outcomes->v_m;
    v_o_parent := NULL;
    v_name := NULL;
    BEGIN
      IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: each row is an object'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN ('parent_id', 'expected_outcome_version', 'outcome', 'note')) THEN
        RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: unexpected field';
      END IF;
      v_o_parent := public._product_rate_review_text(v_row, 'parent_id')::uuid;
      IF v_o_parent IS NULL THEN RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: parent_id is required'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_out_rows) o WHERE o->>'parent_id' = v_o_parent::text) THEN
        RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: this parent is on the tab twice';
      END IF;
      SELECT name INTO v_name FROM public.product_parents WHERE id = v_o_parent;
      v_o_version := public._product_rate_review_version(v_row, 'expected_outcome_version');
      IF v_o_version IS NOT DISTINCT FROM COALESCE((v_before_versions->>v_o_parent::text)::bigint, 0) THEN
        SELECT COALESCE(max(o.outcome_version), 0) INTO v_o_version FROM public.product_parent_rate_outcomes o
         WHERE o.parent_id = v_o_parent;
      END IF;
      v_o_outcome := lower(public._product_rate_review_text(v_row, 'outcome'));
      v_o_note := public._product_rate_review_text(v_row, 'note');
      v_res := public._product_rate_review_outcome(v_o_parent, v_o_version, v_o_outcome, v_o_note, p_actor);
      v_out_rows := v_out_rows || jsonb_build_array(jsonb_build_object('index', v_m, 'parent_id', v_o_parent, 'name', v_name,
        'outcome', v_o_outcome, 'note', v_o_note,
        'status', CASE WHEN (v_res->>'changed')::boolean THEN 'change' ELSE 'unchanged' END));
    EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation
                   OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
      v_out_rows := v_out_rows || jsonb_build_array(jsonb_build_object('index', v_m, 'parent_id', v_o_parent, 'name', v_name,
        'status', CASE WHEN SQLERRM LIKE 'PRODUCT_RATE_OUTCOME_STALE%' THEN 'stale'
                       WHEN SQLERRM LIKE 'PARENT_NOT_FOUND%' THEN 'not_found' ELSE 'invalid' END,
        'problem', SQLERRM));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'rates', (SELECT COALESCE(jsonb_agg(p - 'vals' - 'before' - 'reason' - 'actions' - 'version'
                || jsonb_build_object('actions', p->'actions') ORDER BY (p->>'index')::int), '[]'::jsonb)
                FROM jsonb_array_elements(v_plan) p WHERE p->>'status' <> 'skip'),
    'outcomes', v_out_rows);
END;
$function$;

DO $postflight$
DECLARE expected record; actual record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public._product_rate_review_approve(uuid,bigint,uuid)', '8fd6021b25f1cfb55d856b84e3d0bac6'),
    ('public._product_rate_review_run(jsonb,jsonb,text,uuid)', '29e0d7b91f2746458050626a9a5f2262')
  ) AS pins(signature, body_md5) LOOP
    SELECT p.* INTO actual FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(expected.signature);
    IF NOT FOUND OR md5(actual.prosrc) IS DISTINCT FROM expected.body_md5
       OR actual.proowner <> 'postgres'::regrole OR NOT actual.prosecdef
       OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       OR actual.proacl IS DISTINCT FROM '{postgres=X/postgres}'::aclitem[] THEN
      RAISE EXCEPTION 'RATE_REVIEW_PARENT_CHANGED_POSTFLIGHT: unexpected definition or access for %', expected.signature;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('_product_rate_review_approve', '_product_rate_review_run')) <> 2 THEN
    RAISE EXCEPTION 'RATE_REVIEW_PARENT_CHANGED_POSTFLIGHT: unexpected function overload';
  END IF;
END;
$postflight$;
