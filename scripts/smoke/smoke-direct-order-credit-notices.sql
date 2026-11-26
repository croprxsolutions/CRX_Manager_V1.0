-- Invented-only local proof. Use the walkthrough prover, which refuses external targets.
BEGIN;
ALTER TABLE public.idempotency_keys ADD CONSTRAINT credit_probe_reject_marker
  CHECK (idempotency_key NOT LIKE '%-marker' OR NOT (result ? '_direct_order_credit_notice')) NOT VALID;
CREATE FUNCTION public._local_credit_proof_cancel_notice()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $cancel$
BEGIN
  IF current_setting('crx.local_credit_cancel', true) = 'on' THEN
    RAISE EXCEPTION 'Invented cancelled notice query' USING ERRCODE = '57014';
  END IF;
  RETURN NEW;
END;
$cancel$;
CREATE TRIGGER _local_credit_proof_cancel_notice BEFORE INSERT ON public.notifications
  FOR EACH ROW WHEN (NEW.notification_type = 'credit_limit_exceeded')
  EXECUTE FUNCTION public._local_credit_proof_cancel_notice();

CREATE FUNCTION public._local_credit_proof_cancel_marker()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $cancel_marker$
BEGIN
  RAISE EXCEPTION 'Invented cancelled marker query' USING ERRCODE = '57014';
END;
$cancel_marker$;
CREATE TRIGGER _local_credit_proof_cancel_marker BEFORE UPDATE ON public.idempotency_keys
  FOR EACH ROW WHEN (NEW.idempotency_key LIKE '%-marker-cancelled' AND NEW.result ? '_direct_order_credit_notice')
  EXECUTE FUNCTION public._local_credit_proof_cancel_marker();

DO $proof$
DECLARE
  admin_id uuid := gen_random_uuid();
  rep_id uuid := gen_random_uuid();
  farm_id uuid := gen_random_uuid();
  product_id uuid := gen_random_uuid();
  other_farm_id uuid := gen_random_uuid();
  invoice_id uuid;
  business_date date := (now() AT TIME ZONE 'America/Chicago')::date;
  base_key text := 'local-credit-' || gen_random_uuid();
  result jsonb;
  replay jsonb;
  items jsonb;
  receipt public.idempotency_keys%ROWTYPE;
