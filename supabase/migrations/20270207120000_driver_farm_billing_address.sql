-- #2018 (Sol round 5 on #2165, Mason 2026-11-21 "Fix address first"): the driver's farm lookup also returns the farm's
-- billing and shipping addresses separately. A delivery saved with "Use billing address" (no site id) goes to the
-- billing address on the office screens; the driver screens need the same address, and `address` (shipping, else
-- billing) could send the driver to a different place.
--
-- Changes only get_driver_customers(uuid[]): two more keys per row, billing_address and shipping_address (trimmed,
-- blank as null). `address` stays as it was. Who may call it, the 500-id limit, the refusals, owner,
-- SECURITY DEFINER, search_path and grants are unchanged. Still never credit limit, prepay balance, payment terms
-- or notes. No row changes.
--
-- Rollback: a new migration re-emitting the 20270204120000 body (the screens fall back to `address`).

CREATE TEMP TABLE driver_farm_billing_2018_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.driver_farm_billing_2018_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.driver_farm_billing_2018_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  -- The body this file replaces (20270204120000); anything else means someone changed it since (or a re-apply).
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.get_driver_customers(uuid[])'))
     IS DISTINCT FROM '5d5ec0712f317bfcfdedea8de7240282' THEN
    RAISE EXCEPTION 'DRIVER_FARM_BILLING_BASELINE_DRIFT: get_driver_customers is not the 20270204120000 body (already applied?)';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_driver_customers(p_customer_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true AND role = 'driver'
  ) THEN
    RAISE EXCEPTION 'Not authorized to view farm contacts' USING ERRCODE = '42501';
  END IF;
  IF p_customer_ids IS NULL OR cardinality(p_customer_ids) > 500 THEN
    RAISE EXCEPTION 'Pass up to 500 farm ids' USING ERRCODE = '22023';
  END IF;

  -- One row per distinct existing farm; unknown ids are simply absent.
  RETURN jsonb_build_object('rows', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', c.id,
             'farm_name', c.farm_name,
             'phone', c.phone,
             'email', c.email,
             'address', COALESCE(NULLIF(btrim(c.shipping_address), ''), NULLIF(btrim(c.billing_address), '')),
             'billing_address', NULLIF(btrim(c.billing_address), ''),
             'shipping_address', NULLIF(btrim(c.shipping_address), ''))
           ORDER BY c.id)
    FROM public.customers c
    WHERE c.id = ANY (p_customer_ids)
  ), '[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.get_driver_customers(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_customers(uuid[]) TO authenticated, service_role;

DO $postflight$
BEGIN
  IF (SELECT prosecdef AND provolatile = 's' AND proconfig = ARRAY['search_path=public, pg_temp']
        FROM pg_proc WHERE oid = to_regprocedure('public.get_driver_customers(uuid[])')) IS NOT TRUE
     OR has_function_privilege('anon', 'public.get_driver_customers(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_driver_customers(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_driver_customers must be definer, stable, fixed search_path, authenticated only';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.get_driver_customers(uuid[])')) IS DISTINCT FROM 'f49caaf5f387375c92be94c52c74e4ed' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_driver_customers is not this file''s body';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
