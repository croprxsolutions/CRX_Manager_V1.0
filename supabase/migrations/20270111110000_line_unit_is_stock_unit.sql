-- KI-136, KI-158, KI-140 (Product Master repair step 1, To-Do 0.17): stock moves only in the product's stock unit,
-- and quote math refuses a unit it does not know.
--
-- WHY: receiving, orders and deliveries added or took the typed number whatever unit the line was in (KI-136,
-- KI-158): 9,000 "Dry oz" received onto an MG product adds 9,000 MG; a case line on a gallon product takes "1"
-- gallon. New order lines defaulted to products.unit_size instead of the stock unit. product_price_per_acre and
-- save_quote priced an unknown unit as 1 oz (KI-140).
--
-- WHAT:
--  1. public._unit_matches_stock_unit(line_unit, stock_unit): true when the line unit is blank, equal to the stock
--     unit ignoring case and spaces, or both are units_conversions rows of the same type and factor (LB = Lb, Unit =
--     Ea, oz = fl oz). "Gallon" never matches "Gal"; "Dry oz" never matches "MG".
--  2. One BEFORE trigger, a1_line_unit_is_stock_unit, on order_items, delivery_items and purchase_order_items: a line
--     with a product and no unit takes the stock unit (inventory_unit, else unit_size); a line whose unit does not
--     match is refused (LINE_UNIT_NOT_STOCK_UNIT). It checks only a new line, a line whose unit or product changes,
--     and (PO lines) a line being received into, so existing history saves as before (e.g. delivery completion).
--     It replaces trg_fill_order_line_unit / _fill_order_line_unit (20270106100000), which filled from unit_size.
--     Receiving is covered by the PO-line check: _section9_receive_po_items_serialized raises quantity_received on the
--     line, so a mismatched line refuses the whole receipt before it commits. Its body is not re-emitted. No
--     conversion is done: the per-line factor (inventory_units_per_supplier_unit_snapshot) has only ever been 1 or
--     blank, and converting would also need reversal, close-short, on-order and vendor bills to convert.
--     The on-order recompute (_recompute_po_on_order_for_products) is unchanged; it stays right because no open PO
--     line can hold another unit (postflight below; the data correction 20270111100000 runs first).
--  3. product_price_per_acre returns NULL (no figure) when the rate unit or the stock unit is not in
--     unit_conversions, instead of pricing it as 1 oz. Same body otherwise.
--  4. A quote_items trigger refuses a rate-mode line with a rate above 0 whose rate unit, or whose product's stock
--     unit, is not in unit_conversions (the same LOWER(unit) = LOWER(...) match save_quote's math uses), so
--     save_quote's COALESCE(factor, 1) is never reached with an unknown unit. save_quote is not re-emitted.
--     Not done here (KI-140 stays open for it): liquid-vs-dry type mismatch; 4 active dry products are rated in the
--     liquid "oz" and RT-2 step 2 owns them.
-- Live 2026-11-15: every product's stock unit and every rate-mode quote line's rate unit is in unit_conversions;
-- no open line carries another unit once 20270111100000 has run.
--
-- ROLLBACK: scripts/smoke/units-batch-rules-reverse.sql restores trg_fill_order_line_unit, the old
-- product_price_per_acre and drops the new triggers and helper (proven by the units-batch prover).

DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = 'public.product_price_per_acre(numeric,numeric,text,text,text)'::regprocedure)
       IS DISTINCT FROM '30f5f703b82b8198062c1e997a63891d' THEN
    RAISE EXCEPTION 'PREFLIGHT_UNITS_DRIFT: product_price_per_acre is not the reviewed live body';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = 'public._fill_order_line_unit()'::regprocedure)
       IS DISTINCT FROM '9a20cb882c0c827cebb0a1c530688522' THEN
    RAISE EXCEPTION 'PREFLIGHT_UNITS_DRIFT: _fill_order_line_unit is not the reviewed live body';
  END IF;
  IF to_regprocedure('public._unit_matches_stock_unit(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_UNITS_DRIFT: _unit_matches_stock_unit already exists';
  END IF;
END;
$preflight$;

CREATE FUNCTION public._unit_matches_stock_unit(p_line_unit text, p_stock_unit text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(btrim(p_line_unit, E' \t\r\n' || chr(160)), '') = ''
      OR COALESCE(btrim(p_stock_unit, E' \t\r\n' || chr(160)), '') = ''
      OR lower(btrim(p_line_unit, E' \t\r\n' || chr(160))) = lower(btrim(p_stock_unit, E' \t\r\n' || chr(160)))
      OR EXISTS (
           SELECT 1 FROM public.unit_conversions a, public.unit_conversions b
            WHERE lower(a.unit) = lower(btrim(p_line_unit, E' \t\r\n' || chr(160)))
              AND lower(b.unit) = lower(btrim(p_stock_unit, E' \t\r\n' || chr(160)))
              AND a.unit_type = b.unit_type AND a.factor_oz = b.factor_oz);
$function$;

CREATE FUNCTION public._enforce_line_stock_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_stock text;
  v_what  text := CASE TG_TABLE_NAME WHEN 'order_items' THEN 'order line'
                                     WHEN 'delivery_items' THEN 'delivery line' ELSE 'purchase order line' END;
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.unit_size IS NOT DISTINCT FROM OLD.unit_size
     -- A PO line is checked again when it is received into (receive_po_items raises quantity_received).
     AND NOT (TG_TABLE_NAME = 'purchase_order_items'
              AND COALESCE((to_jsonb(NEW)->>'quantity_received')::numeric, 0)
                  > COALESCE((to_jsonb(OLD)->>'quantity_received')::numeric, 0)) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), ''))
    INTO v_stock FROM public.products p WHERE p.id = NEW.product_id
     FOR SHARE;  -- the stock unit cannot change before this line commits (see a1_product_unit_keeps_open_lines)
  IF v_stock IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(btrim(NEW.unit_size, E' \t\r\n' || chr(160)), '') = '' THEN
    NEW.unit_size := v_stock;
  ELSIF public._unit_matches_stock_unit(NEW.unit_size, v_stock) THEN
    -- One spelling per product ("EA", "Unit" -> "Ea") on a new or re-pointed order or PO line. Not on a receipt (the
    -- PO cost-snapshot trigger treats a unit change on a received line as tampering) and not on delivery lines (the
    -- delivery brand carry-over compares the old and new unit exactly).
    IF TG_TABLE_NAME <> 'delivery_items'
       AND (TG_OP = 'INSERT' OR NEW.unit_size IS DISTINCT FROM OLD.unit_size OR NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
      NEW.unit_size := v_stock;
    END IF;
  ELSE
    RAISE EXCEPTION 'LINE_UNIT_NOT_STOCK_UNIT: this % is in "%" but the product is stocked in "%". Enter the quantity in %.',
      v_what, NEW.unit_size, v_stock, v_stock
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._unit_matches_stock_unit(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._enforce_line_stock_unit() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER trg_fill_order_line_unit ON public.order_items;
DROP FUNCTION public._fill_order_line_unit();

-- a1_ sorts after a0_lock_quick_delivery_line_unit (which sets a quick-delivery line's unit first) and before the
-- PO cost-snapshot trigger, which compares the line unit with the stock unit when a line is first received.
-- It also sorts before trigger_0_guard_closed_po_item: a unit or product edit on a closed PO's line now reports
-- LINE_UNIT_NOT_STOCK_UNIT (when the unit is wrong) instead of PO_CLOSED; either way nothing is saved.
CREATE TRIGGER a1_line_unit_is_stock_unit
  BEFORE INSERT OR UPDATE OF unit_size, product_id ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_line_stock_unit();
CREATE TRIGGER a1_line_unit_is_stock_unit
  BEFORE INSERT OR UPDATE OF unit_size, product_id ON public.delivery_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_line_stock_unit();
CREATE TRIGGER a1_line_unit_is_stock_unit
  BEFORE INSERT OR UPDATE OF unit_size, product_id, quantity_received ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_line_stock_unit();

-- KI-140: an unknown unit gives no per-acre figure (was priced as 1 oz).
CREATE OR REPLACE FUNCTION public.product_price_per_acre(
  p_tier_price       numeric,
  p_rate_per_acre    numeric,
  p_rate_unit        text,
  p_inventory_unit   text,
  p_unit_size        text
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rate_factor numeric;
  v_inv_factor  numeric;
  v_inv_unit    text;
BEGIN
  -- No usable rate -> no per-acre figure (matches frontend: returns null).
  IF p_rate_per_acre IS NULL OR p_rate_per_acre <= 0 THEN
    RETURN NULL;
  END IF;

  -- rate unit -> oz factor (case-insensitive). An unknown unit gives no figure (KI-140).
  v_rate_factor := (SELECT factor_oz FROM unit_conversions WHERE lower(unit) = lower(p_rate_unit) LIMIT 1);

  -- inventory unit falls back to unit_size when blank/null (JS: inventory_unit || unit_size).
  v_inv_unit := COALESCE(NULLIF(p_inventory_unit, ''), p_unit_size);
  v_inv_factor := (SELECT factor_oz FROM unit_conversions WHERE lower(unit) = lower(v_inv_unit) LIMIT 1);

  IF v_rate_factor IS NULL OR v_inv_factor IS NULL OR v_inv_factor <= 0 THEN
    RETURN NULL;
  END IF;

  RETURN ROUND(
    (COALESCE(p_tier_price, 0) * (p_rate_per_acre * v_rate_factor) / v_inv_factor)::numeric,
    2);
END;
$$;

-- KI-140: a rate-mode quote line must use units save_quote's math knows.
CREATE FUNCTION public._refuse_unknown_quote_rate_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_stock text;
BEGIN
  IF COALESCE(NEW.calc_mode, 'rate_acres') <> 'rate_acres' OR COALESCE(NEW.actual_rate, 0) = 0
     OR NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.product_id, NEW.rate_unit, NEW.calc_mode, NEW.actual_rate)
         IS NOT DISTINCT FROM (OLD.product_id, OLD.rate_unit, OLD.calc_mode, OLD.actual_rate) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.unit_conversions u WHERE lower(u.unit) = lower(NEW.rate_unit)) THEN
    RAISE EXCEPTION 'QUOTE_RATE_UNIT_UNKNOWN: rate unit "%" is not a known unit; pick a unit from the list.',
      COALESCE(NEW.rate_unit, '(none)') USING ERRCODE = 'check_violation';
  END IF;
  -- Same fallback as save_quote's math.
  SELECT COALESCE(p.inventory_unit, p.unit_size, 'Ea') INTO v_stock FROM public.products p WHERE p.id = NEW.product_id;
  IF NOT EXISTS (SELECT 1 FROM public.unit_conversions u WHERE lower(u.unit) = lower(v_stock)) THEN
    RAISE EXCEPTION 'QUOTE_STOCK_UNIT_UNKNOWN: this product is stocked in "%", which is not a known unit; fix the product''s stock unit first.',
      v_stock USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._refuse_unknown_quote_rate_unit() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER a1_quote_item_known_units
  BEFORE INSERT OR UPDATE OF product_id, rate_unit, calc_mode, actual_rate ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public._refuse_unknown_quote_rate_unit();

-- KI-136: a product's stock unit cannot change under open lines counted in the old unit (they would then receive,
-- deliver and count on-order in the new one). Close, finish or re-enter those lines first.
CREATE FUNCTION public._refuse_stock_unit_change_with_open_lines()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_new text := COALESCE(NULLIF(btrim(NEW.inventory_unit), ''), NULLIF(btrim(NEW.unit_size), ''));
  v_old text := COALESCE(NULLIF(btrim(OLD.inventory_unit), ''), NULLIF(btrim(OLD.unit_size), ''));
  v_bad text;
BEGIN
  -- Blanking a stock unit counts as a change (lines would then accept any unit).
  IF v_old IS NULL AND v_new IS NULL
     OR v_old IS NOT NULL AND v_new IS NOT NULL AND public._unit_matches_stock_unit(v_old, v_new) THEN
    RETURN NEW;
  END IF;
  SELECT string_agg(x, ', ') INTO v_bad FROM (
    SELECT 'PO ' || po.po_number AS x
      FROM public.purchase_order_items l JOIN public.purchase_orders po ON po.id = l.purchase_order_id
     WHERE l.product_id = NEW.id AND po.status IN ('draft', 'submitted', 'partially_received')
       AND COALESCE(l.quantity_received, 0) < COALESCE(l.quantity_ordered, 0)
       AND NOT public._unit_matches_stock_unit(l.unit_size, v_new)
    UNION
    SELECT 'order ' || o.order_number
      FROM public.order_items l JOIN public.orders o ON o.id = l.order_id
     WHERE l.product_id = NEW.id AND o.status IN ('confirmed', 'partially_fulfilled')
       AND NOT public._unit_matches_stock_unit(l.unit_size, v_new)
    UNION
    SELECT 'delivery ' || d.delivery_number
      FROM public.delivery_items l JOIN public.deliveries d ON d.id = l.delivery_id
     WHERE l.product_id = NEW.id AND d.status IN ('scheduled', 'in_progress')
       AND NOT public._unit_matches_stock_unit(l.unit_size, v_new)
  ) s;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_UNIT_HAS_OPEN_LINES: this product''s stock unit cannot change to "%" while these are open in another unit: %',
      COALESCE(v_new, ''), v_bad USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._refuse_stock_unit_change_with_open_lines() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER a1_product_unit_keeps_open_lines
  BEFORE UPDATE OF inventory_unit, unit_size ON public.products
  FOR EACH ROW EXECUTE FUNCTION public._refuse_stock_unit_change_with_open_lines();

-- An open PO line with no unit would receive into a blank-unit stock row: give it the stock unit (1 live line
-- on 2026-11-15; more than 5 means the data moved, so stop and look).
DO $blank_fill$
DECLARE v_done integer;
BEGIN
UPDATE public.purchase_order_items l
   SET unit_size = COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), ''))
  FROM public.purchase_orders po, public.products p
 WHERE po.id = l.purchase_order_id AND p.id = l.product_id
   AND po.status IN ('draft', 'submitted', 'partially_received')
   AND COALESCE(l.quantity_received, 0) < COALESCE(l.quantity_ordered, 0)
   AND COALESCE(btrim(l.unit_size), '') = '';
