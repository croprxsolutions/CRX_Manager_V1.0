-- Products sold by the whole item take whole quantities (follow-up promised on #2562).
-- Contract: docs/plans/2026-11-26-whole-item-quantities-CONTRACT.md (Mason's decisions D1-D4, 2026-11-26).
--
-- WHAT: one BEFORE trigger function, _enforce_whole_item_quantity(), on quote_items, order_items and
--   delivery_items. When the line's product is stocked in a count unit (Ea or Unit, case and spaces ignored), a
--   quantity column that is new or changed and not a whole number is refused (WHOLE_ITEMS_ONLY, check_violation).
--   Columns: quote_items.total_units_needed; order_items.total_units_needed, quantity_delivered;
--   delivery_items.quantity, quantity_delivered. NULL and unchanged values pass, so history saves as before
--   (except quote lines: save_quote re-inserts every line, so every quote save re-checks them all).
--   Nothing is rounded. Products stocked by the gallon, pound or ounce are unchanged.
-- Live 2026-11-26 (read-only): 0 quote, order or delivery lines on Ea/Unit products; no row changes here.
--
-- idempotency-body-check: exempt -- no RPC is created or changed; the trigger only narrows what any writer stores.
-- caller-analysis: every writer of the five columns (save_quote, convert_quote_to_order, draw_down_quote,
--   create_direct_order, bulk_import_order, update_order_items, create_quick_delivery, create_rush_order,
--   create_order_from_blend_ticket, complete_delivery and wrappers, return and cancel paths) now gets
--   WHOLE_ITEMS_ONLY for a fractional figure on an Ea/Unit product; src/lib/errorSanitizer.ts shows the sentence.
-- ROLLBACK: scripts/smoke/whole-item-quantities-reverse.sql drops the three triggers and the function.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public._enforce_whole_item_quantity()') IS NOT NULL THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_PREFLIGHT: _enforce_whole_item_quantity already exists';
  END IF;
END;
$preflight$;

CREATE FUNCTION public._enforce_whole_item_quantity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_new   jsonb := to_jsonb(NEW);
  v_old   jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  v_cols  text[] := CASE TG_TABLE_NAME WHEN 'delivery_items' THEN ARRAY['quantity', 'quantity_delivered']
                                       WHEN 'order_items' THEN ARRAY['total_units_needed', 'quantity_delivered']
                                       ELSE ARRAY['total_units_needed'] END;
  v_col   text;
  v_qty   numeric;
  v_name  text;
  v_unit  text;
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  FOREACH v_col IN ARRAY v_cols LOOP
    v_qty := (v_new->>v_col)::numeric;
    -- A changed product re-checks every figure; otherwise only a new or changed figure.
    -- NaN and Infinity equal their own trunc(), so they are not counted as whole.
    CONTINUE WHEN v_qty IS NULL
               OR (v_qty = trunc(v_qty) AND v_qty > '-Infinity'::numeric AND v_qty < 'Infinity'::numeric)
               OR (TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
                   AND v_new->v_col IS NOT DISTINCT FROM v_old->v_col);
    IF v_unit IS NULL THEN
      -- Same trim as _unit_matches_stock_unit; FOR SHARE holds the stock unit until this line commits.
      SELECT p.product_name,
             COALESCE(NULLIF(btrim(p.inventory_unit, E' \t\r\n' || chr(160)), ''),
                      NULLIF(btrim(p.unit_size, E' \t\r\n' || chr(160)), ''))
        INTO v_name, v_unit FROM public.products p WHERE p.id = NEW.product_id FOR SHARE;
      IF lower(COALESCE(v_unit, '')) NOT IN ('ea', 'unit') THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'WHOLE_ITEMS_ONLY: % is sold by the whole item (%), so % can''t be used. Enter a whole number%',
      COALESCE(v_name, 'This product'), v_unit, trim_scale(v_qty),
      CASE WHEN TG_TABLE_NAME = 'quote_items'
           THEN '. Change the rate or acres, or type the number of items.' ELSE '.' END
      USING ERRCODE = 'check_violation';
  END LOOP;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public._enforce_whole_item_quantity() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER a3_whole_item_quantity
  BEFORE INSERT OR UPDATE OF product_id, total_units_needed ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_whole_item_quantity();
CREATE TRIGGER a3_whole_item_quantity
  BEFORE INSERT OR UPDATE OF product_id, total_units_needed, quantity_delivered ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_whole_item_quantity();
CREATE TRIGGER a3_whole_item_quantity
  BEFORE INSERT OR UPDATE OF product_id, quantity, quantity_delivered ON public.delivery_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_whole_item_quantity();

DO $postflight$
DECLARE
  v_docs text;
BEGIN
  -- Scanned after CREATE TRIGGER: its lock waits out in-flight writers and holds off new ones until commit,
  -- so no fractional line can land between this scan and the triggers. Every status counts (closing a document
  -- leaves its figures), and save_quote re-inserts lines, so a legacy quote fraction would block every save.
  WITH whole_items AS (
    SELECT p.id FROM public.products p
     WHERE lower(COALESCE(NULLIF(btrim(p.inventory_unit, E' \t\r\n' || chr(160)), ''),
                          NULLIF(btrim(p.unit_size, E' \t\r\n' || chr(160)), ''), '')) IN ('ea', 'unit')
  ), bad AS (
    SELECT 'quote ' || q.quote_number AS doc FROM public.quote_items qi JOIN public.quotes q ON q.id = qi.quote_id
     WHERE qi.product_id IN (SELECT id FROM whole_items) AND qi.total_units_needed <> trunc(qi.total_units_needed)
    UNION
    SELECT 'order ' || o.order_number FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
     WHERE oi.product_id IN (SELECT id FROM whole_items)
       AND (oi.total_units_needed <> trunc(oi.total_units_needed) OR oi.quantity_delivered <> trunc(oi.quantity_delivered))
    UNION
    SELECT 'delivery ' || d.delivery_number FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id
     WHERE di.product_id IN (SELECT id FROM whole_items)
       AND (di.quantity <> trunc(di.quantity) OR di.quantity_delivered <> trunc(di.quantity_delivered))
  )
  SELECT string_agg(doc, ', ' ORDER BY doc) INTO v_docs FROM (SELECT doc FROM bad ORDER BY doc LIMIT 10) first_ten;
  IF v_docs IS NOT NULL THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_POSTFLIGHT: fractional quantities already exist on Ea/Unit products (first ten: %). Closed and completed documents count too: closing one does not change its figures. Make each figure whole before applying; a delivered fraction needs a person to decide how to correct the record', v_docs;
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'a3_whole_item_quantity' AND NOT tgisinternal
        AND tgfoid = 'public._enforce_whole_item_quantity()'::regprocedure) <> 3 THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_POSTFLIGHT: expected three a3_whole_item_quantity triggers';
  END IF;
  IF has_function_privilege('authenticated', 'public._enforce_whole_item_quantity()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._enforce_whole_item_quantity()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._enforce_whole_item_quantity()', 'EXECUTE') THEN
    RAISE EXCEPTION 'WHOLE_ITEMS_POSTFLIGHT: an API role can call the trigger function';
  END IF;
END;
$postflight$;
