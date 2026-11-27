BEGIN;
DO $proof$
DECLARE
  rep uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  primary_farm uuid := gen_random_uuid();
  card_payer uuid := gen_random_uuid();
  line_payer uuid := gen_random_uuid();
  unrelated uuid := gen_random_uuid();
  missing_id uuid := gen_random_uuid();
  product uuid := gen_random_uuid();
  other_product uuid := gen_random_uuid();
  ordinary_order uuid := gen_random_uuid();
  split_order uuid := gen_random_uuid();
  empty_order uuid := gen_random_uuid();
  split_line uuid := gen_random_uuid();
  program uuid := gen_random_uuid();
  actor uuid;
  allowed record;
  refused record;
  receipt jsonb;
  replay jsonb;
  replay_key text := gen_random_uuid()::text;
  rejected_key text;
  rejected_keys text[] := ARRAY[]::text[];
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id,email) VALUES (rep,rep || '@fixture.example.test'), (admin_id,admin_id || '@fixture.example.test');
  INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
    (rep,rep || '@fixture.example.test','Invented Rebates Rep','sales_rep',true),
    (admin_id,admin_id || '@fixture.example.test','Invented Rebates Admin','admin',true);
  UPDATE public.profiles SET denied_pages=ARRAY['rebates'] WHERE id=admin_id;
  INSERT INTO public.customers (id,farm_name) VALUES
    (primary_farm,'Invented Primary'), (card_payer,'Invented Card Payer'),
    (line_payer,'Invented Line Payer'), (unrelated,'Invented Unrelated Farm');
  INSERT INTO public.products (id,product_name,product_form,inventory_unit) VALUES
    (product,'Invented Rebate Product','liquid','Gal'), (other_product,'Invented Different Product','liquid','Gal');
  INSERT INTO public.orders (id,order_number,customer_id,status) VALUES
    (ordinary_order,'INVENTED-REBATE-ORDINARY',primary_farm,'confirmed'),
    (split_order,'INVENTED-REBATE-SPLIT',primary_farm,'confirmed'),
    (empty_order,'INVENTED-REBATE-EMPTY',primary_farm,'confirmed');
  INSERT INTO public.order_items (id,order_id,product_id,product_name,unit_size,total_units_needed,quantity_remaining)
    VALUES (split_line,split_order,product,'Invented Rebate Product','Gal',2,2);
  INSERT INTO public.order_shares (order_id,customer_id,customer_name,split_percentage,amount_cents) VALUES
    (split_order,card_payer,'Invented Card Payer',40,4000),
    (empty_order,card_payer,'Invented Card Payer',40,4000);
  INSERT INTO public.order_item_shares (order_item_id,customer_id,split_percentage) VALUES (split_line,line_payer,100);
  INSERT INTO public.rebate_programs (id,program_name,manufacturer,season,start_date,end_date,rebate_amount,product_id)
    VALUES (program,'Invented Rebates Program','Invented Maker',public.current_season(),CURRENT_DATE,CURRENT_DATE+1,7,product);
  SET LOCAL session_replication_role = origin;

  FOREACH actor IN ARRAY ARRAY[rep,admin_id] LOOP
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
    PERFORM set_config('request.jwt.claim.sub',actor::text,true);
    SET LOCAL ROLE authenticated;
    IF NOT EXISTS (SELECT FROM public.rebate_programs WHERE id=program) THEN
      RAISE EXCEPTION 'Rebate program was hidden from an authorized user';
    END IF;
    FOR allowed IN SELECT * FROM (VALUES
      (ordinary_order,primary_farm), (split_order,line_payer), (empty_order,card_payer), (empty_order,primary_farm)
    ) AS cases(order_id,customer_id) LOOP
      receipt := public.create_rebate_claim(program,2,1847,allowed.order_id,allowed.customer_id,product,NULL,gen_random_uuid()::text);
      IF NOT EXISTS (SELECT FROM public.rebate_claims c WHERE c.id=(receipt->>'claim_id')::uuid
        AND c.customer_id=allowed.customer_id AND c.order_id=allowed.order_id AND c.created_by=actor
        AND c.status='pending' AND c.claim_amount_cents=1847) THEN
        RAISE EXCEPTION 'Allowed payer did not save the expected pending claim';
      END IF;
    END LOOP;
    FOR refused IN SELECT * FROM (VALUES
      (split_order,card_payer,product,'REBATE_CLAIM_ORDER_CUSTOMER_MISMATCH'),
      (split_order,primary_farm,product,'REBATE_CLAIM_ORDER_CUSTOMER_MISMATCH'),
      (split_order,unrelated,product,'REBATE_CLAIM_ORDER_CUSTOMER_MISMATCH'),
      (split_order,line_payer,other_product,'REBATE_CLAIM_PROGRAM_PRODUCT_MISMATCH')
    ) AS cases(order_id,customer_id,product_id,message) LOOP
      rejected_key := gen_random_uuid()::text;
      rejected_keys := array_append(rejected_keys,rejected_key);
      BEGIN
        PERFORM public.create_rebate_claim(program,2,1847,refused.order_id,refused.customer_id,refused.product_id,NULL,rejected_key);
        RAISE EXCEPTION 'Incorrect link accepted';
      EXCEPTION WHEN SQLSTATE '22023' THEN
        IF SQLERRM <> refused.message THEN RAISE; END IF;
      END;
    END LOOP;
    PERFORM public.create_rebate_claim(program,1,1847,NULL,NULL,NULL,NULL,gen_random_uuid()::text);
    FOR refused IN SELECT * FROM (VALUES
      (ordinary_order,missing_id,product), (missing_id,primary_farm,product), (ordinary_order,primary_farm,missing_id)
    ) AS cases(order_id,customer_id,product_id) LOOP
      rejected_key := gen_random_uuid()::text;
      rejected_keys := array_append(rejected_keys,rejected_key);
      BEGIN
        PERFORM public.create_rebate_claim(program,2,1847,refused.order_id,refused.customer_id,refused.product_id,NULL,rejected_key);
        RAISE EXCEPTION 'Missing claim reference accepted';
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
    END LOOP;
    RESET ROLE;
  END LOOP;

  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',rep,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',rep::text,true);
  SET LOCAL ROLE authenticated;
  receipt := public.create_rebate_claim(program,2,1847,split_order,line_payer,product,NULL,replay_key);
  RESET ROLE;
  UPDATE public.order_item_shares SET customer_id=card_payer WHERE order_item_id=split_line;
  UPDATE public.rebate_programs SET product_id=other_product WHERE id=program;
  SET LOCAL ROLE authenticated;
  replay := public.create_rebate_claim(program,2,1847,split_order,line_payer,product,NULL,replay_key);
  RESET ROLE;
  IF receipt IS DISTINCT FROM replay THEN RAISE EXCEPTION 'Eligibility change altered a saved retry'; END IF;

  SET LOCAL session_replication_role = replica;
  UPDATE public.profiles SET denied_pages=ARRAY['rebates'] WHERE id=rep;
  SET LOCAL session_replication_role = origin;
  SET LOCAL ROLE authenticated;
  IF EXISTS (SELECT FROM public.rebate_claims WHERE program_id=program)
    OR EXISTS (SELECT FROM public.rebate_programs WHERE id=program) THEN
    RAISE EXCEPTION 'Hidden Rebates rows were visible';
  END IF;
  BEGIN
    PERFORM public.create_rebate_claim(program,2,1847,split_order,line_payer,product,NULL,replay_key);
    RAISE EXCEPTION 'Hidden Rebates receipt was visible';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'PAGE_ACCESS_DENIED' THEN RAISE; END IF;
  END;
  RESET ROLE;
  IF (SELECT count(*) FROM public.rebate_claims WHERE program_id=program) <> 11
    OR EXISTS (SELECT FROM public.idempotency_keys WHERE idempotency_key=ANY(rejected_keys)) THEN
    RAISE EXCEPTION 'A rejected claim changed rows or receipts';
  END IF;
END;
$proof$;
ROLLBACK;
SELECT 'LOCAL_REBATE_BILLED_CUSTOMERS_PASS';
