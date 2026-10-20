-- ============================================================================
-- CONTAINER ONLY smoke chain for 20261020210000_blend_ticket_pricing_guards.
-- Run through scripts/smoke/prove-blend-ticket-pricing-guards-real-schema.mjs, never against the
-- live database: it creates orders and invoices, which draw customer-visible order and invoice
-- numbers from sequences that a rollback does not return.
--
-- Rules under test (Goal 3 "Pricing", Mason 2026-10-15):
--   * an order made from a blend ticket never prices a product at $0 because a tier price is
--     missing: the tier-1 price is used, and a product with no price at all is refused;
--   * a blend-ticket invoice never bills a product at $0 because it has no price;
--   * when the job's quote lists the same product more than once at different prices, the blend
--     invoice stops and lists the choices; staff pick one, and it bills as the quoted price;
--   * the same product twice at the same price is not ambiguous.
--
-- Runs as the table owner with request.jwt.claims set to an admin (and a sales rep for the
-- own-name step), so every function sees the auth.uid() it sees on live. Every refused step must
-- leave nothing behind. Terminal SMOKE_PASS_ROLLBACK.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_other_rep uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_p_full uuid;
  v_p_t1only uuid;
  v_p_none uuid;
  v_pricing jsonb;
  v_customer uuid;
  v_field uuid;
  v_quote uuid;
  v_section uuid;
  v_job uuid;
  v_qi_700 uuid;
  v_qi_750 uuid;
  v_qi_t1_a uuid;
  v_qi_t1_b uuid;
  v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid; v_t5 uuid; v_t6 uuid;
  v_line_full uuid;
  v_line_other uuid;
  v_json json;
  v_res jsonb;
  v_res2 jsonb;
  v_detail jsonb;
  v_err text;
  v_err_detail text;
  v_count int;
  v_cents bigint;
  v_numeric numeric;
  v_text text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_rep FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_other_rep FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true AND id IS DISTINCT FROM v_rep
   ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_other_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin and two active sales reps are required';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Three products: fully priced, tier-1 only, and never priced (products are born pricing-free;
  -- the two priced ones go through the governed preview/apply path).
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] BTP Full ' || v_suffix, 'GL') RETURNING id INTO v_p_full;
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] BTP Tier1Only ' || v_suffix, 'GL') RETURNING id INTO v_p_t1only;
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] BTP Unpriced ' || v_suffix, 'GL') RETURNING id INTO v_p_none;
  v_pricing := public.preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p_full, 'row_version', 1, 'pricing_mode', 'price_driven',
        'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '9.00', 'tier3_price', '8.00'),
      jsonb_build_object('product_id', v_p_t1only, 'row_version', 1, 'pricing_mode', 'price_driven',
        'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '9.00', 'tier3_price', '8.00')),
    v_admin, 'e2e-btp-pricing-preview-' || v_suffix);
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin,
    'e2e-btp-pricing-apply-' || v_suffix);
  -- The governed path always writes all three tiers, but live still holds legacy products with a
  -- tier left blank (4 with no tier 2 on 2026-10-20). Recreate one: as the table owner, with the
  -- pricing guards off for this one statement (container only; the transaction rolls back). Before
  -- this change the order body priced it at $0 for a tier-2 customer, which the below-cost line
  -- guard then refused (BELOW_COST_CONTEXT_REQUIRED, every order line needs a cost), so the order
  -- could not be made at all and staff saw a below-cost error instead of the tier-1 price.
  EXECUTE 'ALTER TABLE public.products DISABLE TRIGGER USER';
  UPDATE public.products SET tier2_price = NULL, tier3_price = NULL WHERE id = v_p_t1only;
  EXECUTE 'ALTER TABLE public.products ENABLE TRIGGER USER';
  IF (SELECT tier1_price FROM public.products WHERE id = v_p_t1only) IS DISTINCT FROM 10.00
     OR (SELECT tier2_price FROM public.products WHERE id = v_p_t1only) IS NOT NULL
     OR (SELECT tier1_price FROM public.products WHERE id = v_p_none) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the tier-1-only or unpriced fixture product has unexpected prices';
  END IF;

  -- A tier-2 customer and one 10-acre field.
  INSERT INTO public.customers (farm_name, assigned_tier)
  VALUES ('[E2E] BTP Farm ' || v_suffix, 2) RETURNING id INTO v_customer;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[E2E] BTP Field ' || v_suffix, 'corn', 10) RETURNING id INTO v_field;

  -- The job's quote: the full product twice at different prices, the tier-1-only product twice at
  -- the same price.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned)
  VALUES ('[E2E] BTP-Q-' || v_suffix, v_customer, v_admin, 'sent', true) RETURNING id INTO v_quote;
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, '[E2E] BTP Section', 0) RETURNING id INTO v_section;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section, v_p_full, 0, 7.00, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_700;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section, v_p_full, 1, 7.50, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_750;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section, v_p_t1only, 2, 6.00, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_t1_a;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section, v_p_t1only, 3, 6.00, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_t1_b;
  INSERT INTO public.jobs (job_number, customer_id, job_date, status, quote_id, quote_section_id, total_acres)
  VALUES ('E2E-BTP-J-' || v_suffix, v_customer, v_today, 'scheduled', v_quote, v_section, 10) RETURNING id INTO v_job;

  -- Six approved, unbilled tickets (T5 and T6 on the job; T6 names another rep).
  FOR v_count IN 1..6 LOOP
    INSERT INTO public.blend_tickets (
      ticket_number, uploaded_by, customer_id, salesman_id, status, review_status,
      payment_status, order_link_status, season, total_acres, source, job_id
    ) VALUES (
      '[E2E]-BTP-' || v_count || '-' || v_suffix, v_admin, v_customer,
      CASE WHEN v_count = 6 THEN v_other_rep END,
      'completed', 'approved', 'unbilled', 'unlinked', public.current_season(), 10, 'manual',
      CASE WHEN v_count IN (5, 6) THEN v_job END
    ) RETURNING id INTO v_t6;
    INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
    VALUES (v_t6, v_field, v_customer, 10);
    CASE v_count
      WHEN 1 THEN v_t1 := v_t6;
      WHEN 2 THEN v_t2 := v_t6;
      WHEN 3 THEN v_t3 := v_t6;
      WHEN 4 THEN v_t4 := v_t6;
      WHEN 5 THEN v_t5 := v_t6;
      ELSE NULL;
    END CASE;
  END LOOP;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t1, v_p_t1only, '[E2E] BTP t1 line', 20, 'GL', 2, 'gal/ac', 1),
         (v_t2, v_p_full, '[E2E] BTP t2 full', 20, 'GL', 2, 'gal/ac', 1),
         (v_t2, v_p_none, '[E2E] BTP t2 unpriced', 20, 'GL', 2, 'gal/ac', 2),
         (v_t3, v_p_t1only, '[E2E] BTP t3 line', 20, 'GL', 2, 'gal/ac', 1),
         (v_t4, v_p_none, '[E2E] BTP t4 unpriced', 20, 'GL', 2, 'gal/ac', 1),
         (v_t5, v_p_t1only, '[E2E] BTP t5 same-price', 20, 'GL', 2, 'gal/ac', 2);
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t5, v_p_full, '[E2E] BTP t5 two-price', 20, 'GL', 2, 'gal/ac', 1) RETURNING id INTO v_line_full;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t6, v_p_full, '[E2E] BTP t6 other rep', 20, 'GL', 2, 'gal/ac', 1) RETURNING id INTO v_line_other;

  -- 1. Order: a tier-2 customer, a product with no tier-2 price -> priced at tier 1, never $0.
  BEGIN
    v_json := public.create_order_from_blend_ticket(v_t1, 'E2E-BTP-1-' || v_suffix, v_today, NULL, v_admin, 'e2e-btp-order-1-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: the tier-1 fallback order was refused: %', v_err;
  END;
  IF (v_json::jsonb->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the tier-1 fallback order was not created: %', v_json;
  END IF;
  SELECT oi.price_per_unit, o.total_price INTO v_numeric, v_cents
    FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
   WHERE o.id = (v_json::jsonb->>'order_id')::uuid;
  IF v_numeric IS DISTINCT FROM 10.00 OR v_cents IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an order line was priced at % (order total %) when the tier-2 price was missing; expected the 10.00 tier-1 price', v_numeric, v_cents;
  END IF;

  -- 2. Order: a product with no price at all -> refused, naming it; nothing written.
  BEGIN
    v_json := public.create_order_from_blend_ticket(v_t2, 'E2E-BTP-2-' || v_suffix, v_today, NULL, v_admin, 'e2e-btp-order-2-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: an order was made from a blend ticket with an unpriced product: %', v_json;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_PRICE_MISSING:%' || '[E2E] BTP Unpriced ' || v_suffix || '%'
       OR v_err LIKE '%[E2E] BTP Full %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong unpriced-order refusal: %', v_err;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.orders WHERE order_number = 'E2E-BTP-2-' || v_suffix)
     OR (SELECT order_link_status FROM public.blend_tickets WHERE id = v_t2) IS DISTINCT FROM 'unlinked' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused order left an order behind or linked the ticket';
  END IF;

  -- 3. Invoice: a tier-2 customer, no tier-2 price -> billed at the tier-1 price.
  v_res := public.create_invoice_from_blend_ticket(v_t3, v_admin, 'e2e-btp-invoice-3-' || v_suffix);
  SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_text
    FROM public.invoice_items ii
   WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = v_p_t1only;
  IF v_cents IS DISTINCT FROM 1000 OR v_text IS DISTINCT FROM 'tier' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the tier-1 fallback invoice line billed % (%), expected 1000 cents (tier)', v_cents, v_text;
  END IF;

  -- 4. Invoice: a product with no price at all -> refused, naming it; nothing written.
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t4, v_admin, 'e2e-btp-invoice-4-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a blend-ticket invoice billed an unpriced product: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_PRICE_MISSING:%' || '[E2E] BTP Unpriced ' || v_suffix || '%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong unpriced-invoice refusal: %', v_err;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE blend_ticket_id = v_t4)
     OR (SELECT payment_status FROM public.blend_tickets WHERE id = v_t4) IS DISTINCT FROM 'unbilled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused unpriced invoice left an invoice behind or billed the ticket';
  END IF;

  -- 5. Invoice: the quote lists the product twice at different prices -> stops with the choices.
  --    The same product twice at the same price is not listed.
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t5, v_admin, 'e2e-btp-invoice-5-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a blend-ticket invoice picked one of two quoted prices without asking: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_err_detail = PG_EXCEPTION_DETAIL;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong duplicate-quote-line refusal: %', v_err;
    END IF;
  END;
  v_detail := v_err_detail::jsonb;
  IF jsonb_array_length(v_detail->'products') <> 1
     OR (v_detail->'products'->0->>'blend_ticket_product_id')::uuid IS DISTINCT FROM v_line_full
     OR (v_detail->'products'->0->>'product_id')::uuid IS DISTINCT FROM v_p_full
     OR (v_detail->'products'->0->'options') IS DISTINCT FROM jsonb_build_array(
          jsonb_build_object('quote_item_id', v_qi_700, 'price_cents', 700),
          jsonb_build_object('quote_item_id', v_qi_750, 'price_cents', 750)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the choices handed to the screen are wrong: %', v_err_detail;
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE blend_ticket_id = v_t5) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a stopped duplicate-quote-line invoice left an invoice behind';
  END IF;

  -- 6. The pick refuses: no key, a forged actor, and a quote line for another product.
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_750, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: a price was picked with no idempotency key';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong no-key refusal: %', v_err; END IF;
  END;
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_750, v_rep, 'e2e-btp-pick-forged-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a price was picked under a forged actor';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'ACTOR_MISMATCH' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong forged-actor refusal: %', v_err; END IF;
  END;
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_t1_a, v_admin, 'e2e-btp-pick-wrong-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a quote line for another product was accepted as the pick: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_QUOTE_PRICE_INVALID_CHOICE:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong invalid-choice refusal: %', v_err; END IF;
  END;
  IF (SELECT unit_price_cents FROM public.blend_ticket_products WHERE id = v_line_full) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused pick stored a price';
  END IF;

  -- 7. Staff pick the 7.50 line; the same key replays the same answer and refuses another pick.
  v_res := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_750, v_admin, 'e2e-btp-pick-' || v_suffix);
  IF (v_res->>'unit_price_cents')::bigint IS DISTINCT FROM 750
     OR (SELECT unit_price_cents FROM public.blend_ticket_products WHERE id = v_line_full) IS DISTINCT FROM 750 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the picked price was not stored: %', v_res;
  END IF;
  v_res2 := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_750, v_admin, 'e2e-btp-pick-' || v_suffix);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the pick replay returned % instead of %', v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_700, v_admin, 'e2e-btp-pick-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a reused pick key stored a different price: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'IDEMPOTENCY_INTENT_MISMATCH' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong reused-key refusal: %', v_err; END IF;
  END;

  -- 8. The invoice now bills the picked price as quoted, and the same-price line at its quote.
  v_res := public.create_invoice_from_blend_ticket(v_t5, v_admin, 'e2e-btp-invoice-5b-' || v_suffix);
  SELECT ii.unit_price_cents, ii.price_source, ii.quoted_price_cents INTO v_cents, v_text, v_numeric
    FROM public.invoice_items ii
   WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = v_p_full;
  IF v_cents IS DISTINCT FROM 750 OR v_text IS DISTINCT FROM 'quoted' OR v_numeric IS DISTINCT FROM 750 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the picked price billed % (%, quoted %), expected 750 cents as quoted', v_cents, v_text, v_numeric;
  END IF;
  SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_text
    FROM public.invoice_items ii
   WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = v_p_t1only;
  IF v_cents IS DISTINCT FROM 600 OR v_text IS DISTINCT FROM 'quoted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the same-price quote line billed % (%), expected 600 cents as quoted', v_cents, v_text;
  END IF;

  -- 9. Once billed, the pick is locked.
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_700, v_admin, 'e2e-btp-pick-late-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a price was picked on a billed ticket: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_QUOTE_PRICE_LOCKED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong billed-ticket refusal: %', v_err; END IF;
  END;

  -- 10. Own name: a sales rep cannot pick a price on another rep's ticket.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_other, v_qi_750, v_rep, 'e2e-btp-pick-rep-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep picked a price on another rep''s ticket: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong own-name refusal: %', v_err; END IF;
  END;
  IF (SELECT unit_price_cents FROM public.blend_ticket_products WHERE id = v_line_other) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused own-name pick stored a price';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
