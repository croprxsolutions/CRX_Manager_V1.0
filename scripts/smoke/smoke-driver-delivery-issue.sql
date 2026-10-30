-- CONTAINER ONLY. Synthetic full completion chain; never run on production.
-- Force deferred triggers after the public RPC returns, including under the driver's
-- authenticated role, so a test inside the completion's definer context cannot mask RLS errors.
DO $smoke$
DECLARE
  v_admin uuid := gen_random_uuid();
  v_inactive uuid := gen_random_uuid();
  v_driver uuid := gen_random_uuid();
  v_customer uuid;
  v_product uuid;
  v_order uuid;
  v_oi uuid;
  v_di uuid;
  v_d uuid;
  v_key text;
  v_path text;
  v_pricing jsonb;
  v_result jsonb;
  v_again jsonb;
  v_message text;
  v_stock numeric;
  v_count int;
  v_i int;
  v_notes text;
  v_issue_type text;
  v_issue_label text;
  v_delivered numeric;
  v_failed boolean;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    (v_admin,v_admin || '@example.invalid',jsonb_build_object('full_name','[SMOKE] Office ' || v_admin,'role','admin')),
    (v_inactive,v_inactive || '@example.invalid',jsonb_build_object('full_name','[SMOKE] Inactive Office ' || v_inactive,'role','admin')),
    (v_driver,v_driver || '@example.invalid',jsonb_build_object('full_name','[SMOKE] Driver ' || v_driver,'role','driver'));
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  UPDATE public.profiles SET is_active=false WHERE id=v_inactive;
  INSERT INTO public.customers(farm_name) VALUES ('[SMOKE] Driver report farm') RETURNING id INTO v_customer;
  INSERT INTO public.products(product_name,unit_size,product_form)
    VALUES ('[SMOKE] Atrazine <img src=x onerror=alert(1)>','GL','liquid') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes('product_page',NULL,
    jsonb_build_array(jsonb_build_object('product_id',v_product,'row_version',1,'pricing_mode','price_driven',
    'new_cost','6.00','tier1_price','10.00','tier2_price','10.00','tier3_price','10.00')),v_admin,v_admin || ':preview');
  PERFORM public.apply_product_pricing_change_set((v_pricing->>'change_set_id')::uuid,v_pricing->>'request_fingerprint',v_admin,v_admin || ':apply');
  INSERT INTO public.inventory(product_id,location,quantity_available,quantity_prebooked,unit_size)
    VALUES(v_product,'Main Warehouse',100,0,'GL');

  FOR v_i IN 1..11 LOOP
    PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
    INSERT INTO public.orders(order_number,customer_id,status,booking_draw)
      VALUES ('[SMOKE] REPORT-' || gen_random_uuid(),v_customer,'confirmed',false) RETURNING id INTO v_order;
    INSERT INTO public.order_items(order_id,product_id,product_name,price_per_unit,cost_per_unit,
      total_units_needed,total_price,profit,net_margin,quantity_delivered,quantity_remaining)
      VALUES(v_order,v_product,'[SMOKE] Atrazine',10,6,5,50,20,40,0,5) RETURNING id INTO v_oi;
    INSERT INTO public.deliveries(delivery_number,order_id,customer_id,assigned_driver,scheduled_date,status,created_by)
      VALUES('[SMOKE] REPORT-DEL-' || gen_random_uuid(),v_order,v_customer,v_driver,CURRENT_DATE,'scheduled',v_admin) RETURNING id INTO v_d;
    INSERT INTO public.delivery_items(delivery_id,order_item_id,product_id,quantity,quantity_delivered,unit_size)
      VALUES(v_d,v_oi,v_product,5,0,CASE WHEN v_i=3 THEN NULL ELSE 'GL' END) RETURNING id INTO v_di;
    UPDATE public.deliveries SET status='in_progress' WHERE id=v_d;
    v_key := v_d || ':complete';
    v_path := 'signatures/' || v_d || '/' || left(encode(sha256(convert_to(v_key,'UTF8')),'hex'),32) || '.png';
    INSERT INTO storage.objects(bucket_id,name,owner_id,metadata)
      VALUES('delivery-signatures',v_path,v_driver::text,'{"size":1000,"mimetype":"image/png"}');
    v_notes := CASE v_i WHEN 1 THEN 'Shortage: only 3 GL on truck.'
      WHEN 2 THEN E'Damage: Atrazine container leaking.\n<img src=x onerror=alert(1)>'
      WHEN 3 THEN '   ' WHEN 5 THEN 'Damage: cap broken; office please review.'
      WHEN 11 THEN '  ' || repeat('Long explanation ',150) || ' END  ' ELSE NULL END;
    v_delivered := CASE WHEN v_i=1 THEN 3 ELSE 5 END;
    v_issue_type := CASE WHEN v_i=4 THEN NULL WHEN v_i<=5 THEN 'other'
      ELSE (ARRAY['customer_not_home','gate_locked','road_blocked','wrong_address','refused','weather'])[v_i-5] END;
    v_issue_label := CASE WHEN v_i<=5 THEN 'Other'
      ELSE (ARRAY['Customer Not Home','Gate Locked','Road Blocked','Wrong Address','Refused','Weather'])[v_i-5] END;
    SELECT quantity_available INTO v_stock FROM public.inventory WHERE product_id=v_product AND location='Main Warehouse';
    IF v_i=5 THEN
      -- Local fault injection: the notice must not be silently lost on insert failure.
      EXECUTE format('ALTER TABLE public.notifications ADD CONSTRAINT smoke_reject_driver_notice CHECK (related_entity_id IS DISTINCT FROM %L::uuid OR notification_type <> ''delivery_issue_reported'')',v_d);
    END IF;
    PERFORM set_config('request.jwt.claim.sub',v_driver::text,true);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_driver,'role','authenticated')::text,true);
    SET LOCAL ROLE authenticated;
    IF v_i=5 THEN
      v_failed := false;
      BEGIN
        v_result := public.complete_delivery(v_d,'[SMOKE] Signer',v_driver,jsonb_build_object(v_di::text,v_delivered),
          'other',v_notes,v_key,NULL,'signature',v_path);
        SET CONSTRAINTS ALL IMMEDIATE;
      EXCEPTION WHEN check_violation THEN
        IF SQLERRM NOT LIKE '%smoke_reject_driver_notice%' THEN RAISE; END IF;
        v_failed := true;
      END;
      RESET ROLE;
      IF NOT v_failed THEN RAISE EXCEPTION 'SMOKE_FAIL: notification failure was swallowed'; END IF;
      IF (SELECT status FROM public.deliveries WHERE id=v_d) <> 'in_progress'
        OR (SELECT quantity_available FROM public.inventory WHERE product_id=v_product AND location='Main Warehouse') <> v_stock
        OR EXISTS(SELECT 1 FROM public.invoices WHERE delivery_id=v_d)
        OR EXISTS(SELECT 1 FROM public.notifications WHERE related_entity_id=v_d) THEN
        RAISE EXCEPTION 'SMOKE_FAIL: failure changed completion, stock, invoice or notice';
      END IF;
      ALTER TABLE public.notifications DROP CONSTRAINT smoke_reject_driver_notice;
      SET LOCAL ROLE authenticated;
    END IF;
    SET CONSTRAINTS ALL DEFERRED;
    v_result := public.complete_delivery(v_d,'[SMOKE] Signer',v_driver,jsonb_build_object(v_di::text,v_delivered),
      v_issue_type,v_notes,v_key,NULL,'signature',v_path);
    SET CONSTRAINTS ALL IMMEDIATE;
    -- The committed-result retry takes the same key and returns the same receipt.
    v_again := public.complete_delivery(v_d,'[SMOKE] Signer',v_driver,jsonb_build_object(v_di::text,v_delivered),
      v_issue_type,v_notes,v_key,NULL,'signature',v_path);
    SET CONSTRAINTS ALL IMMEDIATE;
    IF v_again IS DISTINCT FROM v_result THEN RAISE EXCEPTION 'SMOKE_FAIL: replay changed result'; END IF;
    RESET ROLE;
    IF (SELECT quantity_available FROM public.inventory WHERE product_id=v_product AND location='Main Warehouse') <> v_stock-v_delivered
      THEN RAISE EXCEPTION 'SMOKE_FAIL: replay or retry changed stock twice'; END IF;
    SELECT count(*),min(message) INTO v_count,v_message FROM public.notifications
      WHERE related_entity_id=v_d AND notification_type='delivery_issue_reported' AND user_id=v_admin;
    IF v_i=4 THEN
      IF v_count<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: no-issue completion created report'; END IF;
      CONTINUE;
    END IF;
    IF v_count<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: shortage notice missing or duplicated (%)',v_count; END IF;
    IF v_i=11 AND position(E'\nDriver explanation: ' || left(btrim(v_notes),2000) || E'\nDelivery lines (' in v_message)=0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: explanation must be trimmed to exactly 2000 characters';
    END IF;
    IF v_i=1 AND (v_message NOT LIKE '%planned 5; delivered 3; units GL; short 2%') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: shortage quantities: %',v_message;
    END IF;
    IF v_message NOT LIKE '%Order [SMOKE] REPORT-%' OR position('Reported issue: ' || v_issue_label in v_message)=0
      OR v_message NOT LIKE '%[SMOKE] Atrazine <img src=x onerror=alert(1)>%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: report identity or recorded type missing';
    END IF;
    IF v_i IN (1,2,5) AND position(v_notes in v_message)=0 THEN RAISE EXCEPTION 'SMOKE_FAIL: driver explanation lost'; END IF;
    IF v_i=3 AND (v_message NOT LIKE '%Driver explanation: Not provided%' OR v_message NOT LIKE '%units not recorded%') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: missing optional details invented or hidden';
    END IF;
    IF EXISTS(SELECT 1 FROM public.notifications WHERE related_entity_id=v_d AND notification_type='delivery_issue_reported'
      AND (user_id=v_inactive OR user_id=v_driver OR created_by IS DISTINCT FROM v_driver)) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: notice audience or sender changed';
    END IF;
    SET LOCAL ROLE authenticated;
    IF EXISTS(SELECT 1 FROM public.notifications WHERE related_entity_id=v_d AND notification_type='delivery_issue_reported') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: driver could read office notice';
    END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
    SET LOCAL ROLE authenticated;
    IF (SELECT count(*) FROM public.notifications WHERE related_entity_id=v_d AND notification_type='delivery_issue_reported') <> 1 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: office could not read its report';
    END IF;
    RESET ROLE;
  END LOOP;
  IF has_function_privilege('anon','public._notify_driver_delivery_issue()','EXECUTE')
    OR has_function_privilege('authenticated','public._notify_driver_delivery_issue()','EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: trigger is directly executable';
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