BEGIN

  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email) VALUES (rep_id, rep_id || '@fixture.example.test'), (admin_id, admin_id || '@fixture.example.test');
  INSERT INTO public.profiles (id,email,full_name,role,is_active)
  VALUES (rep_id,rep_id || '@fixture.example.test','Invented Credit Rep','sales_rep',true), (admin_id,admin_id || '@fixture.example.test','Invented Credit Admin','admin',true);
  SET LOCAL session_replication_role = origin;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  INSERT INTO public.customers (id, farm_name, credit_limit_cents, assigned_tier, assigned_sales_rep)
  VALUES (farm_id,'Invented Credit Notice Farm',100000,1,rep_id);
  INSERT INTO public.invoices (invoice_number,customer_id,invoice_type,status,invoice_date,due_date,total_amount_cents,created_by,salesman_id)
  VALUES ('LOCAL-CREDIT-DRAFT',farm_id,'chemical_sale','draft',business_date,business_date+30,60001,rep_id,rep_id);
  INSERT INTO public.invoices (invoice_number,customer_id,invoice_type,status,invoice_date,due_date,total_amount_cents,created_by,salesman_id)
  VALUES ('LOCAL-CREDIT-BALANCE',farm_id,'chemical_sale','draft',business_date,business_date+30,100001,rep_id,rep_id) RETURNING id INTO invoice_id;
  INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit, is_active)
  VALUES (product_id,'Invented Credit Product','LOCAL-CREDIT-PRODUCT','liquid','Gal','Gal','Gal','Gal',true);
  result := public.preview_product_pricing_changes('product_page', NULL, jsonb_build_array(jsonb_build_object(
    'product_id', product_id, 'row_version', 1, 'pricing_mode', 'price_driven',
    'new_cost', '10.00', 'tier1_price', '30.00', 'tier2_price', '30.00', 'tier3_price', '30.00'
  )), admin_id, base_key || '-preview');
  IF result->>'status' IS DISTINCT FROM 'previewed' OR (result->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Governed product pricing preview did not allow fixture pricing';
  END IF;
  PERFORM public.apply_product_pricing_change_set((result->>'change_set_id')::uuid, result->>'request_fingerprint', admin_id, base_key || '-pricing');
  items := jsonb_build_array(jsonb_build_object('product_id', product_id, 'product_name', 'Invented Credit Product', 'quantity', 1, 'price_per_unit', 30, 'unit_size', 'Gal'));

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', rep_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', rep_id::text, true);
  SET LOCAL ROLE authenticated;
  result := public.customer_credit_exposure(farm_id);
  IF (result->>'exposure_cents')::bigint IS DISTINCT FROM 160002::bigint THEN
    RAISE EXCEPTION 'Credit exposure did not count the invented drafts';
  END IF;
  result := public.check_customer_credit_limit(farm_id);
  IF (result->>'exceeded')::boolean IS DISTINCT FROM false OR (result->>'outstanding_ar')::numeric IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'Post-save credit check counted a draft';
  END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  UPDATE public.invoices SET status = 'unposted' WHERE id = invoice_id;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', rep_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', rep_id::text, true);
  SET LOCAL ROLE authenticated;
  result := public.check_customer_credit_limit(farm_id);
  IF (result->>'exceeded')::boolean IS DISTINCT FROM true OR (result->>'outstanding_ar')::numeric IS DISTINCT FROM 1000.01::numeric THEN
    RAISE EXCEPTION 'Post-save credit check did not detect one cent over';
  END IF;
  result := public.create_direct_order(farm_id, business_date, 'Invented Credit Ordinary Order', NULL, items, rep_id, base_key, NULL);
  replay := public.create_direct_order(farm_id, business_date, 'Invented Credit Ordinary Order', NULL, items, rep_id, base_key, NULL);
  IF replay IS DISTINCT FROM result OR result->>'order_id' IS NULL THEN
    RAISE EXCEPTION 'Exact direct-order retry did not recover the committed outcome';
  END IF;
  RESET ROLE;

  IF NOT EXISTS (
    SELECT 1 FROM pg_locks
    WHERE locktype = 'advisory' AND mode = 'ExclusiveLock' AND granted
      AND pid = pg_backend_pid() AND objsubid = 1
      AND ((classid::bigint << 32) | objid::bigint) = hashtextextended('crx:idempotency:' || base_key, 0)
  ) THEN RAISE EXCEPTION 'Ordinary save did not retain the shared transaction lock'; END IF;

  replay := public.check_idempotency_intent(
    base_key, 'create_direct_order', rep_id,
    public._replay_fingerprint_20261015(jsonb_build_object(
      'actor_id', rep_id, 'customer_id', farm_id, 'order_date', business_date,
      'order_name', 'Invented Credit Ordinary Order', 'notes', NULL, 'items', items,
      'customer_po_number', NULL
    ))
  );
  IF replay -> 'result' IS DISTINCT FROM result THEN
    RAISE EXCEPTION 'Canonical retry check did not return the matching saved order';
  END IF;

  SELECT * INTO STRICT receipt FROM public.idempotency_keys WHERE idempotency_key = base_key AND operation = 'create_direct_order';
  IF receipt.request_actor_id IS DISTINCT FROM rep_id OR receipt.request_fingerprint IS NULL
     OR receipt.expires_at IS DISTINCT FROM now() + interval '24 hours'
     OR receipt.result IS DISTINCT FROM result THEN
    RAISE EXCEPTION 'Direct-order receipt did not have the expected binding and lifetime';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = (result->>'order_id')::uuid AND customer_id = farm_id)
     OR (SELECT count(*) FROM public.orders WHERE customer_id = farm_id) <> 1 THEN
    RAISE EXCEPTION 'Expected one saved direct order belonging to the synthetic rep and farm';
  END IF;
  IF EXISTS (SELECT 1 FROM public.notifications WHERE notification_type = 'credit_limit_exceeded' AND related_entity_id = farm_id) THEN
    RAISE EXCEPTION 'The existing direct-order RPC unexpectedly sent its own credit notice';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', rep_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', rep_id::text, true);
  SET LOCAL ROLE authenticated;
  replay := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented Credit Ordinary Order',NULL,items,rep_id,base_key,NULL);
  IF replay IS DISTINCT FROM result OR public.send_direct_order_credit_notice(base_key) IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy replay unexpectedly received new notice authority';
  END IF;
  result := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented Checked Credit Order',NULL,items,rep_id,base_key || '-new',NULL);
  replay := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented Checked Credit Order',NULL,items,rep_id,base_key || '-new',NULL);
  IF replay IS DISTINCT FROM result OR result->>'order_id' IS NULL THEN
    RAISE EXCEPTION 'Checked retry returned a different order';
  END IF;
  replay := public.create_direct_order(farm_id,business_date,'Invented Checked Credit Order',NULL,items,rep_id,base_key || '-new',NULL);
  IF (replay-'_direct_order_credit_notice') IS DISTINCT FROM result THEN
    RAISE EXCEPTION 'Older save caller lost the original result fields';
  END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  SET LOCAL ROLE authenticated;
  IF public.send_direct_order_credit_notice(base_key || '-new') IS NOT NULL THEN
    RAISE EXCEPTION 'Another office user could consume the notice';
  END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', rep_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', rep_id::text, true);
  SET LOCAL ROLE authenticated;
  replay := public.send_direct_order_credit_notice(base_key || '-new');
  IF replay IS DISTINCT FROM public.send_direct_order_credit_notice(base_key || '-new')
     OR (replay->>'outstanding_ar')::numeric IS DISTINCT FROM 1000.01::numeric
     OR (replay->>'exceeded')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Checked notice did not preserve its exact warning across retry';
  END IF;
  RESET ROLE;
  IF (SELECT count(*) FROM public.notifications WHERE notification_type = 'credit_limit_exceeded' AND related_entity_id = farm_id AND created_by = rep_id)
     <> (SELECT count(*) FROM public.profiles WHERE role='admin' AND is_active)
     OR EXISTS (
       SELECT 1 FROM public.notifications
       WHERE notification_type = 'credit_limit_exceeded' AND related_entity_id = farm_id
         AND (title <> 'Credit Limit Exceeded' OR related_entity_type <> 'customer'
           OR message <> 'Invented Credit Notice Farm outstanding AR $1,000.01 exceeds credit limit $1,000')
     ) THEN
    RAISE EXCEPTION 'Expected exactly one notice per active admin after retry';
  END IF;

  ALTER TABLE public.notifications ADD CONSTRAINT credit_probe_reject_invented_notice
    CHECK (notification_type <> 'credit_limit_exceeded') NOT VALID;
  SET LOCAL ROLE authenticated;
  result := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented Credit Failure Order',NULL,items,rep_id,base_key || '-failed',NULL);
  replay := public.send_direct_order_credit_notice(base_key || '-failed');
  RESET ROLE;
  IF (replay->>'notice_failed')::boolean IS DISTINCT FROM true OR (replay->>'exceeded')::boolean IS DISTINCT FROM true
     OR NOT EXISTS (SELECT 1 FROM public.orders WHERE id=(result->>'order_id')::uuid AND customer_id=farm_id) THEN
    RAISE EXCEPTION 'A notice write failure affected the order or credit warning';
  END IF;
  ALTER TABLE public.notifications DROP CONSTRAINT credit_probe_reject_invented_notice;
  SET LOCAL ROLE authenticated;
  replay := public.send_direct_order_credit_notice(base_key || '-failed');
  IF (replay->>'notice_failed')::boolean IS TRUE OR (replay->>'exceeded')::boolean IS DISTINCT FROM true
     OR replay IS DISTINCT FROM public.send_direct_order_credit_notice(base_key || '-failed') THEN
    RAISE EXCEPTION 'An ordinary notice failure could not be retried';
  END IF;
  replay := public.create_direct_order(farm_id,business_date,'Invented Credit Failure Order',NULL,items,rep_id,base_key || '-failed',NULL);
  IF (replay->'_direct_order_credit_notice') IS DISTINCT FROM jsonb_build_object('customer_id', farm_id, 'handled', true) THEN
    RAISE EXCEPTION 'Unexpected legacy order result metadata';
  END IF;
  RESET ROLE;
  IF (SELECT count(*) FROM public.notifications WHERE notification_type='credit_limit_exceeded' AND related_entity_id=farm_id)
     <> 2 * (SELECT count(*) FROM public.profiles WHERE role='admin' AND is_active) THEN
    RAISE EXCEPTION 'Two eligible orders did not send once each';
  END IF;

  SET LOCAL ROLE authenticated;
  result := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented Order With Marker Failure',NULL,items,rep_id,base_key || '-marker',NULL);
  IF (result->>'notice_marker_failed')::boolean IS DISTINCT FROM true OR public.send_direct_order_credit_notice(base_key || '-marker') IS NOT NULL THEN
    RAISE EXCEPTION 'Marker failure did not stop notice only';
  END IF;
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id=(result->>'order_id')::uuid AND customer_id=farm_id) THEN
    RAISE EXCEPTION 'Marker failure rolled back the saved order';
  END IF;
  SET LOCAL ROLE authenticated;
  result := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented Credit Cancel Query',NULL,items,rep_id,base_key || '-cancel',NULL);
  PERFORM set_config('crx.local_credit_cancel', 'on', true);
  BEGIN
    PERFORM public.send_direct_order_credit_notice(base_key || '-cancel');
    RAISE EXCEPTION 'Expected cancelled notification query';
  EXCEPTION WHEN query_canceled THEN NULL;
  END;
  PERFORM set_config('crx.local_credit_cancel', 'off', true);
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = (result->>'order_id')::uuid)
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key=base_key || '-cancel'
       AND idempotency_keys.result #>> '{_direct_order_credit_notice,handled}' = 'true') THEN
    RAISE EXCEPTION 'Cancelled notice query did not leave a saved, retryable order';
  END IF;
  SET LOCAL ROLE authenticated;
  replay := public.send_direct_order_credit_notice(base_key || '-cancel');
  IF (replay->>'exceeded')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Retry after cancelled query did not compute credit correctly';
  END IF;
  RESET ROLE;

  INSERT INTO public.idempotency_keys
    (idempotency_key, operation, result, request_actor_id, request_fingerprint)
  SELECT base_key || '-wrong-operation', 'invented_other_operation', idempotency_keys.result,
    request_actor_id, request_fingerprint
  FROM public.idempotency_keys
  WHERE idempotency_key = base_key || '-cancel' AND operation = 'create_direct_order';
  IF NOT FOUND THEN RAISE EXCEPTION 'Expected a controlled wrong-operation fixture'; END IF;
  UPDATE public.idempotency_keys SET expires_at = now() - interval '1 second' WHERE idempotency_key = base_key || '-new';
  SET LOCAL ROLE authenticated;
  IF public.send_direct_order_credit_notice(base_key || '-wrong-operation') IS NOT NULL THEN
    RAISE EXCEPTION 'A receipt from the wrong operation was accepted';
  END IF;
  IF public.send_direct_order_credit_notice(base_key || '-new') IS NOT NULL THEN
    RAISE EXCEPTION 'Expired receipt was accepted';
  END IF;
  BEGIN
    PERFORM public.send_direct_order_credit_notice(NULL);
    RAISE EXCEPTION 'Missing idempotency key was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    UPDATE public.idempotency_keys SET result = '{}'::jsonb WHERE idempotency_key = base_key || '-cancel';
    IF FOUND THEN RAISE EXCEPTION 'Authenticated user could rewrite a receipt directly'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  UPDATE public.profiles SET role='driver' WHERE id=rep_id;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', rep_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', rep_id::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.send_direct_order_credit_notice(base_key || '-cancel');
    RAISE EXCEPTION 'A driver could see the credit snapshot';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Permission denied: requires admin or sales_rep role' THEN RAISE; END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  UPDATE public.profiles SET role='sales_rep', is_active=false WHERE id=rep_id;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', rep_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', rep_id::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.send_direct_order_credit_notice(base_key || '-cancel');
    RAISE EXCEPTION 'An inactive rep could see the credit snapshot';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Permission denied: requires admin or sales_rep role' THEN RAISE; END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  UPDATE public.profiles SET is_active=true WHERE id=rep_id;

  UPDATE public.customers SET credit_limit_cents=100001 WHERE id=farm_id;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  SET LOCAL ROLE authenticated;
  result := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented Exact Limit Order',NULL,items,admin_id,base_key || '-equal',NULL);
  replay := public.send_direct_order_credit_notice(base_key || '-equal');
  IF result->>'order_id' IS NULL OR (replay->>'exceeded')::boolean IS DISTINCT FROM false
     OR (replay->>'outstanding_ar')::numeric IS DISTINCT FROM (replay->>'credit_limit')::numeric THEN
    RAISE EXCEPTION 'An admin could not save at exactly the existing limit without an alert';
  END IF;
  RESET ROLE;
  UPDATE public.customers SET credit_limit_cents=0 WHERE id=farm_id;
  SET LOCAL ROLE authenticated;
  result := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented No Limit Order',NULL,items,admin_id,base_key || '-unset',NULL);
  replay := public.send_direct_order_credit_notice(base_key || '-unset');
  IF result->>'order_id' IS NULL OR (replay->>'exceeded')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'An unset credit limit incorrectly alerted';
  END IF;
  RESET ROLE;
  IF (SELECT count(*) FROM public.notifications WHERE notification_type='credit_limit_exceeded' AND related_entity_id=farm_id)
      <> 3 * (SELECT count(*) FROM public.profiles WHERE role='admin' AND is_active) THEN
    RAISE EXCEPTION 'Expected three qualifying sends with no extra notices';
  END IF;
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.customers (id,farm_name,credit_limit_cents)
    VALUES (other_farm_id,'Invented Different Credit Farm',900000);
  INSERT INTO public.invoices
    (invoice_number,customer_id,invoice_type,status,invoice_date,due_date,total_amount_cents,created_by,salesman_id,posted_at,deleted_at)
  VALUES
    ('LOCAL-CREDIT-NEGATIVE',farm_id,'credit_memo','unposted',business_date,business_date+30,-300000,rep_id,rep_id,NULL,NULL),
    ('LOCAL-CREDIT-VOIDED',farm_id,'chemical_sale','voided',business_date,business_date+30,300000,rep_id,rep_id,now(),NULL),
    ('LOCAL-CREDIT-DELETED',farm_id,'chemical_sale','unposted',business_date,business_date+30,300000,rep_id,rep_id,NULL,now()),
    ('LOCAL-CREDIT-UNRELATED',other_farm_id,'chemical_sale','unposted',business_date,business_date+30,300000,rep_id,rep_id,NULL,NULL);
  SET LOCAL session_replication_role = origin;
  UPDATE public.customers SET credit_limit_cents=100000 WHERE id=farm_id;

  SET LOCAL ROLE authenticated;
  result := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented Credit Relink Order',NULL,items,admin_id,base_key || '-relink',NULL);
  RESET ROLE;
  SET LOCAL session_replication_role = replica;
  UPDATE public.orders SET customer_id=other_farm_id WHERE id = (result->>'order_id')::uuid;
  SET LOCAL session_replication_role = origin;
  SET LOCAL ROLE authenticated;
  replay := public.send_direct_order_credit_notice(base_key || '-relink');
  IF (replay->>'outstanding_ar')::numeric IS DISTINCT FROM 1000.01::numeric
     OR (replay->>'exceeded')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'The original customer or eligible balance changed before notification';
  END IF;
  RESET ROLE;
  IF (SELECT count(*) FROM public.notifications WHERE notification_type='credit_limit_exceeded'
       AND related_entity_id=farm_id AND created_by=admin_id)
      <> (SELECT count(*) FROM public.profiles WHERE role='admin' AND is_active)
     OR EXISTS (SELECT 1 FROM public.notifications WHERE notification_type='credit_limit_exceeded'
       AND related_entity_id=other_farm_id) THEN
    RAISE EXCEPTION 'A notice went to the relinked order customer';
  END IF;
  SET LOCAL ROLE authenticated;
  result := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented Cancelled Marker Order',NULL,items,admin_id,base_key || '-marker-cancelled',NULL);
  IF (result->>'notice_marker_failed')::boolean IS DISTINCT FROM true
     OR public.send_direct_order_credit_notice(base_key || '-marker-cancelled') IS NOT NULL THEN
    RAISE EXCEPTION 'A cancelled marker did not preserve the marker failure outcome';
  END IF;
  replay := public.create_direct_order_with_credit_notice(farm_id,business_date,'Invented Cancelled Marker Order',NULL,items,admin_id,base_key || '-marker-cancelled',NULL);
  IF replay->>'order_id' IS DISTINCT FROM result->>'order_id' THEN
    RAISE EXCEPTION 'A cancelled marker prevented replay of the saved order';
  END IF;
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id=(result->>'order_id')::uuid AND customer_id=farm_id) THEN
    RAISE EXCEPTION 'A cancelled marker rolled back the order';
  END IF;
END;
$proof$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
SELECT 'SMOKE_PASS_ROLLBACK';
