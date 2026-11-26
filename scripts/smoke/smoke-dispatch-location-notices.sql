-- Local Docker only. This transaction uses invented fixtures and always rolls back.
SET ROLE postgres;
BEGIN;
DO $proof$
DECLARE
  rep uuid := gen_random_uuid();
  fixture_admin uuid;
  app_a uuid := gen_random_uuid();
  app_b uuid := gen_random_uuid();
  farm uuid := gen_random_uuid();
  job uuid := gen_random_uuid();
  field_a uuid := gen_random_uuid();
  field_b uuid := gen_random_uuid();
  field_c uuid := gen_random_uuid();
  crew uuid := gen_random_uuid();
  location_a uuid := gen_random_uuid();
  location_b uuid := gen_random_uuid();
  location_c uuid := gen_random_uuid();
  wizard_key text := gen_random_uuid()::text;
  old_key text := gen_random_uuid()::text;
  wizard_payload jsonb;
  old_payload jsonb;
  take_over jsonb;
  replace_location jsonb;
  crew_payload jsonb;
  first_result jsonb;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id,email) VALUES
    (rep,rep || '@fixture.example.test'), (app_a,app_a || '@fixture.example.test'),
    (app_b,app_b || '@fixture.example.test');
  INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
    (rep,rep || '@fixture.example.test','Invented Dispatcher','sales_rep',true),
    (app_a,app_a || '@fixture.example.test','Invented Applicator A','applicator',true),
    (app_b,app_b || '@fixture.example.test','Invented Applicator B','applicator',true);
  INSERT INTO public.customers (id,farm_name) VALUES (farm,'Invented Notice Farm');
  INSERT INTO public.jobs (id,job_number,customer_id,job_date,status,total_acres)
  VALUES (job,'INVENTED-NOTICE-JOB',farm,CURRENT_DATE,'scheduled',30);
  INSERT INTO public.fields (id,customer_id,field_name,total_acres) VALUES
    (field_a,farm,'Invented Notice A',10), (field_b,farm,'Invented Notice B',10),
    (field_c,farm,'Invented Notice C',10);
  INSERT INTO public.job_fields (id,job_id,field_id,acres_to_treat) VALUES
    (location_a,job,field_a,10), (location_b,job,field_b,10), (location_c,job,field_c,10);
  INSERT INTO public.ground_crews (id,name) VALUES (crew,'Invented Notice Crew');
  SET LOCAL session_replication_role = origin;

  wizard_payload := jsonb_build_array(
    jsonb_build_object('job_field_id',location_a,'applicator_id',app_a),
    jsonb_build_object('job_field_id',location_b,'applicator_id',app_a));
  old_payload := jsonb_build_array(jsonb_build_object('job_field_id',location_c,'applicator_id',app_a));
  take_over := jsonb_build_array(jsonb_build_object('job_field_id',location_c,'applicator_id',app_b));
  replace_location := jsonb_build_array(jsonb_build_object('job_field_id',location_a,'applicator_id',app_b));
  crew_payload := jsonb_build_array(jsonb_build_object('job_field_id',location_b,'crew_id',crew));

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.dispatch_location_with_notices('wizard', wizard_payload, p_idempotency_key => gen_random_uuid()::text);
    RAISE EXCEPTION 'Dispatch without a signed-in user succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'AUTH_REQUIRED' THEN RAISE; END IF;
  END;
  RESET ROLE;
  IF has_function_privilege('anon', 'public.dispatch_location_with_notices(text,jsonb,uuid[],boolean,text)', 'EXECUTE')
    OR EXISTS (SELECT FROM public.job_location_dispatches WHERE job_field_id IN (location_a, location_b, location_c))
  THEN RAISE EXCEPTION 'Unsigned dispatch was executable or wrote an assignment'; END IF;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',rep,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', rep::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.dispatch_location_with_notices('wizard', wizard_payload,
      p_license_override => NULL, p_idempotency_key => gen_random_uuid()::text);
    RAISE EXCEPTION 'Missing license override value was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM <> 'INVALID_LICENSE_OVERRIDE' THEN RAISE; END IF;
  END;
  first_result := public.dispatch_location_with_notices('wizard', wizard_payload, p_idempotency_key => wizard_key);
  IF first_result IS DISTINCT FROM public.dispatch_location_with_notices('wizard', wizard_payload, p_idempotency_key => wizard_key)
  THEN RAISE EXCEPTION 'Wizard replay changed its result'; END IF;
  PERFORM public.dispatch_job_locations(old_payload, NULL, old_key);
  PERFORM public.dispatch_location_with_notices('wizard', old_payload, p_idempotency_key => old_key);
  RESET ROLE;
  IF (SELECT count(*) FROM public.notifications WHERE related_entity_id = job) <> 1
    OR NOT EXISTS (SELECT FROM public.notifications WHERE related_entity_id = job
      AND user_id = app_a AND created_by = rep AND notification_type = 'job_dispatched'
      AND message LIKE '%Invented Notice Farm%')
  THEN RAISE EXCEPTION 'Wizard grouping, sender or old-caller replay changed'; END IF;

  SET LOCAL ROLE authenticated;
  PERFORM public.dispatch_location_with_notices('wizard', take_over, p_idempotency_key => gen_random_uuid()::text);
  PERFORM public.dispatch_location_with_notices('reassign', replace_location, p_idempotency_key => gen_random_uuid()::text);
  PERFORM public.dispatch_location_with_notices('reassign', replace_location, p_idempotency_key => gen_random_uuid()::text);
  RESET ROLE;
  IF (SELECT count(*) FROM public.notifications WHERE related_entity_id = job AND user_id = app_b
     AND notification_type = 'job_dispatched') <> 2
    OR (SELECT count(*) FROM public.notifications WHERE related_entity_id = job
     AND user_id = app_a AND notification_type = 'job_undispatched') <> 1
  THEN RAISE EXCEPTION 'Wizard takeover, Board prior recipient or Board no-op changed'; END IF;

  SET LOCAL ROLE authenticated;
  PERFORM public.dispatch_location_with_notices('remove', p_job_field_ids => ARRAY[location_a],
    p_idempotency_key => gen_random_uuid()::text);
  PERFORM public.dispatch_location_with_notices('remove', p_job_field_ids => ARRAY[location_a],
    p_idempotency_key => gen_random_uuid()::text);
  PERFORM public.dispatch_location_with_notices('reassign', crew_payload, p_idempotency_key => gen_random_uuid()::text);
  RESET ROLE;
  IF (SELECT count(*) FROM public.notifications WHERE related_entity_id = job) <> 6
    OR (SELECT count(*) FROM public.notifications WHERE related_entity_id = job AND user_id = app_b
     AND notification_type = 'job_undispatched') <> 1
    OR EXISTS (SELECT FROM public.notifications WHERE related_entity_id = job AND created_by IS DISTINCT FROM rep)
  THEN RAISE EXCEPTION 'Removal, crew or sender behavior changed'; END IF;

  SELECT id INTO fixture_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1;
  IF fixture_admin IS NULL THEN RAISE EXCEPTION 'The local walkthrough needs its seeded administrator'; END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',fixture_admin,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', fixture_admin::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.admin_update_profile(app_a, new_is_active => false, p_idempotency_key => gen_random_uuid()::text);
  RESET ROLE;
  IF (SELECT is_active FROM public.profiles WHERE id = app_a) IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'The local administrator did not deactivate the fixture'; END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',rep,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', rep::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.dispatch_location_with_notices('wizard', wizard_payload, p_idempotency_key => gen_random_uuid()::text);
    RAISE EXCEPTION 'Inactive applicator was dispatched';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'INVALID_APPLICATOR:%' THEN RAISE; END IF;
  END;
  RESET ROLE;

  ALTER TABLE public.notifications ADD CONSTRAINT dispatch_proof_refuses_notice
    CHECK (notification_type <> 'job_dispatched') NOT VALID;
  SET LOCAL ROLE authenticated;
  PERFORM public.dispatch_location_with_notices('wizard', replace_location, p_idempotency_key => gen_random_uuid()::text);
  RESET ROLE;
  ALTER TABLE public.notifications DROP CONSTRAINT dispatch_proof_refuses_notice;
  IF NOT EXISTS (SELECT FROM public.job_location_dispatches WHERE job_field_id = location_a
     AND applicator_id = app_b AND dispatch_status = 'dispatched')
    OR (SELECT count(*) FROM public.failed_notifications WHERE entity_id = job AND notification_type = 'job_dispatched') <> 1
    OR (SELECT count(*) FROM public.notifications WHERE related_entity_id = job) <> 6
  THEN RAISE EXCEPTION 'Notice refusal changed the saved dispatch or lost its failure record'; END IF;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',app_b,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', app_b::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.dispatch_location_with_notices('wizard', replace_location, p_idempotency_key => gen_random_uuid()::text);
    RAISE EXCEPTION 'Field role sent a dispatch';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'INSUFFICIENT_ROLE' THEN RAISE; END IF;
  END;
  RESET ROLE;
END
$proof$;
ROLLBACK;
SELECT 'DISPATCH_LOCATION_NOTICES_PROOF_PASS';
