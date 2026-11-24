-- Reverse of 20270228120000_piksi_mg_to_grams.sql (KI-114): puts every Piksi label back (g -> MG, and the 4 older Plus
-- delivery lines -> "Dry oz") with no number changed. Proven by scripts/smoke/prove-piksi-grams-real-schema.mjs.
-- To use it live, copy it into a new migration through the gates. It refuses unless every pinned row still says g with
-- the reviewed numbers, so it only works before new gram-era activity (a receipt, a new line, a rate cut-over); after
-- that, write a separately reviewed forward correction instead.
-- History moves forward, never back: pricing_version and parent_version advance again, and the open cost basis closes
-- and a new one opens at the same cents (the history guard never reopens a closed row).

DO $piksi_rev$
DECLARE
  v_bad  text;
  v_done integer;
  v_override text := current_setting('app.admin_override', true);
  c_plus constant uuid := '36732b8d-b4ed-4643-8a13-d793975d13c7';
  c_inf  constant uuid := 'c22ce37d-cb11-4145-be9a-5469e453bca1';
  c_old  constant uuid := '9a1716a2-8ac3-42e6-887b-64795fca3a57';
  c_guards constant text[] := ARRAY['a1_product_unit_keeps_open_lines', 'a2_product_unit_keeps_history',
                                    'trg_validate_product_setup_fields', 'trigger_zz_guard_product_parent_values'];
  c_po_guards constant text[] := ARRAY['trigger_0_guard_closed_po_item', 'trigger_capture_purchase_order_item_cost_snapshot'];
  c_di_guards constant text[] := ARRAY['a1_line_unit_is_stock_unit', 'a2_delivery_line_matches_order_line'];
  -- md5 of the sorted ids of every Piksi stock movement, read live 2026-11-22 (re-pin when copying into a migration).
  c_movements_md5 constant text := '55f9f30a1ab11f683093743f27168fd2';
  -- md5 of the sorted ids of every Piksi cycle-count line, read live 2026-11-22 (17 rows); both directions pin it.
  c_counts_md5 constant text := 'b1a5558d9e8b96a22839a02f99137226';
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'PIKSI_REV_ISOLATION: run in a READ COMMITTED transaction';
  END IF;
  PERFORM set_config('lock_timeout', '10s', true);
  -- Receiving locks a PO line before stock, so PO tables come first: a live receipt makes this wait, not deadlock.
  LOCK TABLE public.purchase_orders, public.purchase_order_items, public.receiving_records,
             public.products, public.product_parents, public.product_parent_members, public.product_cost_basis,
             public.product_rate_lock, public.product_rate_correction_passes, public.unit_conversions, public.inventory,
             public.inventory_holds, public.inventory_transactions, public.orders, public.order_items, public.deliveries,
             public.delivery_items, public.delivery_remainders, public.return_items, public.quote_items, public.quote_versions,
             public.quote_templates, public.invoice_items,
             public.job_chemicals, public.blend_recipe_items, public.blend_ticket_products, public.cycle_counts,
             public.cycle_count_items, public.product_size_net_weight_values, public.product_weight_events,
             public.app_settings, public.product_cost_basis_rollout, public.product_supplier_links
             IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.cycle_counts WHERE status = 'in_progress') THEN
    RAISE EXCEPTION 'PIKSI_REV_COUNT_IN_PROGRESS: finish or cancel the open cycle count first';
  END IF;
  IF NOT COALESCE((SELECT is_locked FROM public.product_rate_lock), false) THEN
    RAISE EXCEPTION 'PIKSI_REV_RATE_LOCK_OFF: the product rate lock is not on';
  END IF;
  IF public._supplier_cost_basis_enabled_for_product(c_plus) OR public._supplier_cost_basis_enabled_for_product(c_inf)
     OR public._supplier_cost_basis_enabled_for_product(c_old) THEN
    RAISE EXCEPTION 'PIKSI_REV_COST_BASIS_FLAG_ON: supplier cost basis is on for a Piksi product';
  END IF;
  IF (SELECT count(*) FROM public.unit_conversions WHERE lower(unit) IN ('mg', 'g')) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = 'MG' AND unit_type = 'dry' AND factor_oz = 0.00003527396)
     OR NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = 'g' AND unit_type = 'dry' AND factor_oz = 0.03527396) THEN
    RAISE EXCEPTION 'PIKSI_REV_ROW_MOVED: the MG or g conversion factor is not the reviewed one';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgenabled = 'O' AND (
        (tgrelid = 'public.products'::regclass AND tgname = ANY (c_guards || ARRAY['a1_product_unit_relabels_stock_rows', 'trigger_return_net_weight_to_draft']))
     OR (tgrelid = 'public.purchase_order_items'::regclass AND tgname = ANY (c_po_guards))
     OR (tgrelid = 'public.delivery_items'::regclass AND tgname = ANY (c_di_guards)))) <> 10 THEN
    RAISE EXCEPTION 'PIKSI_REV_GUARD_STATE: a guard this script switches is not in its normal on state';
  END IF;
  -- Gram-era use anywhere else means quantities exist that MG would misread 1000x: write a forward fix instead.
  IF EXISTS (SELECT 1 FROM public.quote_items WHERE product_id IN (c_plus, c_inf, c_old))
     OR EXISTS (SELECT 1 FROM public.quote_versions v WHERE strpos(lower(v.snapshot_data::text), c_plus::text) > 0
                  OR strpos(lower(v.snapshot_data::text), c_inf::text) > 0 OR strpos(lower(v.snapshot_data::text), c_old::text) > 0)
     OR EXISTS (SELECT 1 FROM public.invoice_items WHERE product_id IN (c_plus, c_inf, c_old))
     OR EXISTS (SELECT 1 FROM public.delivery_remainders WHERE product_id IN (c_plus, c_inf, c_old))
     OR EXISTS (SELECT 1 FROM public.job_chemicals WHERE product_id IN (c_plus, c_inf, c_old))
     OR EXISTS (SELECT 1 FROM public.blend_recipe_items WHERE product_id IN (c_plus, c_inf, c_old))
     OR EXISTS (SELECT 1 FROM public.blend_ticket_products WHERE product_id IN (c_plus, c_inf, c_old))
     OR EXISTS (SELECT 1 FROM public.return_items WHERE product_id IN (c_plus, c_inf, c_old))
     OR EXISTS (SELECT 1 FROM public.inventory_holds WHERE product_id IN (c_plus, c_inf, c_old) AND is_active)
     OR EXISTS (SELECT 1 FROM public.product_size_net_weight_values WHERE product_id IN (c_plus, c_inf, c_old)) THEN
    RAISE EXCEPTION 'PIKSI_REV_ROW_MOVED: a quote, invoice, job, blend, return, hold, remainder line or jar net weight now uses Piksi';
  END IF;

  CREATE TEMP TABLE rev_prod (id uuid PRIMARY KEY, parent_id uuid) ON COMMIT DROP;
  INSERT INTO rev_prod VALUES (c_plus, 'afdae5f9-3410-4f17-975b-07a1650089ae'), (c_inf, 'c9933638-612a-407a-a4a8-6422b5e38c9c'),
                              (c_old, NULL);
  -- kind, id, product, label to restore, quantity, PO cost-unit snapshot to restore, and links
  -- (oi: order; di: order line, delivery; poi: PO; rr: PO line, PO), all as the forward migration pinned them.
  CREATE TEMP TABLE rev_rows (kind text, id uuid, product_id uuid, old_unit text, qty numeric, snap text, ref uuid, ref2 uuid, status text,
                              PRIMARY KEY (kind, id)) ON COMMIT DROP;
  INSERT INTO rev_rows VALUES
    ('inv', '40224943-7238-4504-ae72-1dbc0ad0bdf6', c_plus, 'MG', 58500, NULL, NULL, NULL, NULL),
    ('inv', '6a758cb1-b1d9-4458-bdcc-944dfdc465d7', c_inf, 'MG', 6000, NULL, NULL, NULL, NULL),
    ('oi', '69766da1-a9bf-4fc6-90c0-f9ced47556bc', c_plus, 'MG', 10800, NULL, 'c34e4901-66ad-4f77-b952-015cf7072caa', NULL, 'partially_fulfilled'),
    ('oi', 'c12acb4c-45ec-424e-bb13-9566ea3c73f9', c_plus, 'MG', 27000, NULL, '97bf6b05-1653-4b61-b1a9-322f9f2a44a7', NULL, 'confirmed'),
    ('oi', 'c8fd3a29-e44b-4ba5-9318-b574845d69a4', c_plus, 'MG', 21600, NULL, '002579ab-feb7-4a47-93c5-4c83251e160e', NULL, 'partially_fulfilled'),
    ('oi', 'c87bc85e-9751-4bac-90f3-94ebe0a2c168', c_inf, 'MG', 5250, NULL, '002579ab-feb7-4a47-93c5-4c83251e160e', NULL, 'partially_fulfilled'),
    ('di', 'd33b3ba5-8c72-49e5-81a1-6a60a5507c93', c_plus, 'MG', 27000, NULL, 'c12acb4c-45ec-424e-bb13-9566ea3c73f9', '8e943c48-045e-43d9-abe0-3251d71a7e12', 'in_progress'),
    ('di', '4cb70b28-7b6f-48f3-a5b0-268a908aac0b', c_plus, 'Dry oz', 21600, NULL, 'c8fd3a29-e44b-4ba5-9318-b574845d69a4', 'f66fac69-654b-4288-bca9-c8cad645ba5c', 'cancelled'),
    ('di', 'ee67433f-698b-49fc-ac17-bd12fd926c89', c_plus, 'Dry oz', 21600, NULL, 'c8fd3a29-e44b-4ba5-9318-b574845d69a4', '4669ebce-cec6-4d30-b7f4-38eb35c0e61e', 'cancelled'),
    ('di', 'd1a6127d-b3d6-431e-a4ce-a78b23402812', c_plus, 'Dry oz', 21600, NULL, 'c8fd3a29-e44b-4ba5-9318-b574845d69a4', 'f21ab0e6-9234-4592-829c-9bdd96b47bfa', 'completed'),
    ('di', 'f2402811-20b8-4be8-b9a3-c2f10a6995fd', c_plus, 'Dry oz', 10800, NULL, '69766da1-a9bf-4fc6-90c0-f9ced47556bc', '2dadcc17-3e24-41b0-a1a2-0b576c607a71', 'completed'),
    ('di', '5bfae54e-79cf-43b6-b4bc-3795031b297e', c_inf, 'MG', 5250, NULL, 'c87bc85e-9751-4bac-90f3-94ebe0a2c168', 'f21ab0e6-9234-4592-829c-9bdd96b47bfa', 'completed'),
    ('di', '74b0c82b-171a-4fa1-8d67-258eece1d150', c_inf, 'MG', 5250, NULL, 'c87bc85e-9751-4bac-90f3-94ebe0a2c168', 'f66fac69-654b-4288-bca9-c8cad645ba5c', 'cancelled'),
    ('di', '781b3324-d70a-407d-b0b8-6c06198befaa', c_inf, 'MG', 5250, NULL, 'c87bc85e-9751-4bac-90f3-94ebe0a2c168', '4669ebce-cec6-4d30-b7f4-38eb35c0e61e', 'cancelled'),
    ('poi', '59a5c466-7e4a-46d8-a65c-55cd8397d52c', c_plus, 'MG', 9000, NULL, '4664da15-393f-4381-b36c-852a4f2199e2', NULL, 'partially_received'),
    ('poi', '74b7f457-b4ef-462a-a3a2-0a125a98392f', c_plus, 'MG', 45000, 'MG', '88126b10-cf90-483f-aedc-46b59603ee07', NULL, 'partially_received'),
    ('poi', 'd76d553c-4a29-490a-9a61-0382eb46941a', c_inf, 'MG', 11250, 'MG', '88126b10-cf90-483f-aedc-46b59603ee07', NULL, 'partially_received'),
    ('rr', 'b79cca8f-6c7e-4f8b-a590-d4906cd13c6e', c_plus, 'MG', 40500, NULL, '74b7f457-b4ef-462a-a3a2-0a125a98392f', '88126b10-cf90-483f-aedc-46b59603ee07', NULL),
    ('rr', 'e2575bc7-88d4-4a05-8637-4ec96de53238', c_plus, 'MG', 4500, NULL, '74b7f457-b4ef-462a-a3a2-0a125a98392f', '88126b10-cf90-483f-aedc-46b59603ee07', NULL),
    ('rr', '253d018e-e0a8-4999-a3fc-428b52ea993f', c_inf, 'MG', 11250, NULL, 'd76d553c-4a29-490a-9a61-0382eb46941a', '88126b10-cf90-483f-aedc-46b59603ee07', NULL);

  -- Pins: the state the forward migration left, and nothing new since.
  IF (SELECT count(*) FROM public.products p JOIN rev_prod m ON m.id = p.id
       WHERE (p.inventory_unit, p.unit_size, p.rate_unit, p.container_unit) = ('g', 'g', 'g', 'g') AND p.pricing_version = 2) <> 3
     OR (SELECT count(*) FROM public.product_parents pp JOIN rev_prod m ON m.parent_id = pp.id
          WHERE pp.rate_unit = 'g' AND pp.rate_source = 'legacy' AND pp.parent_version = 2) <> 2
     OR (SELECT count(*) FROM public.product_cost_basis b JOIN rev_prod m ON m.id = b.product_id
          WHERE b.effective_to IS NULL AND b.selection_source = 'migration_baseline') <> 3
     OR (SELECT count(*) FROM public.product_cost_basis b JOIN rev_prod m ON m.id = b.product_id WHERE b.effective_to IS NULL) <> 3 THEN
    RAISE EXCEPTION 'PIKSI_REV_ROW_MOVED: a Piksi product, group or cost basis is not as the forward migration left it';
  END IF;
  -- A stock movement recorded in grams after the forward (even one netting to zero) would be misread as MG:
  -- the exact set of Piksi movements must be the one read live on 2026-11-22 (13 rows), by id, whatever their timestamps.
  IF (SELECT md5(COALESCE(string_agg(t.id::text, ',' ORDER BY t.id), '')) FROM public.inventory_transactions t
       WHERE t.product_id IN (c_plus, c_inf, c_old)) <> c_movements_md5 THEN
    RAISE EXCEPTION 'PIKSI_REV_ROW_MOVED: a Piksi stock movement was recorded after the change to grams';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(c.id::text, ',' ORDER BY c.id), '')) FROM public.cycle_count_items c
       WHERE c.product_id IN (c_plus, c_inf, c_old)) <> c_counts_md5 THEN
    RAISE EXCEPTION 'PIKSI_REV_ROW_MOVED: the set of Piksi cycle-count lines is not the reviewed one';
  END IF;
  -- A saved quote template would restore its old rate and unit verbatim into a new quote (none live).
  IF EXISTS (SELECT 1 FROM public.quote_templates q WHERE strpos(lower(q.sections::text), c_plus::text) > 0
               OR strpos(lower(q.sections::text), c_inf::text) > 0 OR strpos(lower(q.sections::text), c_old::text) > 0) THEN
    RAISE EXCEPTION 'PIKSI_REV_ROW_MOVED: a quote template now uses Piksi';
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_supplier_links l WHERE l.product_id IN (c_plus, c_inf, c_old) AND l.conversion_unit IS NOT NULL) THEN
    RAISE EXCEPTION 'PIKSI_REV_ROW_MOVED: a Piksi supplier link now carries a unit label';
  END IF;
  SELECT string_agg(r.kind || ' ' || r.id, ', ') INTO v_bad FROM rev_rows r
   WHERE NOT CASE r.kind
     WHEN 'inv' THEN EXISTS (SELECT 1 FROM public.inventory x WHERE x.id = r.id AND x.product_id = r.product_id AND x.unit_size = 'g' AND x.quantity_available = r.qty)
     WHEN 'oi' THEN EXISTS (SELECT 1 FROM public.order_items x WHERE x.id = r.id AND x.product_id = r.product_id AND x.order_id = r.ref AND x.unit_size = 'g'
                               AND (SELECT o.status FROM public.orders o WHERE o.id = x.order_id) = r.status AND x.total_units_needed = r.qty)
     WHEN 'di' THEN EXISTS (SELECT 1 FROM public.delivery_items x WHERE x.id = r.id AND x.product_id = r.product_id
                               AND x.order_item_id = r.ref AND x.delivery_id = r.ref2 AND x.unit_size = 'g'
                               AND (SELECT d.status FROM public.deliveries d WHERE d.id = x.delivery_id AND NOT d.is_quick_delivery) = r.status AND x.quantity = r.qty)
     WHEN 'poi' THEN EXISTS (SELECT 1 FROM public.purchase_order_items x WHERE x.id = r.id AND x.product_id = r.product_id
                               AND x.purchase_order_id = r.ref AND x.unit_size = 'g'
                               AND (SELECT po.status FROM public.purchase_orders po WHERE po.id = x.purchase_order_id) = r.status AND x.quantity_ordered = r.qty
                               AND x.inventory_unit_snapshot IS NOT DISTINCT FROM CASE WHEN r.snap = 'MG' THEN 'g' END)
     WHEN 'rr' THEN EXISTS (SELECT 1 FROM public.receiving_records x WHERE x.id = r.id AND x.product_id = r.product_id
                               AND x.po_item_id = r.ref AND x.purchase_order_id = r.ref2 AND x.unit_size = 'g' AND x.quantity_received = r.qty)
   END;
  SELECT concat_ws(', ', v_bad, string_agg(x, ', ')) INTO v_bad FROM (
    SELECT 'stock row ' || id AS x FROM public.inventory WHERE product_id IN (SELECT id FROM rev_prod) AND id NOT IN (SELECT id FROM rev_rows WHERE kind = 'inv')
    UNION ALL SELECT 'order line ' || id FROM public.order_items WHERE product_id IN (SELECT id FROM rev_prod) AND id NOT IN (SELECT id FROM rev_rows WHERE kind = 'oi')
    UNION ALL SELECT 'delivery line ' || id FROM public.delivery_items WHERE product_id IN (SELECT id FROM rev_prod) AND id NOT IN (SELECT id FROM rev_rows WHERE kind = 'di')
    UNION ALL SELECT 'PO line ' || id FROM public.purchase_order_items WHERE product_id IN (SELECT id FROM rev_prod) AND id NOT IN (SELECT id FROM rev_rows WHERE kind = 'poi')
    UNION ALL SELECT 'receipt ' || id FROM public.receiving_records WHERE product_id IN (SELECT id FROM rev_prod) AND id NOT IN (SELECT id FROM rev_rows WHERE kind = 'rr')) s;
  IF NULLIF(v_bad, '') IS NOT NULL THEN
    RAISE EXCEPTION 'PIKSI_REV_ROW_MOVED: these rows moved or are new since the forward migration: %', v_bad;
  END IF;

  -- Every row of the touched tables, for the byte-for-byte postflight (orders: all but updated_at and row_version).
  CREATE TEMP TABLE rev_before ON COMMIT DROP AS
    SELECT 'products' AS t, id, to_jsonb(x) AS j FROM public.products x
    UNION ALL SELECT 'product_parents', id, to_jsonb(x) FROM public.product_parents x
    UNION ALL SELECT 'inventory', id, to_jsonb(x) FROM public.inventory x
    UNION ALL SELECT 'orders', id, to_jsonb(x) - ARRAY['updated_at', 'row_version'] FROM public.orders x
    UNION ALL SELECT 'order_items', id, to_jsonb(x) FROM public.order_items x
    UNION ALL SELECT 'deliveries', id, to_jsonb(x) FROM public.deliveries x
    UNION ALL SELECT 'delivery_items', id, to_jsonb(x) FROM public.delivery_items x
    UNION ALL SELECT 'purchase_orders', id, to_jsonb(x) FROM public.purchase_orders x
    UNION ALL SELECT 'purchase_order_items', id, to_jsonb(x) FROM public.purchase_order_items x
    UNION ALL SELECT 'receiving_records', id, to_jsonb(x) FROM public.receiving_records x
    UNION ALL SELECT 'inventory_transactions', id, to_jsonb(x) FROM public.inventory_transactions x
    UNION ALL SELECT 'product_cost_basis', id, to_jsonb(x) FROM public.product_cost_basis x;

  CREATE TEMP TABLE rev_nw ON COMMIT DROP AS
    SELECT m.id AS product_id, s.net_weight_version, s.pack_generation
      FROM rev_prod m LEFT JOIN public.product_size_net_weight_state s ON s.product_id = m.id;

  CREATE TEMP TABLE rev_basis ON COMMIT DROP AS
    SELECT b.id, b.product_id FROM public.product_cost_basis b JOIN rev_prod m ON m.id = b.product_id WHERE b.effective_to IS NULL;

  UPDATE public.product_parents pp SET rate_unit = 'MG', parent_version = pp.parent_version + 1, updated_at = now()
   WHERE pp.id IN (SELECT parent_id FROM rev_prod) AND pp.rate_unit = 'g';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 2 THEN RAISE EXCEPTION 'PIKSI_REV_UPDATE_COUNT: % of 2 groups', v_done; END IF;

  INSERT INTO public.product_rate_correction_passes (txid, product_id) SELECT txid_current(), id FROM rev_prod;
  ALTER TABLE public.products DISABLE TRIGGER a1_product_unit_keeps_open_lines;
  ALTER TABLE public.products DISABLE TRIGGER a2_product_unit_keeps_history;
  ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;
  ALTER TABLE public.products DISABLE TRIGGER trigger_zz_guard_product_parent_values;
  UPDATE public.products p SET inventory_unit = 'MG', unit_size = 'MG', rate_unit = 'MG', container_unit = 'MG', updated_at = now()
   WHERE p.id IN (SELECT id FROM rev_prod);
  GET DIAGNOSTICS v_done = ROW_COUNT;
  ALTER TABLE public.products ENABLE TRIGGER trigger_zz_guard_product_parent_values;
  ALTER TABLE public.products ENABLE TRIGGER trg_validate_product_setup_fields;
  ALTER TABLE public.products ENABLE TRIGGER a2_product_unit_keeps_history;
  ALTER TABLE public.products ENABLE TRIGGER a1_product_unit_keeps_open_lines;
  DELETE FROM public.product_rate_correction_passes x USING rev_prod m WHERE x.txid = txid_current() AND x.product_id = m.id;
  IF v_done <> 3 THEN RAISE EXCEPTION 'PIKSI_REV_UPDATE_COUNT: % of 3 products', v_done; END IF;

  INSERT INTO public.product_cost_basis (product_id, basis_type, cost_cents, selection_source, reason, effective_from)
  SELECT b.product_id, b.basis_type, b.cost_cents, 'migration_baseline',
         'KI-114 reverse: stock unit g -> MG, same quantities and cost.', b.effective_to
    FROM rev_basis r JOIN public.product_cost_basis b ON b.id = r.id WHERE b.effective_to IS NOT NULL;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 3 THEN RAISE EXCEPTION 'PIKSI_REV_UPDATE_COUNT: % of 3 cost bases', v_done; END IF;

  UPDATE public.order_items x SET unit_size = r.old_unit FROM rev_rows r WHERE r.kind = 'oi' AND x.id = r.id AND x.unit_size = 'g';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 4 THEN RAISE EXCEPTION 'PIKSI_REV_UPDATE_COUNT: % of 4 order lines', v_done; END IF;

  -- The 4 "Dry oz" lines never matched their product's unit (KI-137 kept them as history), so the line-unit and
  -- order-line-match guards are off for this one statement.
  PERFORM set_config('app.admin_override', 'true', true);
  ALTER TABLE public.delivery_items DISABLE TRIGGER a1_line_unit_is_stock_unit;
  ALTER TABLE public.delivery_items DISABLE TRIGGER a2_delivery_line_matches_order_line;
  UPDATE public.delivery_items x SET unit_size = r.old_unit FROM rev_rows r WHERE r.kind = 'di' AND x.id = r.id AND x.unit_size = 'g';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  ALTER TABLE public.delivery_items ENABLE TRIGGER a2_delivery_line_matches_order_line;
  ALTER TABLE public.delivery_items ENABLE TRIGGER a1_line_unit_is_stock_unit;
  PERFORM set_config('app.admin_override', COALESCE(v_override, ''), true);
  IF v_done <> 8 THEN RAISE EXCEPTION 'PIKSI_REV_UPDATE_COUNT: % of 8 delivery lines', v_done; END IF;

  ALTER TABLE public.purchase_order_items DISABLE TRIGGER trigger_0_guard_closed_po_item;
  ALTER TABLE public.purchase_order_items DISABLE TRIGGER trigger_capture_purchase_order_item_cost_snapshot;
  UPDATE public.purchase_order_items x SET unit_size = 'MG', inventory_unit_snapshot = r.snap
    FROM rev_rows r WHERE r.kind = 'poi' AND x.id = r.id AND x.unit_size = 'g';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  ALTER TABLE public.purchase_order_items ENABLE TRIGGER trigger_capture_purchase_order_item_cost_snapshot;
  ALTER TABLE public.purchase_order_items ENABLE TRIGGER trigger_0_guard_closed_po_item;
  IF v_done <> 3 THEN RAISE EXCEPTION 'PIKSI_REV_UPDATE_COUNT: % of 3 PO lines', v_done; END IF;

  UPDATE public.receiving_records x SET unit_size = 'MG' FROM rev_rows r WHERE r.kind = 'rr' AND x.id = r.id AND x.unit_size = 'g';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 3 THEN RAISE EXCEPTION 'PIKSI_REV_UPDATE_COUNT: % of 3 receipts', v_done; END IF;

  IF (SELECT count(*) FROM pg_trigger WHERE tgname = ANY (c_guards || c_po_guards) AND tgenabled = 'O'
        AND tgrelid IN ('public.products'::regclass, 'public.purchase_order_items'::regclass)) <> 6
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.delivery_items'::regclass AND tgname = ANY (c_di_guards) AND tgenabled = 'O') <> 2
     OR EXISTS (SELECT 1 FROM public.product_rate_correction_passes WHERE txid = txid_current())
     OR (SELECT count(*) FROM public.inventory x JOIN rev_rows r ON r.kind = 'inv' AND r.id = x.id WHERE x.unit_size = 'MG') <> 2
     -- Versions must step again (2 -> 3) so any pricing preview opened in the gram era is invalidated.
     OR (SELECT count(*) FROM public.products p JOIN rev_prod m ON m.id = p.id WHERE p.pricing_version = 3) <> 3
     OR (SELECT count(*) FROM public.product_parents pp JOIN rev_prod m ON m.parent_id = pp.id WHERE pp.parent_version = 3) <> 2 THEN
    RAISE EXCEPTION 'PIKSI_REV_POSTFLIGHT: a guard is off, a pass is left, a stock row was not relabelled, or a version did not step';
  END IF;
  IF (SELECT count(*) FROM rev_nw b JOIN public.product_size_net_weight_state s ON s.product_id = b.product_id
       WHERE s.net_weight_version = COALESCE(b.net_weight_version, 0) + 1
         AND s.pack_generation = COALESCE(b.pack_generation, 0) + 1) <> 3
     OR EXISTS (SELECT 1 FROM public.product_size_net_weight_values WHERE product_id IN (c_plus, c_inf, c_old))
     OR EXISTS (SELECT 1 FROM public.product_weight_events WHERE product_id IN (c_plus, c_inf, c_old)) THEN
    RAISE EXCEPTION 'PIKSI_REV_POSTFLIGHT: the net-weight counters did not each step exactly once, or a weight value or event appeared';
  END IF;
  -- Byte for byte: only the Piksi products, groups, cost bases and pinned rows changed, and only in the listed columns.
  SELECT string_agg(b.t || ' ' || b.id, ', ') INTO v_bad
    FROM rev_before b
    LEFT JOIN LATERAL (
      SELECT to_jsonb(x) AS j FROM public.products x WHERE b.t = 'products' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.product_parents x WHERE b.t = 'product_parents' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.inventory x WHERE b.t = 'inventory' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) - ARRAY['updated_at', 'row_version'] FROM public.orders x WHERE b.t = 'orders' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.order_items x WHERE b.t = 'order_items' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.deliveries x WHERE b.t = 'deliveries' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.delivery_items x WHERE b.t = 'delivery_items' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.purchase_orders x WHERE b.t = 'purchase_orders' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.purchase_order_items x WHERE b.t = 'purchase_order_items' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.receiving_records x WHERE b.t = 'receiving_records' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.inventory_transactions x WHERE b.t = 'inventory_transactions' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.product_cost_basis x WHERE b.t = 'product_cost_basis' AND x.id = b.id
    ) a ON true
   WHERE a.j IS NULL
      OR CASE
           WHEN b.t = 'products' AND b.id IN (SELECT id FROM rev_prod) THEN
             a.j - ARRAY['inventory_unit', 'unit_size', 'rate_unit', 'container_unit', 'updated_at', 'pricing_version']
               IS DISTINCT FROM b.j - ARRAY['inventory_unit', 'unit_size', 'rate_unit', 'container_unit', 'updated_at', 'pricing_version']
           WHEN b.t = 'product_parents' AND b.id IN (SELECT parent_id FROM rev_prod) THEN
             a.j - ARRAY['rate_unit', 'parent_version', 'updated_at'] IS DISTINCT FROM b.j - ARRAY['rate_unit', 'parent_version', 'updated_at']
           WHEN b.t = 'product_cost_basis' AND b.id IN (SELECT id FROM rev_basis) THEN
             a.j - ARRAY['effective_to', 'updated_at'] IS DISTINCT FROM b.j - ARRAY['effective_to', 'updated_at']
           WHEN b.id IN (SELECT id FROM rev_rows WHERE kind = CASE b.t WHEN 'inventory' THEN 'inv' WHEN 'order_items' THEN 'oi'
                  WHEN 'delivery_items' THEN 'di' WHEN 'purchase_order_items' THEN 'poi' WHEN 'receiving_records' THEN 'rr' END) THEN
             a.j - ARRAY['unit_size', 'inventory_unit_snapshot', 'updated_at'] IS DISTINCT FROM b.j - ARRAY['unit_size', 'inventory_unit_snapshot', 'updated_at']
           ELSE a.j IS DISTINCT FROM b.j
         END;
  IF v_bad IS NOT NULL
     OR (SELECT count(*) FROM public.product_cost_basis) <> (SELECT count(*) FROM rev_before WHERE t = 'product_cost_basis') + 3
     OR (SELECT count(*) FROM public.products) + (SELECT count(*) FROM public.product_parents) + (SELECT count(*) FROM public.inventory)
        + (SELECT count(*) FROM public.orders) + (SELECT count(*) FROM public.order_items) + (SELECT count(*) FROM public.deliveries)
        + (SELECT count(*) FROM public.delivery_items) + (SELECT count(*) FROM public.purchase_orders)
        + (SELECT count(*) FROM public.purchase_order_items) + (SELECT count(*) FROM public.receiving_records)
        + (SELECT count(*) FROM public.inventory_transactions)
        <> (SELECT count(*) FROM rev_before WHERE t <> 'product_cost_basis') THEN
    RAISE EXCEPTION 'PIKSI_REV_POSTFLIGHT: unexpected change or new row: %', v_bad;
  END IF;
END;
$piksi_rev$;
