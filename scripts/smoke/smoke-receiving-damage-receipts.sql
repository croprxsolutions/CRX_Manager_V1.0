-- Container only. Every role and receiving record in this test belongs to the local walkthrough.
SET ROLE postgres;
BEGIN;
DO $proof$
DECLARE
  admin uuid;
  rep uuid := gen_random_uuid();
  driver uuid := gen_random_uuid();
  product uuid;
  po_a uuid;
  po_b uuid;
  line_a uuid;
  line_b uuid;
  receipt jsonb;
  receive_key text := gen_random_uuid()::text;
  notice_key text;
  fallback_key text;
  count_admins bigint;
  items jsonb;
  reversed uuid;
BEGIN
  SELECT id INTO STRICT admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1;
  SELECT count(*) INTO count_admins FROM public.profiles WHERE role = 'admin' AND is_active;
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id,email) VALUES (rep,rep || '@fixture.example.test'),(driver,driver || '@fixture.example.test');
  INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
    (rep,rep || '@fixture.example.test','Invented Receiver','sales_rep',true),
    (driver,driver || '@fixture.example.test','Invented Driver','driver',true);
  SET LOCAL session_replication_role = origin;
  INSERT INTO public.products (product_name,category,product_form,inventory_unit)
    VALUES ('Invented Receipt Chemical','Herbicide','liquid','Gal') RETURNING id INTO product;
  INSERT INTO public.purchase_orders (po_number,vendor,status,created_by)
    VALUES ('INVENTED-DAMAGE-A','Invented Vendor','submitted',admin) RETURNING id INTO po_a;
  INSERT INTO public.purchase_orders (po_number,vendor,status,created_by)
    VALUES ('INVENTED-DAMAGE-B','Invented Vendor','submitted',admin) RETURNING id INTO po_b;
  INSERT INTO public.purchase_order_items (purchase_order_id,product_id,quantity_ordered,quantity_received,unit_cost,unit_size)
    VALUES (po_a,product,10,0,1.00,'gal') RETURNING id INTO line_a;
  INSERT INTO public.purchase_order_items (purchase_order_id,product_id,quantity_ordered,quantity_received,unit_cost,unit_size)
    VALUES (po_b,product,10,0,1.00,'gal') RETURNING id INTO line_b;
  items := jsonb_build_array(jsonb_build_object('po_item_id',line_a,'quantity',2,'condition','damaged'),
    jsonb_build_object('po_item_id',line_b,'quantity',3,'condition','wrong_product'));

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',rep,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', rep::text, true);
  SET LOCAL ROLE authenticated;
  receipt := public.receive_po_items(items, rep, receive_key, false);
  SELECT 'damaged-receiving:' || po_a || ':' || encode(extensions.digest(convert_to(
    '[' || string_agg(to_json(id)::text, ',' ORDER BY id COLLATE "C") || ']', 'UTF8'), 'sha256'), 'hex')
  INTO notice_key FROM jsonb_array_elements_text(receipt -> 'receiving_record_ids') AS ids(id);
  fallback_key := 'damaged-receiving:' || po_b || ':' || encode(extensions.digest(convert_to(
    '[' || to_json(receive_key)::text || ']', 'UTF8'), 'sha256'), 'hex');
  PERFORM public.notify_damaged_receiving('Old label','Old summary',po_a,notice_key);
  PERFORM public.notify_damaged_receiving('Old label','Old summary',po_a,notice_key);
  PERFORM public.notify_damaged_receiving('Other allocation','Other summary',po_b,fallback_key);
  INSERT INTO public.notifications (user_id,title,message,notification_type)
    VALUES (rep,'Local general notice','Local policy proof','general');
  RESET ROLE;

  IF (SELECT count(*) FROM public.notifications WHERE related_entity_id IN (po_a,po_b)
      AND notification_type = 'po_damaged_received') <> count_admins
    OR (SELECT count(*) FROM public.notifications n JOIN public.profiles p ON p.id = n.user_id
      WHERE n.related_entity_id = po_a AND n.notification_type = 'po_damaged_received'
        AND n.created_by IS NULL AND p.role = 'admin' AND p.is_active
        AND n.message LIKE '%INVENTED-DAMAGE-A%2%dama%INVENTED-DAMAGE-B%3%wrong_product%') <> count_admins
  THEN RAISE EXCEPTION 'Saved multi-order damage notice, recipients or replay changed'; END IF;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',driver,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', driver::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.notify_damaged_receiving('Old label','Old summary',po_a,notice_key);
    RAISE EXCEPTION 'Driver could request a receiving damage notice';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'INSUFFICIENT_ROLE' THEN RAISE; END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',admin,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', admin::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.notify_damaged_receiving('Other allocation','Other summary',po_b,fallback_key);
    RAISE EXCEPTION 'An office user could request another receiver''s notice';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'RECEIVING_DAMAGE_RECEIPT_REQUIRED' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.notifications (user_id,title,message,notification_type)
      VALUES (admin,'Local policy test','Local policy test','po_damaged_received');
    RAISE EXCEPTION 'Table policy allowed a direct damage notice';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.notifications SET is_read = true WHERE user_id = admin AND related_entity_id = po_a;
  RESET ROLE;
  IF NOT EXISTS (SELECT FROM public.notifications WHERE user_id = admin AND related_entity_id = po_a AND is_read)
  THEN RAISE EXCEPTION 'Marking a saved damage notice read stopped working'; END IF;
  IF (SELECT quantity_available FROM public.inventory WHERE product_id = product AND location = 'Main Warehouse') <> 5
  THEN RAISE EXCEPTION 'Damage notices changed inventory'; END IF;

  receive_key := gen_random_uuid()::text;
  SET LOCAL ROLE authenticated;
  receipt := public.receive_po_items(items, admin, receive_key, false);
  reversed := (receipt -> 'receiving_record_ids' ->> 0)::uuid;
  PERFORM public.reverse_receiving_record(reversed, 'Invented receipt correction', admin, gen_random_uuid()::text);
  RESET ROLE;
  notice_key := 'damaged-receiving:' || po_a || ':' || encode(extensions.digest(convert_to(
    '[' || to_json(receive_key)::text || ']', 'UTF8'), 'sha256'), 'hex');

  ALTER TABLE public.notifications ADD CONSTRAINT local_damage_notice_refused
    CHECK (notification_type <> 'po_damaged_received') NOT VALID;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.notify_damaged_receiving('Old label','Old summary',po_a,notice_key);
    RAISE EXCEPTION 'The simulated notification failure was not observed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RESET ROLE;
  ALTER TABLE public.notifications DROP CONSTRAINT local_damage_notice_refused;
  IF (SELECT count(*) FROM public.notifications WHERE related_entity_id IN (po_a,po_b)
      AND notification_type = 'po_damaged_received') <> count_admins
    OR (SELECT quantity_available FROM public.inventory WHERE product_id = product AND location = 'Main Warehouse') <> 8
    OR EXISTS (SELECT FROM public.idempotency_keys WHERE idempotency_key = notice_key AND operation = 'notify_damaged_receiving')
  THEN RAISE EXCEPTION 'The failed notice changed receipt or notice state'; END IF;

  SET LOCAL ROLE authenticated;
  PERFORM public.notify_damaged_receiving('Old label','Old summary',po_a,notice_key);
  RESET ROLE;
  IF (SELECT count(*) FROM public.notifications WHERE related_entity_id = po_b
      AND notification_type = 'po_damaged_received' AND message NOT LIKE '%INVENTED-DAMAGE-A%') <> count_admins
    OR (SELECT quantity_available FROM public.inventory WHERE product_id = product AND location = 'Main Warehouse') <> 8
  THEN RAISE EXCEPTION 'Notice retry included a reversed line or changed stock'; END IF;
END
$proof$;
ROLLBACK;
SELECT 'RECEIVING_DAMAGE_RECEIPTS_PROOF_PASS';
