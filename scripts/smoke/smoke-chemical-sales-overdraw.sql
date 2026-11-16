-- ============================================================================
-- ROLLED-BACK chemical-sales booking/draw proof (no field or job allocation).
-- Run this entire file as one statement against the isolated local profile.
-- It always ends with SMOKE_PASS_ROLLBACK; any other exception is a failure.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_rep_a uuid;
  v_rep_b uuid;
  v_customer uuid;
  v_product uuid;
  v_suffix text := substr(md5(random()::text), 1, 10);
  v_line jsonb;
  v_split jsonb;
  v_save jsonb;
  v_price_preview jsonb;
  v_quote_today uuid;
  v_quote_booked uuid;
  v_quote_cross_rep uuid;
  v_quote_item_today uuid;
  v_quote_item_booked uuid;
  v_quote_item_cross_rep uuid;
  v_order uuid;
  v_extra_order uuid;
  v_result jsonb;
  v_error text;
  v_row_version bigint;
  v_fails text := '';
  v_drawn numeric;
  v_status text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role='admin' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep_a FROM public.profiles WHERE role='sales_rep' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep_b FROM public.profiles WHERE role='sales_rep' AND is_active AND id<>v_rep_a ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep_a IS NULL OR v_rep_b IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: requires an active admin and two active sales reps';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  INSERT INTO public.customers(farm_name, assigned_sales_rep)
  VALUES ('[SMOKE] Overdraw Farm '||v_suffix, v_rep_a) RETURNING id INTO v_customer;
  INSERT INTO public.products(product_name, unit_size, product_form)
  VALUES ('[SMOKE] Overdraw Product '||v_suffix, 'gal', 'liquid') RETURNING id INTO v_product;
  v_split := jsonb_build_object('splits',jsonb_build_array(jsonb_build_object(
    'recipient',(SELECT full_name FROM public.profiles WHERE id=v_rep_a),
    'recipient_user_id',v_rep_a,'percentage',100)));

  -- Govern the fixture price through the same preview/apply path as production.
  -- At cost $6, Tier 1 is $7.50. Later, the live catalog moves to $8.75 while
  -- all three sent quotes retain their $7.50 snapshot.
  v_price_preview := public.preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id',v_product,
      'row_version',(SELECT pricing_version FROM public.products WHERE id=v_product),
      'pricing_mode','margin_driven','new_cost','6.00',
      'tier1_margin_percent','20','tier2_margin_percent','25','tier3_margin_percent','30',
      'change_reason','Rollback smoke chemical overdraw fixture')),
    v_admin,'smk-overdraw-price-initial-preview-'||v_suffix);
  PERFORM public.apply_product_pricing_change_set((v_price_preview->>'change_set_id')::uuid,
    v_price_preview->>'request_fingerprint',v_admin,'smk-overdraw-price-initial-apply-'||v_suffix);

  v_line := jsonb_build_object('id',NULL,'client_key','_overdraw', 'product_id',v_product,
    'sort_order',0,'notes',NULL,'calc_mode','units_direct','total_units_needed',10,
    'price_override',NULL,'price_per_unit',7.50,'current_cost',6.00,'unit_size','gal','acres',0);
  PERFORM set_config('request.jwt.claims',json_build_object('sub',v_rep_a,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_rep_a::text,true);
  FOR v_status IN SELECT unnest(ARRAY['today','booked','cross_rep']) LOOP
    v_save := public.save_quote(NULL,
      jsonb_build_object('quote_number','[SMOKE] OVERDRAW-'||v_status||'-'||v_suffix,
        'customer_id',v_customer,'status','draft','tier',1,'commission_split',v_split),
      jsonb_build_array(jsonb_build_object('section_name','Chemical Sales','sort_order',0,
        'items',jsonb_build_array(v_line))),
      v_rep_a,'smk-overdraw-save-'||v_status||'-'||v_suffix);
    v_row_version := (v_save->>'row_version')::bigint;
    IF v_status='today' THEN
      v_quote_today := (v_save->>'quote_id')::uuid;
      v_quote_item_today := (v_save->'item_ids'->>'_overdraw')::uuid;
    ELSIF v_status='booked' THEN
      v_quote_booked := (v_save->>'quote_id')::uuid;
      v_quote_item_booked := (v_save->'item_ids'->>'_overdraw')::uuid;
    ELSE
      v_quote_cross_rep := (v_save->>'quote_id')::uuid;
      v_quote_item_cross_rep := (v_save->'item_ids'->>'_overdraw')::uuid;
    END IF;
    PERFORM public.create_quote_version((v_save->>'quote_id')::uuid,v_rep_a,'presented',
      'smk-overdraw-present-'||v_status||'-'||v_suffix,v_row_version);
  END LOOP;

  -- Separate baseline check: another active rep may convert the booking and the
  -- order keeps the customer's assigned sales rep (Rep A) as salesman.
  PERFORM set_config('request.jwt.claims',json_build_object('sub',v_rep_b,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_rep_b::text,true);
  v_result := public.draw_down_quote(v_quote_cross_rep,
    jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',10)),
    v_rep_b,'smk-overdraw-cross-rep-draw-'||v_suffix,NULL);
  v_order := (v_result->>'order_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id=v_order AND quote_id=v_quote_cross_rep)
     OR NOT EXISTS (SELECT 1 FROM public.commissions WHERE order_id=v_order AND recipient_user_id=v_rep_a) THEN
    v_fails := v_fails||' cross-rep draw did not preserve commission attribution to the booking rep;';
  END IF;

  -- Reprice after all versions have been presented. The locked quote stays at
  -- $7.50; new units at today's price must use the new Tier 1 $8.75 catalog.
  PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  v_price_preview := public.preview_product_pricing_changes('product_page',NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id',v_product,
      'row_version',(SELECT pricing_version FROM public.products WHERE id=v_product),
      'pricing_mode','margin_driven','new_cost','8.75',
      'tier1_margin_percent','0','tier2_margin_percent','25','tier3_margin_percent','30',
      'change_reason','Rollback smoke catalog increase after quote presentation')),
    v_admin,'smk-overdraw-price-current-preview-'||v_suffix);
  PERFORM public.apply_product_pricing_change_set((v_price_preview->>'change_set_id')::uuid,
    v_price_preview->>'request_fingerprint',v_admin,'smk-overdraw-price-current-apply-'||v_suffix);
  IF (SELECT tier1_price FROM public.products WHERE id=v_product) IS DISTINCT FROM 8.75
     OR (SELECT current_cost FROM public.products WHERE id=v_product) IS DISTINCT FROM 8.75 THEN
    v_fails := v_fails||' governed catalog change did not produce current Tier 1 $8.75 and cost $8.75;';
  END IF;

  -- A sent booking accepts only hundredths. This refusal is checked before any
  -- order/ledger write and must not consume its ten booked units.
  PERFORM set_config('request.jwt.claims',json_build_object('sub',v_rep_b,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_rep_b::text,true);
  v_error := NULL;
  BEGIN
    PERFORM public.draw_down_quote(v_quote_today,
      jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',0.001)),
      v_rep_b,'smk-overdraw-precision-'||v_suffix,NULL);
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  IF v_error IS NULL OR v_error NOT LIKE 'BOOKING_QUANTITY_PRECISION:%' THEN
    v_fails := v_fails||' fractional-hundredths request was not refused for quantity precision: '||COALESCE(v_error,'saved')||';';
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders WHERE quote_id=v_quote_today)
     OR EXISTS (SELECT 1 FROM public.quote_product_draws WHERE quote_id=v_quote_today) THEN
    v_fails := v_fails||' precision refusal wrote an order or booking draw;';
  END IF;

  -- Draw a partial amount at the booked price, then request the remaining six
  -- plus two extra. The explicit current API choice is `today`; only the extra
  -- is priced from the current catalog and is stored on its own non-booking order.
  PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  v_result := public.draw_down_quote(v_quote_today,
    jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',4)),
    v_admin,'smk-overdraw-partial-'||v_suffix,'Admin approval for the booked $7.50 price below current $8.75 cost');
  v_result := public.draw_down_quote(v_quote_today,
    jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',8,'extra_price','today')),
    v_admin,'smk-overdraw-today-extra-'||v_suffix,'Admin approval for the booked $7.50 price below current $8.75 cost');
  v_order := (v_result->>'order_id')::uuid;
  v_extra_order := (v_result->>'extra_order_id')::uuid;
  SELECT quantity_drawn INTO v_drawn FROM public.quote_product_draws
   WHERE quote_id=v_quote_today AND product_id=v_product;
  IF v_drawn IS DISTINCT FROM 10 THEN
    v_fails := v_fails||' booked ledger is not capped at ten units after drawing the remainder plus extra;';
  END IF;
  IF (SELECT COALESCE(sum(oi.total_units_needed),0) FROM public.order_items oi
       JOIN public.orders o ON o.id=oi.order_id WHERE o.quote_id=v_quote_today) IS DISTINCT FROM 10::numeric
     OR EXISTS (SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id=oi.order_id
       WHERE o.quote_id=v_quote_today AND oi.price_per_unit IS DISTINCT FROM 7.50) THEN
    v_fails := v_fails||' booking orders did not conserve ten booked units at $7.50;';
  END IF;
  IF v_extra_order IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id=o.id
        WHERE o.id=v_extra_order AND o.quote_id IS NULL AND o.booking_draw IS DISTINCT FROM true
          AND oi.total_units_needed=2 AND oi.price_per_unit=8.75 AND oi.quote_item_id IS NULL) THEN
    v_fails := v_fails||' today-priced two-unit extra is not isolated at $8.75 outside the booking;';
  END IF;

  -- Once no booked balance remains, another quantity is refused even when the
  -- caller explicitly selects the overdraw path. It must not mint another order.
  v_error := NULL;
  BEGIN
    PERFORM public.draw_down_quote(v_quote_today,
      jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',0.01,'extra_price','today')),
      v_admin,'smk-overdraw-zero-remainder-'||v_suffix,'Admin approval reason is not a license to draw beyond a closed booking');
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  IF v_error IS NULL OR v_error NOT LIKE 'BOOKING_CLOSED:%' THEN
    v_fails := v_fails||' zero-remainder booking was not refused as closed: '||COALESCE(v_error,'saved')||';';
  END IF;
  IF (SELECT count(*) FROM public.orders WHERE quote_id=v_quote_today)<>2 THEN
    v_fails := v_fails||' zero-remainder refusal changed the pair of booking/extra orders;';
  END IF;

  -- At booked price, the extra is below the current cost. A rep cannot approve
  -- it even with a reason; an admin must repeat the same business request with
  -- an explicit reason. The refused attempt is transactional and leaves no rows.
  PERFORM set_config('request.jwt.claims',json_build_object('sub',v_rep_b,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_rep_b::text,true);
  v_error := NULL;
  BEGIN
    PERFORM public.draw_down_quote(v_quote_booked,
      jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',12,'extra_price','booked')),
      v_rep_b,'smk-overdraw-booked-rep-denied-'||v_suffix,'Rep approval is not permitted');
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  IF v_error IS NULL OR v_error NOT LIKE 'BELOW_COST_ADMIN_REQUIRED:%' THEN
    v_fails := v_fails||' below-cost booked-price extra was not refused to a rep: '||COALESCE(v_error,'saved')||';';
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders WHERE quote_id=v_quote_booked) THEN
    v_fails := v_fails||' refused rep booked-price extra left order rows;';
  END IF;
  PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  v_result := public.draw_down_quote(v_quote_booked,
    jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',12,'extra_price','booked')),
    v_admin,'smk-overdraw-booked-admin-approved-'||v_suffix,'Admin approved booked-price extra below current cost for the invented local customer');
  v_extra_order := (v_result->>'extra_order_id')::uuid;
  IF v_extra_order IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id=v_extra_order
        AND oi.total_units_needed=2 AND oi.price_per_unit=7.50 AND oi.cost_per_unit=8.75)
     OR NOT EXISTS (SELECT 1 FROM public.below_cost_approvals a WHERE a.entity_type='order'
        AND a.entity_id=v_extra_order AND a.actor_user_id=v_admin AND a.reason LIKE 'Admin approved booked-price extra%') THEN
    v_fails := v_fails||' admin-approved booked-price extra was not saved at $7.50 with its approval audit;';
  END IF;

  IF v_fails<>'' THEN RAISE EXCEPTION 'SMOKE_FAIL:%',v_fails; END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK (chemical sales overdraw preserves booked $7.50 tiers, uses current $8.75 only for selected extras, rejects zero remainder and fractional hundredths, gates below-cost booked extras to an admin reason, and permits cross-rep conversion with original sales attribution)';
END
$smoke$;
