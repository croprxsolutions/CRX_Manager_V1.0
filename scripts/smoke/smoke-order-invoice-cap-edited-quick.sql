-- Disposable prover fixture only; the candidate is installed before this runs.
DO $proof$
DECLARE
  v_admin uuid := '7e320000-0000-4000-8000-000000000001';
  v_customer uuid := '7e320000-0000-4000-8000-000000000003';
  v_product uuid := '7e320000-0000-4000-8000-000000000004';
  v_quick jsonb;
  v_delivery uuid;
  v_followup uuid;
  v_followup_invoice uuid;
  v_followup_key text := gen_random_uuid()::text;
  v_order uuid;
  v_invoice uuid;
  v_sibling uuid;
  v_unlinked numeric;
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
  FOREACH v_unlinked IN ARRAY ARRAY[7,6]::numeric[] LOOP
    v_key := gen_random_uuid()::text;
    v_followup_key := gen_random_uuid()::text;
    v_sibling := NULL;
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
        jsonb_build_object('product_id',v_product,'description','[PROVER] Unlinked','quantity',v_unlinked,
          'unit_price_cents',v_unit_price,'extended_cents',v_unlinked*v_unit_price,'cost_cents',v_cost,'unit_size',v_unit_size)),
      gen_random_uuid()::text);
    IF v_unlinked=6 THEN
      INSERT INTO public.invoices (invoice_number,customer_id,order_id,delivery_id,invoice_date,invoice_type,status,total_amount_cents)
        VALUES ('PROVER-QUICK-SIBLING-'||gen_random_uuid(),v_customer,v_order,v_delivery,CURRENT_DATE,'chemical_sale','draft',v_unit_price)
        RETURNING id INTO v_sibling;
      INSERT INTO public.invoice_items (invoice_id,order_item_id,product_id,description,quantity,unit_price_cents,extended_cents,cost_cents,unit_size)
        VALUES (v_sibling,v_order_item,v_product,'[PROVER] Valid sibling',1,v_unit_price,v_unit_price,v_cost,v_unit_size);
    END IF;
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
       OR (SELECT sum(quantity) FROM public.invoice_items WHERE invoice_id=v_invoice AND order_item_id IS NULL) <> v_unlinked
       OR public._delivery_invoice_overbilling(v_invoice) IS NULL
       OR public._order_invoice_overbilling(v_order) IS NOT NULL THEN
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
    INSERT INTO public.deliveries (delivery_number,order_id,customer_id,status,scheduled_date,created_by)
      VALUES ('PROVER-QUICK-FOLLOWUP-'||gen_random_uuid(),v_order,v_customer,'scheduled',CURRENT_DATE,v_admin)
      RETURNING id INTO v_followup;
    INSERT INTO public.delivery_items (delivery_id,order_item_id,product_id,quantity,unit_size)
      VALUES (v_followup,v_order_item,v_product,5,v_unit_size);
    PERFORM public.confirm_delivery(v_followup,v_admin,gen_random_uuid()::text);
    PERFORM public.complete_delivery(v_followup,'No proof — recorded by office',v_admin,NULL,NULL,NULL,
      v_followup_key,NULL,'no_proof','Disposable fixture; follow-up while quick draft needs correction');
    PERFORM public.complete_delivery(v_followup,'No proof — recorded by office',v_admin,NULL,NULL,NULL,
      v_followup_key,NULL,'no_proof','Disposable fixture; follow-up while quick draft needs correction');
    SELECT id INTO v_followup_invoice FROM public.invoices WHERE delivery_id=v_followup;
    IF (SELECT status FROM public.deliveries WHERE id=v_followup) <> 'completed'
       OR (SELECT quantity_delivered FROM public.order_items WHERE id=v_order_item) <> 8
       OR (SELECT count(*) FROM public.inventory_transactions WHERE delivery_id=v_followup AND transaction_type='delivered') <> 1
       OR (SELECT sum(quantity) FROM public.inventory_transactions WHERE delivery_id=v_followup AND transaction_type='delivered') <> 5
       OR v_followup_invoice IS NULL
       OR (SELECT sum(quantity) FROM public.invoice_items WHERE invoice_id=v_followup_invoice) <> 5 THEN
      RAISE EXCEPTION 'PROOF_FAIL: unpostable quick draft prevented exact once-only follow-up completion and billing';
    END IF;
    BEGIN
      PERFORM public.post_invoice(v_invoice,public._invoice_post_version(v_invoice),gen_random_uuid()::text);
      RAISE EXCEPTION 'PROOF_FAIL: follow-up delivery made the incorrect quick draft postable';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'ORDER_INVOICE_EXCEEDS_DELIVERED:%'
         AND SQLERRM NOT LIKE 'DELIVERY_INVOICE_EXCEEDS_DELIVERED:%' THEN RAISE; END IF;
    END;
    IF v_sibling IS NOT NULL THEN
      IF coalesce((SELECT sum(quantity) FROM public.invoice_items WHERE invoice_id=v_sibling),0) NOT BETWEEN 0.0001 AND 3
         OR public._delivery_invoice_overbilling(v_sibling) IS NULL THEN
        RAISE EXCEPTION 'PROOF_FAIL: valid sibling must be individually within delivery but collectively unpostable';
      END IF;
      BEGIN
        PERFORM public.post_invoice(v_sibling,public._invoice_post_version(v_sibling),gen_random_uuid()::text);
        RAISE EXCEPTION 'PROOF_FAIL: collectively invalid quick draft group posted a valid sibling';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'DELIVERY_INVOICE_EXCEEDS_DELIVERED:%' THEN RAISE; END IF;
      END;
      PERFORM public.void_invoice(v_sibling,'[PROVER] Cancel surplus sibling draft',gen_random_uuid()::text);
    END IF;
    PERFORM public.post_invoice(v_followup_invoice,public._invoice_post_version(v_followup_invoice),gen_random_uuid()::text);
    DELETE FROM public.invoice_items WHERE invoice_id=v_invoice AND order_item_id IS NULL;
    PERFORM public.post_invoice(v_invoice,public._invoice_post_version(v_invoice),gen_random_uuid()::text);
    IF (SELECT status FROM public.invoices WHERE id=v_invoice) <> 'posted'
       OR (SELECT sum(ii.quantity) FROM public.invoice_items ii JOIN public.invoices i ON i.id=ii.invoice_id
            WHERE i.order_id=v_order AND i.status='posted' AND i.invoice_type<>'credit_memo') <> 8 THEN
      RAISE EXCEPTION 'PROOF_FAIL: corrected quick draft and follow-up did not post exactly eight physical units';
    END IF;
    RAISE NOTICE 'EDITED_QUICK_COMPLETION_PASS sibling=%',v_sibling IS NOT NULL;
  END LOOP;
END;
$proof$;
