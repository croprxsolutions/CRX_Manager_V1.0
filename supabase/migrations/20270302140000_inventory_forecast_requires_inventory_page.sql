-- ============================================================================
-- 20270302140000_inventory_forecast_requires_inventory_page
-- Follow-up to #2394 (Taha's review; Mason, 2026-11-24).
--
-- WHY: the Inventory page's Forecast tab reads get_inventory_forecast, which checks only the caller's role. A sales
-- rep whose Inventory page is turned off in Settings > Page Access could still call it and read the business-wide
-- planned demand (per product and month, with customer and quote counts), stock and PO coverage.
-- WHAT (access check only; no forecast logic changes):
--   get_inventory_forecast(integer) = the 20261204110000 body plus one line after its role check:
--   PERFORM public._require_page_access('inventory') (the 20270228210000 helper, unchanged). Same signature,
--   SECURITY DEFINER, volatility, search_path and grants. Callers without the role keep the old 'Access denied'
--   message; only a rep with Inventory turned off is new.
-- NOT CHANGED: get_inventory_position (stock position) stays open to every caller it served, because New Order,
--   Quick Delivery, Receiving and other screens read it.
-- ROLLBACK: a NEW forward migration restoring the pinned prior body (md5 in the preflight below).
-- ============================================================================

DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.get_inventory_forecast(integer)'))
     IS DISTINCT FROM 'd09a7eb840476fdbe05a189e1093c804' THEN
    RAISE EXCEPTION 'PREFLIGHT_FORECAST_DRIFT: get_inventory_forecast is not the 20261204110000 body';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public._require_page_access(text)'))
     IS DISTINCT FROM 'f8d14bb0f4929894eea830a8cf723aba' THEN
    RAISE EXCEPTION 'PREFLIGHT_HELPER_DRIFT: _require_page_access is not the 20270228210000 body';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_inventory_forecast(p_months_ahead integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid()
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required' USING ERRCODE = '42501';
  END IF;
  -- #2394 follow-up: Settings > Page Access is enforced here too; a rep with the Inventory page turned off is refused.
  PERFORM public._require_page_access('inventory');

  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
    FROM (
      WITH demand_rows AS (
        -- crop_program holds bucketed by expiry − 14d (live behavior, unchanged)
        SELECT ih.product_id, ih.source_id, ih.customer_id, ih.quantity,
               'crop_program'::text AS kind,
               DATE_TRUNC('month', (ih.expires_at - INTERVAL '14 days'))::date AS needed_month
        FROM inventory_holds ih
        WHERE ih.is_active = true
          AND ih.hold_type = 'crop_program'
          AND ih.expires_at IS NOT NULL
          AND (ih.expires_at - INTERVAL '14 days') <= (now() AT TIME ZONE 'America/Chicago')::date + (p_months_ahead || ' months')::interval
        UNION ALL
        -- LAYER2: job holds bucketed by jobs.job_date (expires_at is NULL for job holds)
        SELECT ih.product_id, ih.source_id, ih.customer_id, ih.quantity,
               'job'::text AS kind,
               DATE_TRUNC('month', j.job_date)::date AS needed_month
        FROM inventory_holds ih
        JOIN jobs j ON j.id = ih.source_id
        WHERE ih.is_active = true
          AND ih.hold_type = 'job'
          AND j.deleted_at IS NULL
          AND j.job_date IS NOT NULL
          AND j.job_date <= ((now() AT TIME ZONE 'America/Chicago')::date + (p_months_ahead || ' months')::interval)::date
      )
      SELECT
        p.id AS product_id,
        p.product_name,
        p.sku,
        dr.needed_month,
        SUM(dr.quantity) AS planned_demand,
        COALESCE(SUM(dr.quantity) FILTER (WHERE dr.kind = 'job'), 0) AS job_demand,
        -- Codex A+B P2 #5: wrap the scalar subquery in COALESCE so a NO-ROW result
        -- (product with a job hold but no Main Warehouse inventory row) yields 0, not
        -- NULL — the inner COALESCE only guards a NULL column, not a missing row, and
        -- the frontend calls .toLocaleString() on these (would crash on null).
        COALESCE((SELECT i.quantity_available FROM inventory i WHERE i.product_id = p.id AND i.location = 'Main Warehouse' LIMIT 1), 0) AS current_available,
        COALESCE((SELECT i.quantity_prebooked FROM inventory i WHERE i.product_id = p.id AND i.location = 'Main Warehouse' LIMIT 1), 0) AS prebooked,
        (SELECT COALESCE(SUM(poi.quantity_ordered - poi.quantity_received), 0)
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE poi.product_id = p.id AND po.status IN ('submitted', 'partially_received')
        ) AS on_order,
        COUNT(DISTINCT dr.source_id) FILTER (WHERE dr.kind = 'crop_program') AS quote_count,
        COUNT(DISTINCT dr.customer_id) AS customer_count
      FROM demand_rows dr
      JOIN products p ON p.id = dr.product_id
      GROUP BY p.id, p.product_name, p.sku, dr.needed_month
      ORDER BY dr.needed_month, p.product_name
    ) r
  );
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
      WHERE p.oid = 'public.get_inventory_forecast(integer)'::regprocedure)
     IS DISTINCT FROM '6f815eb16bdf82c8ba5873db8055a2b0' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FORECAST: get_inventory_forecast did not install';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = 'get_inventory_forecast') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: expected exactly one get_inventory_forecast';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.get_inventory_forecast(integer)'::regprocedure
        AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SECURITY: security definer, volatility or search_path changed';
  END IF;
  IF has_function_privilege('anon', 'public.get_inventory_forecast(integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_inventory_forecast(integer)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = 'public.get_inventory_forecast(integer)'::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANTS: get_inventory_forecast must run for authenticated only (no anon, no PUBLIC)';
  END IF;
END;
$postflight$;
