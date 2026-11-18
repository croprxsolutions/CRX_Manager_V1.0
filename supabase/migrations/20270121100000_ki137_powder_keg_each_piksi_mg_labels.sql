-- KI-137 + KI-136/KI-158 data correction (Product Master repair step 1, To-Do 0.17): data only.
--
-- WHY: Powder Keg Corn and Powder Keg Soybeans are sold by the each (one jug) but were set up per Lb, so their
-- prices and cost (per jug) read as per pound, and their PO lines say "EA" while stock says "Lb" (Mason,
-- 2026-11-13, DECISION_LOG: sold by the each at current prices; stock and rate unit become Ea). Piksi Dust Plus is
-- stocked in MG (milligrams, Mason 2026-11-13) but its stock row, an open PO line and its open order and delivery
-- lines are labelled "Dry oz"; the quantities are milligrams already ("the quantity is right, the label is wrong").
-- The units rule that follows (20270121110000) refuses a line whose unit is not the stock unit, so these labels must
-- be right first.
--
-- WHAT (each row pinned by id and current values; quantities and money never change, and prices and costs are not
-- printed here: the repo is public. Prices stay as they are, now per each; the postflight proves none moved):
--   Powder Keg Corn, Powder Keg Soybeans: inventory_unit, unit_size and rate_unit Lb -> Ea; their one-size family's
--     rate unit Lb -> Ea (parent_version + 1); their stock rows' unit label Lb -> Ea; their open order lines Lb -> Ea.
--     The stock-unit change closes each open cost basis (guard_product_cost_basis_unit_change); a new open basis is
--     written at the same cents (now per each), as a migration baseline. Their open PO lines already say "EA".
--   Piksi Dust Plus: the open PO line (9,000, none received), the three order lines on its open orders, the line on
--     its in-progress delivery and its stock row's label "Dry oz" -> MG.
--   Completed, fulfilled and cancelled history keeps its labels. Historical balances are not converted.
-- Trigger handling as RT-2a (20270101010000): the setup guard and the family-values guard are switched off only
-- around the one product UPDATE and checked back on. The in-progress delivery line is relabelled under
-- app.admin_override (its parent lock allows edits only while scheduled), for that one statement.
--
-- REFUSES (and changes nothing) if: the rate lock is on; the supplier-cost-basis flag is on for a listed product;
-- any pinned row moved (id, name, form, units, quantities, status, family, open cost basis row); a Powder Keg product
-- has a rate (rate_per_acre, suggested_rate or a family rate row); a listed product has a quote line, a
-- saved quote version, an invoice line, a delivery remainder, a net weight, a label maximum or a tote fill source;
-- or a listed product has an open line not in the pinned list.
--
-- ROLLBACK: scripts/smoke/ki137-units-data-reverse.sql puts every pinned row back (proven by
-- scripts/smoke/prove-units-batch-real-schema.mjs). To use it live, copy it into a new migration through the gates.

