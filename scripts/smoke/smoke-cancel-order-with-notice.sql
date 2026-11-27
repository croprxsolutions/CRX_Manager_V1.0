-- Container only. Use invented fixtures and restore original state by rollback.
BEGIN;
CREATE FUNCTION pg_temp.cancel_notice_injected_timeout()
RETURNS trigger LANGUAGE plpgsql AS $timeout$
BEGIN
  RAISE EXCEPTION 'Synthetic cancellation notice timeout' USING ERRCODE = '57014';
END;
$timeout$;

DO $proof$
DECLARE
  admin_id uuid := gen_random_uuid();
  admin_two uuid := gen_random_uuid();
  rep_id uuid := gen_random_uuid();
  inactive_admin uuid := gen_random_uuid();
  farm_id uuid;
  unnamed_farm uuid;
  fresh_order uuid;
  legacy_order uuid;
  nested_order uuid;
  failed_notice_order uuid;
  failed_receipt_order uuid;
  canceled_query_order uuid;
  remaining_order uuid := gen_random_uuid();
  product_id uuid := gen_random_uuid();
  order_item_id uuid := gen_random_uuid();
  delivery_id uuid := gen_random_uuid();
  base_key text := gen_random_uuid()::text;
  active_admin_count int;
  outcome jsonb;
  retry jsonb;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id,email) VALUES
    (admin_id, admin_id || '@fixture.example.test'), (admin_two, admin_two || '@fixture.example.test'),
    (rep_id, rep_id || '@fixture.example.test'), (inactive_admin, inactive_admin || '@fixture.example.test');
  INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
    (admin_id,admin_id || '@fixture.example.test','Invented Wrapper Admin','admin',true),
    (admin_two,admin_two || '@fixture.example.test','Invented Next Admin','admin',true),
    (rep_id,rep_id || '@fixture.example.test','Invented Nonadmin','sales_rep',true),
    (inactive_admin,inactive_admin || '@fixture.example.test','Invented Inactive Admin','admin',false);
  SET LOCAL session_replication_role = origin;
  SELECT count(*) INTO active_admin_count FROM public.profiles WHERE role = 'admin' AND is_active;
  INSERT INTO public.customers (farm_name) VALUES ('Invented Cancellation Farm') RETURNING id INTO farm_id;
  INSERT INTO public.customers (farm_name) VALUES ('') RETURNING id INTO unnamed_farm;
  INSERT INTO public.orders (order_number,customer_id,status) VALUES ('INVENTED-NEW-CANCEL',farm_id,'confirmed') RETURNING id INTO fresh_order;
  INSERT INTO public.orders (order_number,customer_id,status) VALUES ('INVENTED-OLD-CANCEL',farm_id,'confirmed') RETURNING id INTO legacy_order;
  INSERT INTO public.orders (order_number,customer_id,status) VALUES ('INVENTED-NESTED-CANCEL',unnamed_farm,'confirmed') RETURNING id INTO nested_order;
  INSERT INTO public.orders (order_number,customer_id,status) VALUES ('INVENTED-SEND-FAIL-CANCEL',farm_id,'confirmed') RETURNING id INTO failed_notice_order;
  INSERT INTO public.orders (order_number,customer_id,status) VALUES ('INVENTED-RECEIPT-FAIL-CANCEL',farm_id,'confirmed') RETURNING id INTO failed_receipt_order;
  INSERT INTO public.orders (order_number,customer_id,status) VALUES ('INVENTED-QUERY-TIMEOUT-CANCEL',farm_id,'confirmed') RETURNING id INTO canceled_query_order;

  SET LOCAL session_replication_role = replica;
  INSERT INTO public.products (id, product_name, unit_size, product_form, inventory_unit)
    VALUES (product_id, 'Invented Partial Order Product', 'Gal', 'liquid', 'Gal');
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
    VALUES (product_id, 'Main Warehouse', 10, 6, 0, 'Gal');
  INSERT INTO public.orders (id, order_number, customer_id, status)
    VALUES (remaining_order, 'INVENTED-CANCEL-REMAINDER', farm_id, 'partially_fulfilled');
  INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining)
    VALUES (order_item_id, remaining_order, product_id, 'Invented Partial Order Product', 'Gal', 10, 4, 6);
  INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, signed_by)
    VALUES (delivery_id, 'INVENTED-PARTIAL-DELIVERY', remaining_order, farm_id, admin_id, 'completed', current_date, 'Invented Customer');
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (delivery_id, order_item_id, product_id, 10, 4, 'Gal');
  SET LOCAL session_replication_role = origin;

  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',rep_id,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',rep_id::text,true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.cancel_order_with_notice(fresh_order, NULL, base_key);
    RAISE EXCEPTION 'Expected refusal';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'INSUFFICIENT_ROLE' THEN RAISE; END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',inactive_admin,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',inactive_admin::text,true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.cancel_order_with_notice(fresh_order, NULL, base_key);
    RAISE EXCEPTION 'Expected inactive admin refusal';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'INSUFFICIENT_ROLE' THEN RAISE; END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.cancel_order_with_notice(fresh_order, admin_two, base_key);
    RAISE EXCEPTION 'Expected actor refusal';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ACTOR_MISMATCH' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.cancel_order_with_notice(fresh_order, NULL, '  ');
    RAISE EXCEPTION 'Expected blank key refusal';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' THEN RAISE; END IF;
  END;
  outcome := public.cancel_order_with_notice(fresh_order, NULL, base_key);
  retry := public.cancel_order_with_notice(fresh_order, NULL, base_key);
  IF outcome->'success' IS DISTINCT FROM 'true'::jsonb OR retry IS DISTINCT FROM outcome THEN
    RAISE EXCEPTION 'Fresh cancel or exact replay did not return the original result';
  END IF;
  outcome := public.cancel_order(legacy_order,admin_id,'local-legacy:' || base_key);
  IF outcome->'success' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Legacy cancellation failed'; END IF;
  outcome := public.cancel_order_with_notice(legacy_order, NULL, base_key || '-legacy');
  IF outcome ? 'success' THEN RAISE EXCEPTION 'Checked replay treated a legacy-cancelled order as fresh'; END IF;
  outcome := public.cancel_order_with_notice(remaining_order, NULL, base_key || '-partial');
  IF outcome->'success' IS DISTINCT FROM 'true'::jsonb OR outcome->>'mode' IS DISTINCT FROM 'remainder_closed'
     OR outcome->>'status' IS DISTINCT FROM 'fulfilled' THEN
    RAISE EXCEPTION 'The checked operation changed the remainder close result';
  END IF;

  -- The EXCEPTION block creates a real PostgreSQL subtransaction.
  BEGIN
    outcome := public.cancel_order_with_notice(nested_order, NULL, base_key || '-nested');
    IF outcome->'success' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Nested cancellation failed'; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE;
  END;
  RESET ROLE;

  EXECUTE format('ALTER TABLE public.notifications ADD CONSTRAINT local_cancel_injected_failure CHECK (related_entity_id <> %L) NOT VALID', failed_notice_order);
  SET LOCAL ROLE authenticated;
  outcome := public.cancel_order_with_notice(failed_notice_order, NULL, base_key || '-failure');
  retry := public.cancel_order_with_notice(failed_notice_order, NULL, base_key || '-failure');
  IF outcome->'success' IS DISTINCT FROM 'true'::jsonb OR retry IS DISTINCT FROM outcome THEN
    RAISE EXCEPTION 'Notification failure prevented restoring the successful cancellation outcome';
  END IF;
  RESET ROLE;

  EXECUTE format(
    'ALTER TABLE public.idempotency_keys ADD CONSTRAINT local_cancel_receipt_failure
     CHECK (operation <> %L OR result->''request''->>''order_id'' <> %L OR result->''response'' = ''null''::jsonb) NOT VALID',
    'cancel_order_with_notice', failed_receipt_order
  );
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.cancel_order_with_notice(failed_receipt_order, NULL, base_key || '-receipt-failure');
    RAISE EXCEPTION 'Expected binding a completed receipt to fail';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%local_cancel_receipt_failure%' THEN RAISE; END IF;
  END;
  RESET ROLE;
  IF (SELECT status FROM public.orders WHERE id = failed_receipt_order) IS DISTINCT FROM 'confirmed'
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE result->'request'->>'order_id' = failed_receipt_order::text)
     OR EXISTS (SELECT 1 FROM public.notifications WHERE related_entity_id = failed_receipt_order)
  THEN RAISE EXCEPTION 'Failure to bind a receipt left a cancellation, receipt or notice'; END IF;

  EXECUTE format(
    'CREATE TRIGGER local_cancel_notice_timeout BEFORE INSERT ON public.notifications FOR EACH ROW
     WHEN (NEW.related_entity_id = %L) EXECUTE FUNCTION pg_temp.cancel_notice_injected_timeout()',
    canceled_query_order
  );
  SET LOCAL ROLE authenticated;
  outcome := public.cancel_order_with_notice(canceled_query_order, NULL, base_key || '-query-canceled');
  retry := public.cancel_order_with_notice(canceled_query_order, NULL, base_key || '-query-canceled');
  IF outcome->'success' IS DISTINCT FROM 'true'::jsonb OR retry IS DISTINCT FROM outcome THEN
    RAISE EXCEPTION 'A cancelled notification query lost the cancellation outcome';
  END IF;
  RESET ROLE;
  IF (SELECT status FROM public.orders WHERE id = canceled_query_order) IS DISTINCT FROM 'cancelled'
     OR EXISTS (SELECT 1 FROM public.notifications WHERE related_entity_id = canceled_query_order)
     OR NOT EXISTS (SELECT 1 FROM public.failed_notifications WHERE entity_id = canceled_query_order
       AND error_message LIKE '%SQLSTATE 57014%')
  THEN RAISE EXCEPTION 'A cancelled notification query lost the order or its failure result'; END IF;

  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',admin_two,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',admin_two::text,true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.cancel_order_with_notice(fresh_order, NULL, base_key);
    RAISE EXCEPTION 'Expected a refusal for another admin using the same key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_REQUEST_MISMATCH:%' THEN RAISE; END IF;
  END;
  retry := public.cancel_order_with_notice(fresh_order, NULL, base_key || '-second-admin');
  IF retry ? 'success' THEN RAISE EXCEPTION 'Second admin was treated as a fresh cancellation'; END IF;
  RESET ROLE;

  UPDATE public.idempotency_keys SET expires_at = now() - interval '1 second'
    WHERE operation = 'cancel_order_with_notice' AND idempotency_key = 'cancel_order_with_notice:' || base_key;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
  SET LOCAL ROLE authenticated;
  retry := public.cancel_order_with_notice(fresh_order, NULL, base_key);
  IF retry ? 'success' THEN RAISE EXCEPTION 'Expired receipt was treated as a fresh cancellation'; END IF;
  RESET ROLE;

  IF (SELECT count(*) FROM public.notifications WHERE related_entity_id = fresh_order AND created_by = admin_id AND notification_type = 'order_status') <> active_admin_count
     OR (SELECT count(*) FROM public.notifications WHERE related_entity_id = nested_order AND created_by = admin_id AND notification_type = 'order_status') <> active_admin_count
     OR (SELECT count(DISTINCT user_id) FROM public.notifications WHERE related_entity_id = fresh_order AND created_by = admin_id AND notification_type = 'order_status') <> active_admin_count
     OR (SELECT count(DISTINCT user_id) FROM public.notifications WHERE related_entity_id = nested_order AND created_by = admin_id AND notification_type = 'order_status') <> active_admin_count
     OR EXISTS (SELECT 1 FROM public.notifications WHERE related_entity_id IN (legacy_order, failed_notice_order, remaining_order) AND notification_type = 'order_status')
     OR EXISTS (SELECT 1 FROM public.notifications WHERE related_entity_id IN (fresh_order, nested_order)
                    AND user_id IN (inactive_admin, rep_id) AND notification_type = 'order_status')
     OR (SELECT count(*) FROM public.failed_notifications WHERE entity_id = failed_notice_order AND notification_type = 'order_status') <> 1
  THEN RAISE EXCEPTION 'Unexpected notification or failure recipients and count'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.notifications WHERE related_entity_id = fresh_order AND related_entity_type = 'order'
      AND user_id = admin_id AND title = 'Order cancelled'
      AND message = 'Order INVENTED-NEW-CANCEL for Invented Cancellation Farm is now cancelled'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.notifications WHERE related_entity_id = nested_order AND related_entity_type = 'order'
      AND user_id = admin_id AND title = 'Order cancelled'
      AND message = 'Order INVENTED-NESTED-CANCEL for customer is now cancelled'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.failed_notifications WHERE entity_id = failed_notice_order AND entity_type = 'order'
      AND error_message LIKE '%SQLSTATE 23514%' AND payload->>'sender' = admin_id::text
  ) THEN RAISE EXCEPTION 'Unexpected cancellation notice text, destination or failure details'; END IF;

  IF (SELECT count(*) FROM public.orders WHERE id IN (fresh_order,legacy_order,nested_order,failed_notice_order) AND status = 'cancelled') <> 4 THEN
    RAISE EXCEPTION 'A synthetic cancellation did not reach its expected stored status';
  END IF;
END;
$proof$;
ROLLBACK;
SELECT 'SMOKE_PASS_ROLLBACK';
