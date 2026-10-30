-- Disposable historical fixture; delivery measurements retain more than four places.
DO $proof$
DECLARE
  v_admin uuid := '7e320000-0000-4000-8000-000000000001';
  v_customer uuid := '7e320000-0000-4000-8000-000000000003';
  v_product uuid := '7e320000-0000-4000-8000-000000000004';
  v_order uuid;
  v_line uuid;
  v_delivery uuid;
  v_invoice uuid;
  v_ids uuid[];
  v_group uuid;
  v_field uuid;
  v_qty numeric;
BEGIN
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  INSERT INTO public.orders (order_number,customer_id,order_date,status,salesman_id)
    VALUES ('PROVER-CAP-FRAGMENTS',v_customer,CURRENT_DATE,'confirmed',v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation','create_direct_order',true);
  INSERT INTO public.order_items (order_id,product_id,product_name,unit_size,price_per_unit,cost_per_unit,
    total_units_needed,total_price,quantity_delivered,quantity_remaining)
    VALUES (v_order,v_product,'[PROVER] Fragmented product','gal',10,6,1,10,1,0) RETURNING id INTO v_line;
  INSERT INTO public.fields (customer_id,field_name,total_acres)
    VALUES (v_customer,'[PROVER] Fragmented field',100) RETURNING id INTO v_field;
  INSERT INTO public.field_billing_defaults (field_id,customer_id,split_pct,is_primary)
    VALUES (v_field,v_customer,100,true);
  INSERT INTO public.order_item_field_allocations (order_item_id,field_id,acres) VALUES (v_line,v_field,100);
  ALTER TABLE public.deliveries DISABLE TRIGGER require_delivery_completion_evidence;
  ALTER TABLE public.delivery_items DISABLE TRIGGER enforce_delivery_items_parent_lock;
  FOREACH v_qty IN ARRAY ARRAY[0.33334,0.33334,0.33332]::numeric[] LOOP
    INSERT INTO public.deliveries (delivery_number,order_id,customer_id,status,scheduled_date,signed_by,completed_at,created_by)
      VALUES ('PROVER-CAP-FRAGMENT-'||gen_random_uuid(),v_order,v_customer,'completed',CURRENT_DATE,
        '[PROVER] Historical',now(),v_admin) RETURNING id INTO v_delivery;
    INSERT INTO public.delivery_items (delivery_id,order_item_id,product_id,quantity,quantity_delivered,unit_size)
      VALUES (v_delivery,v_line,v_product,v_qty,v_qty,'gal');
  END LOOP;
  ALTER TABLE public.delivery_items ENABLE TRIGGER enforce_delivery_items_parent_lock;
  ALTER TABLE public.deliveries ENABLE TRIGGER require_delivery_completion_evidence;
  v_ids := public.create_split_invoices_from_order(v_order,v_admin,'chemical_sale',gen_random_uuid()::text);
  v_invoice := v_ids[1];
  IF (SELECT sum(quantity) FROM public.invoice_items WHERE invoice_id=v_invoice) <> 1
     OR public._order_invoice_overbilling(v_order) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF_FAIL: fragmented physical quantities must aggregate before billing precision is applied';
  END IF;
  SELECT invoice_group_id INTO v_group FROM public.invoices WHERE id=v_invoice;
  PERFORM public.post_invoice_group(v_group,v_admin,
    (SELECT jsonb_object_agg(id,public._invoice_post_version(id)) FROM public.invoices WHERE invoice_group_id=v_group),
    gen_random_uuid()::text);
  RAISE NOTICE 'FRAGMENTED_DELIVERY_PRECISION_PASS';
END;
$proof$;
