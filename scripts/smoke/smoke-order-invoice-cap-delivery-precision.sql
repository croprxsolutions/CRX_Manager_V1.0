-- Disposable fixture: each real delivery creates a separate four-decimal invoice.
DO $proof$
DECLARE
  v_admin uuid := '7e320000-0000-4000-8000-000000000001';
  v_customer uuid := '7e320000-0000-4000-8000-000000000003';
  v_product uuid := '7e320000-0000-4000-8000-000000000004';
  v_order uuid;
  v_line uuid;
  v_delivery uuid;
  v_invoice uuid;
  v_ids uuid[] := '{}';
  v_deliveries uuid[] := '{}';
  v_qty numeric;
BEGIN
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  INSERT INTO public.orders (order_number,customer_id,order_date,status,salesman_id)
    VALUES ('PROVER-CAP-DOCUMENT-PRECISION',v_customer,CURRENT_DATE,'confirmed',v_admin) RETURNING id INTO v_order;
  PERFORM set_config('app.crx_below_cost_operation','create_direct_order',true);
  INSERT INTO public.order_items (order_id,product_id,product_name,unit_size,price_per_unit,cost_per_unit,
    total_units_needed,total_price,quantity_delivered,quantity_remaining)
    VALUES (v_order,v_product,'[PROVER] Delivery precision','gal',10,6,1,10,0,1) RETURNING id INTO v_line;
  FOREACH v_qty IN ARRAY ARRAY[0.33336,0.33336,0.33328]::numeric[] LOOP
    INSERT INTO public.deliveries (delivery_number,order_id,customer_id,status,scheduled_date,created_by)
      VALUES ('PROVER-CAP-DOCUMENT-'||gen_random_uuid(),v_order,v_customer,'scheduled',CURRENT_DATE,v_admin)
      RETURNING id INTO v_delivery;
    v_deliveries := array_append(v_deliveries,v_delivery);
    INSERT INTO public.delivery_items (delivery_id,order_item_id,product_id,quantity,unit_size)
      VALUES (v_delivery,v_line,v_product,v_qty,'gal');
    PERFORM public.confirm_delivery(v_delivery,v_admin,gen_random_uuid()::text);
    PERFORM public.complete_delivery(v_delivery,'No proof — recorded by office',v_admin,NULL,NULL,NULL,
      gen_random_uuid()::text,NULL,'no_proof','Disposable fixture; per-delivery precision');
    SELECT id INTO v_invoice FROM public.invoices WHERE delivery_id=v_delivery AND invoice_type<>'credit_memo';
    IF v_invoice IS NULL THEN
      v_invoice := public.create_invoice_for_unbilled_delivery(v_delivery,v_admin,gen_random_uuid()::text);
    END IF;
    v_ids := array_append(v_ids,v_invoice);
    BEGIN
      UPDATE public.invoice_items SET quantity=quantity+0.0001 WHERE invoice_id=v_invoice;
      RAISE EXCEPTION 'PROOF_FAIL: delivery invoice accepted an extra stored quantity tick';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'ORDER_INVOICE_EXCEEDS_DELIVERED:%'
         AND SQLERRM NOT LIKE 'DELIVERY_INVOICE_EXCEEDS_DELIVERED:%' THEN RAISE; END IF;
    END;
    PERFORM public.post_invoice(v_invoice,public._invoice_post_version(v_invoice),gen_random_uuid()::text);
  END LOOP;
  IF cardinality(v_ids) <> 3
     OR (SELECT quantity_delivered FROM public.order_items WHERE id=v_line) <> 1
     OR (SELECT sum(quantity) FROM public.inventory_transactions WHERE delivery_id=ANY(v_deliveries) AND transaction_type='delivered') <> 1
     OR (SELECT sum(quantity) FROM public.invoice_items WHERE invoice_id=ANY(v_ids)) <> 1.0001
     OR EXISTS (SELECT 1 FROM public.invoices WHERE id=ANY(v_ids) AND status<>'posted')
     OR public._order_invoice_overbilling(v_order) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF_FAIL: per-delivery documents must retain their stored precision with one physical unit recorded';
  END IF;
  RAISE NOTICE 'DELIVERY_DOCUMENT_PRECISION_PASS';
END;
$proof$;
