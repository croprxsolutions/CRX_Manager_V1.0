-- CONTAINER ONLY. Run via prove-records-replay-binding-batch4d-real-schema.mjs.
-- Invented users and rows; one DO statement always ends SMOKE_PASS_ROLLBACK.
DO $smoke$
DECLARE
  v_admin uuid := '4c4d0000-0000-4000-8000-0000000000a1';
  v_admin_b uuid := '4c4d0000-0000-4000-8000-0000000000a2';
  v_no_role uuid := '4c4d0000-0000-4000-8000-0000000000c1';
  v_ops text[] := ARRAY['admin_update_profile','batch_approve_blend_tickets','batch_reject_blend_tickets','bulk_create_label_drafts','commit_label_draft','create_label_draft','create_blend_ticket','save_blend_ticket','save_blend_ticket_fields','dismiss_watchdog_flag','delete_vendor','reactivate_vendor','save_vendor','link_fields_to_parent','unlink_field_from_parent','review_customer_fact','supersede_customer_fact','save_blend_recipe','save_field','save_field_crop_history','save_field_geometry','save_field_polygons','set_application_record_lots','set_field_boundary','set_field_override_acres'];
  v_op text;
  v_proc pg_proc%ROWTYPE;
  v_name text;
  v_type text;
  v_arg1 text;
  v_arg2 text;
  v_arg0 text;
  v_changed text;
  v_json jsonb;
  v_fingerprint text;
  v_key text;
  v_i integer;
  v_count integer;
  v_out1 text;
  v_out2 text;
  v_err1 text;
  v_err2 text;
  v_suffix text := substr(md5(random()::text),1,8);
  v_customer uuid;
  v_vendor uuid;
  v_vendor_b uuid;
  v_field uuid;
  v_field_b uuid;
  v_fact uuid;
  v_fact_b uuid;
  v_ticket uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_payload jsonb;
  v_result jsonb;
  v_retry jsonb;
  v_field_result uuid;
  v_work_count integer;
  v_app_record uuid;
  v_expr text;
  v_expr2 text;
  v_value jsonb;
  v_target_name text;
