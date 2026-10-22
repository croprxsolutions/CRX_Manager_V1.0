-- Post-apply rollback-only chain for 20261021155000_split_payer_return_credit: a field owner billed
-- through a split (a customer other than the order's) can return its billed share and receive its
-- own return credit, and no payer can return another payer's share.
--
-- FAIL-FIRST CONTRACT: before the fix create_return refuses any returner other than the order's
-- customer (RETURN_ORDER_CUSTOMER_MISMATCH), and this chain raises SMOKE_FAIL at step 1. Against
-- the fix:
--   0. setup: an order for customer A with two lines on one field billed 50/50 to A and landlord B
--      (line 1: 4 GL at 10.00; line 2: 1 GL at 10.01, whose cents split unevenly), delivered in full
--      through complete_delivery, split into two governed invoices and posted;
--   1. B returns 1 GL of line 1: the return is B's, priced 10.00 from B's own billed cents;
--   2. refusals: B returning more than its open share (RETURN_QUANTITY_EXCEEDS_BILLED_SHARE); A
--      returning more than A was billed although the goods were delivered (same code); customer D,
--      billed nothing on the order (RETURN_ORDER_CUSTOMER_MISMATCH);
--   3. B's return is approved, received (restocked) and credited: one posted credit memo for B on
--      A's order, -10.00, its one line backed by B's split invoice line, the claim gone;
--   4. the memo is applied to B's split invoice (the guard admits the memo's UPDATE as the credit of
--      B's return);
--   (1 also checks the Returns screen's read-only lookups: B may then return 1 GL / 0.5 GL more, A
--    2 GL, D nothing;)
--   5. B's whole share of line 2 credits exactly what B was billed for it, not a cent more;
--   5b. on a second split order whose invoices are still drafts, A cannot return anything
--      (RETURN_SPLIT_SHARE_NOT_BILLED);
--   6. the guard still refuses a credit memo for B on A's order with no claim, and a memo for D
--      inside a claim for B (INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID).
--
-- Fixtures: an [E2E]-marked product priced through the governed preview/apply path, three
-- customers and one field. Runs as the earliest active admin. One DO block, terminal exception ->
-- nothing commits. CONTAINER ONLY: delivering, invoicing and crediting draw customer-visible numbers.
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;  -- the business date
  v_admin uuid;
  v_a uuid;
  v_b uuid;
  v_d uuid;
  v_field uuid;
  v_product uuid;
  v_pricing jsonb;
  v_order uuid;
  v_line1 uuid;
  v_line2 uuid;
  v_delivery uuid;
  v_group uuid;
  v_b_invoice uuid;
  v_b_line1_item uuid;
  v_b_line2_cents bigint;
  v_return uuid;
  v_return2 uuid;
  v_return3 uuid;
  v_memo uuid;
  v_order2 uuid;
  v_line3 uuid;
  v_delivery2 uuid;
  v_res jsonb;
  v_err text;
BEGIN
  SELECT id INTO v_admin
    FROM public.profiles
   WHERE role = 'admin' AND is_active = true
   ORDER BY created_at
   LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- 0. Setup. Order lines need a positive cost basis, so price a fresh product shell through the
  --    governed preview/apply path.
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] Split Payer Return Product ' || v_suffix, 'GL') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page',
    NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00'
    )),
    v_admin,
    'e2e-split-return-pricing-preview-' || v_suffix
  );
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid,
    v_pricing->>'request_fingerprint',
    v_admin,
    'e2e-split-return-pricing-apply-' || v_suffix
  );
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 100, 0, 'GL');

  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Split Return A ' || v_suffix) RETURNING id INTO v_a;
  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Split Return B ' || v_suffix) RETURNING id INTO v_b;
  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Split Return D ' || v_suffix) RETURNING id INTO v_d;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_a, '[E2E] Split Return Field ' || v_suffix, 'corn', 100) RETURNING id INTO v_field;
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary)
  VALUES (v_field, v_a, 50, true), (v_field, v_b, 50, false);

  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-SPLIT-RETURN-' || v_suffix, v_a, v_today, 'confirmed', false, NULL)
  RETURNING id INTO v_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit, unit_size,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_order, v_product, '[E2E] split return line 1', 10, 5, 'GL', 4, 40, 20, 50, 0, 4, 1
  ) RETURNING id INTO v_line1;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit, unit_size,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_order, v_product, '[E2E] split return line 2', 10.01, 5, 'GL', 1, 10.01, 5.01, 50, 0, 1, 2
  ) RETURNING id INTO v_line2;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_line1, v_field, 100), (v_line2, v_field, 100);

  -- Deliver everything through the canonical completion boundary. A same-day completion of a
  -- field-allocated order creates the per-owner split drafts itself; create them if it did not.
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('E2E-SPLIT-RETURN-D-' || v_suffix, v_order, v_a, v_today, 'scheduled', v_admin)
  RETURNING id INTO v_delivery;
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES (v_delivery, v_line1, v_product, 4, 4, 'GL'), (v_delivery, v_line2, v_product, 1, 1, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;
  v_res := public.complete_delivery(
    v_delivery, '[E2E] Split Return Receiver', v_admin,
    NULL, NULL, NULL, 'e2e-split-return-complete-' || v_suffix, now()
  );
  IF v_res->>'delivery_id' IS DISTINCT FROM v_delivery::text THEN
    RAISE EXCEPTION 'SMOKE_SETUP: complete_delivery returned an unexpected receipt: %', v_res;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_order AND invoice_group_id IS NOT NULL) THEN
    PERFORM public.create_split_invoices_from_order(v_order, NULL, 'chemical_sale', 'e2e-split-return-split-' || v_suffix);
  END IF;
  SELECT invoice_group_id INTO v_group
    FROM public.invoices WHERE order_id = v_order AND invoice_group_id IS NOT NULL LIMIT 1;
  PERFORM public.post_invoice_group(v_group, v_admin, 'e2e-split-return-post-' || v_suffix);
  SELECT i.id INTO v_b_invoice
    FROM public.invoices i WHERE i.invoice_group_id = v_group AND i.customer_id = v_b;
  SELECT ii.id INTO v_b_line1_item
    FROM public.invoice_items ii WHERE ii.invoice_id = v_b_invoice AND ii.order_item_id = v_line1;
  SELECT ii.extended_cents INTO v_b_line2_cents
    FROM public.invoice_items ii WHERE ii.invoice_id = v_b_invoice AND ii.order_item_id = v_line2;
  IF v_b_invoice IS NULL
     OR (SELECT count(*) FROM public.invoices WHERE invoice_group_id = v_group) <> 2
     OR EXISTS (SELECT 1 FROM public.invoices WHERE invoice_group_id = v_group AND status IS DISTINCT FROM 'posted')
     OR (SELECT ii.quantity FROM public.invoice_items ii WHERE ii.id = v_b_line1_item) IS DISTINCT FROM 2::numeric
     OR (SELECT ii.extended_cents FROM public.invoice_items ii WHERE ii.id = v_b_line1_item) IS DISTINCT FROM 2000::bigint
     OR v_b_line2_cents IS NULL OR v_b_line2_cents NOT IN (500, 501) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the delivered order did not split into posted A and B invoices (B line 1: 2 GL, 20.00)';
  END IF;

  -- 1. B, the landlord, returns 1 GL of line 1. FAIL-FIRST: before 20261021155000 the return must
  --    be the order customer's.
  BEGIN
    v_res := public.create_return(
      jsonb_build_object('customer_id', v_b, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line1, 'quantity', 1, 'condition', 'unopened', 'restock', true)),
      'e2e-split-return-create-b1-' || v_suffix
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: a split payer''s return was refused: %', v_err;
  END;
  v_return := (v_res->>'return_id')::uuid;
  IF (SELECT customer_id FROM public.returns WHERE id = v_return) IS DISTINCT FROM v_b
     OR (SELECT extended_cents FROM public.return_items WHERE return_id = v_return) IS DISTINCT FROM 1000::bigint
     OR (SELECT unit_price_cents FROM public.return_items WHERE return_id = v_return) IS DISTINCT FROM 1000::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B''s return is not B''s 1 GL at 10.00';
  END IF;
  -- The Returns screen's read-only lookups follow the same rule: with B's 1 GL open, B may return
  -- 1 GL more of line 1 and 0.5 GL of line 2, A 2 GL of line 1, D nothing; the order is among B's
  -- split-billed orders.
  IF NOT (v_order IN (SELECT public.get_split_payer_return_orders(v_b)))
     OR (SELECT returnable_qty FROM public.get_return_line_allowances(v_order, v_b) WHERE order_item_id = v_line1) IS DISTINCT FROM 1::numeric
     OR (SELECT returnable_qty FROM public.get_return_line_allowances(v_order, v_b) WHERE order_item_id = v_line2) IS DISTINCT FROM 0.5::numeric
     OR (SELECT returnable_qty FROM public.get_return_line_allowances(v_order, v_a) WHERE order_item_id = v_line1) IS DISTINCT FROM 2::numeric
     OR EXISTS (SELECT 1 FROM public.get_return_line_allowances(v_order, v_d)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the return lookups do not show B 1 GL / 0.5 GL, A 2 GL, and nothing for D';
  END IF;
  -- The screen shows each payer's credit per unit from its own billed cents, not the order price:
  -- B 10.00 on line 1 (20.00 for 2 GL), and 10.00 or 10.02 on line 2 (5.00 or 5.01 for 0.5 GL).
  IF (SELECT unit_credit_cents FROM public.get_return_line_allowances(v_order, v_b) WHERE order_item_id = v_line1) IS DISTINCT FROM 1000::bigint
     OR (SELECT unit_credit_cents FROM public.get_return_line_allowances(v_order, v_b) WHERE order_item_id = v_line2) IS DISTINCT FROM (v_b_line2_cents * 2)::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the return lookup does not show B''s credit per unit from B''s own billed cents';
  END IF;

  -- 2a. B cannot return more than its open billed share (2 GL billed, 1 GL already open).
  BEGIN
    PERFORM public.create_return(
      jsonb_build_object('customer_id', v_b, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line1, 'quantity', 1.5)),
      'e2e-split-return-create-b-over-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: B returned more than its billed share';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('RETURN_QUANTITY_EXCEEDS_BILLED_SHARE' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: B''s over-share return failed for the wrong reason: %', v_err;
    END IF;
  END;
  -- 2b. A cannot return B's share: 3 GL fit the delivered 4 GL (1 GL open), but A was billed 2 GL.
  BEGIN
    PERFORM public.create_return(
      jsonb_build_object('customer_id', v_a, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line1, 'quantity', 3)),
      'e2e-split-return-create-a-over-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: the order customer returned the landlord''s share';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('RETURN_QUANTITY_EXCEEDS_BILLED_SHARE' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: A''s over-share return failed for the wrong reason: %', v_err;
    END IF;
  END;
  -- 2c. D, billed nothing on the order, cannot return from it.
  BEGIN
    PERFORM public.create_return(
      jsonb_build_object('customer_id', v_d, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line1, 'quantity', 1)),
      'e2e-split-return-create-d-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a customer billed nothing on the order returned from it';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('RETURN_ORDER_CUSTOMER_MISMATCH' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: D''s return failed for the wrong reason: %', v_err;
    END IF;
  END;

  -- 3. Approve, receive and credit B's return.
  BEGIN
    PERFORM public.approve_return(v_return, v_admin, 'e2e-split-return-approve-' || v_suffix);
    PERFORM public.receive_return(v_return, v_admin, 'e2e-split-return-receive-' || v_suffix);
    v_res := public.issue_return_credit(v_return, v_admin, 'e2e-split-return-credit-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s return could not be received and credited: %', v_err;
  END;
  SELECT credit_invoice_id INTO v_memo FROM public.returns WHERE id = v_return;
  IF (SELECT status FROM public.returns WHERE id = v_return) IS DISTINCT FROM 'credited'
     OR (SELECT bool_and(restocked) FROM public.return_items WHERE return_id = v_return) IS DISTINCT FROM true
     OR (SELECT i.customer_id FROM public.invoices i WHERE i.id = v_memo) IS DISTINCT FROM v_b
     OR (SELECT i.order_id FROM public.invoices i WHERE i.id = v_memo) IS DISTINCT FROM v_order
     OR (SELECT i.invoice_type FROM public.invoices i WHERE i.id = v_memo) IS DISTINCT FROM 'credit_memo'
     OR (SELECT i.status FROM public.invoices i WHERE i.id = v_memo) IS DISTINCT FROM 'posted'
     OR (SELECT i.total_amount_cents FROM public.invoices i WHERE i.id = v_memo) IS DISTINCT FROM -1000::bigint
     OR (SELECT count(*) FROM public.invoice_items ii WHERE ii.invoice_id = v_memo AND ii.quantity < 0) <> 1
     OR EXISTS (SELECT 1 FROM public.invoice_items ii
                 WHERE ii.invoice_id = v_memo AND ii.quantity < 0
                   AND ii.return_credit_source_item_id IS DISTINCT FROM v_b_line1_item)
     OR EXISTS (SELECT 1 FROM public.return_credit_customer_claims) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B''s credit is not one posted -10.00 memo for B on the order, backed by B''s own line';
  END IF;

  -- 4. Apply the memo to B's split invoice.
  BEGIN
    PERFORM public.apply_credit_memo_to_invoice(v_memo, v_b_invoice, 1000, v_admin, 'e2e-split-return-apply-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s credit memo could not be applied to B''s invoice: %', v_err;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.credit_memo_applications cma
     WHERE cma.credit_memo_id = v_memo AND cma.target_invoice_id = v_b_invoice AND cma.amount_cents = 1000
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no 10.00 application of B''s memo to B''s invoice was recorded';
  END IF;

  -- 5. Returning B's whole line-2 share (0.5 GL of 1 GL at 10.01, billed 5.00 or 5.01 by the split's
  --    penny rounding) credits exactly what B was billed for it. The quantities are chosen so the
  --    order-price formula (quantity x 10.01) misses B's cents either way: one 0.5 GL return when B
  --    was billed 5.00 (order price: 5.01), two 0.25 GL returns when B was billed 5.01 (order
  --    price: 2.50 + 2.50). Each return is received and credited.
  BEGIN
    v_res := public.create_return(
      jsonb_build_object('customer_id', v_b, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line2,
        'quantity', CASE WHEN v_b_line2_cents = 500 THEN 0.5 ELSE 0.25 END, 'restock', true)),
      'e2e-split-return-create-b2-' || v_suffix
    );
    v_return2 := (v_res->>'return_id')::uuid;
    IF v_b_line2_cents = 501 THEN
      v_res := public.create_return(
        jsonb_build_object('customer_id', v_b, 'order_id', v_order, 'reason', 'defective'),
        jsonb_build_array(jsonb_build_object('order_item_id', v_line2, 'quantity', 0.25, 'restock', true)),
        'e2e-split-return-create-b3-' || v_suffix
      );
      v_return3 := (v_res->>'return_id')::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s partial return of line 2 was refused: %', v_err;
  END;
  IF (SELECT sum(extended_cents) FROM public.return_items WHERE return_id IN (v_return2, v_return3))
       IS DISTINCT FROM v_b_line2_cents::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B''s partial returns of line 2 do not add up to B''s billed % cents', v_b_line2_cents;
  END IF;
  BEGIN
    PERFORM public.approve_return(v_return2, v_admin, 'e2e-split-return-approve-b2-' || v_suffix);
    PERFORM public.receive_return(v_return2, v_admin, 'e2e-split-return-receive-b2-' || v_suffix);
    IF v_return3 IS NOT NULL THEN
      PERFORM public.approve_return(v_return3, v_admin, 'e2e-split-return-approve-b3-' || v_suffix);
      PERFORM public.receive_return(v_return3, v_admin, 'e2e-split-return-receive-b3-' || v_suffix);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s line-2 return could not be received: %', v_err;
  END;
  BEGIN
    PERFORM public.issue_return_credit(v_return2, v_admin, 'e2e-split-return-credit-b2-' || v_suffix);
    IF v_return3 IS NOT NULL THEN
      PERFORM public.issue_return_credit(v_return3, v_admin, 'e2e-split-return-credit-b3-' || v_suffix);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s line-2 return could not be credited: %', v_err;
  END;
  IF (SELECT -sum(i.total_amount_cents) FROM public.returns r JOIN public.invoices i ON i.id = r.credit_invoice_id
       WHERE r.id IN (v_return2, v_return3)) IS DISTINCT FROM v_b_line2_cents::numeric
     OR EXISTS (SELECT 1 FROM public.returns r JOIN public.invoices i ON i.id = r.credit_invoice_id
                 WHERE r.id IN (v_return2, v_return3) AND i.customer_id IS DISTINCT FROM v_b) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B''s line-2 credits are not exactly B''s billed % cents, all to B', v_b_line2_cents;
  END IF;

  -- 5b. On a second split order whose per-owner invoices are still drafts, the order's own customer
  --     cannot return anything: nothing is billed to A yet, and the split will bill part to B.
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-SPLIT-RETURN-2-' || v_suffix, v_a, v_today, 'confirmed', false, NULL)
  RETURNING id INTO v_order2;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit, unit_size,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_order2, v_product, '[E2E] split return draft line', 10, 5, 'GL', 2, 20, 10, 50, 0, 2, 1
  ) RETURNING id INTO v_line3;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_line3, v_field, 100);
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('E2E-SPLIT-RETURN-D2-' || v_suffix, v_order2, v_a, v_today, 'scheduled', v_admin)
  RETURNING id INTO v_delivery2;
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES (v_delivery2, v_line3, v_product, 2, 2, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery2;
  PERFORM public.complete_delivery(
    v_delivery2, '[E2E] Split Return Receiver', v_admin,
    NULL, NULL, NULL, 'e2e-split-return-complete-2-' || v_suffix, now()
  );
  IF EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_order2 AND status IN ('posted', 'overdue', 'paid')) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the second split order already has a posted invoice';
  END IF;
  BEGIN
    PERFORM public.create_return(
      jsonb_build_object('customer_id', v_a, 'order_id', v_order2, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line3, 'quantity', 1)),
      'e2e-split-return-create-a-draft-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: the order customer returned goods its unposted split had not billed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('RETURN_SPLIT_SHARE_NOT_BILLED' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the draft-split return failed for the wrong reason: %', v_err;
    END IF;
  END;

  -- 6a. The guard: a credit memo for B on A's order, outside any claim.
  BEGIN
    INSERT INTO public.invoices (order_id, customer_id, invoice_type, status, season, created_by,
      total_amount_cents, invoice_date)
    VALUES (v_order, v_b, 'credit_memo', 'draft', public.current_season(), v_admin, -100, v_today);
    RAISE EXCEPTION 'SMOKE_FAIL: an unclaimed credit memo billed another customer on the order';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the unclaimed memo failed for the wrong reason: %', v_err;
    END IF;
  END;
  -- 6b. A credit memo for D inside a claim for B.
  BEGIN
    INSERT INTO public.return_credit_customer_claims (return_id, order_id, customer_id)
    VALUES (v_return2, v_order, v_b);
    INSERT INTO public.invoices (order_id, customer_id, invoice_type, status, season, created_by,
      total_amount_cents, invoice_date)
    VALUES (v_order, v_d, 'credit_memo', 'draft', public.current_season(), v_admin, -100, v_today);
    RAISE EXCEPTION 'SMOKE_FAIL: a claim for B admitted a credit memo for another customer';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the memo for D failed for the wrong reason: %', v_err;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
