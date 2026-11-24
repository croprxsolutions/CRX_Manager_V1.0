-- KI-114 / #1958 data correction: Piksi Dust is stocked, sold and rated in GRAMS. Data only.
--
-- WHY: the three Piksi products say "MG" (milligrams), but every number on them is grams: the jars are 1800 g and
-- 750 g, the unit price is a price per gram, and the approved rates already say 18 g (Plus) and 6 g (Infurrow). The app
-- converts MG at 1/1000 of a gram, so switching Piksi onto its approved rate would price and deduct 1000 times too much.
-- Mason, 2026-11-22: "piksi dust is in grams ... all mg need changed to gram price is same as grams". This replaces the
-- 2026-11-13 reading that 20270121100000 relied on ("MG means milligrams"). Contract:
-- docs/plans/2026-11-22-ki114-piksi-grams-CONTRACT.md.
--
-- WHAT (each row pinned by id, links and current values; no quantity, price, cost or rate changes):
--   3 products (Plus 1800G Jar, Infurrow 750 G Jar, old inactive Plus): stock, size, rate and container unit MG -> g
--   (pricing_version + 1, as the pricing guard does for any unit edit); their 2 product groups: rate unit MG -> g
--   (parent_version 1 -> 2); 2 stock rows (relabelled by the product's own trigger); 4 order lines; 8 delivery lines
--   (4 say MG, 4 older Plus lines say "Dry oz"; all are grams); 3 PO lines and the 2 PO cost-unit snapshots that say MG;
--   3 receiving records. The stock-unit change closes each open cost basis; a new one opens at the same cents, starting
--   the instant the old one ends. After the one-time live test-data reset (#2407) those lines, movements and count
--   lines are gone and stock is 0: that state is accepted too (all or nothing), and only products, groups, stock rows
--   and cost bases change. Not changed: unit_conversions, product_rates (already g), stock movements (they carry
--   no unit), frozen pricing-workbook exports, and the cut-over hold list (Piksi stays on legacy pricing).
--
-- GUARDS, each for its one statement and checked on before and after: the stock-unit locks (a1/a2: they stop a REAL unit
-- change from reinterpreting old quantities; here the meaning stays and every line moves with the product, in this
-- transaction), the setup and parent-values guards (as KI-137), the rate lock via a correction pass for exactly these
-- three products in this transaction (rates stay locked for everyone), the closed-PO-line guard and PO cost-snapshot
-- trigger (as KI-137's Treaty Extra fix), and the delivery-line parent lock via app.admin_override.
--
-- REFUSES (and changes nothing) if: a cycle count is in progress; the rate lock is off; the supplier-cost-basis flag is
-- on for a listed product; the MG or g conversion factor changed; any pinned row or link moved; any other row of a listed
-- product exists in a corrected table; or a listed product has a quote, saved quote, invoice, job, blend, remainder,
-- return or active hold line.
--
-- ROLLBACK: scripts/smoke/piksi-grams-reverse.sql puts every pinned label back while nothing else moved (proven by
-- scripts/smoke/prove-piksi-grams-real-schema.mjs). To use it live, copy it into a new migration through the gates.

DO $piksi_g$
DECLARE
  v_bad  text;
  v_done integer;
  v_reset boolean;
  v_override text := current_setting('app.admin_override', true);
  c_plus constant uuid := '36732b8d-b4ed-4643-8a13-d793975d13c7';
  c_inf  constant uuid := 'c22ce37d-cb11-4145-be9a-5469e453bca1';
  c_old  constant uuid := '9a1716a2-8ac3-42e6-887b-64795fca3a57';
  c_guards constant text[] := ARRAY['a1_product_unit_keeps_open_lines', 'a2_product_unit_keeps_history',
                                    'trg_validate_product_setup_fields', 'trigger_zz_guard_product_parent_values'];
  c_po_guards constant text[] := ARRAY['trigger_0_guard_closed_po_item', 'trigger_capture_purchase_order_item_cost_snapshot'];
  -- md5 of the sorted ids of every Piksi stock movement, read live 2026-11-22 (13 rows); the reverse pins the same set.
  c_movements_md5 constant text := '55f9f30a1ab11f683093743f27168fd2';
  -- md5 of the sorted ids of every Piksi cycle-count line, read live 2026-11-22 (17 rows); both directions pin it.
  c_counts_md5 constant text := 'b1a5558d9e8b96a22839a02f99137226';
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'PIKSI_G_ISOLATION: run in a READ COMMITTED transaction (this one is %). Nothing was changed.',
      current_setting('transaction_isolation');
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
    RAISE EXCEPTION 'PIKSI_G_COUNT_IN_PROGRESS: finish or cancel the open cycle count first. Nothing was changed.';
  END IF;
  IF NOT COALESCE((SELECT is_locked FROM public.product_rate_lock), false) THEN
    RAISE EXCEPTION 'PIKSI_G_RATE_LOCK_OFF: the product rate lock is not on. Nothing was changed.';
  END IF;
  IF public._supplier_cost_basis_enabled_for_product(c_plus) OR public._supplier_cost_basis_enabled_for_product(c_inf)
     OR public._supplier_cost_basis_enabled_for_product(c_old) THEN
    RAISE EXCEPTION 'PIKSI_G_COST_BASIS_FLAG_ON: supplier cost basis is on for a Piksi product. Nothing was changed.';
  END IF;
  -- A saved quote template would restore its old rate and unit verbatim into a new quote (none live).
  IF EXISTS (SELECT 1 FROM public.quote_templates q WHERE strpos(lower(q.sections::text), c_plus::text) > 0
               OR strpos(lower(q.sections::text), c_inf::text) > 0 OR strpos(lower(q.sections::text), c_old::text) > 0) THEN
    RAISE EXCEPTION 'PIKSI_G_ROW_MOVED: a quote template now uses Piksi';
  END IF;
  -- A supplier link carrying its own unit label would keep saying MG after stock becomes g (none live).
  IF EXISTS (SELECT 1 FROM public.product_supplier_links l WHERE l.product_id IN (c_plus, c_inf, c_old) AND l.conversion_unit IS NOT NULL) THEN
    RAISE EXCEPTION 'PIKSI_G_ROW_MOVED: a Piksi supplier link now carries a unit label. Nothing was changed.';
  END IF;
  IF (SELECT count(*) FROM public.unit_conversions WHERE lower(unit) = 'mg') <> 1
     OR (SELECT count(*) FROM public.unit_conversions WHERE lower(unit) = 'g') <> 1
     OR NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = 'MG' AND unit_type = 'dry' AND factor_oz = 0.00003527396)
     OR NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = 'g' AND unit_type = 'dry' AND factor_oz = 0.03527396) THEN
    RAISE EXCEPTION 'PIKSI_G_ROW_MOVED: the MG or g conversion factor is not the reviewed one. Nothing was changed.';
  END IF;
  -- A product added since the review (another Piksi, or anything else in MG) would silently stay MG (none live).
  SELECT string_agg(p.product_name, ', ' ORDER BY p.product_name) INTO v_bad FROM public.products p
   WHERE p.id NOT IN (c_plus, c_inf, c_old)
     AND (p.product_name ILIKE '%piksi%' OR 'mg' IN (lower(p.inventory_unit), lower(p.unit_size), lower(p.rate_unit),
                                                    lower(p.container_unit), lower(p.max_label_rate_unit)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PIKSI_G_ROW_MOVED: another product is Piksi or uses MG, nothing was changed: %', v_bad;
  END IF;

  -- Products and groups, as reviewed (live 2026-11-22).
  CREATE TEMP TABLE piksi_prod (id uuid PRIMARY KEY, product_name text, is_active boolean, container_size numeric,
    rate_per_acre numeric, parent_id uuid, basis_id uuid) ON COMMIT DROP;
  INSERT INTO piksi_prod VALUES
    (c_plus, 'Piksi Dust Plus - 1800G Jar', true, 1800, 18, 'afdae5f9-3410-4f17-975b-07a1650089ae', '0522b9ea-401e-41df-bce8-23822c286d4e'),
    (c_inf, 'Piksi Dust Inffurow - 750 G Jar', true, 750, 6, 'c9933638-612a-407a-a4a8-6422b5e38c9c', 'b31d8263-2cfc-4f8e-ae22-d1efa8b762b8'),
    (c_old, 'Piksi Dust Plus', false, 1800, 18, NULL, 'eb32265b-301f-498d-8602-058ed845ffb4');
  CREATE TEMP TABLE piksi_parent (id uuid PRIMARY KEY, name text) ON COMMIT DROP;
  INSERT INTO piksi_parent VALUES ('afdae5f9-3410-4f17-975b-07a1650089ae', 'Piksi Dust Plus'),
                                  ('c9933638-612a-407a-a4a8-6422b5e38c9c', 'Piksi Dust Infurrow');

  -- Every line and stock row of these products (kind: inv, oi, di, poi, rr) with label, quantities and links.
  -- qty/done: inv = available/prebooked (on order in extra); oi = needed/delivered; di = quantity; poi = ordered/received;
  -- rr = received. status: the parent document's status (inv: location). ref: oi order, di order line, poi PO,
  -- rr PO line; ref2: di delivery, rr PO. snap/factor: the PO line's cost-unit snapshot.
  CREATE TEMP TABLE piksi_rows (kind text, id uuid, product_id uuid, old_unit text, qty numeric, done_qty numeric,
    extra numeric, status text, ref uuid, ref2 uuid, snap text, factor numeric, PRIMARY KEY (kind, id)) ON COMMIT DROP;
  INSERT INTO piksi_rows VALUES
    ('inv', '40224943-7238-4504-ae72-1dbc0ad0bdf6', c_plus, 'MG', 58500, 27000, 9000, 'Main Warehouse', NULL, NULL, NULL, NULL),
    ('inv', '6a758cb1-b1d9-4458-bdcc-944dfdc465d7', c_inf, 'MG', 6000, 0, 0, 'Main Warehouse', NULL, NULL, NULL, NULL),
    ('oi', '69766da1-a9bf-4fc6-90c0-f9ced47556bc', c_plus, 'MG', 10800, 10800, NULL, 'partially_fulfilled', 'c34e4901-66ad-4f77-b952-015cf7072caa', NULL, NULL, NULL),
    ('oi', 'c12acb4c-45ec-424e-bb13-9566ea3c73f9', c_plus, 'MG', 27000, 0, NULL, 'confirmed', '97bf6b05-1653-4b61-b1a9-322f9f2a44a7', NULL, NULL, NULL),
    ('oi', 'c8fd3a29-e44b-4ba5-9318-b574845d69a4', c_plus, 'MG', 21600, 21600, NULL, 'partially_fulfilled', '002579ab-feb7-4a47-93c5-4c83251e160e', NULL, NULL, NULL),
    ('oi', 'c87bc85e-9751-4bac-90f3-94ebe0a2c168', c_inf, 'MG', 5250, 5250, NULL, 'partially_fulfilled', '002579ab-feb7-4a47-93c5-4c83251e160e', NULL, NULL, NULL),
    ('di', 'd33b3ba5-8c72-49e5-81a1-6a60a5507c93', c_plus, 'MG', 27000, NULL, NULL, 'in_progress', 'c12acb4c-45ec-424e-bb13-9566ea3c73f9', '8e943c48-045e-43d9-abe0-3251d71a7e12', NULL, NULL),
    ('di', '4cb70b28-7b6f-48f3-a5b0-268a908aac0b', c_plus, 'Dry oz', 21600, NULL, NULL, 'cancelled', 'c8fd3a29-e44b-4ba5-9318-b574845d69a4', 'f66fac69-654b-4288-bca9-c8cad645ba5c', NULL, NULL),
    ('di', 'ee67433f-698b-49fc-ac17-bd12fd926c89', c_plus, 'Dry oz', 21600, NULL, NULL, 'cancelled', 'c8fd3a29-e44b-4ba5-9318-b574845d69a4', '4669ebce-cec6-4d30-b7f4-38eb35c0e61e', NULL, NULL),
    ('di', 'd1a6127d-b3d6-431e-a4ce-a78b23402812', c_plus, 'Dry oz', 21600, NULL, NULL, 'completed', 'c8fd3a29-e44b-4ba5-9318-b574845d69a4', 'f21ab0e6-9234-4592-829c-9bdd96b47bfa', NULL, NULL),
    ('di', 'f2402811-20b8-4be8-b9a3-c2f10a6995fd', c_plus, 'Dry oz', 10800, NULL, NULL, 'completed', '69766da1-a9bf-4fc6-90c0-f9ced47556bc', '2dadcc17-3e24-41b0-a1a2-0b576c607a71', NULL, NULL),
    ('di', '5bfae54e-79cf-43b6-b4bc-3795031b297e', c_inf, 'MG', 5250, NULL, NULL, 'completed', 'c87bc85e-9751-4bac-90f3-94ebe0a2c168', 'f21ab0e6-9234-4592-829c-9bdd96b47bfa', NULL, NULL),
    ('di', '74b0c82b-171a-4fa1-8d67-258eece1d150', c_inf, 'MG', 5250, NULL, NULL, 'cancelled', 'c87bc85e-9751-4bac-90f3-94ebe0a2c168', 'f66fac69-654b-4288-bca9-c8cad645ba5c', NULL, NULL),
    ('di', '781b3324-d70a-407d-b0b8-6c06198befaa', c_inf, 'MG', 5250, NULL, NULL, 'cancelled', 'c87bc85e-9751-4bac-90f3-94ebe0a2c168', '4669ebce-cec6-4d30-b7f4-38eb35c0e61e', NULL, NULL),
    ('poi', '59a5c466-7e4a-46d8-a65c-55cd8397d52c', c_plus, 'MG', 9000, 0, NULL, 'partially_received', '4664da15-393f-4381-b36c-852a4f2199e2', NULL, NULL, NULL),
    ('poi', '74b7f457-b4ef-462a-a3a2-0a125a98392f', c_plus, 'MG', 45000, 45000, NULL, 'partially_received', '88126b10-cf90-483f-aedc-46b59603ee07', NULL, 'MG', 1),
    ('poi', 'd76d553c-4a29-490a-9a61-0382eb46941a', c_inf, 'MG', 11250, 11250, NULL, 'partially_received', '88126b10-cf90-483f-aedc-46b59603ee07', NULL, 'MG', 1),
    ('rr', 'b79cca8f-6c7e-4f8b-a590-d4906cd13c6e', c_plus, 'MG', 40500, NULL, NULL, NULL, '74b7f457-b4ef-462a-a3a2-0a125a98392f', '88126b10-cf90-483f-aedc-46b59603ee07', NULL, NULL),
    ('rr', 'e2575bc7-88d4-4a05-8637-4ec96de53238', c_plus, 'MG', 4500, NULL, NULL, NULL, '74b7f457-b4ef-462a-a3a2-0a125a98392f', '88126b10-cf90-483f-aedc-46b59603ee07', NULL, NULL),
    ('rr', '253d018e-e0a8-4999-a3fc-428b52ea993f', c_inf, 'MG', 11250, NULL, NULL, NULL, 'd76d553c-4a29-490a-9a61-0382eb46941a', '88126b10-cf90-483f-aedc-46b59603ee07', NULL, NULL);

  -- After the one-time live test-data reset (#2407, Mason 2026-11-24) every pinned order, delivery, PO and receipt
  -- line, every Piksi stock movement and cycle-count line is gone and both stock rows hold 0. That state is accepted
  -- too, all or nothing: then only the products, groups, stock rows and cost bases change. Any mix still refuses.
  v_reset := NOT EXISTS (SELECT 1 FROM piksi_rows r WHERE r.kind = 'oi' AND EXISTS (SELECT 1 FROM public.order_items x WHERE x.id = r.id))
         AND NOT EXISTS (SELECT 1 FROM piksi_rows r WHERE r.kind = 'di' AND EXISTS (SELECT 1 FROM public.delivery_items x WHERE x.id = r.id))
         AND NOT EXISTS (SELECT 1 FROM piksi_rows r WHERE r.kind = 'poi' AND EXISTS (SELECT 1 FROM public.purchase_order_items x WHERE x.id = r.id))
         AND NOT EXISTS (SELECT 1 FROM piksi_rows r WHERE r.kind = 'rr' AND EXISTS (SELECT 1 FROM public.receiving_records x WHERE x.id = r.id));
  IF v_reset THEN
    DELETE FROM piksi_rows WHERE kind IN ('oi', 'di', 'poi', 'rr');
    UPDATE piksi_rows SET qty = 0, done_qty = 0, extra = 0 WHERE kind = 'inv';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(t.id::text, ',' ORDER BY t.id), '')) FROM public.inventory_transactions t
       WHERE t.product_id IN (c_plus, c_inf, c_old)) <> (CASE WHEN v_reset THEN md5('') ELSE c_movements_md5 END) THEN
    RAISE EXCEPTION 'PIKSI_G_ROW_MOVED: the set of Piksi stock movements is not the reviewed one. Nothing was changed.';
  END IF;
  IF (SELECT md5(COALESCE(string_agg(c.id::text, ',' ORDER BY c.id), '')) FROM public.cycle_count_items c
       WHERE c.product_id IN (c_plus, c_inf, c_old)) <> (CASE WHEN v_reset THEN md5('') ELSE c_counts_md5 END) THEN
    RAISE EXCEPTION 'PIKSI_G_ROW_MOVED: the set of Piksi cycle-count lines is not the reviewed one';
  END IF;

  SELECT string_agg(m.product_name, ', ' ORDER BY m.product_name) INTO v_bad
    FROM piksi_prod m LEFT JOIN public.products p ON p.id = m.id
   WHERE p.id IS NULL
      OR (p.product_name, p.is_active, p.product_form::text, p.inventory_unit, p.unit_size, p.rate_unit, p.container_unit,
          p.rate_per_acre, p.container_size, p.pricing_version)
         IS DISTINCT FROM (m.product_name, m.is_active, 'dry', 'MG', 'MG', 'MG', 'MG', m.rate_per_acre, m.container_size, 1)
      OR p.max_label_rate IS NOT NULL OR NULLIF(btrim(p.max_label_rate_unit), '') IS NOT NULL
      OR (SELECT pm.parent_id FROM public.product_parent_members pm WHERE pm.product_id = m.id) IS DISTINCT FROM m.parent_id
      OR (m.parent_id IS NOT NULL AND (SELECT count(*) FROM public.product_parent_members pm WHERE pm.parent_id = m.parent_id) <> 1)
      OR EXISTS (SELECT 1 FROM public.product_parent_members pm
                  WHERE pm.fill_source_product_id = m.id OR (pm.product_id = m.id AND pm.fill_source_product_id IS NOT NULL))
      OR EXISTS (SELECT 1 FROM public.quote_items x WHERE x.product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.quote_versions v WHERE strpos(lower(v.snapshot_data::text), m.id::text) > 0)
      OR EXISTS (SELECT 1 FROM public.invoice_items x WHERE x.product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.delivery_remainders x WHERE x.product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.job_chemicals x WHERE x.product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.blend_recipe_items x WHERE x.product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.blend_ticket_products x WHERE x.product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.return_items x WHERE x.product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.inventory_holds x WHERE x.product_id = m.id AND x.is_active)
      -- A recorded jar net weight would be sent back to draft by the pack-change trigger (KI-137 precedent): refuse.
      OR EXISTS (SELECT 1 FROM public.product_size_net_weight_values w WHERE w.product_id = m.id)
      OR (SELECT array_agg(b.id) FROM public.product_cost_basis b WHERE b.product_id = m.id AND b.effective_to IS NULL)
           IS DISTINCT FROM ARRAY[m.basis_id]
      OR NOT EXISTS (SELECT 1 FROM public.product_cost_basis b WHERE b.id = m.basis_id AND b.basis_type = 'manual_override');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PIKSI_G_ROW_MOVED: these products no longer match the reviewed state, nothing was changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM public.product_parents pp JOIN piksi_parent m ON m.id = pp.id
       WHERE pp.name = m.name AND pp.rate_unit = 'MG' AND pp.rate_source = 'legacy' AND pp.is_active AND pp.parent_version = 1) <> 2 THEN
    RAISE EXCEPTION 'PIKSI_G_ROW_MOVED: a Piksi product group no longer matches the reviewed state, nothing was changed';
  END IF;

  SELECT string_agg(r.kind || ' ' || r.id, ', ') INTO v_bad
    FROM piksi_rows r
   WHERE NOT CASE r.kind
     WHEN 'inv' THEN EXISTS (SELECT 1 FROM public.inventory i WHERE i.id = r.id AND i.product_id = r.product_id
                               AND i.unit_size = r.old_unit AND i.location = r.status AND i.quantity_available = r.qty
                               AND i.quantity_prebooked = r.done_qty AND i.quantity_on_order = r.extra)
     WHEN 'oi' THEN EXISTS (SELECT 1 FROM public.order_items x JOIN public.orders o ON o.id = x.order_id
                             WHERE x.id = r.id AND x.product_id = r.product_id AND x.unit_size = r.old_unit
                               AND x.rate_unit IS NULL AND x.order_id = r.ref AND x.total_units_needed = r.qty
                               AND COALESCE(x.quantity_delivered, 0) = r.done_qty AND o.status::text = r.status)
     WHEN 'di' THEN EXISTS (SELECT 1 FROM public.delivery_items x JOIN public.deliveries d ON d.id = x.delivery_id
                             WHERE x.id = r.id AND x.product_id = r.product_id AND x.unit_size = r.old_unit
                               AND x.order_item_id = r.ref AND x.delivery_id = r.ref2 AND x.quantity = r.qty
                               AND d.status::text = r.status AND NOT d.is_quick_delivery)
     WHEN 'poi' THEN EXISTS (SELECT 1 FROM public.purchase_order_items x JOIN public.purchase_orders po ON po.id = x.purchase_order_id
                              WHERE x.id = r.id AND x.product_id = r.product_id AND x.unit_size = r.old_unit
                                AND x.purchase_order_id = r.ref AND x.quantity_ordered = r.qty
                                AND COALESCE(x.quantity_received, 0) = r.done_qty AND po.status::text = r.status
                                AND x.inventory_unit_snapshot IS NOT DISTINCT FROM r.snap
                                AND x.inventory_units_per_supplier_unit_snapshot IS NOT DISTINCT FROM r.factor)
     WHEN 'rr' THEN EXISTS (SELECT 1 FROM public.receiving_records x WHERE x.id = r.id AND x.product_id = r.product_id
                              AND x.unit_size = r.old_unit AND x.quantity_received = r.qty
                              AND x.po_item_id = r.ref AND x.purchase_order_id = r.ref2)
   END;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PIKSI_G_ROW_MOVED: these pinned rows no longer match the reviewed state, nothing was changed: %', v_bad;
  END IF;

  -- No unpinned row of a listed product in any table this corrects.
  SELECT string_agg(x, ', ') INTO v_bad FROM (
    SELECT 'stock row ' || id AS x FROM public.inventory WHERE product_id IN (SELECT id FROM piksi_prod)
       AND id NOT IN (SELECT id FROM piksi_rows WHERE kind = 'inv')
    UNION ALL SELECT 'order line ' || id FROM public.order_items WHERE product_id IN (SELECT id FROM piksi_prod)
       AND id NOT IN (SELECT id FROM piksi_rows WHERE kind = 'oi')
    UNION ALL SELECT 'delivery line ' || id FROM public.delivery_items WHERE product_id IN (SELECT id FROM piksi_prod)
       AND id NOT IN (SELECT id FROM piksi_rows WHERE kind = 'di')
    UNION ALL SELECT 'PO line ' || id FROM public.purchase_order_items WHERE product_id IN (SELECT id FROM piksi_prod)
       AND id NOT IN (SELECT id FROM piksi_rows WHERE kind = 'poi')
    UNION ALL SELECT 'receipt ' || id FROM public.receiving_records WHERE product_id IN (SELECT id FROM piksi_prod)
       AND id NOT IN (SELECT id FROM piksi_rows WHERE kind = 'rr')) s;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PIKSI_G_UNLISTED_ROW: a Piksi product has a row not in the reviewed list, nothing was changed: %', v_bad;
  END IF;

  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND tgname = ANY (c_guards) AND tgenabled = 'O') <> 4
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.purchase_order_items'::regclass AND tgname = ANY (c_po_guards) AND tgenabled = 'O') <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND tgname = 'a1_product_unit_relabels_stock_rows' AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND tgname = 'trigger_return_net_weight_to_draft' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'PIKSI_G_GUARD_STATE: a product or PO line trigger is not in its normal on state. Nothing was changed.';
  END IF;
  -- Net-weight counters before, so the postflight can prove the pack-change trigger stepped each one once.
  CREATE TEMP TABLE piksi_nw ON COMMIT DROP AS
    SELECT m.id AS product_id, s.net_weight_version, s.pack_generation
      FROM piksi_prod m LEFT JOIN public.product_size_net_weight_state s ON s.product_id = m.id;

  -- Everything else, for the postflight (these tables hold a few hundred rows each).
  CREATE TEMP TABLE piksi_before ON COMMIT DROP AS
    SELECT 'products' AS t, id, to_jsonb(p) AS j FROM public.products p
    UNION ALL SELECT 'product_parents', id, to_jsonb(x) FROM public.product_parents x
    UNION ALL SELECT 'inventory', id, to_jsonb(x) FROM public.inventory x
    UNION ALL SELECT 'orders', id, to_jsonb(x) FROM public.orders x
    UNION ALL SELECT 'order_items', id, to_jsonb(x) FROM public.order_items x
    UNION ALL SELECT 'deliveries', id, to_jsonb(x) FROM public.deliveries x
    UNION ALL SELECT 'delivery_items', id, to_jsonb(x) FROM public.delivery_items x
    UNION ALL SELECT 'purchase_orders', id, to_jsonb(x) FROM public.purchase_orders x
    UNION ALL SELECT 'purchase_order_items', id, to_jsonb(x) FROM public.purchase_order_items x
    UNION ALL SELECT 'receiving_records', id, to_jsonb(x) FROM public.receiving_records x
    UNION ALL SELECT 'inventory_transactions', id, to_jsonb(x) FROM public.inventory_transactions x
    UNION ALL SELECT 'product_cost_basis', id, to_jsonb(x) FROM public.product_cost_basis x;

  -- 1. Product groups.
  UPDATE public.product_parents pp SET rate_unit = 'g', parent_version = pp.parent_version + 1, updated_at = now()
   WHERE pp.id IN (SELECT id FROM piksi_parent) AND pp.rate_unit = 'MG';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 2 THEN RAISE EXCEPTION 'PIKSI_G_UPDATE_COUNT: moved % of 2 group rate units', v_done; END IF;

  -- 2. Products. The rate lock stays on; a correction pass covers these three products in this transaction only.
  INSERT INTO public.product_rate_correction_passes (txid, product_id) SELECT txid_current(), id FROM piksi_prod;
  ALTER TABLE public.products DISABLE TRIGGER a1_product_unit_keeps_open_lines;
  ALTER TABLE public.products DISABLE TRIGGER a2_product_unit_keeps_history;
  ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;
  ALTER TABLE public.products DISABLE TRIGGER trigger_zz_guard_product_parent_values;
  UPDATE public.products p SET inventory_unit = 'g', unit_size = 'g', rate_unit = 'g', container_unit = 'g', updated_at = now()
   WHERE p.id IN (SELECT id FROM piksi_prod)
     AND (p.inventory_unit, p.unit_size, p.rate_unit, p.container_unit) = ('MG', 'MG', 'MG', 'MG');
  GET DIAGNOSTICS v_done = ROW_COUNT;
  ALTER TABLE public.products ENABLE TRIGGER trigger_zz_guard_product_parent_values;
  ALTER TABLE public.products ENABLE TRIGGER trg_validate_product_setup_fields;
  ALTER TABLE public.products ENABLE TRIGGER a2_product_unit_keeps_history;
  ALTER TABLE public.products ENABLE TRIGGER a1_product_unit_keeps_open_lines;
  IF v_done <> 3 THEN RAISE EXCEPTION 'PIKSI_G_UPDATE_COUNT: moved % of 3 products', v_done; END IF;
  DELETE FROM public.product_rate_correction_passes x USING piksi_prod m WHERE x.txid = txid_current() AND x.product_id = m.id;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 3 THEN RAISE EXCEPTION 'PIKSI_G_UPDATE_COUNT: removed % of 3 correction passes', v_done; END IF;
  -- The product's own trigger relabelled its stock rows.
  IF (SELECT count(*) FROM public.inventory i JOIN piksi_rows r ON r.kind = 'inv' AND r.id = i.id WHERE i.unit_size = 'g') <> 2 THEN
    RAISE EXCEPTION 'PIKSI_G_UPDATE_COUNT: the product update did not relabel both Piksi stock rows';
  END IF;

  -- 3. The unit change closed each open cost basis; a new one opens at the same cents the instant the old one ended.
  INSERT INTO public.product_cost_basis (product_id, basis_type, cost_cents, selection_source, reason, effective_from)
  SELECT m.id, 'manual_override', b.cost_cents, 'migration_baseline',
         'KI-114: stock unit MG -> g, the quantities were always grams (Mason 2026-11-22); same cost.', b.effective_to
    FROM piksi_prod m JOIN public.product_cost_basis b ON b.id = m.basis_id
   WHERE b.effective_to IS NOT NULL;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 3 THEN RAISE EXCEPTION 'PIKSI_G_UPDATE_COUNT: reopened % of 3 cost bases', v_done; END IF;

  -- 4. Line labels.
  UPDATE public.order_items x SET unit_size = 'g'
    FROM piksi_rows r WHERE r.kind = 'oi' AND x.id = r.id AND x.unit_size = r.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> (SELECT count(*) FROM piksi_rows WHERE kind = 'oi') THEN
    RAISE EXCEPTION 'PIKSI_G_UPDATE_COUNT: relabelled % order lines, not every listed one', v_done;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.delivery_items x SET unit_size = 'g'
    FROM piksi_rows r WHERE r.kind = 'di' AND x.id = r.id AND x.unit_size = r.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  PERFORM set_config('app.admin_override', COALESCE(v_override, ''), true);
  IF v_done <> (SELECT count(*) FROM piksi_rows WHERE kind = 'di') THEN
    RAISE EXCEPTION 'PIKSI_G_UPDATE_COUNT: relabelled % delivery lines, not every listed one', v_done;
  END IF;

  ALTER TABLE public.purchase_order_items DISABLE TRIGGER trigger_0_guard_closed_po_item;
  ALTER TABLE public.purchase_order_items DISABLE TRIGGER trigger_capture_purchase_order_item_cost_snapshot;
  UPDATE public.purchase_order_items x
     SET unit_size = 'g', inventory_unit_snapshot = CASE WHEN r.snap = 'MG' THEN 'g' ELSE x.inventory_unit_snapshot END
    FROM piksi_rows r WHERE r.kind = 'poi' AND x.id = r.id AND x.unit_size = r.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  ALTER TABLE public.purchase_order_items ENABLE TRIGGER trigger_capture_purchase_order_item_cost_snapshot;
  ALTER TABLE public.purchase_order_items ENABLE TRIGGER trigger_0_guard_closed_po_item;
  IF v_done <> (SELECT count(*) FROM piksi_rows WHERE kind = 'poi') THEN
    RAISE EXCEPTION 'PIKSI_G_UPDATE_COUNT: relabelled % PO lines, not every listed one', v_done;
  END IF;

  UPDATE public.receiving_records x SET unit_size = 'g'
    FROM piksi_rows r WHERE r.kind = 'rr' AND x.id = r.id AND x.unit_size = r.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> (SELECT count(*) FROM piksi_rows WHERE kind = 'rr') THEN
    RAISE EXCEPTION 'PIKSI_G_UPDATE_COUNT: relabelled % receipts, not every listed one', v_done;
  END IF;

  -- Postflight.
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND tgname = ANY (c_guards) AND tgenabled = 'O') <> 4
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.purchase_order_items'::regclass AND tgname = ANY (c_po_guards) AND tgenabled = 'O') <> 2
     OR EXISTS (SELECT 1 FROM public.product_rate_correction_passes WHERE txid = txid_current())
     OR NOT COALESCE((SELECT is_locked FROM public.product_rate_lock), false) THEN
    RAISE EXCEPTION 'PIKSI_G_POSTFLIGHT: a guard is not on again, a correction pass is left, or the rate lock is off';
  END IF;
  -- Each changed row changed exactly as listed; every other row of these tables is byte-identical.
  SELECT string_agg(b.t || ' ' || b.id, ', ') INTO v_bad
    FROM piksi_before b
    LEFT JOIN LATERAL (
      SELECT to_jsonb(x) AS j FROM public.products x WHERE b.t = 'products' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.product_parents x WHERE b.t = 'product_parents' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.inventory x WHERE b.t = 'inventory' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.orders x WHERE b.t = 'orders' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.order_items x WHERE b.t = 'order_items' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.deliveries x WHERE b.t = 'deliveries' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.delivery_items x WHERE b.t = 'delivery_items' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.purchase_orders x WHERE b.t = 'purchase_orders' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.purchase_order_items x WHERE b.t = 'purchase_order_items' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.receiving_records x WHERE b.t = 'receiving_records' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.inventory_transactions x WHERE b.t = 'inventory_transactions' AND x.id = b.id
      UNION ALL SELECT to_jsonb(x) FROM public.product_cost_basis x WHERE b.t = 'product_cost_basis' AND x.id = b.id
    ) a ON true
    LEFT JOIN piksi_rows r ON r.id = b.id AND r.kind = CASE b.t WHEN 'inventory' THEN 'inv' WHEN 'order_items' THEN 'oi'
      WHEN 'delivery_items' THEN 'di' WHEN 'purchase_order_items' THEN 'poi' WHEN 'receiving_records' THEN 'rr' END
   WHERE a.j IS NULL
      OR CASE
           WHEN b.t = 'products' AND b.id IN (SELECT id FROM piksi_prod) THEN
             a.j - ARRAY['inventory_unit', 'unit_size', 'rate_unit', 'container_unit', 'updated_at', 'pricing_version']
               IS DISTINCT FROM b.j - ARRAY['inventory_unit', 'unit_size', 'rate_unit', 'container_unit', 'updated_at', 'pricing_version']
             OR (a.j->>'inventory_unit', a.j->>'unit_size', a.j->>'rate_unit', a.j->>'container_unit') IS DISTINCT FROM ('g', 'g', 'g', 'g')
             OR (a.j->>'pricing_version')::int IS DISTINCT FROM (b.j->>'pricing_version')::int + 1
           WHEN b.t = 'product_parents' AND b.id IN (SELECT id FROM piksi_parent) THEN
             a.j - ARRAY['rate_unit', 'parent_version', 'updated_at'] IS DISTINCT FROM b.j - ARRAY['rate_unit', 'parent_version', 'updated_at']
             OR a.j->>'rate_unit' IS DISTINCT FROM 'g' OR (a.j->>'parent_version')::int IS DISTINCT FROM (b.j->>'parent_version')::int + 1
           WHEN b.t = 'product_cost_basis' AND b.id IN (SELECT basis_id FROM piksi_prod) THEN
             a.j - ARRAY['effective_to', 'updated_at'] IS DISTINCT FROM b.j - ARRAY['effective_to', 'updated_at']
             OR b.j->>'effective_to' IS NOT NULL OR a.j->>'effective_to' IS NULL
           -- The order-total trigger re-saves each Piksi order: only its timestamp and row_version may move, never a total.
           WHEN b.t = 'orders' AND b.id IN (SELECT ref FROM piksi_rows WHERE kind = 'oi') THEN
             a.j - ARRAY['updated_at', 'row_version'] IS DISTINCT FROM b.j - ARRAY['updated_at', 'row_version']
             OR (a.j->>'row_version')::bigint <= (b.j->>'row_version')::bigint
           WHEN r.id IS NOT NULL THEN
             a.j - ARRAY['unit_size', 'inventory_unit_snapshot', 'updated_at'] IS DISTINCT FROM b.j - ARRAY['unit_size', 'inventory_unit_snapshot', 'updated_at']
             OR a.j->>'unit_size' IS DISTINCT FROM 'g'
             OR a.j->>'inventory_unit_snapshot' IS DISTINCT FROM CASE WHEN r.snap = 'MG' THEN 'g' ELSE b.j->>'inventory_unit_snapshot' END
           ELSE a.j IS DISTINCT FROM b.j
         END;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PIKSI_G_POSTFLIGHT: unexpected change on: %', v_bad;
  END IF;
  -- Per product: exactly one open cost basis, new, same cents and type, starting when the old one ended.
  SELECT string_agg(m.product_name, ', ') INTO v_bad
    FROM piksi_prod m JOIN public.product_cost_basis o ON o.id = m.basis_id
   WHERE (SELECT count(*) FROM public.product_cost_basis b WHERE b.product_id = m.id AND b.effective_to IS NULL) <> 1
      OR NOT EXISTS (SELECT 1 FROM public.product_cost_basis b
                      WHERE b.product_id = m.id AND b.effective_to IS NULL AND b.id <> o.id AND b.cost_cents = o.cost_cents
                        AND b.basis_type = 'manual_override' AND b.selection_source = 'migration_baseline'
                        AND b.effective_from = o.effective_to);
  IF v_bad IS NOT NULL
     OR (SELECT count(*) FROM public.product_cost_basis) <> (SELECT count(*) FROM piksi_before WHERE t = 'product_cost_basis') + 3 THEN
    RAISE EXCEPTION 'PIKSI_G_POSTFLIGHT: the Piksi cost basis is not one new open row at the old cents: %', v_bad;
  END IF;
  -- No row was added to any other snapshotted table.
  IF (SELECT count(*) FROM public.products) + (SELECT count(*) FROM public.product_parents) + (SELECT count(*) FROM public.inventory)
     + (SELECT count(*) FROM public.orders) + (SELECT count(*) FROM public.order_items) + (SELECT count(*) FROM public.deliveries)
     + (SELECT count(*) FROM public.delivery_items) + (SELECT count(*) FROM public.purchase_orders)
     + (SELECT count(*) FROM public.purchase_order_items) + (SELECT count(*) FROM public.receiving_records)
     + (SELECT count(*) FROM public.inventory_transactions)
     <> (SELECT count(*) FROM piksi_before WHERE t <> 'product_cost_basis') THEN
    RAISE EXCEPTION 'PIKSI_G_POSTFLIGHT: a row was added to a corrected table';
  END IF;
  -- The pack-change trigger only steps each product's net-weight counters; no weight value or weight event appears.
  IF EXISTS (SELECT 1 FROM public.product_size_net_weight_values w JOIN piksi_prod m ON m.id = w.product_id)
     OR EXISTS (SELECT 1 FROM public.product_weight_events e JOIN piksi_prod m ON m.id = e.product_id) THEN
    RAISE EXCEPTION 'PIKSI_G_POSTFLIGHT: a Piksi net-weight value or weight event appeared';
  END IF;
  IF (SELECT count(*) FROM piksi_nw b JOIN public.product_size_net_weight_state s ON s.product_id = b.product_id
       WHERE s.net_weight_version = COALESCE(b.net_weight_version, 0) + 1
         AND s.pack_generation = COALESCE(b.pack_generation, 0) + 1) <> 3 THEN
    RAISE EXCEPTION 'PIKSI_G_POSTFLIGHT: the net-weight counters did not each step exactly once';
  END IF;
END;
$piksi_g$;
