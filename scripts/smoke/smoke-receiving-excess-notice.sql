-- Local Docker only. All purchase records and user fixtures are invented.
SET ROLE postgres;
BEGIN;
DO $proof$
DECLARE
  v_admin uuid;
  v_rep uuid := gen_random_uuid();
  v_driver uuid := gen_random_uuid();
  v_product uuid;
  v_po uuid;
  v_line uuid;
  v_admin_count bigint;
  v_key text := gen_random_uuid()::text;
  v_old_key text := gen_random_uuid()::text;
  v_batch jsonb;
  v_one jsonb;
  v_result jsonb;
  v_repeat jsonb;
  v_excess_record uuid;
BEGIN
  SELECT id INTO STRICT v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1;
  SELECT count(*) INTO v_admin_count FROM public.profiles WHERE role = 'admin' AND is_active;
  IF has_function_privilege('anon', 'public.receive_po_items_with_excess_notice(jsonb,uuid,text,boolean)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.receive_po_items_with_excess_notice(jsonb,uuid,text,boolean)', 'EXECUTE')
  THEN RAISE EXCEPTION 'Anonymous receiving notice access was granted'; END IF;

  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email) VALUES (v_rep, v_rep || '@fixture.example.test'), (v_driver, v_driver || '@fixture.example.test');
  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES (v_rep, v_rep || '@fixture.example.test', 'Invented Receipt Rep', 'sales_rep', true),
    (v_driver, v_driver || '@fixture.example.test', 'Invented Receipt Driver', 'driver', true);
  SET LOCAL session_replication_role = origin;
  INSERT INTO public.products (product_name, category, product_form, inventory_unit)
  VALUES ('Invented Excess Notice Product', 'Herbicide', 'liquid', 'Gal') RETURNING id INTO v_product;
  INSERT INTO public.purchase_orders (po_number, vendor, status, created_by)
  VALUES ('INVENTED-EXCESS-NOTICE', 'Invented Vendor', 'submitted', v_admin) RETURNING id INTO v_po;
  INSERT INTO public.purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size)
  VALUES (v_po, v_product, 10, 0, 1.00, 'gal') RETURNING id INTO v_line;

  v_one := jsonb_build_array(jsonb_build_object('po_item_id', v_line, 'quantity', 1, 'over_receive_reason', 'Invented excess'));
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.receive_po_items_with_excess_notice(v_one, p_idempotency_key => gen_random_uuid()::text);
    RAISE EXCEPTION 'The unsigned user could receive';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Not authenticated' THEN RAISE; END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',v_driver,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.receive_po_items_with_excess_notice(v_one, v_driver, gen_random_uuid()::text);
    RAISE EXCEPTION 'The driver could receive';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Only admin or sales_rep can receive PO items' THEN RAISE; END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',v_rep,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.receive_po_items_with_excess_notice(v_one, v_admin, gen_random_uuid()::text);
    RAISE EXCEPTION 'The rep could receive as the admin';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH:%' THEN RAISE; END IF;
  END;
  PERFORM public.receive_po_items_with_excess_notice(jsonb_build_array(jsonb_build_object(
    'po_item_id', v_line, 'quantity', 2)), v_rep, gen_random_uuid()::text);
  BEGIN
    PERFORM public.receive_po_items_with_excess_notice(jsonb_build_array(jsonb_build_object(
      'po_item_id', v_line, 'quantity', 9, 'over_receive_reason', 'Invented excess')), v_rep, gen_random_uuid()::text, true);
    RAISE EXCEPTION 'The sales rep could over-receive';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'OVER_RECEIVE_ADMIN_REQUIRED' THEN RAISE; END IF;
  END;
  RESET ROLE;
  IF (SELECT quantity_received FROM public.purchase_order_items WHERE id = v_line) <> 2
    OR EXISTS (SELECT FROM public.notifications WHERE related_entity_id = v_po AND notification_type = 'over_receive')
  THEN RAISE EXCEPTION 'Ordinary or denied receiving changed the excess-notice state'; END IF;

  v_batch := jsonb_build_array(
    jsonb_build_object('po_item_id', v_line, 'quantity', 7),
    jsonb_build_object('po_item_id', v_line, 'quantity', 2, 'over_receive_reason', 'Invented excess'));
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',v_admin,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SET LOCAL ROLE authenticated;
  v_result := public.receive_po_items_with_excess_notice(v_batch, v_admin, v_key, true);
  IF v_result IS DISTINCT FROM public.receive_po_items(v_batch, v_admin, v_key, true) THEN
    RAISE EXCEPTION 'Old caller could not replay a new receipt';
  END IF;
  IF v_result IS DISTINCT FROM public.receive_po_items_with_excess_notice(v_batch, v_admin, v_key, true) THEN
    RAISE EXCEPTION 'New caller could not replay its receipt';
  END IF;
  v_excess_record := (v_result -> 'receiving_record_ids' ->> 1)::uuid;
  v_repeat := public.receive_po_items(v_one, v_admin, v_old_key, true);
  IF v_repeat IS DISTINCT FROM public.receive_po_items_with_excess_notice(v_one, v_admin, v_old_key, true) THEN
    RAISE EXCEPTION 'New caller could not replay an old receipt';
  END IF;
  RESET ROLE;
  IF (SELECT quantity_received FROM public.purchase_order_items WHERE id = v_line) <> 12
    OR (SELECT quantity_available FROM public.inventory WHERE product_id = v_product AND location = 'Main Warehouse') <> 12
    OR (SELECT count(*) FROM public.notifications WHERE related_entity_id = v_po AND notification_type = 'over_receive') <> v_admin_count
    OR EXISTS (SELECT FROM public.notifications n LEFT JOIN public.profiles p ON p.id = n.user_id
      WHERE n.related_entity_id = v_po AND n.notification_type = 'over_receive'
        AND (n.created_by IS DISTINCT FROM v_admin OR p.role IS DISTINCT FROM 'admin' OR p.is_active IS DISTINCT FROM true
          OR n.message NOT LIKE '%previously received 9%, received 2%, ordered 10%' OR n.message LIKE '%received 7%'))
  THEN RAISE EXCEPTION 'Saved notice, receipt quantities or replay changed'; END IF;

  ALTER TABLE public.notifications ADD CONSTRAINT local_excess_notice_refused CHECK (notification_type <> 'over_receive') NOT VALID;
  SET LOCAL ROLE authenticated;
  PERFORM public.receive_po_items_with_excess_notice(v_one, v_admin, gen_random_uuid()::text, true);
  RESET ROLE;
  ALTER TABLE public.notifications DROP CONSTRAINT local_excess_notice_refused;
  IF (SELECT quantity_received FROM public.purchase_order_items WHERE id = v_line) <> 13
    OR (SELECT count(*) FROM public.failed_notifications WHERE entity_id = v_po AND notification_type = 'over_receive') <> 1
  THEN RAISE EXCEPTION 'A failed excess notice changed the saved receipt or lost its error record'; END IF;

  SET LOCAL ROLE authenticated;
  PERFORM public.reverse_receiving_record(v_excess_record, 'Invented receipt correction', v_admin, gen_random_uuid()::text);
  RESET ROLE;
  IF (SELECT quantity_received FROM public.purchase_order_items WHERE id = v_line) <> 11
    OR (SELECT count(*) FROM public.notifications WHERE related_entity_id = v_po AND notification_type = 'over_receive') <> v_admin_count
  THEN RAISE EXCEPTION 'Reversal changed the expected receipt or notice history'; END IF;
END
$proof$;
ROLLBACK;
SELECT 'RECEIVING_EXCESS_NOTICE_PROOF_PASS';