DO $ki137$
DECLARE
  v_bad  text;
  v_done integer;
  c_corn constant uuid := '0b2e713b-4962-4c49-ae3a-6074ddac1464';
  c_soy  constant uuid := '17ccc5ba-7e98-49bf-9510-4d57c0eda962';
  c_piks constant uuid := '36732b8d-b4ed-4643-8a13-d793975d13c7';
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  LOCK TABLE public.products, public.product_parents, public.product_parent_members,
             public.product_size_net_weight_values, public.product_cost_basis,
             public.inventory, public.purchase_orders, public.purchase_order_items, public.quotes,
             public.quote_items, public.quote_versions, public.orders, public.order_items,
             public.deliveries, public.delivery_items, public.delivery_remainders, public.invoice_items,
             public.cycle_counts, public.cycle_count_items
             IN SHARE ROW EXCLUSIVE MODE;

  -- A count opened before the relabel would complete in the old unit (Sol, #1896). 0 in progress live 2026-11-16.
  IF EXISTS (SELECT 1 FROM public.cycle_counts WHERE status = 'in_progress') THEN
    RAISE EXCEPTION 'KI137_COUNT_IN_PROGRESS: finish or cancel the open cycle count first. Nothing was changed.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.product_rate_lock WHERE is_locked = false FOR SHARE) THEN
    RAISE EXCEPTION 'KI137_RATE_LOCK_ON: product rates are locked; unlock them with a reason, apply, then lock again. Nothing was changed.';
  END IF;
  IF public._supplier_cost_basis_enabled_for_product(c_corn) OR public._supplier_cost_basis_enabled_for_product(c_soy) THEN
    RAISE EXCEPTION 'KI137_COST_BASIS_FLAG_ON: supplier cost basis is on for a Powder Keg product. Nothing was changed.';
  END IF;

  -- Products, as reviewed (live 2026-11-15).
  CREATE TEMP TABLE ki137_prod (id uuid PRIMARY KEY, product_name text, product_form text, inventory_unit text,
    unit_size text, rate_unit text, container_unit text,
    parent_id uuid, parent_rate_unit text, basis_id uuid) ON COMMIT DROP;
  INSERT INTO ki137_prod VALUES
    (c_corn, 'Powder Keg - Corn', 'dry', 'Lb', 'Lb', 'Lb', 'Ea',
     '8a1f87bf-9732-4046-b464-8bb5e0ee97b9', 'Lb', 'bef8f574-e1a5-495a-a6a6-cf0218850f89'),
    (c_soy, 'Powder Keg - Soybeans', 'dry', 'Lb', 'Lb', 'Lb', 'Ea',
     '7a565acf-19e8-416e-9373-817ca065ae8a', 'Lb', '41414dad-1ec7-4191-a80c-95806c5a5c50'),
    (c_piks, 'Piksi Dust Plus - 1800G Jar', 'dry', 'MG', 'MG', 'MG', 'MG',
     'afdae5f9-3410-4f17-975b-07a1650089ae', 'MG', NULL);

  -- Every pinned line and stock row, with its current label and quantities (kind: inv, poi, oi, di).
  CREATE TEMP TABLE ki137_rows (kind text, id uuid PRIMARY KEY, product_id uuid, old_unit text, new_unit text,
    qty numeric, done_qty numeric, parent_status text) ON COMMIT DROP;
  INSERT INTO ki137_rows VALUES
    ('inv', 'a1396a1c-7cbf-48f7-b98d-83e36ad7de25', c_corn, 'Lb', 'Ea', 0, 1, NULL),     -- qty = available, done = prebooked
    ('inv', 'd847d5c1-0676-4e7e-addf-3e1640e216db', c_soy, 'Lb', 'Ea', 0, 0, NULL),
    ('inv', '40224943-7238-4504-ae72-1dbc0ad0bdf6', c_piks, 'Dry oz', 'MG', 58500, 27000, NULL),
    ('oi', '41ce7cfe-ad47-4fe3-9ace-9b694338ec34', c_corn, 'Lb', 'Ea', 2, 1, 'partially_fulfilled'),
    ('oi', 'b24ffb13-7925-4c03-8ffd-bdcbb00ad0ca', c_soy, 'Lb', 'Ea', 2, 2, 'partially_fulfilled'),
    ('oi', '69766da1-a9bf-4fc6-90c0-f9ced47556bc', c_piks, 'Dry oz', 'MG', 10800, 10800, 'partially_fulfilled'),
    ('oi', 'c12acb4c-45ec-424e-bb13-9566ea3c73f9', c_piks, 'Dry oz', 'MG', 27000, 0, 'confirmed'),
    ('oi', 'c8fd3a29-e44b-4ba5-9318-b574845d69a4', c_piks, 'Dry oz', 'MG', 21600, 21600, 'partially_fulfilled'),
    ('di', 'd33b3ba5-8c72-49e5-81a1-6a60a5507c93', c_piks, 'Dry oz', 'MG', 27000, NULL, 'in_progress'),
    ('poi', '59a5c466-7e4a-46d8-a65c-55cd8397d52c', c_piks, 'Dry oz', 'MG', 9000, 0, 'partially_received');

  SELECT string_agg(m.product_name, ', ' ORDER BY m.product_name) INTO v_bad
    FROM ki137_prod m LEFT JOIN public.products p ON p.id = m.id
   WHERE p.id IS NULL OR NOT p.is_active
      OR (p.product_name, p.product_form::text, p.inventory_unit, p.unit_size, p.rate_unit, p.container_unit)
         IS DISTINCT FROM
         (m.product_name, m.product_form, m.inventory_unit, m.unit_size, m.rate_unit, m.container_unit)
      -- A rate typed per Lb would silently become per each: Powder Keg must have none (live 2026-11-15: none).
      OR (m.id IN (c_corn, c_soy) AND (p.rate_per_acre IS NOT NULL OR NULLIF(btrim(p.suggested_rate), '') IS NOT NULL
            OR EXISTS (SELECT 1 FROM public.product_rates r WHERE r.parent_id = m.parent_id)))
      OR p.max_label_rate IS NOT NULL OR NULLIF(btrim(p.max_label_rate_unit), '') IS NOT NULL
      OR (SELECT pm.parent_id FROM public.product_parent_members pm WHERE pm.product_id = m.id) IS DISTINCT FROM m.parent_id
      OR (SELECT count(*) FROM public.product_parent_members pm WHERE pm.parent_id = m.parent_id) <> 1
      OR NOT EXISTS (SELECT 1 FROM public.product_parents pp WHERE pp.id = m.parent_id AND pp.is_active
                       AND pp.rate_unit IS NOT DISTINCT FROM m.parent_rate_unit)
      OR EXISTS (SELECT 1 FROM public.product_parent_members pm
                  WHERE pm.fill_source_product_id = m.id OR (pm.product_id = m.id AND pm.fill_source_product_id IS NOT NULL))
      OR EXISTS (SELECT 1 FROM public.product_size_net_weight_values w WHERE w.product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.quote_items x WHERE x.product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.quote_versions v WHERE strpos(v.snapshot_data::text, m.id::text) > 0)
      OR EXISTS (SELECT 1 FROM public.invoice_items x WHERE x.product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.delivery_remainders x WHERE x.product_id = m.id)
      OR (m.basis_id IS NOT NULL AND
          (SELECT array_agg(b.id) FROM public.product_cost_basis b WHERE b.product_id = m.id AND b.effective_to IS NULL)
            IS DISTINCT FROM ARRAY[m.basis_id])
      OR (m.basis_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.product_cost_basis b
            WHERE b.id = m.basis_id AND b.basis_type = 'manual_override'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI137_ROW_MOVED: these products no longer match the reviewed state, nothing was changed: %', v_bad;
  END IF;

  -- Pinned rows unchanged.
  SELECT string_agg(r.kind || ' ' || r.id, ', ') INTO v_bad
    FROM ki137_rows r
   WHERE NOT CASE r.kind
     WHEN 'inv' THEN EXISTS (SELECT 1 FROM public.inventory i WHERE i.id = r.id AND i.product_id = r.product_id
                               AND i.unit_size = r.old_unit AND i.quantity_available = r.qty AND i.quantity_prebooked = r.done_qty)
     WHEN 'oi' THEN EXISTS (SELECT 1 FROM public.order_items x JOIN public.orders o ON o.id = x.order_id
                             WHERE x.id = r.id AND x.product_id = r.product_id AND x.unit_size = r.old_unit
                               AND x.total_units_needed = r.qty AND COALESCE(x.quantity_delivered, 0) = r.done_qty
                               AND o.status::text = r.parent_status)
     WHEN 'di' THEN EXISTS (SELECT 1 FROM public.delivery_items x JOIN public.deliveries d ON d.id = x.delivery_id
                             WHERE x.id = r.id AND x.product_id = r.product_id AND x.unit_size = r.old_unit
                               AND x.quantity = r.qty AND d.status::text = r.parent_status AND NOT d.is_quick_delivery)
     WHEN 'poi' THEN EXISTS (SELECT 1 FROM public.purchase_order_items x JOIN public.purchase_orders po ON po.id = x.purchase_order_id
                              WHERE x.id = r.id AND x.product_id = r.product_id AND x.unit_size = r.old_unit
                                AND x.quantity_ordered = r.qty AND COALESCE(x.quantity_received, 0) = r.done_qty
                                AND po.status::text = r.parent_status)
   END;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI137_ROW_MOVED: these pinned rows no longer match the reviewed state, nothing was changed: %', v_bad;
  END IF;

  -- No other open line or stock row of a listed product may carry a unit other than its new stock unit.
  SELECT string_agg(x, ', ') INTO v_bad FROM (
    SELECT 'stock row ' || i.id AS x FROM public.inventory i
     WHERE i.product_id IN (SELECT id FROM ki137_prod) AND i.id NOT IN (SELECT id FROM ki137_rows)
    UNION ALL
    SELECT 'order line ' || x.id FROM public.order_items x JOIN public.orders o ON o.id = x.order_id
     WHERE x.product_id IN (SELECT id FROM ki137_prod) AND o.status IN ('confirmed', 'partially_fulfilled')
       AND x.id NOT IN (SELECT id FROM ki137_rows)
    UNION ALL
    SELECT 'delivery line ' || x.id FROM public.delivery_items x JOIN public.deliveries d ON d.id = x.delivery_id
     WHERE x.product_id IN (SELECT id FROM ki137_prod) AND d.status IN ('scheduled', 'in_progress')
       AND x.id NOT IN (SELECT id FROM ki137_rows)
    UNION ALL
    SELECT 'PO line ' || x.id FROM public.purchase_order_items x JOIN public.purchase_orders po ON po.id = x.purchase_order_id
      JOIN ki137_prod m ON m.id = x.product_id
     WHERE po.status IN ('draft', 'submitted', 'partially_received') AND x.id NOT IN (SELECT id FROM ki137_rows)
       AND lower(btrim(x.unit_size)) <> lower(CASE WHEN m.id = c_piks THEN 'MG' ELSE 'Ea' END)) s;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI137_UNLISTED_OPEN_LINE: a listed product has an open line or stock row not in the reviewed list, nothing was changed: %', v_bad;
  END IF;

  CREATE TEMP TABLE ki137_before ON COMMIT DROP AS
    SELECT id, rate_per_acre, tier1_price, tier2_price, tier3_price, tier1_price_per_acre, tier2_price_per_acre,
           tier3_price_per_acre, current_cost, inventory_unit, unit_size, rate_unit, container_unit, max_label_rate_unit
      FROM public.products;
  CREATE TEMP TABLE ki137_parents_before ON COMMIT DROP AS SELECT * FROM public.product_parents;

  -- Families first (Powder Keg only), then the products with only their two guards off.
  UPDATE public.product_parents pp
     SET rate_unit = 'Ea', parent_version = pp.parent_version + 1, updated_at = now()
   WHERE pp.id IN (SELECT parent_id FROM ki137_prod WHERE id IN (c_corn, c_soy)) AND pp.rate_unit = 'Lb';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 2 THEN RAISE EXCEPTION 'KI137_UPDATE_COUNT: moved % of 2 family rate units', v_done; END IF;

  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
        AND tgname = 'trg_validate_product_setup_fields') IS DISTINCT FROM 'O'
     OR (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
        AND tgname = 'trigger_zz_guard_product_parent_values') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'KI137_GUARD_STATE: a product guard is not in its normal on state. Nothing was changed.';
  END IF;
  ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;
  ALTER TABLE public.products DISABLE TRIGGER trigger_zz_guard_product_parent_values;
  UPDATE public.products p
     SET inventory_unit = 'Ea', unit_size = 'Ea', rate_unit = 'Ea', updated_at = now()
   WHERE p.id IN (c_corn, c_soy) AND p.inventory_unit = 'Lb' AND p.unit_size = 'Lb' AND p.rate_unit = 'Lb';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 2 THEN RAISE EXCEPTION 'KI137_UPDATE_COUNT: moved % of 2 products', v_done; END IF;
  ALTER TABLE public.products ENABLE TRIGGER trigger_zz_guard_product_parent_values;
  ALTER TABLE public.products ENABLE TRIGGER trg_validate_product_setup_fields;

  -- The unit change closed each open cost basis; open a new one at the same cents, now per each.
  INSERT INTO public.product_cost_basis (product_id, basis_type, cost_cents, selection_source, reason)
  SELECT m.id, 'manual_override', (SELECT b.cost_cents FROM public.product_cost_basis b WHERE b.id = m.basis_id), 'migration_baseline',
         'KI-137: stock unit Lb -> Ea (Mason 2026-11-13); same cost, now per each.'
    FROM ki137_prod m
   WHERE m.basis_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.product_cost_basis b WHERE b.id = m.basis_id AND b.effective_to IS NOT NULL);
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 2 THEN RAISE EXCEPTION 'KI137_UPDATE_COUNT: reopened % of 2 cost bases', v_done; END IF;

  -- Labels. Stock rows have no trigger on unit_size.
  UPDATE public.inventory i SET unit_size = r.new_unit, updated_at = now()
    FROM ki137_rows r WHERE r.kind = 'inv' AND i.id = r.id AND i.unit_size = r.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 3 THEN RAISE EXCEPTION 'KI137_UPDATE_COUNT: relabelled % of 3 stock rows', v_done; END IF;

  UPDATE public.order_items x SET unit_size = r.new_unit
    FROM ki137_rows r WHERE r.kind = 'oi' AND x.id = r.id AND x.unit_size = r.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 5 THEN RAISE EXCEPTION 'KI137_UPDATE_COUNT: relabelled % of 5 order lines', v_done; END IF;

  UPDATE public.purchase_order_items x SET unit_size = r.new_unit
    FROM ki137_rows r WHERE r.kind = 'poi' AND x.id = r.id AND x.unit_size = r.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 1 THEN RAISE EXCEPTION 'KI137_UPDATE_COUNT: relabelled % of 1 PO line', v_done; END IF;

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.delivery_items x SET unit_size = r.new_unit
    FROM ki137_rows r WHERE r.kind = 'di' AND x.id = r.id AND x.unit_size = r.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  PERFORM set_config('app.admin_override', '', true);
  IF v_done <> 1 THEN RAISE EXCEPTION 'KI137_UPDATE_COUNT: relabelled % of 1 delivery line', v_done; END IF;

  -- Postflight.
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
        AND tgname = 'trg_validate_product_setup_fields') IS DISTINCT FROM 'O'
     OR (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
        AND tgname = 'trigger_zz_guard_product_parent_values') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'KI137_POSTFLIGHT: a product guard is not enabled again';
  END IF;
  -- No money field moved on any product; unit columns moved only on the two Powder Keg products.
  IF EXISTS (SELECT 1 FROM ki137_before b JOIN public.products p ON p.id = b.id
              WHERE (b.rate_per_acre, b.tier1_price, b.tier2_price, b.tier3_price, b.tier1_price_per_acre,
                     b.tier2_price_per_acre, b.tier3_price_per_acre, b.current_cost)
                    IS DISTINCT FROM
                    (p.rate_per_acre, p.tier1_price, p.tier2_price, p.tier3_price, p.tier1_price_per_acre,
                     p.tier2_price_per_acre, p.tier3_price_per_acre, p.current_cost))
     OR (SELECT count(*) FROM public.products) <> (SELECT count(*) FROM ki137_before) THEN
    RAISE EXCEPTION 'KI137_POSTFLIGHT: a product price or rate changed';
  END IF;
  SELECT string_agg(b.id::text, ', ') INTO v_bad
    FROM ki137_before b JOIN public.products p ON p.id = b.id
   WHERE (p.inventory_unit, p.unit_size, p.rate_unit, p.container_unit, p.max_label_rate_unit) IS DISTINCT FROM (
           CASE WHEN b.id IN (c_corn, c_soy) THEN 'Ea' ELSE b.inventory_unit END,
           CASE WHEN b.id IN (c_corn, c_soy) THEN 'Ea' ELSE b.unit_size END,
           CASE WHEN b.id IN (c_corn, c_soy) THEN 'Ea' ELSE b.rate_unit END,
           b.container_unit, b.max_label_rate_unit);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI137_POSTFLIGHT: unexpected unit change on: %', v_bad;
  END IF;
  SELECT string_agg(COALESCE(a.name, b.name), ', ') INTO v_bad
    FROM ki137_parents_before b FULL JOIN public.product_parents a ON a.id = b.id
   WHERE a.id IS NULL OR b.id IS NULL
      OR (b.id NOT IN (SELECT parent_id FROM ki137_prod WHERE id IN (c_corn, c_soy)) AND to_jsonb(a) IS DISTINCT FROM to_jsonb(b))
      OR (b.id IN (SELECT parent_id FROM ki137_prod WHERE id IN (c_corn, c_soy)) AND (
            to_jsonb(a) - ARRAY['rate_unit', 'parent_version', 'updated_at']
              IS DISTINCT FROM to_jsonb(b) - ARRAY['rate_unit', 'parent_version', 'updated_at']
         OR a.rate_unit <> 'Ea' OR a.parent_version <> b.parent_version + 1));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI137_POSTFLIGHT: unexpected family change on: %', v_bad;
  END IF;
  -- Exactly one open cost basis per Powder Keg product, at the reviewed cents.
  IF (SELECT count(*) FROM public.product_cost_basis b JOIN ki137_prod m ON m.id = b.product_id
       WHERE m.basis_id IS NOT NULL AND b.effective_to IS NULL
         AND b.cost_cents = (SELECT o.cost_cents FROM public.product_cost_basis o WHERE o.id = m.basis_id)) <> 2
     OR (SELECT count(*) FROM public.product_cost_basis b WHERE b.product_id IN (c_corn, c_soy) AND b.effective_to IS NULL) <> 2 THEN
    RAISE EXCEPTION 'KI137_POSTFLIGHT: the Powder Keg cost basis is not one open row at the old cents';
  END IF;
  -- Pinned rows: new label, same quantities.
  IF EXISTS (SELECT 1 FROM ki137_rows r WHERE NOT CASE r.kind
       WHEN 'inv' THEN EXISTS (SELECT 1 FROM public.inventory i WHERE i.id = r.id AND i.unit_size = r.new_unit
                                 AND i.quantity_available = r.qty AND i.quantity_prebooked = r.done_qty)
       WHEN 'oi' THEN EXISTS (SELECT 1 FROM public.order_items x WHERE x.id = r.id AND x.unit_size = r.new_unit
                               AND x.total_units_needed = r.qty AND COALESCE(x.quantity_delivered, 0) = r.done_qty)
       WHEN 'di' THEN EXISTS (SELECT 1 FROM public.delivery_items x WHERE x.id = r.id AND x.unit_size = r.new_unit AND x.quantity = r.qty)
       WHEN 'poi' THEN EXISTS (SELECT 1 FROM public.purchase_order_items x WHERE x.id = r.id AND x.unit_size = r.new_unit
                                AND x.quantity_ordered = r.qty AND COALESCE(x.quantity_received, 0) = r.done_qty)
     END) THEN
    RAISE EXCEPTION 'KI137_POSTFLIGHT: a pinned row is not relabelled with its quantities unchanged';
  END IF;
