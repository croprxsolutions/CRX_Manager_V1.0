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
-- On order_items only unit_size changes. An open (pending) delivery remainder of these lines in the line's approved
-- old spelling is relabelled too (unit_size, updated_at), since a follow-up delivery copies its unit; remainders already
-- scheduled, fulfilled or cancelled are history and stay. A delivery line of these order lines on a delivery that is
-- not finished (not completed, voided or cancelled) in an old spelling refuses the whole migration: the office finishes
-- or cancels that delivery first. Quantities, prices and costs never change. Completed delivery lines and
-- invoice lines keep their labels; the real-schema proof shows void, a new delivery and a follow-up from a remainder
-- all go through with them in place (invoices there are the drafts completion writes; a posted invoice is not proven).
-- Any such line on these three order lines in another spelling is listed as a NOTICE, for the record.
--
-- LIVE_ID_TODO: the order and product ids and the open-remainder list below are read live (read-only) before apply.
-- While any is still NULL the migration refuses (KI167_LIVE_IDS_MISSING) and changes nothing.
--
-- LOCKS: row locks only, in the order an order edit takes them (update_order_items locks the order, then its lines,
-- whose a1 guard then shares the product): the three orders FOR UPDATE, the three products FOR SHARE (so no rename or
-- stock-unit change lands until commit; the pins are checked after every lock), the three lines and their remainders
-- FOR UPDATE, each ORDER BY id, 10-second lock_timeout.
--
-- TRIGGERS (none is switched off): an UPDATE OF unit_size fires a1_line_unit_is_stock_unit (passes: the new unit is
-- the stock unit), order_items_bump_edit_version (the order's row_version goes up, so an open screen refuses a stale
-- save) and after_order_items_change (re-sums the order's totals and stamps orders.updated_at). The below-cost, price,
-- inactive-product, deleted-order, delivered-quantity and lineage guards fire only on other columns. delivery_remainders
-- has no triggers. The postflight proves each order's totals did not move.
--
-- REFUSES (and changes nothing) if: a pinned line moved (id, order id and number, order status 'fulfilled', product id,
-- name and stock unit, old unit, ordered, delivered, remaining 0), a pinned remainder moved or is not in its line's
-- approved old spelling, or an unpinned open remainder of these lines is in another unit (KI167_ROW_MOVED); an
-- unfinished delivery has a line of these order lines in an old spelling (KI167_ACTIVE_DELIVERY_LINE); or any other
-- order line anywhere is not in its product's stock unit or points at a missing product (KI167_OTHER_LINE, listed;
-- 0 live 2026-11-23 besides these three).
--
-- ROLLBACK: a new migration through the gates setting the three unit_size values back, pinned by id, new unit, order
-- status still 'fulfilled', delivered = ordered and remaining 0, and no delivery of the line created after this
-- migration's apply time (recorded in its migrations.d record; a reopened or re-delivered line must keep the stock
-- unit, or its next replacement is refused again), with a1_line_unit_is_stock_unit disabled on order_items around that one UPDATE and its
-- on-state checked before and after; and the remainders set back by id, still pending with the same quantity. Not
-- written: the old spellings are the bug.