BEGIN
  IF (SELECT count(*) FROM public.profiles WHERE id IN (v_admin, v_admin_b) AND role='admin' AND is_active) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: two invented active admins missing';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin,'role','authenticated')::text, true);
  -- Vendor create: exact retry leaves one row and one activity; changing the record is refused.
  v_key := 'smk-4d-vendor-' || v_suffix;
  v_payload := jsonb_build_object('name', '[SMOKE] KI10 vendor A ' || v_suffix);
  v_result := public.save_vendor(NULL, v_payload, v_key);
  v_vendor := (v_result->>'vendor_id')::uuid;
  SELECT count(*) INTO v_work_count FROM public.activity_feed WHERE related_entity_id=v_vendor AND event_type='vendor_created';
  v_retry := public.save_vendor(NULL, v_payload, v_key);
  IF v_vendor IS NULL OR v_retry IS DISTINCT FROM v_result OR (SELECT count(*) FROM public.activity_feed WHERE related_entity_id=v_vendor AND event_type='vendor_created')<>v_work_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_vendor first/retry';
  END IF;
  v_vendor_b := (public.save_vendor(NULL, jsonb_build_object('name','[SMOKE] KI10 vendor B ' || v_suffix), 'smk-4d-vendor-b-' || v_suffix)->>'vendor_id')::uuid;
  BEGIN
    PERFORM public.save_vendor(v_vendor_b, v_payload, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: save_vendor replayed a changed request';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: save_vendor R2 gave %', SQLERRM; END IF;
  END;
  IF (SELECT name FROM public.vendors WHERE id=v_vendor_b) IS DISTINCT FROM '[SMOKE] KI10 vendor B ' || v_suffix THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_vendor R2 changed row';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin_b,'role','authenticated')::text, true);
  BEGIN
    PERFORM public.save_vendor(NULL, v_payload, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: save_vendor actor B accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: save_vendor actor B gave %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin,'role','authenticated')::text, true);
  IF NOT EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=v_key AND operation='save_vendor'
    AND request_actor_id=v_admin AND request_fingerprint ~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'SMOKE_FAIL: save_vendor receipt unbound'; END IF;

  INSERT INTO public.customers (farm_name, account_number)
  VALUES ('[SMOKE] KI10 records ' || v_suffix, '[SMOKE]-KI10-4D-' || v_suffix) RETURNING id INTO v_customer;
  v_payload := jsonb_build_object('customer_id',v_customer,'field_name','[SMOKE] KI10 field A ' || v_suffix,
    'total_acres',1,'state','IL','is_active',true);
  v_key := 'smk-4d-field-' || v_suffix;
  v_field := public.save_field(NULL,v_payload,'[]'::jsonb,v_admin,v_key);
  SELECT count(*) INTO v_work_count FROM public.activity_feed WHERE related_entity_id=v_field AND event_type='field_saved';
  v_field_result := public.save_field(NULL,v_payload,'[]'::jsonb,v_admin,v_key);
  IF v_field IS NULL OR v_field_result IS DISTINCT FROM v_field OR
    (SELECT count(*) FROM public.activity_feed WHERE related_entity_id=v_field AND event_type='field_saved')<>v_work_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_field first/retry';
  END IF;
  v_field_b := public.save_field(NULL,jsonb_set(v_payload,'{field_name}',to_jsonb('[SMOKE] KI10 field B ' || v_suffix)),
    '[]'::jsonb,v_admin,'smk-4d-field-b-' || v_suffix);
  BEGIN
    PERFORM public.save_field(v_field_b,v_payload,'[]'::jsonb,v_admin,v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: save_field changed record accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: save_field R2 gave %', SQLERRM; END IF;
  END;
  IF (SELECT field_name FROM public.fields WHERE id=v_field_b) IS DISTINCT FROM '[SMOKE] KI10 field B ' || v_suffix THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_field R2 changed row';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin_b,'role','authenticated')::text, true);
  BEGIN
    PERFORM public.save_field(NULL,v_payload,'[]'::jsonb,v_admin,v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: save_field actor B accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM <> 'ACTOR_MISMATCH' THEN RAISE EXCEPTION 'SMOKE_FAIL: save_field actor B gave %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin,'role','authenticated')::text, true);
  IF NOT EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=v_key AND operation='save_field'
    AND request_actor_id=v_admin AND request_fingerprint ~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'SMOKE_FAIL: save_field receipt unbound'; END IF;

  v_fact := (public.log_customer_fact(v_customer,'agronomy','ki10_a','[SMOKE] first',NULL,NULL,NULL,NULL,
    'smk-4d-fact-create-a-' || v_suffix)->>'fact_id')::uuid;
  v_fact_b := (public.log_customer_fact(v_customer,'agronomy','ki10_b','[SMOKE] second',NULL,NULL,NULL,NULL,
    'smk-4d-fact-create-b-' || v_suffix)->>'fact_id')::uuid;
  v_key := 'smk-4d-review-' || v_suffix;
  v_result := public.review_customer_fact(v_fact,'verified','[SMOKE] reviewed',v_key);
  SELECT count(*) INTO v_work_count FROM public.customer_facts WHERE id=v_fact AND status='verified' AND reviewed_by=v_admin;
  v_retry := public.review_customer_fact(v_fact,'verified','[SMOKE] reviewed',v_key);
  IF v_result IS DISTINCT FROM v_retry OR v_work_count<>1 OR
    (SELECT count(*) FROM public.customer_facts WHERE id=v_fact AND status='verified' AND reviewed_by=v_admin)<>1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: review_customer_fact first/retry';
  END IF;
  BEGIN
    PERFORM public.review_customer_fact(v_fact_b,'verified','[SMOKE] reviewed',v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: review_customer_fact changed record accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: review_customer_fact R2 gave %', SQLERRM; END IF;
  END;
  IF (SELECT status FROM public.customer_facts WHERE id=v_fact_b)<>'pending_review' THEN RAISE EXCEPTION 'SMOKE_FAIL: review_customer_fact R2 changed row'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin_b,'role','authenticated')::text, true);
  BEGIN
    PERFORM public.review_customer_fact(v_fact,'verified','[SMOKE] reviewed',v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: review_customer_fact actor B accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: review_customer_fact actor B gave %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin,'role','authenticated')::text, true);
  IF NOT EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=v_key AND operation='review_customer_fact'
    AND request_actor_id=v_admin AND request_fingerprint ~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'SMOKE_FAIL: review_customer_fact receipt unbound'; END IF;

  FOR v_i IN 1..2 LOOP
    INSERT INTO public.blend_tickets (ticket_number,uploaded_by,customer_id,status,review_status)
    VALUES ('[SMOKE]-KI10-4D-BT-' || v_i || '-' || v_suffix,v_admin,v_customer,'completed','unreviewed') RETURNING id INTO v_id;
    v_ticket := v_ticket || v_id;
  END LOOP;
  v_key := 'smk-4d-approve-' || v_suffix;
  v_result := public.batch_approve_blend_tickets(ARRAY[v_ticket[1]],v_admin,v_key);
  SELECT count(*) INTO v_work_count FROM public.blend_tickets WHERE id=v_ticket[1] AND review_status='approved' AND reviewed_by=v_admin;
  v_retry := public.batch_approve_blend_tickets(ARRAY[v_ticket[1]],v_admin,v_key);
  IF v_result IS DISTINCT FROM v_retry OR v_result->>'approved_count'<>'1' OR v_work_count<>1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch_approve first/retry';
  END IF;
  BEGIN
    PERFORM public.batch_approve_blend_tickets(ARRAY[v_ticket[2]],v_admin,v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: batch_approve changed record accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: batch_approve R2 gave %', SQLERRM; END IF;
  END;
  IF (SELECT review_status FROM public.blend_tickets WHERE id=v_ticket[2])<>'unreviewed' THEN RAISE EXCEPTION 'SMOKE_FAIL: batch_approve R2 changed row'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin_b,'role','authenticated')::text, true);
  BEGIN
    PERFORM public.batch_approve_blend_tickets(ARRAY[v_ticket[1]],v_admin,v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: batch_approve actor B accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM <> 'ACTOR_MISMATCH' THEN RAISE EXCEPTION 'SMOKE_FAIL: batch_approve actor B gave %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin,'role','authenticated')::text, true);
  IF NOT EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=v_key AND operation='batch_approve_blend_tickets'
    AND request_actor_id=v_admin AND request_fingerprint ~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'SMOKE_FAIL: batch_approve receipt unbound'; END IF;
  -- One invented parent row for the lots wrapper's pre-replay FOR UPDATE check.
  INSERT INTO public.application_records(record_number,source_type,source_id,customer_id,application_date,created_by)
  VALUES('[SMOKE]-4D-AR-'||v_suffix,'blend_ticket',v_ticket[1],v_customer,current_date,v_admin)
  RETURNING id INTO v_app_record;

  -- Every wrapper: keyless fails first; a bound R1 receipt may not answer R2 or actor B.
  FOREACH v_op IN ARRAY v_ops LOOP
    SELECT * INTO STRICT v_proc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=v_op;
    v_key := 'smk-4d-generic-'||v_op||'-'||v_suffix;
    v_json := jsonb_build_object('actor_id',v_admin);
    v_arg1 := NULL; v_arg2 := NULL; v_arg0 := NULL;
    v_target_name := CASE WHEN v_op='set_application_record_lots' THEN 'p_lots' ELSE v_proc.proargnames[1] END;
    FOR v_i IN 1..v_proc.pronargs LOOP
      v_name := v_proc.proargnames[v_i];
      v_type := format_type(v_proc.proargtypes[v_i-1],NULL);
      IF v_name='p_idempotency_key' THEN
        v_arg1 := concat_ws(', ',v_arg1,format('%L::text',v_key));
        v_arg2 := concat_ws(', ',v_arg2,format('%L::text',v_key));
        v_arg0 := concat_ws(', ',v_arg0,'NULL::text');
        CONTINUE;
      END IF;
      v_expr := 'NULL::'||v_type;
      IF v_op='create_blend_ticket' THEN
        IF v_name='p_ticket_id' THEN v_expr := format('%L::uuid',v_ticket[1]); END IF;
        IF v_name='p_ticket_payload' THEN v_expr := '''{}''::jsonb'; END IF;
        IF v_name IN ('p_products','p_images') THEN v_expr := '''[]''::jsonb'; END IF;
      ELSIF v_op='dismiss_watchdog_flag' AND v_name='p_resolution' THEN v_expr := '''looks_fine''::text';
      ELSIF v_op='commit_label_draft' AND v_name='p_decision' THEN v_expr := '''rejected''::text';
      ELSIF v_op IN ('review_customer_fact','supersede_customer_fact') AND v_name='p_fact_id' THEN v_expr := format('%L::uuid',v_fact);
      ELSIF v_op='review_customer_fact' AND v_name='p_verdict' THEN v_expr := '''verified''::text';
      ELSIF v_op='supersede_customer_fact' AND v_name='p_value_text' THEN v_expr := '''[SMOKE] replacement''::text';
      ELSIF v_op='save_blend_recipe' THEN
        IF v_name='p_name' THEN v_expr := '''[SMOKE] recipe''::text'; END IF;
        IF v_name='p_recipe_type' THEN v_expr := '''generic''::text'; END IF;
        IF v_name='p_items' THEN v_expr := '''[]''::jsonb'; END IF;
      ELSIF v_op='set_application_record_lots' THEN
        IF v_name='p_application_record_id' THEN v_expr := format('%L::uuid',v_app_record); END IF;
        IF v_name='p_lots' THEN v_expr := '''[]''::jsonb'; END IF;
      ELSIF v_op IN ('set_field_boundary','set_field_override_acres') AND v_name='p_field_id' THEN v_expr := format('%L::uuid',v_field);
      END IF;
      v_expr2 := v_expr;
      IF v_name=v_target_name THEN
        IF v_op='set_application_record_lots' THEN v_expr2 := '''[{"lot_number":"changed"}]''::jsonb';
        ELSIF v_op IN ('review_customer_fact','supersede_customer_fact') THEN v_expr2 := format('%L::uuid',v_fact_b);
        ELSIF v_op IN ('set_field_boundary','set_field_override_acres') THEN v_expr2 := format('%L::uuid',v_field_b);
        ELSIF v_op='create_blend_ticket' THEN v_expr2 := format('%L::uuid',v_ticket[2]);
        ELSIF v_type='uuid' THEN v_expr2 := '''4c4d0000-0000-4000-8000-000000000099''::uuid';
        ELSIF v_type='uuid[]' THEN v_expr2 := 'ARRAY[''4c4d0000-0000-4000-8000-000000000099''::uuid]';
        ELSIF v_type='jsonb' THEN v_expr2 := '''{}''::jsonb';
        ELSIF v_type='text' THEN v_expr2 := '''changed''::text';
        ELSE RAISE EXCEPTION 'SMOKE_SETUP: no R2 for %.%',v_op,v_type; END IF;
      END IF;
      EXECUTE 'SELECT to_jsonb('||v_expr||')' INTO v_value;
      IF NOT (v_name='p_performed_by' AND v_op IN ('create_blend_ticket','save_blend_ticket','save_blend_ticket_fields','dismiss_watchdog_flag','save_field','save_field_crop_history','set_application_record_lots','set_field_boundary','set_field_override_acres')) THEN
        v_json := v_json || jsonb_build_object(v_name,v_value);
      END IF;
      v_arg1 := concat_ws(', ',v_arg1,v_expr);
      v_arg2 := concat_ws(', ',v_arg2,v_expr2);
      v_arg0 := concat_ws(', ',v_arg0,v_expr);
    END LOOP;
    BEGIN
      EXECUTE format('SELECT public.%I(%s)',v_op,v_arg0);
      RAISE EXCEPTION 'SMOKE_FAIL: % accepted no key',v_op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLSTATE<>'22023' OR SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: % keyless gave %',v_op,SQLERRM; END IF;
    END;
    v_fingerprint := public._replay_fingerprint_20261015(v_json);
    INSERT INTO public.idempotency_keys(idempotency_key,operation,result,request_actor_id,request_fingerprint)
    VALUES(v_key,v_op,'{"proof":"R1"}'::jsonb,v_admin,v_fingerprint);
    BEGIN
      EXECUTE format('SELECT public.%I(%s)',v_op,v_arg2);
      RAISE EXCEPTION 'SMOKE_FAIL: % replayed changed request',v_op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: % R2 gave %',v_op,SQLERRM; END IF;
    END;
    PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin_b,'role','authenticated')::text,true);
    BEGIN
      EXECUTE format('SELECT public.%I(%s)',v_op,v_arg1);
      RAISE EXCEPTION 'SMOKE_FAIL: % replayed actor B',v_op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: % B gave %',v_op,SQLERRM; END IF;
    END;
    PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin,'role','authenticated')::text,true);
    IF (SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key=v_key AND operation=v_op AND request_actor_id=v_admin AND request_fingerprint=v_fingerprint)<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: % changed R1 receipt',v_op; END IF;
  END LOOP;
  RAISE NOTICE 'GENERIC_25_BINDING_PASS';

  -- A normal return with an error object has no receipt in admin_update_profile.
  v_key := 'smk-4d-receiptless-'||v_suffix;
  v_result := to_jsonb(public.admin_update_profile(v_admin,'invalid',NULL,NULL,NULL,NULL,v_key));
  IF v_result->>'error' IS NULL OR EXISTS(SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=v_key) THEN RAISE EXCEPTION 'SMOKE_FAIL: admin_update_profile receiptless return'; END IF;

  -- A p_performed_by naming someone else is refused before any receipt is read or written.
  FOREACH v_op IN ARRAY ARRAY['link_fields_to_parent','unlink_field_from_parent','save_field_polygons'] LOOP
    v_key := 'smk-4d-forged-'||v_op||'-'||v_suffix;
    BEGIN
      IF v_op='link_fields_to_parent' THEN PERFORM public.link_fields_to_parent(v_field,ARRAY[v_field_b],v_admin_b,v_key);
      ELSIF v_op='unlink_field_from_parent' THEN PERFORM public.unlink_field_from_parent(v_field_b,v_admin_b,v_key);
      ELSE PERFORM public.save_field_polygons(v_field,'[]'::jsonb,v_admin_b,v_key); END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: % accepted a forged p_performed_by',v_op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM <> 'ACTOR_MISMATCH' THEN RAISE EXCEPTION 'SMOKE_FAIL: % forged p_performed_by gave %',v_op,SQLERRM; END IF;
    END;
    IF EXISTS(SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=v_key) THEN RAISE EXCEPTION 'SMOKE_FAIL: % forged actor left a receipt',v_op; END IF;
  END LOOP;

  -- An applicator must fail the copied role checks before a bound receipt is read.
  PERFORM set_config('request.jwt.claims',json_build_object('sub',v_no_role,'role','authenticated')::text,true);
  FOREACH v_op IN ARRAY ARRAY['save_vendor','save_field','batch_approve_blend_tickets'] LOOP
    BEGIN
      IF v_op='save_vendor' THEN PERFORM public.save_vendor(NULL,v_payload,'smk-4d-vendor-'||v_suffix);
      ELSIF v_op='save_field' THEN PERFORM public.save_field(NULL,v_payload,'[]'::jsonb,NULL,'smk-4d-field-'||v_suffix);
      ELSE PERFORM public.batch_approve_blend_tickets(ARRAY[v_ticket[1]],NULL,'smk-4d-approve-'||v_suffix); END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: % bypassed role',v_op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: % checked receipt before role',v_op; END IF;
    END;
  END LOOP;
  -- An applicator cannot create a recipe through the RPC (the app limits it to admin/sales).
  BEGIN
    PERFORM public.save_blend_recipe(NULL,'[SMOKE] applicator recipe '||v_suffix,'generic','[]'::jsonb,NULL,NULL,NULL,'smk-4d-recipe-role-'||v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: save_blend_recipe accepted an applicator';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN RAISE EXCEPTION 'SMOKE_FAIL: save_blend_recipe applicator gave %',SQLERRM; END IF;
  END;
  IF EXISTS(SELECT 1 FROM public.blend_recipes WHERE name='[SMOKE] applicator recipe '||v_suffix)
    OR EXISTS(SELECT 1 FROM public.idempotency_keys WHERE idempotency_key='smk-4d-recipe-role-'||v_suffix) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: refused applicator recipe left a row';
  END IF;
  RAISE NOTICE 'REAL_4D_PATHS_PASS';
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;

