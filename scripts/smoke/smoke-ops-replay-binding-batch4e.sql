-- CONTAINER ONLY: one block with invented data, always rolled back.
DO $smoke$
DECLARE
  a uuid := '4c4d0000-0000-4000-8000-0000000000a1';
  b uuid := '4c4d0000-0000-4000-8000-0000000000a2';
  c uuid := '4c4d0000-0000-4000-8000-0000000000c1';
  s text := substr(md5(random()::text),1,8);
  k text;
  cust uuid;
  cust2 uuid;
  j uuid;
  j2 uuid;
  pre_job uuid;
  pre_job2 uuid;
  notice uuid;
  notice2 uuid;
  template uuid;
  failed uuid;
  first_answer jsonb;
  second_answer jsonb;
  old_time timestamptz;
  n integer;
  op text;
  p pg_proc%ROWTYPE;
  call_args text;
  i integer;
  ops text[] := ARRAY['confirm_job_notification_sent','record_job_pre_notifications','record_job_post_notifications','log_failed_notification','assign_job_applicator','dispatch_job_locations','undispatch_job_locations','start_job','create_job_from_quote_section','update_field_app_applied_info','create_quote_from_template','rollover_quote_to_season','save_quote_template'];
  arg_name text;
  arg_type text;
  expr text;
  expr2 text;
  r1_args text;
  r2_args text;
  payload jsonb;
  val jsonb;
  fp text;
  target_arg text;
