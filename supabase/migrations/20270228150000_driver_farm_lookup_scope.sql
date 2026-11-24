-- Release #2388 Sol HIGH 1 (Mason, 2026-11-23: fix before release): the driver's farm lookup returned the email,
-- phone and addresses of ANY farm id it was given, to any active driver, even one an admin had shut out of both
-- driver pages. Drivers' direct read of customers (customers_select) only ever showed farms on their own recent
-- deliveries; the lookup must not show more.
--
-- Changes only get_driver_customers(uuid[]):
--   1. The caller must be an active driver who still has the Deliveries or the My Route page (an admin has not put
--      both 'deliveries' and 'my-route' in profiles.denied_pages); otherwise the same "Not authorized" refusal.
--   2. A requested farm is returned only when it is on a not-deleted, not cancelled or voided delivery assigned to
--      the caller that is still open (scheduled or in progress, so an overdue stop on My Route keeps its farm),
--      scheduled from yesterday on (the customers_select driver window), or completed since yesterday (so an overdue
--      stop the driver just finished keeps its farm for the receipt). Other ids are simply absent, as unknown ids already were.
-- Same keys, the 500-id limit, owner, SECURITY DEFINER, search_path and grants (CREATE OR REPLACE). This replaces
-- the 2026-11-21 "drivers may see these for every farm" decision. No row changes.
--
-- Rollback: a new migration re-emitting the 20270207120000 body (reopens the leak; only with Mason's yes).

CREATE TEMP TABLE driver_farm_scope_2388_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.driver_farm_scope_2388_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.driver_farm_scope_2388_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  -- The body this file replaces (20270207120000); anything else means someone changed it since (or a re-apply).
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.get_driver_customers(uuid[])'))
     IS DISTINCT FROM 'f49caaf5f387375c92be94c52c74e4ed' THEN
    RAISE EXCEPTION 'DRIVER_FARM_SCOPE_BASELINE_DRIFT: get_driver_customers is not the 20270207120000 body (already applied?)';
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
      AND NOT (COALESCE('deliveries' = ANY (denied_pages), false) AND COALESCE('my-route' = ANY (denied_pages), false))
  ) THEN
    RAISE EXCEPTION 'Not authorized to view farm contacts' USING ERRCODE = '42501';
  END IF;
  IF p_customer_ids IS NULL OR cardinality(p_customer_ids) > 500 THEN
    RAISE EXCEPTION 'Pass up to 500 farm ids' USING ERRCODE = '22023';
  END IF;

  -- One row per distinct farm on one of the caller's deliveries; any other id is simply absent.
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
      AND EXISTS (
        SELECT 1 FROM public.deliveries d
         WHERE d.customer_id = c.id
           AND d.assigned_driver = auth.uid()
           AND d.deleted_at IS NULL
           AND d.status NOT IN ('cancelled', 'voided')
           AND (d.status IN ('scheduled', 'in_progress') OR d.scheduled_date >= CURRENT_DATE - 1
                OR d.completed_at >= CURRENT_DATE - 1))
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
       WHERE oid = to_regprocedure('public.get_driver_customers(uuid[])')) IS DISTINCT FROM 'd0750901bc7ab9f9fed1897217b0084f' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_driver_customers is not this file''s body';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