END;
$ki137$;

-- Sol #1896 HIGH 1 (Mason 2026-11-16: "clean up old lines"). After the block above, one purchase-order line is still in a
-- unit that is not its product's stock unit: Treaty Extra's line on PO-2026-0011 says "oz" (liquid) on a product stocked
-- in "Dry oz" (same size; the 800 received are already counted in stock as Dry oz). Undoing that receipt would reopen it
-- in the wrong unit, so the line and the product's stock row get the stock unit's label. Quantities and cost never
-- change. The closed-PO guard and the PO cost-snapshot trigger refuse or re-cost any edit of a received line, so both are
-- switched off for this one UPDATE and checked back on; every other column of the line is proved unchanged.
DO $po_oz$
DECLARE
  c_line constant uuid := '46142f54-0e4d-4259-b749-f24e4101b062';
  c_inv  constant uuid := '687b3d54-1f4e-4ae1-9a5f-afa0542e94c2';
  c_prod constant uuid := 'ac926057-cfae-4070-9cb6-ff2ecc421c3c';
  v_line jsonb;
  v_inv  jsonb;
  v_done integer;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  LOCK TABLE public.products, public.inventory, public.purchase_orders, public.purchase_order_items IN SHARE ROW EXCLUSIVE MODE;

  SELECT to_jsonb(x) INTO v_line
    FROM public.purchase_order_items x
    JOIN public.purchase_orders po ON po.id = x.purchase_order_id
    JOIN public.products p ON p.id = x.product_id
   WHERE x.id = c_line AND x.product_id = c_prod AND x.unit_size = 'oz'
     AND x.quantity_ordered = 800 AND x.quantity_received = 800
     AND po.po_number = 'PO-2026-0011' AND po.status::text = 'fully_received'
     AND p.is_active AND p.product_form::text = 'dry' AND p.inventory_unit = 'Dry oz' AND p.unit_size = 'Dry oz'
     AND (SELECT count(*) FROM public.purchase_order_items y WHERE y.product_id = c_prod) = 1;
  SELECT to_jsonb(i) INTO v_inv FROM public.inventory i
   WHERE i.id = c_inv AND i.product_id = c_prod AND i.unit_size = 'oz'
     AND (SELECT count(*) FROM public.inventory j WHERE j.product_id = c_prod) = 1;
  IF v_line IS NULL OR v_inv IS NULL THEN
    RAISE EXCEPTION 'PO_OZ_ROW_MOVED: the Treaty Extra PO-2026-0011 line or stock row no longer matches the reviewed state; nothing was changed';
  END IF;

  IF (SELECT string_agg(tgenabled::text, '' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.purchase_order_items'::regclass
        AND tgname IN ('trigger_0_guard_closed_po_item', 'trigger_capture_purchase_order_item_cost_snapshot')) IS DISTINCT FROM 'OO' THEN
    RAISE EXCEPTION 'PO_OZ_GUARD_STATE: a purchase-order line guard is not in its normal on state. Nothing was changed.';
  END IF;
  UPDATE public.inventory SET unit_size = 'Dry oz', updated_at = now() WHERE id = c_inv AND unit_size = 'oz';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 1 THEN RAISE EXCEPTION 'PO_OZ_UPDATE_COUNT: relabelled % of 1 stock row', v_done; END IF;

  ALTER TABLE public.purchase_order_items DISABLE TRIGGER trigger_0_guard_closed_po_item;
  ALTER TABLE public.purchase_order_items DISABLE TRIGGER trigger_capture_purchase_order_item_cost_snapshot;
  UPDATE public.purchase_order_items SET unit_size = 'Dry oz' WHERE id = c_line AND unit_size = 'oz';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  ALTER TABLE public.purchase_order_items ENABLE TRIGGER trigger_capture_purchase_order_item_cost_snapshot;
  ALTER TABLE public.purchase_order_items ENABLE TRIGGER trigger_0_guard_closed_po_item;
  IF v_done <> 1 THEN RAISE EXCEPTION 'PO_OZ_UPDATE_COUNT: relabelled % of 1 PO line', v_done; END IF;

  -- Postflight: both guards back on; only the label (and the stock row's updated_at) moved.
  IF (SELECT string_agg(tgenabled::text, '' ORDER BY tgname) FROM pg_trigger
       WHERE tgrelid = 'public.purchase_order_items'::regclass
         AND tgname IN ('trigger_0_guard_closed_po_item', 'trigger_capture_purchase_order_item_cost_snapshot')) IS DISTINCT FROM 'OO' THEN
    RAISE EXCEPTION 'PO_OZ_POSTFLIGHT: a PO line guard is not enabled again';
  END IF;
  IF (SELECT to_jsonb(x) - 'unit_size' FROM public.purchase_order_items x WHERE x.id = c_line) IS DISTINCT FROM v_line - 'unit_size'
     OR (SELECT unit_size FROM public.purchase_order_items WHERE id = c_line) IS DISTINCT FROM 'Dry oz'
     OR (SELECT to_jsonb(i) - ARRAY['unit_size', 'updated_at'] FROM public.inventory i WHERE i.id = c_inv)
          IS DISTINCT FROM v_inv - ARRAY['unit_size', 'updated_at'] THEN
    RAISE EXCEPTION 'PO_OZ_POSTFLIGHT: the Treaty Extra line or stock row changed beyond its label';
  END IF;
END;
$po_oz$;
