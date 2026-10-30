-- Disposable prover fixture only; use the real split engine after installation.
DO $proof$
DECLARE
  v_admin uuid := '7e320000-0000-4000-8000-000000000001';
  v_customer uuid := '7e320000-0000-4000-8000-000000000003';
  v_product uuid := '7e320000-0000-4000-8000-000000000004';
  v_owner uuid;
  v_owners uuid[];
  v_fields uuid[] := '{}';
  v_field uuid;
  v_order uuid;
  v_delivery uuid;
  v_line uuid;
  v_invoice uuid;
  v_header jsonb;
  v_items jsonb;
  v_changed jsonb;
  v_group uuid;
  v_return uuid;
  v_result jsonb;
  v_return_qty numeric;
  v_source_cents bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  v_owners := ARRAY[v_customer];
  FOR n IN 1..2 LOOP
    INSERT INTO public.customers (farm_name) VALUES ('[PROVER] Rounding owner '||n) RETURNING id INTO v_owner;
    v_owners := array_append(v_owners,v_owner);
  END LOOP;
  FOREACH v_owner IN ARRAY v_owners LOOP
    INSERT INTO public.fields (customer_id,field_name,total_acres)
      VALUES (v_owner,'[PROVER] Rounding field',100) RETURNING id INTO v_field;
    INSERT INTO public.field_billing_defaults (field_id,customer_id,split_pct,is_primary)
      VALUES (v_field,v_owner,100,true);
    v_fields := array_append(v_fields,v_field);
  END LOOP;
  INSERT INTO public.orders (order_number,customer_id,order_date,status,salesman_id)
    VALUES ('PROVER-CAP-ROUNDING',v_customer,CURRENT_DATE,'confirmed',v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation','create_direct_order',true);
  INSERT INTO public.deliveries (delivery_number,order_id,customer_id,scheduled_date,status,created_by)
    VALUES ('PROVER-CAP-ROUNDING-D',v_order,v_customer,CURRENT_DATE,'scheduled',v_admin) RETURNING id INTO v_delivery;
  FOR n IN 1..10 LOOP
    INSERT INTO public.order_items (order_id,product_id,product_name,unit_size,price_per_unit,cost_per_unit,
      total_units_needed,total_price,quantity_delivered,quantity_remaining)
      VALUES (v_order,v_product,'[PROVER] Rounded product','gal',10,6,2,20,0,2) RETURNING id INTO v_line;
    FOREACH v_field IN ARRAY v_fields LOOP
      INSERT INTO public.order_item_field_allocations (order_item_id,field_id,acres) VALUES (v_line,v_field,100);
    END LOOP;
    INSERT INTO public.delivery_items (delivery_id,order_item_id,product_id,quantity,unit_size)
      VALUES (v_delivery,v_line,v_product,2,'gal');
  END LOOP;
  PERFORM public.confirm_delivery(v_delivery,v_admin,gen_random_uuid()::text);
  PERFORM public.complete_delivery(v_delivery,'No proof — recorded by office',v_admin,NULL,NULL,NULL,
    gen_random_uuid()::text,NULL,'no_proof','Disposable fixture; repeated split product');
  IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE order_id=v_order) THEN
    PERFORM public.create_split_invoices_from_order(v_order,v_admin,'chemical_sale',gen_random_uuid()::text);
  END IF;
  IF (SELECT count(*) FROM public.invoices WHERE order_id=v_order) <> 3
     OR (SELECT sum(ii.quantity) FROM public.invoice_items ii JOIN public.invoices i ON i.id=ii.invoice_id WHERE i.order_id=v_order) <> 20
     OR EXISTS (SELECT 1 FROM public.invoice_items ii JOIN public.invoices i ON i.id=ii.invoice_id
                 WHERE i.order_id=v_order GROUP BY ii.order_item_id HAVING sum(ii.quantity) <> 2)
     OR (SELECT sum(total_amount_cents) FROM public.invoices WHERE order_id=v_order)
          <> (SELECT round(sum(total_price)*100)::bigint FROM public.order_items WHERE order_id=v_order)
     OR public._order_invoice_overbilling(v_order) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF_FAIL: rounded split must bill ten delivered lines through three owners (invoices %, quantity %, order %, cap %)',
      (SELECT count(*) FROM public.invoices WHERE order_id=v_order),
      (SELECT sum(ii.quantity) FROM public.invoice_items ii JOIN public.invoices i ON i.id=ii.invoice_id WHERE i.order_id=v_order),
      (SELECT status FROM public.orders WHERE id=v_order), public._order_invoice_overbilling(v_order);
  END IF;
  SELECT id INTO v_invoice FROM public.invoices WHERE order_id=v_order LIMIT 1;
  SELECT jsonb_build_object('id',i.id,'customer_id',i.customer_id,'order_id',i.order_id,
      'delivery_id',i.delivery_id,'invoice_type',i.invoice_type,'invoice_date',i.invoice_date::text),
    (SELECT jsonb_agg(jsonb_build_object('id',ii.id,'order_item_id',ii.order_item_id,'product_id',ii.product_id,
      'description',ii.description,'quantity',ii.quantity,'unit_price_cents',ii.unit_price_cents,
      'extended_cents',ii.extended_cents,'cost_cents',ii.cost_cents,'unit_size',ii.unit_size,
      'sort_order',ii.sort_order,'acres',ii.acres,'rate_per_acre',ii.rate_per_acre) ORDER BY ii.order_item_id)
       FROM public.invoice_items ii WHERE ii.invoice_id=i.id)
    INTO v_header,v_items FROM public.invoices i WHERE i.id=v_invoice;
  SELECT jsonb_agg(x || jsonb_build_object('quantity',(x->>'quantity')::numeric+0.0009,
    'extended_cents',round(((x->>'quantity')::numeric+0.0009)*(x->>'unit_price_cents')::bigint)))
    INTO v_changed FROM jsonb_array_elements(v_items) x;
  BEGIN
    PERFORM public.save_invoice(v_header,v_changed,gen_random_uuid()::text);
    RAISE EXCEPTION 'PROOF_FAIL: a governed split invoice permitted manual quantity changes';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SPLIT_INVOICE_EDIT_REQUIRES_REISSUE:%' THEN RAISE; END IF;
  END;
  SELECT invoice_group_id INTO v_group FROM public.invoices WHERE id=v_invoice;
  PERFORM public.post_invoice_group(v_group,v_admin,
    (SELECT jsonb_object_agg(id,public._invoice_post_version(id)) FROM public.invoices WHERE invoice_group_id=v_group),
    gen_random_uuid()::text);
  SELECT i.customer_id,ii.order_item_id,ii.quantity,ii.extended_cents
    INTO v_owner,v_line,v_return_qty,v_source_cents
    FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice_id=i.id
   WHERE i.order_id=v_order AND i.customer_id<>v_customer ORDER BY ii.id LIMIT 1;
  -- Returns store two decimal places; exercise a supported partial owner return.
  v_source_cents := round(v_source_cents * 0.33 / v_return_qty)::bigint;
  v_return_qty := 0.33;
  v_result := public.create_return(jsonb_build_object('customer_id',v_owner,'order_id',v_order,'reason','defective'),
    jsonb_build_array(jsonb_build_object('order_item_id',v_line,'quantity',v_return_qty,'condition','damaged','restock',false)),
    gen_random_uuid()::text);
  v_return := (v_result->>'return_id')::uuid;
  PERFORM public.approve_return(v_return,v_admin,gen_random_uuid()::text);
  PERFORM public.receive_return(v_return,v_admin,gen_random_uuid()::text);
  PERFORM public.issue_return_credit(v_return,v_admin,gen_random_uuid()::text);
  IF NOT EXISTS (SELECT 1 FROM public.returns r JOIN public.invoices i ON i.id=r.credit_invoice_id
    WHERE r.id=v_return AND i.invoice_type='credit_memo' AND i.status='posted'
      AND i.customer_id=v_owner AND abs(i.total_amount_cents)=v_source_cents) THEN
    RAISE EXCEPTION 'PROOF_FAIL: fractional owner return must credit its billed cents exactly';
  END IF;
  RAISE NOTICE 'SPLIT_ROUNDING_CAP_PASS';
END;
$proof$;
