-- KI-167 data correction: data only, one-shot (registered in supabase/baselines/one-shot-migrations.json).
--
-- WHY: #1896 (20270121100000) relabelled only open lines. Three completed order lines still carry an old spelling of
-- their product's stock unit. Voiding their delivery reopens the line, and the line-unit guard
-- (a1_line_unit_is_stock_unit, 20270121110000) then refuses the replacement delivery (LINE_UNIT_NOT_STOCK_UNIT), so the
-- office would have to fix the unit by hand. Taha approved relabelling all three to the stock unit (2026-11-23).
--
-- WHAT (each row pinned by id and its values read live 2026-11-23, read-only):
--   ORD-2026-0188 Treaty Extra                 "oz"       -> "Dry oz"  (800 ordered, 800 delivered)
--   ORD-2026-0381 Trivapro - Bulk              "Gallon "  -> "Gal"     (192 ordered, 192 delivered)
--   ORD-2026-0484 Gen Select 2LB ... - 2.5 Gal "Gall"     -> "Gal"     (25 ordered, 25 delivered)
-- Only order_items.unit_size changes. Quantities, prices and costs never change. Delivery and invoice lines keep
-- their labels: a replacement delivery takes the order line's unit, and nothing re-checks a voided or billed line's
-- unit. Any such line on these three order lines in another spelling is listed as a NOTICE, for the record.
--
-- TRIGGERS (none is switched off): an UPDATE OF unit_size fires a1_line_unit_is_stock_unit (passes: the new unit is
-- the stock unit), order_items_bump_edit_version (the order's row_version goes up, so an open screen refuses a stale
-- save) and after_order_items_change (re-sums the order's totals and stamps orders.updated_at). The below-cost, price,
-- inactive-product, deleted-order, delivered-quantity and lineage guards fire only on other columns. The postflight
-- proves each order's totals did not move.
--
-- REFUSES (and changes nothing) if: a pinned line moved (id, order number, order status 'fulfilled', product name,
-- stock unit, old unit, ordered, delivered, remaining 0) (KI167_ROW_MOVED); or any other order line anywhere is not in
-- its product's stock unit (KI167_OTHER_LINE, listed; 0 live 2026-11-23 besides these three).
--
-- ROLLBACK: a new migration through the gates setting the three unit_size values back (pinned by id and new unit);
-- the a1 guard refuses an old spelling, so it must disable a1_line_unit_is_stock_unit on order_items around that one
-- UPDATE, with the same on-state checks. Not written: the old spellings are the bug.

DO $ki167$
DECLARE
  v_bad  text;
  v_done integer;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  LOCK TABLE public.products, public.orders, public.order_items IN SHARE ROW EXCLUSIVE MODE;

  CREATE TEMP TABLE ki167_rows (id uuid PRIMARY KEY, order_number text, product_name text, old_unit text,
    new_unit text, needed numeric, delivered numeric) ON COMMIT DROP;
  INSERT INTO ki167_rows VALUES
    ('1a9a6d97-8540-47ac-8616-7792774d7502', 'ORD-2026-0188', 'Treaty Extra', 'oz', 'Dry oz', 800, 800),
    ('ff563d1a-31d0-46d8-9329-2a928c818c12', 'ORD-2026-0381', 'Trivapro - Bulk', 'Gallon ', 'Gal', 192, 192),
    ('b81e22ff-9596-4abe-80fe-56b8684e5968', 'ORD-2026-0484',
     'Gen Select 2LB: (Ceridian 2EC, Clethodim 2EC, Volunteer) - 2.5 Gal', 'Gall', 'Gal', 25, 25);

  -- Pinned lines unchanged. The new unit is the product's stock unit (inventory_unit, else unit_size, as the guard reads it).
  SELECT string_agg(r.order_number || ' line ' || r.id, ', ' ORDER BY r.order_number) INTO v_bad
    FROM ki167_rows r
   WHERE NOT EXISTS (
     SELECT 1 FROM public.order_items x
       JOIN public.orders o ON o.id = x.order_id
       JOIN public.products p ON p.id = x.product_id
      WHERE x.id = r.id AND o.order_number = r.order_number AND o.status::text = 'fulfilled'
        AND p.product_name = r.product_name
        AND COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')) = r.new_unit
        AND x.unit_size = r.old_unit AND NOT public._unit_matches_stock_unit(x.unit_size, r.new_unit)
        AND x.total_units_needed = r.needed AND x.quantity_delivered = r.delivered AND x.quantity_remaining = 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI167_ROW_MOVED: these pinned lines no longer match the reviewed state, nothing was changed: %', v_bad;
  END IF;

  -- No other order line, any status, may be in a unit other than its product's stock unit (a new one appeared).
  SELECT string_agg(format('%s line %s ("%s", stocked in "%s")', o.order_number, x.id, x.unit_size, s.stock), ', '
                    ORDER BY o.order_number, x.id) INTO v_bad
    FROM public.order_items x
    JOIN public.orders o ON o.id = x.order_id
    JOIN public.products p ON p.id = x.product_id
    CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')) AS stock) s
   WHERE x.id NOT IN (SELECT id FROM ki167_rows)
     AND NOT public._unit_matches_stock_unit(x.unit_size, s.stock);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI167_OTHER_LINE: these order lines are not in their product''s stock unit and were not reviewed, nothing was changed: %', v_bad;
  END IF;

  -- For the record only: delivery, invoice and remainder lines of these order lines in another spelling stay as they are.
  SELECT string_agg(y, ', ') INTO v_bad FROM (
    SELECT format('delivery line %s ("%s")', d.id, d.unit_size) AS y FROM public.delivery_items d JOIN ki167_rows r ON r.id = d.order_item_id
     WHERE d.unit_size IS DISTINCT FROM r.new_unit
    UNION ALL
    SELECT format('invoice line %s ("%s")', i.id, i.unit_size) FROM public.invoice_items i JOIN ki167_rows r ON r.id = i.order_item_id
     WHERE i.unit_size IS DISTINCT FROM r.new_unit
    UNION ALL
    SELECT format('delivery remainder %s ("%s", %s)', m.id, m.unit_size, m.status) FROM public.delivery_remainders m
      JOIN ki167_rows r ON r.id = m.order_item_id WHERE m.unit_size IS DISTINCT FROM r.new_unit) s;
  IF v_bad IS NOT NULL THEN
    RAISE NOTICE 'KI167_HISTORY_LABELS (unchanged): %', v_bad;
  END IF;

  CREATE TEMP TABLE ki167_before ON COMMIT DROP AS
    SELECT x.id, to_jsonb(x) AS line, to_jsonb(o) AS ord
      FROM public.order_items x JOIN public.orders o ON o.id = x.order_id
     WHERE x.id IN (SELECT id FROM ki167_rows);

  UPDATE public.order_items x SET unit_size = r.new_unit
    FROM ki167_rows r WHERE x.id = r.id AND x.unit_size = r.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 3 THEN RAISE EXCEPTION 'KI167_UPDATE_COUNT: relabelled % of 3 order lines', v_done; END IF;

  -- Postflight: each line equals its pre-image except the unit; each order equals its pre-image except the edit
  -- version (raised) and updated_at (the totals trigger stamps it), so its totals did not move.
  SELECT string_agg(r.order_number, ', ') INTO v_bad
    FROM ki167_rows r
    JOIN ki167_before b ON b.id = r.id
    JOIN public.order_items x ON x.id = r.id
    JOIN public.orders o ON o.id = x.order_id
   WHERE x.unit_size IS DISTINCT FROM r.new_unit
      OR to_jsonb(x) - 'unit_size' IS DISTINCT FROM b.line - 'unit_size'
      OR to_jsonb(o) - ARRAY['row_version', 'updated_at'] IS DISTINCT FROM b.ord - ARRAY['row_version', 'updated_at']
      OR o.row_version <= (b.ord->>'row_version')::bigint;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI167_POSTFLIGHT: a line or its order changed beyond the unit label: %', v_bad;
  END IF;
  SELECT string_agg(x.id::text, ', ') INTO v_bad
    FROM public.order_items x JOIN public.products p ON p.id = x.product_id
   WHERE NOT public._unit_matches_stock_unit(x.unit_size,
           COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI167_POSTFLIGHT: order lines still not in their stock unit: %', v_bad;
  END IF;
END;
$ki167$;
