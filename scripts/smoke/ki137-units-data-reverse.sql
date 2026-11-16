-- Rollback for supabase/migrations/20270111100000_ki137_powder_keg_each_piksi_mg_labels.sql (proven by
-- scripts/smoke/prove-units-batch-real-schema.mjs). Run units-batch-rules-reverse.sql first.
-- Puts Powder Keg back to Lb (product, family, stock rows, open order lines) and Piksi's pinned labels back to
-- "Dry oz". A new open cost basis is written at the same cents (history rows cannot be deleted).
-- REFUSES (changes nothing) once anything was written for these three products after the correction (a new line,
-- a delivery, a stock movement, a receipt, a quote, invoice or remainder line, a cost, price or family change):
-- those were made per each / per MG and would be relabelled wrongly.
-- To use it live, copy it into a new migration through the gates.
DO $ki137_reverse$
DECLARE
  v_done integer;
  v_at   timestamptz;
  c_corn constant uuid := '0b2e713b-4962-4c49-ae3a-6074ddac1464';
  c_soy  constant uuid := '17ccc5ba-7e98-49bf-9510-4d57c0eda962';
  c_piks constant uuid := '36732b8d-b4ed-4643-8a13-d793975d13c7';
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  LOCK TABLE public.products, public.product_parents, public.product_cost_basis, public.inventory,
             public.inventory_transactions, public.purchase_order_items, public.order_items, public.delivery_items,
             public.quote_items, public.quote_versions, public.invoice_items, public.delivery_remainders
             IN SHARE ROW EXCLUSIVE MODE;
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND tgname = 'trg_validate_product_setup_fields') IS DISTINCT FROM 'O'
     OR (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND tgname = 'trigger_zz_guard_product_parent_values') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'KI137_REVERSE_GUARD_STATE: a product guard is not in its normal on state. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'a1_line_unit_is_stock_unit') THEN
    RAISE EXCEPTION 'KI137_REVERSE_ORDER: run units-batch-rules-reverse.sql first. Nothing was changed.';
  END IF;
  SELECT min(created_at) INTO v_at FROM public.product_cost_basis
   WHERE product_id IN (c_corn, c_soy) AND reason LIKE 'KI-137: stock unit Lb -> Ea%';
  IF v_at IS NULL THEN
    RAISE EXCEPTION 'KI137_REVERSE_NOT_APPLIED: the correction is not in this database. Nothing was changed.';
  END IF;
  -- Line tables have no timestamps: a line in Ea or MG that the correction did not write is a later write
  -- (live 2026-11-15: the one older such line is the received Piksi PO line 74b7f457, already MG).
  IF EXISTS (SELECT 1 FROM public.order_items WHERE product_id IN (c_corn, c_soy, c_piks) AND unit_size IN ('Ea', 'MG')
               AND id NOT IN ('41ce7cfe-ad47-4fe3-9ace-9b694338ec34', 'b24ffb13-7925-4c03-8ffd-bdcbb00ad0ca', '69766da1-a9bf-4fc6-90c0-f9ced47556bc',
                              'c12acb4c-45ec-424e-bb13-9566ea3c73f9', 'c8fd3a29-e44b-4ba5-9318-b574845d69a4'))
     OR EXISTS (SELECT 1 FROM public.purchase_order_items WHERE product_id IN (c_corn, c_soy, c_piks) AND unit_size IN ('Ea', 'MG')
               AND id NOT IN ('59a5c466-7e4a-46d8-a65c-55cd8397d52c', '74b7f457-b4ef-462a-a3a2-0a125a98392f'))
     OR EXISTS (SELECT 1 FROM public.delivery_items WHERE product_id IN (c_corn, c_soy, c_piks) AND unit_size IN ('Ea', 'MG')
               AND id <> 'd33b3ba5-8c72-49e5-81a1-6a60a5507c93')
     -- The pinned Piksi delivery line still holds the 27000 MG the correction relabelled.
     OR EXISTS (SELECT 1 FROM public.delivery_items WHERE id = 'd33b3ba5-8c72-49e5-81a1-6a60a5507c93' AND quantity IS DISTINCT FROM 27000)
     OR EXISTS (SELECT 1 FROM public.order_items WHERE id IN ('41ce7cfe-ad47-4fe3-9ace-9b694338ec34', 'c12acb4c-45ec-424e-bb13-9566ea3c73f9')
                  AND (id, quantity_delivered) NOT IN (('41ce7cfe-ad47-4fe3-9ace-9b694338ec34'::uuid, 1::numeric), ('c12acb4c-45ec-424e-bb13-9566ea3c73f9'::uuid, 0::numeric)))
     OR EXISTS (SELECT 1 FROM public.inventory_transactions WHERE product_id IN (c_corn, c_soy, c_piks) AND created_at > v_at)
     OR EXISTS (SELECT 1 FROM public.inventory WHERE id IN ('a1396a1c-7cbf-48f7-b98d-83e36ad7de25', 'd847d5c1-0676-4e7e-addf-3e1640e216db', '40224943-7238-4504-ae72-1dbc0ad0bdf6')
                  AND (id, quantity_available, quantity_prebooked) NOT IN (
                    ('a1396a1c-7cbf-48f7-b98d-83e36ad7de25'::uuid, 0::numeric, 1::numeric),
                    ('d847d5c1-0676-4e7e-addf-3e1640e216db'::uuid, 0::numeric, 0::numeric),
                    ('40224943-7238-4504-ae72-1dbc0ad0bdf6'::uuid, 58500::numeric, 27000::numeric)))
     OR EXISTS (SELECT 1 FROM public.purchase_order_items WHERE id = '59a5c466-7e4a-46d8-a65c-55cd8397d52c' AND COALESCE(quantity_received, 0) <> 0)
     -- The correction wrote none of these; any now was made per each / per MG.
     OR EXISTS (SELECT 1 FROM public.quote_items WHERE product_id IN (c_corn, c_soy, c_piks))
     OR EXISTS (SELECT 1 FROM public.quote_versions v WHERE strpos(v.snapshot_data::text, c_corn::text) > 0
                  OR strpos(v.snapshot_data::text, c_soy::text) > 0 OR strpos(v.snapshot_data::text, c_piks::text) > 0)
     OR EXISTS (SELECT 1 FROM public.invoice_items WHERE product_id IN (c_corn, c_soy, c_piks))
     OR EXISTS (SELECT 1 FROM public.delivery_remainders WHERE product_id IN (c_corn, c_soy, c_piks))
     -- No newer cost basis, and Powder Keg not edited since the correction.
     OR EXISTS (SELECT 1 FROM public.product_cost_basis WHERE product_id IN (c_corn, c_soy, c_piks) AND created_at > v_at
                  AND reason NOT LIKE 'KI-137: stock unit Lb -> Ea%')
     OR (SELECT count(*) FROM public.product_cost_basis WHERE product_id IN (c_corn, c_soy) AND effective_to IS NULL
           AND reason LIKE 'KI-137: stock unit Lb -> Ea%') <> 2
     OR EXISTS (SELECT 1 FROM public.products WHERE id IN (c_corn, c_soy) AND updated_at > v_at + interval '1 minute')
     OR EXISTS (SELECT 1 FROM public.product_parents WHERE id IN ('8a1f87bf-9732-4046-b464-8bb5e0ee97b9', '7a565acf-19e8-416e-9373-817ca065ae8a')
                  AND rate_unit IS DISTINCT FROM 'Ea') THEN
    RAISE EXCEPTION 'KI137_REVERSE_LATER_WRITES: these products moved after the correction; reverse by hand. Nothing was changed.';
  END IF;

  UPDATE public.product_parents SET rate_unit = 'Lb', parent_version = parent_version + 1, updated_at = now()
   WHERE id IN ('8a1f87bf-9732-4046-b464-8bb5e0ee97b9', '7a565acf-19e8-416e-9373-817ca065ae8a') AND rate_unit = 'Ea';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 2 THEN RAISE EXCEPTION 'KI137_REVERSE_COUNT: % of 2 families', v_done; END IF;

  ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;
  ALTER TABLE public.products DISABLE TRIGGER trigger_zz_guard_product_parent_values;
  UPDATE public.products SET inventory_unit = 'Lb', unit_size = 'Lb', rate_unit = 'Lb', updated_at = now()
   WHERE id IN (c_corn, c_soy) AND inventory_unit = 'Ea' AND unit_size = 'Ea' AND rate_unit = 'Ea';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  ALTER TABLE public.products ENABLE TRIGGER trigger_zz_guard_product_parent_values;
  ALTER TABLE public.products ENABLE TRIGGER trg_validate_product_setup_fields;
  IF v_done <> 2 THEN RAISE EXCEPTION 'KI137_REVERSE_COUNT: % of 2 products', v_done; END IF;

  INSERT INTO public.product_cost_basis (product_id, basis_type, cost_cents, selection_source, reason)
  SELECT b.product_id, b.basis_type, b.cost_cents, 'migration_baseline', 'KI-137 reversed: stock unit Ea -> Lb; same cost.'
    FROM public.product_cost_basis b
   WHERE b.product_id IN (c_corn, c_soy) AND b.reason LIKE 'KI-137: stock unit Lb -> Ea%' AND b.effective_to IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.product_cost_basis o WHERE o.product_id = b.product_id AND o.effective_to IS NULL);
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 2 THEN RAISE EXCEPTION 'KI137_REVERSE_COUNT: % of 2 cost bases', v_done; END IF;

  UPDATE public.inventory SET unit_size = CASE WHEN id = '40224943-7238-4504-ae72-1dbc0ad0bdf6' THEN 'Dry oz' ELSE 'Lb' END, updated_at = now()
   WHERE (id IN ('a1396a1c-7cbf-48f7-b98d-83e36ad7de25', 'd847d5c1-0676-4e7e-addf-3e1640e216db') AND unit_size = 'Ea')
      OR (id = '40224943-7238-4504-ae72-1dbc0ad0bdf6' AND unit_size = 'MG');
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 3 THEN RAISE EXCEPTION 'KI137_REVERSE_COUNT: % of 3 stock rows', v_done; END IF;
  UPDATE public.order_items SET unit_size = CASE WHEN unit_size = 'Ea' THEN 'Lb' ELSE 'Dry oz' END
   WHERE (id IN ('41ce7cfe-ad47-4fe3-9ace-9b694338ec34', 'b24ffb13-7925-4c03-8ffd-bdcbb00ad0ca') AND unit_size = 'Ea')
      OR (id IN ('69766da1-a9bf-4fc6-90c0-f9ced47556bc', 'c12acb4c-45ec-424e-bb13-9566ea3c73f9', 'c8fd3a29-e44b-4ba5-9318-b574845d69a4') AND unit_size = 'MG');
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 5 THEN RAISE EXCEPTION 'KI137_REVERSE_COUNT: % of 5 order lines', v_done; END IF;
  UPDATE public.purchase_order_items SET unit_size = 'Dry oz'
   WHERE id = '59a5c466-7e4a-46d8-a65c-55cd8397d52c' AND unit_size = 'MG';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 1 THEN RAISE EXCEPTION 'KI137_REVERSE_COUNT: % of 1 PO line', v_done; END IF;
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.delivery_items SET unit_size = 'Dry oz'
   WHERE id = 'd33b3ba5-8c72-49e5-81a1-6a60a5507c93' AND unit_size = 'MG';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  PERFORM set_config('app.admin_override', '', true);
  IF v_done <> 1 THEN RAISE EXCEPTION 'KI137_REVERSE_COUNT: % of 1 delivery line', v_done; END IF;

  IF (SELECT string_agg(tgenabled::text, '' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
        AND tgname IN ('trg_validate_product_setup_fields', 'trigger_zz_guard_product_parent_values')) IS DISTINCT FROM 'OO' THEN
    RAISE EXCEPTION 'KI137_REVERSE_POSTFLIGHT: a product guard is not back on';
  END IF;
END;
$ki137_reverse$;
