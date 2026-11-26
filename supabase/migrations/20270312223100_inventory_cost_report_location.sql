-- 20270312223100_inventory_cost_report_location.sql
-- Written 2026-11-25. STATUS: NOT APPLIED (local candidate).
-- Record: docs/reference/migrations.d/20270312223100_inventory_cost_report_location.md
--
-- WHAT: Reports > Operational > Inventory Cost returns one row per stock location but never said which
--   location, so a product stocked in two barns showed as two identical-looking products (free-screens
--   audit 2026-11-25, finding 1). get_inventory_cost_report() now also returns `location` (the
--   inventory row's location; NULL for an active product with no stock row) and orders by product
--   name, then location. Every other column, row and value is unchanged.
-- NOT CHANGED: no table, row or grant changes. The wrapper stays admin-only (require_admin) and the
--   implementation stays callable by nobody but its owner. Read-only report.
-- WHY DROP: a RETURNS TABLE column list cannot change with CREATE OR REPLACE. The REVOKE/GRANT lines
--   below restore the exact grants the dropped functions had (checked in the postflight).
-- caller-analysis: get_inventory_cost_report :: Reports.tsx Inventory Cost tab, admin only; grants are restored unchanged and the extra column is additive
-- ROLLBACK (new reviewed migration): drop both functions and recreate them from
--   20261103100000_product_active_guard.sql (impl md5 fb77a0d38ee1bb31a3c5a43dd1a0da59,
--   wrapper md5 2fdd283e39482add63e075ab84a7e52d), then re-run this file's REVOKE/GRANT block (a
--   recreated function otherwise gets default EXECUTE for PUBLIC), AND revert the app's
--   Reports.tsx `.order('location')` in the same step: without the column that order errors (42703)
--   and the Inventory Cost tab fails to load. Deploy order: apply this before the app change.
-- ORDERING: independent; any order after 20261103100000_product_active_guard.
SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public._get_inventory_cost_report_cost_impl_20261019()', 'fb77a0d38ee1bb31a3c5a43dd1a0da59'),
    ('public.get_inventory_cost_report()', '2fdd283e39482add63e075ab84a7e52d')
  ) AS t(sig, pin) LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.pin THEN
      RAISE EXCEPTION 'PREFLIGHT_INVENTORY_COST_LOCATION_BODY_DRIFT: %', r.sig;
    END IF;
  END LOOP;
END;
$preflight$;

DROP FUNCTION public.get_inventory_cost_report();
DROP FUNCTION public._get_inventory_cost_report_cost_impl_20261019();

CREATE FUNCTION public._get_inventory_cost_report_cost_impl_20261019()
 RETURNS TABLE(product_id uuid, product_name text, sku text, category text, vendor text, location text, quantity_available numeric, quantity_prebooked numeric, net_available numeric, unit_cost numeric, total_cost_value numeric, reorder_point numeric, below_reorder boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;
  RETURN QUERY
  SELECT pr.id, pr.product_name, pr.sku, pr.category, pr.vendor, inv.location,
    COALESCE(inv.quantity_available, 0), COALESCE(inv.quantity_prebooked, 0),
    COALESCE(inv.quantity_available, 0) - COALESCE(inv.quantity_prebooked, 0),
    COALESCE(pr.current_cost, 0),
    ROUND((COALESCE(inv.quantity_available, 0) * COALESCE(pr.current_cost, 0))::numeric, 2),
    COALESCE(inv.reorder_point, 0),
    pr.is_active AND COALESCE(inv.quantity_available, 0) < COALESCE(inv.reorder_point, 0)
  FROM products pr LEFT JOIN inventory inv ON inv.product_id = pr.id
  -- BEGIN DELTA inventory_cost_report_column_fix (2026-06-10): the live filter
  -- referenced a soft-delete timestamp column that does not exist on products
  -- (42703). The real products soft-delete mechanism is the is_active flag
  -- (Products.tsx deactivates; every picker filters is_active = true).
  WHERE pr.is_active = true OR COALESCE(inv.quantity_available, 0) <> 0
  -- END DELTA inventory_cost_report_column_fix
  ORDER BY pr.product_name, inv.location;
END;
$function$;

CREATE FUNCTION public.get_inventory_cost_report()
RETURNS TABLE(product_id uuid, product_name text, sku text, category text, vendor text, location text,
              quantity_available numeric, quantity_prebooked numeric, net_available numeric,
              unit_cost numeric, total_cost_value numeric, reorder_point numeric, below_reorder boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15).
  PERFORM public.require_admin();
  RETURN QUERY SELECT * FROM public._get_inventory_cost_report_cost_impl_20261019();
END;
$function$;

REVOKE ALL ON FUNCTION public._get_inventory_cost_report_cost_impl_20261019() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public.get_inventory_cost_report() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_cost_report() TO authenticated, service_role;

DO $postflight$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro']) AS r(role)
             WHERE has_function_privilege(r.role, 'public._get_inventory_cost_report_cost_impl_20261019()', 'EXECUTE'))
     OR has_function_privilege('anon', 'public.get_inventory_cost_report()', 'EXECUTE')
     OR has_function_privilege('metabase_ro', 'public.get_inventory_cost_report()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_inventory_cost_report()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_inventory_cost_report()', 'EXECUTE') THEN
    RAISE EXCEPTION 'INVENTORY_COST_LOCATION_POSTFLIGHT: grants';
  END IF;
  IF position('PERFORM public.require_admin();' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_inventory_cost_report()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'INVENTORY_COST_LOCATION_POSTFLIGHT: admin gate';
  END IF;
  -- SECURITY DEFINER runs as the owner: it must stay postgres, as before.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('public.get_inventory_cost_report()'::regprocedure,
               'public._get_inventory_cost_report_cost_impl_20261019()'::regprocedure)
             AND proowner <> 'postgres'::regrole) THEN
    RAISE EXCEPTION 'INVENTORY_COST_LOCATION_POSTFLIGHT: owner';
  END IF;
END;
$postflight$;
