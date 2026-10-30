-- Invoked only by prove-order-invoice-delivered-cap-real-schema.mjs, in its
-- disposable fixture database and rolled-back transaction. No production use.
DO $proof$
DECLARE
  v_admin uuid := '7e320000-0000-4000-8000-000000000001';
  v_customer uuid := '7e320000-0000-4000-8000-000000000003';
  v_product uuid := '7e320000-0000-4000-8000-000000000004';
  v_landlord uuid;
  v_field uuid;
  v_order uuid;
  v_line uuid;
  v_delivery uuid;
  v_group uuid;
  v_quick jsonb;
  v_quick_invoice uuid;
  v_return uuid;
  v_result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  INSERT INTO public.customers (farm_name) VALUES ('[PROVER] Landlord') RETURNING id INTO v_landlord;
  INSERT INTO public.fields (customer_id,field_name,total_acres) VALUES (v_customer,'[PROVER] Cap Field',100) RETURNING id INTO v_field;
  INSERT INTO public.field_billing_defaults (field_id,customer_id,split_pct,is_primary)
    VALUES (v_field,v_customer,50,true),(v_field,v_landlord,50,false);
  INSERT INTO public.orders (order_number,customer_id,order_date,status)
    VALUES ('PROVER-CAP-SPLIT',v_customer,CURRENT_DATE,'confirmed') RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation','create_direct_order',true);
  INSERT INTO public.order_items (order_id,product_id,product_name,unit_size,price_per_unit,cost_per_unit,
    total_units_needed,total_price,quantity_delivered,quantity_remaining)
    VALUES (v_order,v_product,'[PROVER] Product','gal',10,6,6,60,0,6) RETURNING id INTO v_line;
  INSERT INTO public.order_item_field_allocations (order_item_id,field_id,acres) VALUES (v_line,v_field,100);
  BEGIN
    PERFORM public.create_split_invoices_from_order(v_order,v_admin,'chemical_sale',gen_random_uuid()::text);
    RAISE EXCEPTION 'PROOF_FAIL: an upfront split must be refused';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_INVOICE_EXCEEDS_DELIVERED:%' THEN RAISE; END IF;
  END;
  INSERT INTO public.deliveries (delivery_number,order_id,customer_id,scheduled_date,status,created_by)
    VALUES ('PROVER-CAP-SPLIT-D1',v_order,v_customer,CURRENT_DATE,'scheduled',v_admin) RETURNING id INTO v_delivery;
  INSERT INTO public.delivery_items (delivery_id,order_item_id,product_id,quantity,unit_size)
    VALUES (v_delivery,v_line,v_product,6,'gal');
  PERFORM public.confirm_delivery(v_delivery,v_admin,gen_random_uuid()::text);
  PERFORM public.complete_delivery(v_delivery,'No proof — recorded by office',v_admin,
    jsonb_build_object((SELECT id FROM public.delivery_items WHERE delivery_id=v_delivery)::text,3),
    NULL,NULL,gen_random_uuid()::text,NULL,'no_proof','Disposable test fixture; admin records delivery');
  BEGIN
    PERFORM public.create_split_invoices_from_order(v_order,v_admin,'chemical_sale',gen_random_uuid()::text);
    RAISE EXCEPTION 'PROOF_FAIL: partial delivery cannot bill ordered split quantities';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_INVOICE_EXCEEDS_DELIVERED:%'
       AND SQLERRM NOT LIKE 'Order PROVER-CAP-SPLIT is partially delivered%' THEN RAISE; END IF;
  END;
  INSERT INTO public.deliveries (delivery_number,order_id,customer_id,scheduled_date,status,created_by)
    VALUES ('PROVER-CAP-SPLIT-D2',v_order,v_customer,CURRENT_DATE,'scheduled',v_admin) RETURNING id INTO v_delivery;
  INSERT INTO public.delivery_items (delivery_id,order_item_id,product_id,quantity,unit_size)
    VALUES (v_delivery,v_line,v_product,3,'gal');
  PERFORM public.confirm_delivery(v_delivery,v_admin,gen_random_uuid()::text);
  PERFORM public.complete_delivery(v_delivery,'No proof — recorded by office',v_admin,NULL,NULL,NULL,gen_random_uuid()::text,
    NULL,'no_proof','Disposable test fixture; admin records remainder delivery');
  SELECT invoice_group_id INTO v_group FROM public.invoices WHERE order_id=v_order LIMIT 1;
  IF v_group IS NULL OR (SELECT sum(ii.quantity) FROM public.invoice_items ii JOIN public.invoices i ON i.id=ii.invoice_id WHERE i.order_id=v_order) <> 6 THEN
    RAISE EXCEPTION 'PROOF_FAIL: fully delivered order must split exactly six units';
  END IF;
  PERFORM public.post_invoice_group(v_group,v_admin,
    (SELECT jsonb_object_agg(i.id,public._invoice_post_version(i.id)) FROM public.invoices i WHERE i.invoice_group_id=v_group),gen_random_uuid()::text);
  v_result := public.create_return(jsonb_build_object('customer_id',v_landlord,'order_id',v_order,'reason','defective'),
    jsonb_build_array(jsonb_build_object('order_item_id',v_line,'quantity',1,'condition','damaged','restock',false)),gen_random_uuid()::text);
  v_return := (v_result->>'return_id')::uuid;
  PERFORM public.approve_return(v_return,v_admin,gen_random_uuid()::text);
  PERFORM public.receive_return(v_return,v_admin,gen_random_uuid()::text);
  PERFORM public.issue_return_credit(v_return,v_admin,gen_random_uuid()::text);
  IF NOT EXISTS (SELECT 1 FROM public.returns r JOIN public.invoices i ON i.id=r.credit_invoice_id
    WHERE r.id=v_return AND i.invoice_type='credit_memo' AND i.status='posted' AND i.customer_id=v_landlord)
     OR public._order_invoice_overbilling(v_order) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF_FAIL: governed landlord return credit must work within cap';
  END IF;

  -- A real credit on the ordinary fixture does not free sold units for re-billing.
  PERFORM public.post_invoice('7e320000-0000-4000-8000-000000000013',
    public._invoice_post_version('7e320000-0000-4000-8000-000000000013'),gen_random_uuid()::text);
  v_result := public.create_return(jsonb_build_object('customer_id',v_customer,'order_id','7e320000-0000-4000-8000-000000000010','reason','defective'),
    jsonb_build_array(jsonb_build_object('order_item_id','7e320000-0000-4000-8000-000000000011','quantity',1,'condition','damaged','restock',false)),gen_random_uuid()::text);
  v_return := (v_result->>'return_id')::uuid;
  PERFORM public.approve_return(v_return,v_admin,gen_random_uuid()::text);
  PERFORM public.receive_return(v_return,v_admin,gen_random_uuid()::text);
  PERFORM public.issue_return_credit(v_return,v_admin,gen_random_uuid()::text);
  BEGIN
    INSERT INTO public.invoice_items (invoice_id,product_id,description,quantity,unit_price_cents,extended_cents,cost_cents,unit_size)
      VALUES ('7e320000-0000-4000-8000-000000000014',v_product,'[PROVER] credit rebill',3,1000,3000,600,'gal');
    RAISE EXCEPTION 'PROOF_FAIL: a return credit created new billing allowance';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_INVOICE_EXCEEDS_DELIVERED:%' THEN RAISE; END IF;
  END;

  v_quick := public.create_quick_delivery(v_customer,jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',8)),
    NULL,CURRENT_DATE,'[PROVER] Quick',v_admin,gen_random_uuid()::text,false);
  v_delivery := (v_quick->>'delivery_id')::uuid;
  SELECT id INTO v_quick_invoice FROM public.invoices WHERE delivery_id=v_delivery;
  BEGIN
    PERFORM public.post_invoice(v_quick_invoice,public._invoice_post_version(v_quick_invoice),gen_random_uuid()::text);
    RAISE EXCEPTION 'PROOF_FAIL: quick invoice posted before delivery';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'DELIVERY_INVOICE_EXCEEDS_DELIVERED:%' THEN RAISE; END IF;
  END;
  PERFORM public.confirm_delivery(v_delivery,v_admin,gen_random_uuid()::text);
  PERFORM public.complete_delivery(v_delivery,'No proof — recorded by office',v_admin,
    jsonb_build_object((SELECT id FROM public.delivery_items WHERE delivery_id=v_delivery)::text,3),
    NULL,NULL,gen_random_uuid()::text,NULL,'no_proof','Disposable test fixture; short quick delivery');
  IF (SELECT sum(quantity) FROM public.invoice_items WHERE invoice_id=v_quick_invoice) <> 3 THEN
    RAISE EXCEPTION 'PROOF_FAIL: quick invoice must trim to three delivered units';
  END IF;
  PERFORM public.post_invoice(v_quick_invoice,public._invoice_post_version(v_quick_invoice),gen_random_uuid()::text);
  IF (SELECT status FROM public.invoices WHERE id=v_quick_invoice) <> 'posted' THEN
    RAISE EXCEPTION 'PROOF_FAIL: completed quick delivery invoice must post';
  END IF;
  RAISE NOTICE 'PIPELINE_PASS: upfront and partial splits refused; full split posts; landlord return credited; short quick delivery posts only actual units';
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$proof$;