BEGIN
  IF (SELECT count(*) FROM public.profiles WHERE id IN (a,b) AND role='admin' AND is_active)<>2
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=c AND role='applicator' AND is_active)
  THEN RAISE EXCEPTION 'SMOKE_SETUP: invented profiles missing'; END IF;
  PERFORM set_config('request.jwt.claims',json_build_object('sub',a,'role','authenticated')::text,true);
  INSERT INTO public.customers(farm_name,account_number,email) VALUES
    ('[SMOKE] 4e A '||s,'[SMOKE]-4E-A-'||s,'invented-'||s||'@example.invalid') RETURNING id INTO cust;
  INSERT INTO public.customers(farm_name,account_number) VALUES
    ('[SMOKE] 4e B '||s,'[SMOKE]-4E-B-'||s) RETURNING id INTO cust2;
  INSERT INTO public.jobs(job_number,customer_id,job_date,created_by,status) VALUES
    ('[SMOKE]-4E-J1-'||s,cust,current_date,a,'completed') RETURNING id INTO j;
  INSERT INTO public.jobs(job_number,customer_id,job_date,created_by,status) VALUES
    ('[SMOKE]-4E-J2-'||s,cust,current_date,a,'completed') RETURNING id INTO j2;
  INSERT INTO public.jobs(job_number,customer_id,job_date,created_by,status) VALUES
    ('[SMOKE]-4E-P1-'||s,cust,current_date,a,'scheduled') RETURNING id INTO pre_job;
  INSERT INTO public.jobs(job_number,customer_id,job_date,created_by,status) VALUES
    ('[SMOKE]-4E-P2-'||s,cust,current_date,a,'scheduled') RETURNING id INTO pre_job2;

  -- First binding step: old code falsely replays job 1's answer for job 2.
  k := 'smk-4e-post-'||s;
  first_answer := public.record_job_post_notifications(j,'[SMOKE] post','[SMOKE] message',a,k);
  SELECT count(*) INTO n FROM public.job_notifications x WHERE x.job_id=j AND x.notification_type='post';
  second_answer := public.record_job_post_notifications(j,'[SMOKE] post','[SMOKE] message',a,k);
  IF second_answer IS DISTINCT FROM first_answer OR n<>(SELECT count(*) FROM public.job_notifications x WHERE x.job_id=j AND x.notification_type='post') THEN RAISE EXCEPTION 'SMOKE_FAIL: post retry'; END IF;
  BEGIN
    PERFORM public.record_job_post_notifications(j2,'[SMOKE] post','[SMOKE] message',a,k);
    RAISE EXCEPTION 'SMOKE_FAIL: record_job_post_notifications replayed a changed request';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: post R2 gave %',SQLERRM; END IF;
  END;
  IF EXISTS(SELECT 1 FROM public.job_notifications x WHERE x.job_id=j2) THEN RAISE EXCEPTION 'SMOKE_FAIL: post changed job 2'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=k AND operation='record_job_post_notifications' AND request_actor_id=a AND request_fingerprint ~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'SMOKE_FAIL: post receipt'; END IF;
  SELECT (first_answer->'recipients'->0->>'notification_id')::uuid INTO notice;
  IF notice IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: no notice'; END IF;

  INSERT INTO public.job_notifications(job_id,notification_type,recipient_email,status,subject,message)
    VALUES(j,'post','other@example.invalid','failed','[SMOKE] other','[SMOKE] other') RETURNING id INTO notice2;
  k := 'smk-4e-confirm-'||s;
  first_answer := public.confirm_job_notification_sent(notice,'[SMOKE] sent','[SMOKE] sent',a,k);
  SELECT sent_at INTO old_time FROM public.job_notifications WHERE id=notice;
  second_answer := public.confirm_job_notification_sent(notice,'[SMOKE] sent','[SMOKE] sent',a,k);
  IF first_answer IS DISTINCT FROM second_answer OR old_time IS NULL OR old_time IS DISTINCT FROM (SELECT sent_at FROM public.job_notifications WHERE id=notice) THEN RAISE EXCEPTION 'SMOKE_FAIL: confirm retry'; END IF;
  BEGIN
    PERFORM public.confirm_job_notification_sent(notice2,'[SMOKE] sent','[SMOKE] sent',a,k);
    RAISE EXCEPTION 'SMOKE_FAIL: confirm replayed changed request';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: confirm R2 gave %',SQLERRM; END IF;
  END;
  IF (SELECT status FROM public.job_notifications WHERE id=notice2)<>'failed' THEN RAISE EXCEPTION 'SMOKE_FAIL: confirm changed notice 2'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=k AND operation='confirm_job_notification_sent' AND request_actor_id=a AND request_fingerprint ~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'SMOKE_FAIL: confirm receipt'; END IF;
  -- An old tab (before PR #1518) confirms without a key: it still works and writes no receipt.
  SELECT count(*) INTO n FROM public.idempotency_keys WHERE operation='confirm_job_notification_sent';
  PERFORM public.confirm_job_notification_sent(notice2,'[SMOKE] sent','[SMOKE] sent',a,NULL);
  IF (SELECT status FROM public.job_notifications WHERE id=notice2)<>'sent' THEN RAISE EXCEPTION 'SMOKE_FAIL: keyless confirm did not confirm'; END IF;
  IF n<>(SELECT count(*) FROM public.idempotency_keys WHERE operation='confirm_job_notification_sent') THEN RAISE EXCEPTION 'SMOKE_FAIL: keyless confirm wrote a receipt'; END IF;

  k := 'smk-4e-failed-'||s;
  failed := public.log_failed_notification('post','job',j,'[SMOKE] failure','{}'::jsonb,k);
  IF failed IS DISTINCT FROM public.log_failed_notification('post','job',j,'[SMOKE] failure','{}'::jsonb,k) THEN RAISE EXCEPTION 'SMOKE_FAIL: log_failed retry'; END IF;
  BEGIN
    PERFORM public.log_failed_notification('post','job',j2,'[SMOKE] failure','{}'::jsonb,k);
    RAISE EXCEPTION 'SMOKE_FAIL: log_failed replayed changed request';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: log_failed R2 gave %',SQLERRM; END IF;
  END;
  IF (SELECT count(*) FROM public.failed_notifications WHERE id=failed)<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: failed log row'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=k AND operation='log_failed_notification' AND request_actor_id=a AND request_fingerprint ~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'SMOKE_FAIL: failed receipt'; END IF;
  -- An old tab (before PR #1518) logs a failure without a key: the row is still written, with no receipt.
  SELECT count(*) INTO n FROM public.idempotency_keys WHERE operation='log_failed_notification';
  failed := public.log_failed_notification('post','job',j2,'[SMOKE] keyless failure','{}'::jsonb,NULL);
  IF (SELECT count(*) FROM public.failed_notifications WHERE id=failed AND error_message='[SMOKE] keyless failure')<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: keyless log_failed wrote no row'; END IF;
  IF n<>(SELECT count(*) FROM public.idempotency_keys WHERE operation='log_failed_notification') THEN RAISE EXCEPTION 'SMOKE_FAIL: keyless log_failed wrote a receipt'; END IF;

  k := 'smk-4e-assign-'||s;
  first_answer := public.assign_job_applicator(j,NULL,false,a,k);
  SELECT count(*) INTO n FROM public.activity_feed WHERE related_entity_id=j AND event_type='job_assigned';
  second_answer := public.assign_job_applicator(j,NULL,false,a,k);
  IF first_answer IS DISTINCT FROM second_answer OR n<>(SELECT count(*) FROM public.activity_feed WHERE related_entity_id=j AND event_type='job_assigned') THEN RAISE EXCEPTION 'SMOKE_FAIL: assign retry'; END IF;
  BEGIN
    PERFORM public.assign_job_applicator(j2,NULL,false,a,k);
    RAISE EXCEPTION 'SMOKE_FAIL: assign replayed changed request';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: assign R2 gave %',SQLERRM; END IF;
  END;
  IF NOT EXISTS(SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=k AND operation='assign_job_applicator' AND request_actor_id=a AND request_fingerprint ~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'SMOKE_FAIL: assign receipt'; END IF;

  INSERT INTO public.quote_templates(template_name,sections,created_by) VALUES('[SMOKE] 4e '||s,'[]'::jsonb,a) RETURNING id INTO template;
  k := 'smk-4e-quote-'||s;
  first_answer := public.create_quote_from_template(template,cust,a,k);
  second_answer := public.create_quote_from_template(template,cust,a,k);
  IF first_answer IS DISTINCT FROM second_answer OR first_answer->>'status'<>'created' OR
    (SELECT count(*) FROM public.quotes WHERE quote_number=first_answer->>'quote_number')<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: create_quote retry'; END IF;
  BEGIN
    PERFORM public.create_quote_from_template(template,cust2,a,k);
    RAISE EXCEPTION 'SMOKE_FAIL: create_quote replayed changed request';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: create_quote R2 gave %',SQLERRM; END IF;
  END;
  IF EXISTS(SELECT 1 FROM public.quotes WHERE customer_id=cust2) THEN RAISE EXCEPTION 'SMOKE_FAIL: create_quote changed customer 2'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=k AND operation='create_quote_from_template' AND request_actor_id=a AND request_fingerprint ~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'SMOKE_FAIL: create_quote receipt'; END IF;

  -- The two prepayment bodies always raise before any lookup, so their keyed
  -- mismatch probe is unreachable. The other 13 receive an R1 bound receipt.
  FOREACH op IN ARRAY ops LOOP
    SELECT * INTO STRICT p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=op;
    k := 'smk-4e-generic-'||op||'-'||s;
    payload := jsonb_build_object('actor_id',a);
    r1_args := NULL; r2_args := NULL;
    target_arg := p.proargnames[1];
    FOR i IN 1..p.pronargs LOOP
      arg_name := p.proargnames[i];
      arg_type := format_type(p.proargtypes[i-1],NULL);
      IF arg_name='p_idempotency_key' THEN
        r1_args := concat_ws(', ',r1_args,format('%L::text',k));
        r2_args := concat_ws(', ',r2_args,format('%L::text',k));
        CONTINUE;
      END IF;
      expr := 'NULL::'||arg_type;
      IF op='record_job_pre_notifications' THEN
        IF arg_name='p_job_id' THEN expr := format('%L::uuid',pre_job); END IF;
        IF arg_name='p_subject' THEN expr := '''[SMOKE] pre''::text'; END IF;
        IF arg_name='p_message' THEN expr := '''[SMOKE] message''::text'; END IF;
      ELSIF op='record_job_post_notifications' THEN
        IF arg_name='p_job_id' THEN expr := format('%L::uuid',j); END IF;
        IF arg_name='p_subject' THEN expr := '''[SMOKE] post''::text'; END IF;
        IF arg_name='p_message' THEN expr := '''[SMOKE] message''::text'; END IF;
      ELSIF op='log_failed_notification' AND arg_name='p_notification_type' THEN expr := '''post''::text';
      ELSIF op='start_job' AND arg_name='p_performed_by' THEN expr := format('%L::uuid',a);
      ELSIF op='update_field_app_applied_info' THEN
        IF arg_name='p_invoice_ids' THEN expr := format('ARRAY[%L::uuid]',j); END IF;
        IF arg_name='p_performed_by' THEN expr := format('%L::uuid',a); END IF;
      END IF;
      expr2 := expr;
      IF arg_name=target_arg THEN
        IF op='record_job_pre_notifications' THEN expr2 := format('%L::uuid',pre_job2);
        ELSIF op='record_job_post_notifications' THEN expr2 := format('%L::uuid',j2);
        ELSIF op='update_field_app_applied_info' THEN expr2 := format('ARRAY[%L::uuid]',j2);
        ELSIF arg_type='uuid' THEN expr2 := '''4c4d0000-0000-4000-8000-000000000099''::uuid';
        ELSIF arg_type='uuid[]' THEN expr2 := 'ARRAY[''4c4d0000-0000-4000-8000-000000000099''::uuid]';
        ELSIF arg_type='jsonb' THEN expr2 := '''{}''::jsonb';
        ELSIF arg_type='text' THEN expr2 := '''changed''::text';
        ELSE RAISE EXCEPTION 'SMOKE_SETUP: no R2 for %.%',op,arg_type; END IF;
      END IF;
      EXECUTE 'SELECT to_jsonb('||expr||')' INTO val;
      IF arg_name<>'p_performed_by' THEN payload := payload || jsonb_build_object(arg_name,val); END IF;
      r1_args := concat_ws(', ',r1_args,expr);
      r2_args := concat_ws(', ',r2_args,expr2);
    END LOOP;
    fp := public._replay_fingerprint_20261015(payload);
    INSERT INTO public.idempotency_keys(idempotency_key,operation,result,request_actor_id,request_fingerprint)
    VALUES(k,op,'{"proof":"R1"}'::jsonb,a,fp);
    BEGIN
      EXECUTE format('SELECT public.%I(%s)',op,r2_args);
      RAISE EXCEPTION 'SMOKE_FAIL: % replayed changed request',op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: % R2 gave %',op,SQLERRM; END IF;
    END;
    PERFORM set_config('request.jwt.claims',json_build_object('sub',b,'role','authenticated')::text,true);
    BEGIN
      EXECUTE format('SELECT public.%I(%s)',op,r1_args);
      RAISE EXCEPTION 'SMOKE_FAIL: % replayed actor B',op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF op IN ('start_job','update_field_app_applied_info') THEN
        IF SQLERRM NOT LIKE 'p_performed_by does not match%' THEN RAISE EXCEPTION 'SMOKE_FAIL: % B precheck gave %',op,SQLERRM; END IF;
      ELSIF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % B gave %',op,SQLERRM;
      END IF;
    END;
    PERFORM set_config('request.jwt.claims',json_build_object('sub',a,'role','authenticated')::text,true);
    IF (SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key=k AND operation=op AND request_actor_id=a AND request_fingerprint=fp)<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: % changed R1 receipt',op; END IF;
  END LOOP;
  RAISE NOTICE 'GENERIC_13_BINDING_PASS';

  PERFORM set_config('request.jwt.claims',json_build_object('sub',b,'role','authenticated')::text,true);
  FOREACH op IN ARRAY ARRAY['record_job_post_notifications','confirm_job_notification_sent','assign_job_applicator','create_quote_from_template'] LOOP
    BEGIN
      IF op='record_job_post_notifications' THEN PERFORM public.record_job_post_notifications(j,'[SMOKE] post','[SMOKE] message',NULL,'smk-4e-post-'||s);
      ELSIF op='confirm_job_notification_sent' THEN PERFORM public.confirm_job_notification_sent(notice,'[SMOKE] sent','[SMOKE] sent',NULL,'smk-4e-confirm-'||s);
      ELSIF op='assign_job_applicator' THEN PERFORM public.assign_job_applicator(j,NULL,false,NULL,'smk-4e-assign-'||s);
      ELSE PERFORM public.create_quote_from_template(template,cust,NULL,'smk-4e-quote-'||s); END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: % accepted actor B',op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: % B gave %',op,SQLERRM; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM public.log_failed_notification('post','job',j,'[SMOKE] failure','{}'::jsonb,'smk-4e-failed-'||s);
    RAISE EXCEPTION 'SMOKE_FAIL: actor B accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: actor B gave %',SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims',json_build_object('sub',c,'role','authenticated')::text,true);
  FOREACH op IN ARRAY ARRAY['record_job_post_notifications','confirm_job_notification_sent','assign_job_applicator'] LOOP
    BEGIN
      IF op='record_job_post_notifications' THEN PERFORM public.record_job_post_notifications(j,'[SMOKE] post','[SMOKE] message',NULL,'smk-4e-post-'||s);
      ELSIF op='confirm_job_notification_sent' THEN PERFORM public.confirm_job_notification_sent(notice,'[SMOKE] sent','[SMOKE] sent',NULL,'smk-4e-confirm-'||s);
      ELSE PERFORM public.assign_job_applicator(j,NULL,false,NULL,'smk-4e-assign-'||s); END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: % bypassed role',op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN RAISE EXCEPTION 'SMOKE_FAIL: % role gave %',op,SQLERRM; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM public.confirm_job_notification_sent(notice,'[SMOKE] sent','[SMOKE] sent',NULL,NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: keyless confirm bypassed role';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN RAISE EXCEPTION 'SMOKE_FAIL: keyless confirm role gave %',SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims',json_build_object('sub',a,'role','authenticated')::text,true);
  -- An old tab saving applied info without a key reaches the unchanged body (its own actor check), not a key refusal.
  SELECT count(*) INTO n FROM public.idempotency_keys WHERE operation='update_field_app_applied_info';
  BEGIN
    PERFORM public.update_field_app_applied_info(ARRAY[j]::uuid[],NULL,NULL,NULL,NULL,NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: keyless applied info skipped the actor check';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'p_performed_by does not match%' THEN RAISE EXCEPTION 'SMOKE_FAIL: keyless applied info gave %',SQLERRM; END IF;
  END;
  IF n<>(SELECT count(*) FROM public.idempotency_keys WHERE operation='update_field_app_applied_info') THEN RAISE EXCEPTION 'SMOKE_FAIL: keyless applied info wrote a receipt'; END IF;
  FOREACH op IN ARRAY ARRAY['record_job_pre_notifications','record_job_post_notifications','apply_remaining_prepayments','batch_apply_all_prepayments','assign_job_applicator','dispatch_job_locations','undispatch_job_locations','start_job','create_job_from_quote_section','create_quote_from_template','rollover_quote_to_season','save_quote_template'] LOOP
    SELECT * INTO STRICT p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=op;
    call_args := NULL;
    FOR i IN 1..p.pronargs LOOP call_args := concat_ws(', ',call_args,'NULL::'||format_type(p.proargtypes[i-1],NULL)); END LOOP;
    BEGIN
      EXECUTE format('SELECT public.%I(%s)',op,call_args);
      RAISE EXCEPTION 'SMOKE_FAIL: % accepted no key',op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLSTATE<>'22023' OR SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: % keyless gave %',op,SQLERRM; END IF;
    END;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['smk-4e-disabled-'||s,'smk-4e-disabled-'||s] LOOP
    BEGIN
      PERFORM public.batch_apply_all_prepayments(a,k);
      RAISE EXCEPTION 'SMOKE_FAIL: disabled prepay accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM<>'PREPAY_BULK_APPLY_DISABLED' THEN RAISE EXCEPTION 'SMOKE_FAIL: disabled prepay gave %',SQLERRM; END IF;
    END;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['smk-4e-disabled-one-'||s,'smk-4e-disabled-one-'||s] LOOP
    BEGIN
      PERFORM public.apply_remaining_prepayments(cust,a,k);
      RAISE EXCEPTION 'SMOKE_FAIL: disabled single-customer prepay accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM<>'PREPAY_BULK_APPLY_DISABLED' THEN RAISE EXCEPTION 'SMOKE_FAIL: disabled single-customer prepay gave %',SQLERRM; END IF;
    END;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.idempotency_keys WHERE idempotency_key IN ('smk-4e-disabled-'||s,'smk-4e-disabled-one-'||s)) THEN RAISE EXCEPTION 'SMOKE_FAIL: disabled prepay receipt'; END IF;
  RAISE NOTICE 'REAL_4E_PATHS_PASS';
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
