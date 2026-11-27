-- Isolated local walkthrough only. Both test identities and business rows are invented.
-- Derived from the existing start-and-complete smoke fixture. Every write below rolls back.
BEGIN;
DO $smoke$
DECLARE
  v_admin uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_prefix text;
  v_key text;
  v_customer uuid;
  v_product uuid;
  v_pricing jsonb;
  v_order uuid;
  v_oi uuid;
  v_del uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_i int;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_res jsonb;
  v_res2 jsonb;
  v_avail numeric;
  v_n int;
  v_status text;
  v_completed timestamptz;
  v_fp text;
  v_actor uuid;
  v_fail_user uuid := gen_random_uuid();
  v_notice jsonb;
  v_driver uuid := gen_random_uuid();
  v_tiny_line uuid;
  v_driver_key text;
  v_signature text;
  v_amounts jsonb;
  v_lines jsonb;
  v_rep uuid := gen_random_uuid();
  v_other_rep uuid := gen_random_uuid();
  v_rep_key text;
BEGIN
  -- 0. Preconditions, two admins, fixtures.
  IF EXISTS (SELECT 1 FROM public.accounting_periods
              WHERE status = 'closed' AND (v_today - 1) BETWEEN period_start AND period_end) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: yesterday falls in a CLOSED accounting period';
  END IF;
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: one active admin profile is required';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_prefix := 'smk-sacd-' || v_suffix || '-';

  INSERT INTO public.customers (farm_name, account_number)
  VALUES ('[SMOKE] Start Complete Farm ' || v_suffix, '[SMOKE]-SACD-' || v_suffix)
  RETURNING id INTO v_customer;
  INSERT INTO public.products (product_name, unit_size, epa_registration, product_form, inventory_unit)
  VALUES ('[SMOKE] Start Complete Product ' || v_suffix, 'Gal', '999999-99999', 'liquid', 'Gal')
  RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
    v_admin, v_prefix || 'pricing-preview');
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin, v_prefix || 'pricing-apply');
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 100, 8, 'Gal');

  -- One order, four 2-unit lines; deliveries 1-3 scheduled, 4 in_progress.
  INSERT INTO public.orders (order_number, customer_id, status, booking_draw)
  VALUES ('[SMOKE] SACD-' || v_suffix, v_customer, 'confirmed', false)
  RETURNING id INTO v_order;
  FOR v_i IN 1..4 LOOP
    INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
                                    total_units_needed, total_price, profit, net_margin,
                                    quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product, '[SMOKE] line ' || v_i, 10, 6, 2, 20, 8, 40, 0, 2)
    RETURNING id INTO v_oi;
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, assigned_driver,
                                   scheduled_date, status, created_by)
    VALUES ('[SMOKE] SACD-DEL-' || v_i || '-' || v_suffix, v_order, v_customer, NULL,
            CURRENT_DATE, 'scheduled', v_admin)
    RETURNING id INTO v_id;
    v_del := v_del || v_id;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_id, v_oi, v_product, 2, 0, 'Gal');
  END LOOP;
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_del[4];

  -- a. Scheduled delivery, today: one call starts and completes it.
  v_key := v_prefix || 'start-complete';
  SET LOCAL ROLE authenticated;
  v_res := public.start_and_complete_delivery(v_del[1], 'No proof — recorded by office', v_today, v_admin, NULL, NULL, NULL, v_key, 'no_proof', '[SMOKE] test delivery, no proof kept', p_record_completion_notice => true);
  RESET ROLE;
  IF v_res->>'status' IS DISTINCT FROM 'completed' OR (v_res->>'started')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: start_and_complete_delivery did not start and complete delivery 1: %', v_res;
  END IF;
  SELECT status, completed_at INTO v_status, v_completed FROM public.deliveries WHERE id = v_del[1];
  IF v_status IS DISTINCT FROM 'completed' OR (v_completed AT TIME ZONE 'America/Chicago')::date IS DISTINCT FROM v_today THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery 1 is % completed at % (expected completed, Chicago date %)', v_status, v_completed, v_today;
  END IF;
  SELECT quantity_available INTO v_avail FROM public.inventory WHERE product_id = v_product AND location = 'Main Warehouse';
  IF v_avail IS DISTINCT FROM 98::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery 1 moved % units, expected 2', 100 - v_avail;
  END IF;
  SELECT count(*) INTO v_n FROM public.activity_feed
   WHERE event_type = 'delivery_confirmed' AND related_entity_id = v_del[1];
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery 1 has % start activity rows, expected 1', v_n;
  END IF;
  SELECT request_actor_id, request_fingerprint INTO v_actor, v_fp FROM public.idempotency_keys
   WHERE idempotency_key = v_key AND operation = 'start_and_complete_delivery';
  IF v_actor IS DISTINCT FROM v_admin OR v_fp IS NULL OR v_fp !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the start_and_complete_delivery receipt is not bound (actor %, fingerprint %)', v_actor, v_fp;
  END IF;
  SELECT request_actor_id, request_fingerprint INTO v_actor, v_fp FROM public.idempotency_keys
   WHERE idempotency_key = v_key || ':complete' AND operation = 'complete_delivery';
  IF v_actor IS DISTINCT FROM v_admin OR v_fp IS NULL OR v_fp !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the inner complete_delivery receipt is not bound (actor %, fingerprint %)', v_actor, v_fp;
  END IF;

  -- b. The exact retry replays and moves no extra stock.
  SET LOCAL ROLE authenticated;
  v_res2 := public.start_and_complete_delivery(v_del[1], 'No proof — recorded by office', v_today, v_admin, NULL, NULL, NULL, v_key, 'no_proof', '[SMOKE] test delivery, no proof kept', p_record_completion_notice => true);
  RESET ROLE;
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact retry did not replay: % vs %', v_res2, v_res;
  END IF;
  SELECT quantity_available INTO v_avail FROM public.inventory WHERE product_id = v_product AND location = 'Main Warehouse';
  IF v_avail IS DISTINCT FROM 98::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact retry moved stock again (% left)', v_avail;
  END IF;


  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES (v_fail_user,v_fail_user || '@fixture.example.test',
    jsonb_build_object('full_name','Invented Deferred Notice Admin','role','admin'));

  IF (SELECT count(*) FROM public.delivery_completion_notice_events e
    JOIN public.delivery_brand_events b ON b.seq=e.completion_seq WHERE b.delivery_id = v_del[1]) <> 1
  THEN RAISE EXCEPTION 'Expected one new event after save and replay'; END IF;

  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.notify_saved_delivery_completion(v_del[1], v_key || ':complete', v_prefix || 'wrong-path');
    RAISE EXCEPTION 'Expected the saved list event to reject its internal detail receipt';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'DELIVERY_COMPLETION_NOTICE_RECEIPT_REQUIRED' THEN RAISE; END IF;
  END;
  RESET ROLE;

  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT completion_sender_smoke_fault
     CHECK (related_entity_id IS DISTINCT FROM %L::uuid OR user_id IS DISTINCT FROM %L::uuid)',
    v_del[1], v_fail_user
  );
  SET LOCAL ROLE authenticated;
  v_notice := public.notify_saved_delivery_completion(v_del[1], v_key, v_prefix || 'notice');
  RESET ROLE;
  IF v_notice <> '{"status":"pending","failed":1}'::jsonb
    OR EXISTS(SELECT FROM public.notifications WHERE related_entity_id = v_del[1] AND user_id = v_fail_user)
    OR NOT EXISTS(SELECT FROM public.notifications WHERE related_entity_id = v_del[1] AND user_id = v_admin
      AND title = 'Delivery Completed' AND created_by = v_admin)
    OR (SELECT status FROM public.deliveries WHERE id = v_del[1]) IS DISTINCT FROM 'completed'
  THEN RAISE EXCEPTION 'Partial notice failure lost an eligible notice or the completed delivery: %', v_notice; END IF;

  ALTER TABLE public.notifications DROP CONSTRAINT completion_sender_smoke_fault;
  SET LOCAL ROLE authenticated;
  v_notice := public.notify_saved_delivery_completion(v_del[1], v_key, v_prefix || 'notice');
  IF v_notice <> '{"status":"sent"}'::jsonb THEN RAISE EXCEPTION 'Missing notice was not retried'; END IF;
  v_notice := public.notify_saved_delivery_completion(v_del[1], v_key, v_prefix || 'notice-fresh-key');
  RESET ROLE;
  IF v_notice <> '{"status":"sent"}'::jsonb
    OR (SELECT count(*) FROM public.notifications WHERE related_entity_id = v_del[1] AND user_id = v_admin
      AND notification_type = 'delivery_completed') <> 1
    OR (SELECT count(*) FROM public.notifications WHERE related_entity_id = v_del[1] AND user_id = v_fail_user
      AND notification_type = 'delivery_completed') <> 1
  THEN RAISE EXCEPTION 'Recipient duplication or retry gap'; END IF;

  -- Temporarily refuse registration on this local-only transaction. The real save must still commit its work.
  ALTER TABLE public.delivery_completion_notice_events ADD CONSTRAINT completion_registration_smoke_fault CHECK (false) NOT VALID;
  SET LOCAL ROLE authenticated;
  v_res := public.complete_delivery(v_del[4], 'No proof — recorded by office', v_admin, NULL, NULL, NULL,
    v_prefix || 'registration-failure', NULL, 'no_proof', '[SMOKE] test delivery, no proof kept',
    p_record_completion_notice => true);
  RESET ROLE;
  IF v_res->>'status' IS DISTINCT FROM 'completed'
    OR EXISTS (SELECT FROM public.delivery_completion_notice_events e
      JOIN public.delivery_brand_events b ON b.seq=e.completion_seq WHERE b.delivery_id = v_del[4])
    OR NOT EXISTS (SELECT FROM public.invoices WHERE delivery_id = v_del[4])
    OR NOT EXISTS (SELECT FROM public.inventory WHERE product_id = v_product AND quantity_available = 96)
  THEN RAISE EXCEPTION 'Registration failure affected completion work: %', v_res; END IF;
  ALTER TABLE public.delivery_completion_notice_events DROP CONSTRAINT completion_registration_smoke_fault;


  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES (v_driver,v_driver || '@fixture.example.test', jsonb_build_object('full_name','Invented Completion Driver','role','driver'));
  UPDATE public.deliveries SET assigned_driver = v_driver, created_by = v_driver, status = 'in_progress' WHERE id = v_del[3];
  INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
  VALUES (v_order, v_product, 'Invented small quantity', 10, 6, 2, 20, 8, 40, 0, 2) RETURNING id INTO v_oi;
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES (v_del[3], v_oi, v_product, 2, 0, 'Gal') RETURNING id INTO v_tiny_line;
  v_driver_key := v_prefix || 'driver-partial';
  v_signature := 'signatures/' || v_del[3] || '/' || left(encode(sha256(convert_to(v_driver_key,'UTF8')),'hex'),32) || '.png';
  INSERT INTO storage.objects (bucket_id,name,owner_id,metadata)
    VALUES ('delivery-signatures',v_signature,v_driver::text,'{"size":1000,"mimetype":"image/png"}');
  SELECT jsonb_object_agg(di.id::text, CASE WHEN di.id = v_tiny_line THEN 0.004 ELSE di.quantity END),
    jsonb_agg(jsonb_build_object('order_item_id', di.order_item_id, 'product_id', di.product_id,
      'quantity', di.quantity, 'delivered', CASE WHEN di.id = v_tiny_line THEN 0.004 ELSE di.quantity END))
  INTO v_amounts, v_lines FROM public.delivery_items AS di WHERE di.delivery_id = v_del[3];

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  SET LOCAL ROLE authenticated;
  v_res := public.complete_delivery(v_del[3], 'Invented signed delivery', v_driver, v_amounts, NULL, NULL,
    v_driver_key, NULL, 'signature', v_signature, p_lines_seen => v_lines, p_record_completion_notice => true);
  v_notice := public.notify_saved_delivery_completion(v_del[3], v_driver_key, v_prefix || 'driver-notice');
  RESET ROLE;
  IF v_res->>'status' IS DISTINCT FROM 'partial' OR v_notice <> '{"status":"sent"}'::jsonb
    OR (SELECT quantity_delivered FROM public.delivery_items WHERE id = v_tiny_line) IS DISTINCT FROM 0::numeric
    OR (SELECT count(*) FROM public.notifications WHERE related_entity_id = v_del[3] AND user_id = v_driver
      AND created_by = v_driver AND notification_type IN ('delivery_completed','delivery_remainder')) <> 2
    OR EXISTS (SELECT FROM public.notifications WHERE related_entity_id = v_del[3] AND user_id <> v_driver
      AND notification_type IN ('delivery_completed','delivery_remainder'))
    OR NOT EXISTS (SELECT FROM public.notifications WHERE related_entity_id = v_del[3] AND user_id = v_driver
      AND notification_type = 'delivery_remainder' AND message LIKE '%: 0.004/2')
  THEN RAISE EXCEPTION 'Driver legacy recipients or tiny display changed: %, %', v_res, v_notice; END IF;



  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    (v_rep,v_rep || '@fixture.example.test',jsonb_build_object('full_name','Invented Completion Sales Rep','role','sales_rep')),
    (v_other_rep,v_other_rep || '@fixture.example.test',jsonb_build_object('full_name','Invented Other Sales Rep','role','sales_rep'));
  INSERT INTO public.commissions (order_id,customer_id,recipient,recipient_user_id,order_date) VALUES
    (v_order,v_customer,upper(v_rep::text),v_rep,v_today),
    (v_order,v_customer,v_other_rep::text,v_other_rep,v_today);
  v_rep_key := v_prefix || 'sales-rep-list';
  v_signature := 'signatures/' || v_del[2] || '/' ||
    left(encode(sha256(convert_to(v_rep_key || ':complete','UTF8')),'hex'),32) || '.png';
  INSERT INTO storage.objects (bucket_id,name,owner_id,metadata)
    VALUES ('delivery-signatures',v_signature,v_rep::text,'{"size":1000,"mimetype":"image/png"}');
  SELECT jsonb_agg(jsonb_build_object('order_item_id', di.order_item_id, 'product_id', di.product_id,
    'quantity', di.quantity, 'delivered', di.quantity))
  INTO v_lines FROM public.delivery_items AS di WHERE di.delivery_id = v_del[2];

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  SET LOCAL ROLE authenticated;
  v_res := public.start_and_complete_delivery(v_del[2], 'Invented signed sale', v_today, v_rep, NULL, NULL, NULL,
    v_rep_key, 'signature', v_signature, p_lines_seen => v_lines, p_record_completion_notice => true);
  v_notice := public.notify_saved_delivery_completion(v_del[2], v_rep_key, v_prefix || 'sales-rep-notice');
  RESET ROLE;
  IF v_res->>'status' IS DISTINCT FROM 'completed' OR v_notice <> '{"status":"sent"}'::jsonb
    OR NOT EXISTS (SELECT FROM public.notifications WHERE related_entity_id = v_del[2] AND user_id = v_rep
      AND created_by = v_rep AND notification_type = 'delivery_completed' AND message LIKE 'Your customer %')
    OR NOT EXISTS (SELECT FROM public.notifications WHERE related_entity_id = v_del[2] AND user_id = v_admin
      AND created_by = v_rep AND notification_type = 'delivery_completed')
    OR EXISTS (SELECT FROM public.notifications WHERE related_entity_id = v_del[2]
      AND (user_id = v_other_rep OR notification_type = 'delivery_remainder'))
  THEN RAISE EXCEPTION 'Sales rep audience, legacy commission lookup or list scope changed: %, %', v_res, v_notice; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_other_rep::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.notify_saved_delivery_completion(v_del[2], v_rep_key, v_prefix || 'other-rep-notice');
    RAISE EXCEPTION 'A different sales rep reused the notice receipt';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'DELIVERY_COMPLETION_NOTICE_RECEIPT_REQUIRED' THEN RAISE; END IF;
  END;
  RESET ROLE;




END;
$smoke$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
SELECT 'LOCAL_DELIVERY_COMPLETION_MIGRATION_FIRST_CASES_PASS';
