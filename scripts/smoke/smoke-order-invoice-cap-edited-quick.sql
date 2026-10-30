-- Disposable prover fixture only; the candidate is installed before this runs.
DO $proof$
DECLARE
  v_admin uuid := '7e320000-0000-4000-8000-000000000001';
  v_customer uuid := '7e320000-0000-4000-8000-000000000003';
  v_product uuid := '7e320000-0000-4000-8000-000000000004';
  v_quick jsonb;
  v_delivery uuid;
  v_order uuid;
  v_invoice uuid;
  v_item uuid;
  v_order_item uuid;
  v_unit_size text;
  v_unit_price bigint;
  v_cost bigint;
  v_description text;
  v_key text := gen_random_uuid()::text;
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  v_quick := public.create_quick_delivery(v_customer,
    jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',8)),
    NULL,CURRENT_DATE,'[PROVER] Edited quick',v_admin,gen_random_uuid()::text,false);
  v_delivery := (v_quick->>'delivery_id')::uuid;
  SELECT order_id INTO v_order FROM public.deliveries WHERE id=v_delivery;
  SELECT id INTO v_invoice FROM public.invoices WHERE delivery_id=v_delivery;
  SELECT id,order_item_id,unit_size,unit_price_cents,cost_cents,description
    INTO v_item,v_order_item,v_unit_size,v_unit_price,v_cost,v_description
    FROM public.invoice_items WHERE invoice_id=v_invoice;
  PERFORM public.save_invoice(
    jsonb_build_object('id',v_invoice,'customer_id',v_customer,'order_id',v_order,
      'delivery_id',v_delivery,'invoice_type','chemical_sale','invoice_date',CURRENT_DATE::text),
    jsonb_build_array(
      jsonb_build_object('id',v_item,'order_item_id',v_order_item,'product_id',v_product,
        'description',v_description,'quantity',1,'unit_price_cents',v_unit_price,'extended_cents',v_unit_price,'cost_cents',v_cost,'unit_size',v_unit_size),
      jsonb_build_object('product_id',v_product,'description','[PROVER] Unlinked','quantity',7,
        'unit_price_cents',v_unit_price,'extended_cents',7*v_unit_price,'cost_cents',v_cost,'unit_size',v_unit_size)),
    gen_random_uuid()::text);
  PERFORM public.confirm_delivery(v_delivery,v_admin,gen_random_uuid()::text);
  PERFORM public.complete_delivery(v_delivery,'No proof — recorded by office',v_admin,
    jsonb_build_object((SELECT id FROM public.delivery_items WHERE delivery_id=v_delivery)::text,3),
    NULL,NULL,v_key,NULL,'no_proof','Disposable fixture; edited quick delivery');
  PERFORM public.complete_delivery(v_delivery,'No proof — recorded by office',v_admin,
    jsonb_build_object((SELECT id FROM public.delivery_items WHERE delivery_id=v_delivery)::text,3),
    NULL,NULL,v_key,NULL,'no_proof','Disposable fixture; edited quick delivery');
  IF (SELECT status FROM public.deliveries WHERE id=v_delivery) <> 'completed'
     OR (SELECT quantity_delivered FROM public.order_items WHERE id=v_order_item) <> 3
     OR (SELECT count(*) FROM public.inventory_transactions WHERE delivery_id=v_delivery AND transaction_type='delivered') <> 1
     OR (SELECT sum(quantity) FROM public.inventory_transactions WHERE delivery_id=v_delivery AND transaction_type='delivered') <> 3
     OR (SELECT quantity FROM public.invoice_items WHERE invoice_id=v_invoice AND order_item_id=v_order_item) <> 3
     OR (SELECT sum(quantity) FROM public.invoice_items WHERE invoice_id=v_invoice AND order_item_id IS NULL) <> 7
     OR public._order_invoice_overbilling(v_order) IS NULL THEN
    RAISE EXCEPTION 'PROOF_FAIL: edited quick completion must record three physical units exactly once and leave draft correction required';
  END IF;
  BEGIN
    PERFORM public.post_invoice(v_invoice,public._invoice_post_version(v_invoice),gen_random_uuid()::text);
    RAISE EXCEPTION 'PROOF_FAIL: edited quick draft posted before correction';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_INVOICE_EXCEEDS_DELIVERED:%'
       AND SQLERRM NOT LIKE 'DELIVERY_INVOICE_EXCEEDS_DELIVERED:%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.invoice_items SET quantity=4,extended_cents=4*v_unit_price
      WHERE invoice_id=v_invoice AND order_item_id=v_order_item;
    RAISE EXCEPTION 'PROOF_FAIL: completion exception accepted a quantity beyond the physical delivery';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ORDER_INVOICE_EXCEEDS_DELIVERED:%'
       AND SQLERRM NOT LIKE 'DELIVERY_INVOICE_EXCEEDS_DELIVERED:%' THEN RAISE; END IF;
  END;
  DELETE FROM public.invoice_items WHERE invoice_id=v_invoice AND order_item_id IS NULL;
  PERFORM public.post_invoice(v_invoice,public._invoice_post_version(v_invoice),gen_random_uuid()::text);
  IF (SELECT status FROM public.invoices WHERE id=v_invoice) <> 'posted' THEN
    RAISE EXCEPTION 'PROOF_FAIL: corrected quick draft did not post';
  END IF;
  RAISE NOTICE 'EDITED_QUICK_COMPLETION_PASS';
END;
$proof$;
