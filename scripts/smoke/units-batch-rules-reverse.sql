-- Rollback for supabase/migrations/20270121110000_line_unit_is_stock_unit.sql (proven by
-- scripts/smoke/prove-units-batch-real-schema.mjs). Run this BEFORE ki137-units-data-reverse.sql.
-- Puts back the old order-line fill trigger and live's product_price_per_acre body, and removes the unit rules.
-- The one open PO line that had no unit keeps the stock unit it was given (harmless: receiving read blank as it).
-- To use it live, copy it into a new migration through the gates (without the BEGIN / COMMIT lines).
BEGIN;

DROP TRIGGER a1_line_unit_is_stock_unit ON public.order_items;
DROP TRIGGER a1_line_unit_is_stock_unit ON public.delivery_items;
DROP TRIGGER a1_line_unit_is_stock_unit ON public.purchase_order_items;
DROP TRIGGER a1_product_unit_keeps_open_lines ON public.products;
DROP TRIGGER a1_product_unit_relabels_stock_rows ON public.products;
DROP TRIGGER a1_stock_row_unit_is_stock_unit ON public.inventory;
DROP TRIGGER trg_h_quote_item_known_units ON public.quote_items;
DROP FUNCTION public._enforce_line_stock_unit();
DROP FUNCTION public._refuse_stock_unit_change_with_open_lines();
DROP FUNCTION public._relabel_empty_stock_rows();
DROP FUNCTION public._stock_row_unit_is_stock_unit();
DROP FUNCTION public._refuse_unknown_quote_rate_unit();
DROP FUNCTION public._unit_matches_stock_unit(text, text);

CREATE FUNCTION public._fill_order_line_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(btrim(NEW.unit_size, E' \t\r\n' || chr(160)), '') = '' AND NEW.product_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    NEW.unit_size := COALESCE((SELECT p.unit_size FROM public.products p
                                WHERE p.id = NEW.product_id
                                  AND COALESCE(btrim(p.unit_size, E' \t\r\n' || chr(160)), '') <> ''),
                              NEW.unit_size);
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public._fill_order_line_unit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_fill_order_line_unit BEFORE INSERT OR UPDATE OF product_id ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._fill_order_line_unit();

CREATE OR REPLACE FUNCTION public.product_price_per_acre(p_tier_price numeric, p_rate_per_acre numeric, p_rate_unit text, p_inventory_unit text, p_unit_size text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rate_factor numeric;
  v_inv_factor  numeric;
  v_inv_unit    text;
BEGIN
  -- No usable rate -> no per-acre figure (matches frontend: returns null).
  IF p_rate_per_acre IS NULL OR p_rate_per_acre <= 0 THEN
    RETURN NULL;
  END IF;

  -- rate unit -> oz factor (case-insensitive; default 1 when absent/unknown).
  v_rate_factor := COALESCE(
    (SELECT factor_oz FROM unit_conversions WHERE lower(unit) = lower(p_rate_unit) LIMIT 1),
    1);

  -- inventory unit falls back to unit_size when blank/null (JS: inventory_unit || unit_size).
  v_inv_unit := COALESCE(NULLIF(p_inventory_unit, ''), p_unit_size);
  v_inv_factor := COALESCE(
    (SELECT factor_oz FROM unit_conversions WHERE lower(unit) = lower(v_inv_unit) LIMIT 1),
    1);

  -- Guard divide-by-zero (mirrors frontend `inventoryUnitFactorOz > 0`).
  IF v_inv_factor IS NULL OR v_inv_factor <= 0 THEN
    RETURN NULL;
  END IF;

  RETURN ROUND(
    (COALESCE(p_tier_price, 0) * (p_rate_per_acre * v_rate_factor) / v_inv_factor)::numeric,
    2);
END;
$function$;

COMMIT;
