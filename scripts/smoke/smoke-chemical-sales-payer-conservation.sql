-- Current-schema chemical sales only: two/three payers conserve delivered units and cents.
-- Uses the same local fixture and real completion/posting functions as the existing split smoke.
DO $proof$
DECLARE
  actor uuid; main uuid; payer2 uuid; payer3 uuid; product public.products%ROWTYPE;
  sale uuid; line uuid; delivery uuid; grp uuid; versions jsonb;
  tag text := substr(md5(random()::text),1,8); expected_cents bigint; expected_payer bigint;
BEGIN
  SELECT id INTO actor FROM profiles WHERE role='admin' AND is_active ORDER BY created_at LIMIT 1;
  INSERT INTO customers(farm_name,is_active) VALUES ('[SMOKE] Payer main '||tag,true) RETURNING id INTO main;
  INSERT INTO customers(farm_name,is_active) VALUES ('[SMOKE] Payer two '||tag,true) RETURNING id INTO payer2;
  INSERT INTO customers(farm_name,is_active) VALUES ('[SMOKE] Payer three '||tag,true) RETURNING id INTO payer3;
  SELECT * INTO product FROM products WHERE is_active AND current_cost>0 ORDER BY created_at LIMIT 1;
  IF actor IS NULL OR product.id IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: admin and priced product required'; END IF;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  expected_cents := round((product.current_cost+7.33)*10*100)::bigint;
  FOR n IN 2..3 LOOP
    INSERT INTO orders(order_number,customer_id,order_date,status,salesman_id)
      VALUES ('SMK-PAYER-'||tag||n,main,CURRENT_DATE,'confirmed',actor) RETURNING id INTO sale;
    PERFORM set_config('app.crx_below_cost_operation','create_direct_order',true);
    INSERT INTO order_items(order_id,product_id,product_name,unit_size,price_per_unit,cost_per_unit,
      total_units_needed,total_price,quantity_delivered,quantity_remaining)
      VALUES(sale,product.id,product.product_name,'gal',product.current_cost+7.33,product.current_cost,
        10,(product.current_cost+7.33)*10,0,10) RETURNING id INTO line;
    PERFORM set_config('app.crx_below_cost_operation','',true);
    INSERT INTO order_shares(order_id,customer_id,customer_name,split_percentage,amount_cents)
      SELECT sale,c.id,c.farm_name,CASE WHEN n=2 THEN CASE WHEN c.id=main THEN 60 ELSE 40 END ELSE 33.33 END,0
      FROM customers c WHERE c.id IN(main,payer2) OR (n=3 AND c.id=payer3);
    INSERT INTO deliveries(delivery_number,order_id,customer_id,status,scheduled_date,created_by)
      VALUES('SMK-PAYER-'||tag||n,sale,main,'scheduled',CURRENT_DATE,actor) RETURNING id INTO delivery;
    INSERT INTO delivery_items(delivery_id,order_item_id,product_id,quantity,unit_size)
      VALUES(delivery,line,product.id,10,'gal');
    PERFORM confirm_delivery(delivery,actor,'payer-confirm-'||tag||n);
    PERFORM complete_delivery(delivery,'No proof — recorded by office',actor,NULL,NULL,NULL,
      'payer-complete-'||tag||n,NULL,'no_proof','Invented rolled-back chemical sales proof');
    SELECT min(invoice_group_id::text)::uuid INTO grp FROM invoices WHERE delivery_id=delivery;
    IF grp IS NULL OR (SELECT count(*) FROM invoices WHERE delivery_id=delivery AND status='draft')<>n
      OR (SELECT sum(total_amount_cents) FROM invoices WHERE delivery_id=delivery) IS DISTINCT FROM expected_cents
      OR (SELECT sum(ii.quantity) FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
        WHERE i.delivery_id=delivery AND ii.order_item_id=line) IS DISTINCT FROM 10::numeric
      OR (SELECT sum(ii.extended_cents) FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
        WHERE i.delivery_id=delivery AND ii.order_item_id=line) IS DISTINCT FROM expected_cents THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % payers did not conserve delivered units and cents',n;
    END IF;
    expected_payer := floor(expected_cents * CASE WHEN n=2 THEN 0.4 ELSE 0.3333 END)::bigint;
    IF (SELECT total_amount_cents FROM invoices WHERE delivery_id=delivery AND customer_id=payer2)
      IS DISTINCT FROM expected_payer
      OR (SELECT total_amount_cents FROM invoices WHERE delivery_id=delivery AND customer_id=main)
        IS DISTINCT FROM expected_cents-expected_payer*(n-1) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: payer percentage or main-customer remainder differs';
    END IF;
    BEGIN
      UPDATE invoice_items SET quantity=quantity+1 WHERE invoice_id=(SELECT id FROM invoices
        WHERE delivery_id=delivery AND customer_id=payer2) AND order_item_id=line;
      RAISE EXCEPTION 'SMOKE_FAIL: a payer quantity was increased past its allocated share';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'SPLIT_INVOICE_PROVENANCE_IMMUTABLE:%' THEN RAISE; END IF;
    END;
    SELECT jsonb_object_agg(id,_invoice_post_version(id)) INTO versions FROM invoices WHERE invoice_group_id=grp;
    PERFORM post_invoice_group(grp,actor,versions,'payer-post-'||tag||n);
    IF (SELECT count(*) FROM invoices WHERE delivery_id=delivery AND status='posted')<>n
      OR (SELECT sum(balance_cents) FROM invoices WHERE delivery_id=delivery) IS DISTINCT FROM expected_cents THEN
      RAISE EXCEPTION 'SMOKE_FAIL: posted payer balances do not conserve sale cents';
    END IF;
  END LOOP;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK chemical payer conservation: two/three payers, quantity, cents, remainder and group posting';
END $proof$;