DO $ki167$
DECLARE
  -- LIVE_ID_TODO: open (pending) remainders of the three lines in an old spelling, read live: '[]' if none, else
  -- '[{"id": "...", "order_item_id": "...", "old_unit": "...", "quantity": n}]'.
  c_remainders constant text := NULL /* LIVE_ID_TODO open remainders */;
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_rem  jsonb;
  v_bad  text;
  v_done integer;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);

  CREATE TEMP TABLE ki167_rows (id uuid PRIMARY KEY, order_id uuid, order_number text, product_id uuid,
    product_name text, old_unit text, new_unit text, needed numeric, delivered numeric) ON COMMIT DROP;
  INSERT INTO pg_temp.ki167_rows VALUES
    ('1a9a6d97-8540-47ac-8616-7792774d7502', NULL /* LIVE_ID_TODO order ORD-2026-0188 */, 'ORD-2026-0188',
     NULL /* LIVE_ID_TODO product ORD-2026-0188 */, 'Treaty Extra', 'oz', 'Dry oz', 800, 800),
    ('ff563d1a-31d0-46d8-9329-2a928c818c12', NULL /* LIVE_ID_TODO order ORD-2026-0381 */, 'ORD-2026-0381',
     NULL /* LIVE_ID_TODO product ORD-2026-0381 */, 'Trivapro - Bulk', 'Gallon ', 'Gal', 192, 192),
    ('b81e22ff-9596-4abe-80fe-56b8684e5968', NULL /* LIVE_ID_TODO order ORD-2026-0484 */, 'ORD-2026-0484',
     NULL /* LIVE_ID_TODO product ORD-2026-0484 */,
     'Gen Select 2LB: (Ceridian 2EC, Clethodim 2EC, Volunteer) - 2.5 Gal', 'Gall', 'Gal', 25, 25);

  IF c_remainders IS NULL OR EXISTS (SELECT 1 FROM pg_temp.ki167_rows WHERE order_id IS NULL OR product_id IS NULL) THEN
    RAISE EXCEPTION 'KI167_LIVE_IDS_MISSING: the live order and product ids and the open-remainder list are not filled in yet. Nothing was changed.';
  END IF;
  -- The hand-filled list is checked as text before any value is cast.
  BEGIN
    v_rem := c_remainders::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'KI167_LIVE_IDS_MISSING: the open-remainder list is not valid JSON. Nothing was changed.';
  END;
  IF jsonb_typeof(v_rem) IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_rem) e
                 WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e->'quantity') IS DISTINCT FROM 'number'
                    OR jsonb_typeof(e->'old_unit') IS DISTINCT FROM 'string'
                    OR COALESCE(e->>'id', '') !~* c_uuid OR COALESCE(e->>'order_item_id', '') !~* c_uuid) THEN
    RAISE EXCEPTION 'KI167_LIVE_IDS_MISSING: the open-remainder list has a blank or malformed entry. Nothing was changed.';
  END IF;
  CREATE TEMP TABLE ki167_rem ON COMMIT DROP AS
    SELECT * FROM jsonb_to_recordset(v_rem) AS t(id uuid, order_item_id uuid, old_unit text, quantity numeric);
  IF EXISTS (SELECT 1 FROM pg_temp.ki167_rem m LEFT JOIN pg_temp.ki167_rows r ON r.id = m.order_item_id
              WHERE r.id IS NULL OR m.old_unit IS DISTINCT FROM r.old_unit)
     OR (SELECT count(DISTINCT id) FROM pg_temp.ki167_rem) <> (SELECT count(*) FROM pg_temp.ki167_rem) THEN
    RAISE EXCEPTION 'KI167_ROW_MOVED: the open-remainder list has a duplicate entry, an unknown line, or a unit other than its line''s approved old spelling. Nothing was changed.';
  END IF;

  -- Row locks, in an order edit's order: orders, then products (shared), then lines, then remainders.
  PERFORM 1 FROM public.orders WHERE id IN (SELECT order_id FROM pg_temp.ki167_rows) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.products WHERE id IN (SELECT product_id FROM pg_temp.ki167_rows) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.order_items WHERE id IN (SELECT id FROM pg_temp.ki167_rows) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.delivery_remainders WHERE order_item_id IN (SELECT id FROM pg_temp.ki167_rows) ORDER BY id FOR UPDATE;

  -- Pinned lines unchanged. The new unit is the product's stock unit (inventory_unit, else unit_size, as the guard reads it).
  SELECT string_agg(r.order_number || ' line ' || r.id, ', ' ORDER BY r.order_number) INTO v_bad
    FROM pg_temp.ki167_rows r
   WHERE NOT EXISTS (
     SELECT 1 FROM public.order_items x
       JOIN public.orders o ON o.id = x.order_id
       JOIN public.products p ON p.id = x.product_id
      WHERE x.id = r.id AND x.order_id = r.order_id AND o.order_number = r.order_number AND o.status::text = 'fulfilled'
        AND x.product_id = r.product_id AND p.product_name = r.product_name
        AND COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')) = r.new_unit
        AND x.unit_size = r.old_unit AND public._unit_matches_stock_unit(x.unit_size, r.new_unit) IS FALSE
        AND x.total_units_needed = r.needed AND x.quantity_delivered = r.delivered AND x.quantity_remaining = 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI167_ROW_MOVED: these pinned lines no longer match the reviewed state, nothing was changed: %', v_bad;
  END IF;

  -- Pinned open remainders unchanged, and no other open remainder of these lines in another unit.
  SELECT string_agg(y, ', ') INTO v_bad FROM (
    SELECT 'remainder ' || m.id AS y FROM pg_temp.ki167_rem m
     WHERE NOT EXISTS (SELECT 1 FROM public.delivery_remainders d JOIN pg_temp.ki167_rows r ON r.id = d.order_item_id
                        WHERE d.id = m.id AND d.order_item_id = m.order_item_id AND d.status = 'pending'
                          AND d.unit_size = m.old_unit AND d.unit_size = r.old_unit AND d.quantity_remaining = m.quantity
                          AND d.order_id = r.order_id AND d.product_id = r.product_id)
    UNION ALL
    SELECT 'unlisted open remainder ' || d.id FROM public.delivery_remainders d JOIN pg_temp.ki167_rows r ON r.id = d.order_item_id
     WHERE d.status = 'pending' AND d.id NOT IN (SELECT id FROM pg_temp.ki167_rem)
       AND public._unit_matches_stock_unit(d.unit_size, r.new_unit) IS NOT TRUE) s;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI167_ROW_MOVED: open remainders of these lines do not match the reviewed list, nothing was changed: %', v_bad;
  END IF;

  -- An unfinished delivery still carrying an old spelling for these lines is finished or cancelled by the office first.
  SELECT string_agg(format('delivery %s (%s) line %s ("%s")', dl.delivery_number, dl.status, d.id, d.unit_size), ', ' ORDER BY d.id)
    INTO v_bad
    FROM public.delivery_items d JOIN pg_temp.ki167_rows r ON r.id = d.order_item_id
    JOIN public.deliveries dl ON dl.id = d.delivery_id
   WHERE dl.status::text NOT IN ('completed', 'voided', 'cancelled')
     AND public._unit_matches_stock_unit(d.unit_size, r.new_unit) IS NOT TRUE;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI167_ACTIVE_DELIVERY_LINE: an unfinished delivery has a line of these order lines in an old spelling; finish or cancel it first. Nothing was changed: %', v_bad;
  END IF;

  -- No other order line, any status, may be in a unit other than its product's stock unit (a new one appeared), nor
  -- point at a product that does not exist.
  SELECT string_agg(format('%s line %s ("%s", %s)', o.order_number, x.id, x.unit_size,
                           CASE WHEN p.id IS NULL THEN 'product missing' ELSE format('stocked in "%s"', s.stock) END), ', '
                    ORDER BY o.order_number, x.id) INTO v_bad
    FROM public.order_items x
    LEFT JOIN public.orders o ON o.id = x.order_id
    LEFT JOIN public.products p ON p.id = x.product_id
    CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')) AS stock) s
   WHERE x.id NOT IN (SELECT id FROM pg_temp.ki167_rows)
     AND (p.id IS NULL OR public._unit_matches_stock_unit(x.unit_size, s.stock) IS NOT TRUE);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI167_OTHER_LINE: these order lines are not in their product''s stock unit and were not reviewed, nothing was changed: %', v_bad;
  END IF;

  -- For the record only: delivery, invoice and history-remainder lines of these order lines in another spelling stay.
  SELECT string_agg(y, ', ') INTO v_bad FROM (
    SELECT format('delivery line %s ("%s")', d.id, d.unit_size) AS y FROM public.delivery_items d JOIN pg_temp.ki167_rows r ON r.id = d.order_item_id
     WHERE d.unit_size IS DISTINCT FROM r.new_unit
    UNION ALL
    SELECT format('invoice line %s ("%s")', i.id, i.unit_size) FROM public.invoice_items i JOIN pg_temp.ki167_rows r ON r.id = i.order_item_id
     WHERE i.unit_size IS DISTINCT FROM r.new_unit
    UNION ALL
    SELECT format('delivery remainder %s ("%s", %s)', m.id, m.unit_size, m.status) FROM public.delivery_remainders m
      JOIN pg_temp.ki167_rows r ON r.id = m.order_item_id
     WHERE m.unit_size IS DISTINCT FROM r.new_unit AND m.id NOT IN (SELECT id FROM pg_temp.ki167_rem)) s;
  IF v_bad IS NOT NULL THEN
    RAISE NOTICE 'KI167_HISTORY_LABELS (unchanged): %', v_bad;
  END IF;

  CREATE TEMP TABLE ki167_before ON COMMIT DROP AS
    SELECT r.id, to_jsonb(x) AS line, to_jsonb(o) AS ord
      FROM pg_temp.ki167_rows r JOIN public.order_items x ON x.id = r.id JOIN public.orders o ON o.id = x.order_id;
  CREATE TEMP TABLE ki167_rem_before ON COMMIT DROP AS
    SELECT m.id, to_jsonb(d) AS rem FROM pg_temp.ki167_rem m JOIN public.delivery_remainders d ON d.id = m.id;

  UPDATE public.order_items x SET unit_size = r.new_unit
    FROM pg_temp.ki167_rows r WHERE x.id = r.id AND x.unit_size = r.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 3 THEN RAISE EXCEPTION 'KI167_UPDATE_COUNT: relabelled % of 3 order lines', v_done; END IF;

  UPDATE public.delivery_remainders d SET unit_size = r.new_unit, updated_at = greatest(clock_timestamp(), d.updated_at)
    FROM pg_temp.ki167_rem m JOIN pg_temp.ki167_rows r ON r.id = m.order_item_id
   WHERE d.id = m.id AND d.unit_size = m.old_unit AND d.status = 'pending';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> (SELECT count(*) FROM pg_temp.ki167_rem) THEN
    RAISE EXCEPTION 'KI167_UPDATE_COUNT: relabelled % of % open remainders', v_done, (SELECT count(*) FROM pg_temp.ki167_rem);
  END IF;

  -- Postflight: exactly the three lines, each equal to its pre-image except the unit; each order equal to its pre-image
  -- except the edit version (raised) and updated_at (stamped by the totals trigger, never earlier), so its totals did not move.
  IF (SELECT count(*) FROM pg_temp.ki167_rows r
        LEFT JOIN pg_temp.ki167_before b ON b.id = r.id
        LEFT JOIN public.order_items x ON x.id = r.id
        LEFT JOIN public.orders o ON o.id = r.order_id
       WHERE b.id IS NOT NULL AND x.id IS NOT NULL AND o.id IS NOT NULL
         AND x.unit_size = r.new_unit
         AND to_jsonb(x) - 'unit_size' = b.line - 'unit_size'
         AND to_jsonb(o) - ARRAY['row_version', 'updated_at'] = b.ord - ARRAY['row_version', 'updated_at']
         AND o.row_version > (b.ord->>'row_version')::bigint
         AND o.updated_at >= (b.ord->>'updated_at')::timestamptz) <> 3 THEN
    RAISE EXCEPTION 'KI167_POSTFLIGHT: a line or its order changed beyond the unit label (or an order''s edit version or updated_at did not move)';
  END IF;
  IF (SELECT count(*) FROM pg_temp.ki167_rem m
        LEFT JOIN pg_temp.ki167_rem_before b ON b.id = m.id
        LEFT JOIN public.delivery_remainders d ON d.id = m.id
        LEFT JOIN pg_temp.ki167_rows r ON r.id = m.order_item_id
       WHERE b.id IS NOT NULL AND d.id IS NOT NULL AND d.unit_size = r.new_unit
         AND to_jsonb(d) - ARRAY['unit_size', 'updated_at'] = b.rem - ARRAY['unit_size', 'updated_at']
         AND d.updated_at >= (b.rem->>'updated_at')::timestamptz)
     <> (SELECT count(*) FROM pg_temp.ki167_rem) THEN
    RAISE EXCEPTION 'KI167_POSTFLIGHT: an open remainder changed beyond its unit label';
  END IF;
  SELECT string_agg(x.id::text, ', ') INTO v_bad
    FROM public.order_items x LEFT JOIN public.products p ON p.id = x.product_id
   WHERE p.id IS NULL OR public._unit_matches_stock_unit(x.unit_size,
           COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), ''))) IS NOT TRUE;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI167_POSTFLIGHT: order lines still not in their stock unit: %', v_bad;
  END IF;
END;
$ki167$;