GET DIAGNOSTICS v_done = ROW_COUNT;
IF v_done > 5 THEN
  RAISE EXCEPTION 'UNITS_BLANK_FILL_COUNT: % open PO lines have no unit (1 expected); check them before applying', v_done;
END IF;
END;
$blank_fill$;

-- Postflight: no open line holds another unit (the data correction ran first), so receiving, delivering and the
-- on-order total all count in the stock unit.
DO $postflight$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(x, ', ') INTO v_bad FROM (
    SELECT 'PO line ' || l.id AS x
      FROM public.purchase_order_items l JOIN public.purchase_orders po ON po.id = l.purchase_order_id
      JOIN public.products p ON p.id = l.product_id
     WHERE po.status IN ('draft', 'submitted', 'partially_received')
       AND COALESCE(l.quantity_received, 0) < COALESCE(l.quantity_ordered, 0)
       AND (COALESCE(btrim(l.unit_size), '') = ''
            OR NOT public._unit_matches_stock_unit(l.unit_size, COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), ''))))
    UNION ALL
    SELECT 'order line ' || l.id
      FROM public.order_items l JOIN public.orders o ON o.id = l.order_id JOIN public.products p ON p.id = l.product_id
     WHERE o.status IN ('confirmed', 'partially_fulfilled')
       AND NOT public._unit_matches_stock_unit(l.unit_size, COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')))
    UNION ALL
    SELECT 'delivery line ' || l.id
      FROM public.delivery_items l JOIN public.deliveries d ON d.id = l.delivery_id JOIN public.products p ON p.id = l.product_id
     WHERE d.status IN ('scheduled', 'in_progress')
       AND NOT public._unit_matches_stock_unit(l.unit_size, COALESCE(NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')))
  ) s;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'UNITS_POSTFLIGHT_OPEN_LINE: these open lines are not in their product''s stock unit (run 20270111100000 first): %', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fill_order_line_unit') THEN
    RAISE EXCEPTION 'UNITS_POSTFLIGHT: the old order-line fill trigger is still present';
  END IF;
END;
$postflight$;
