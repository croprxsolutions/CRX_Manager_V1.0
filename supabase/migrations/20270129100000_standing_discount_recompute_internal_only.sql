-- v0.1.0 release (#1990), apply review of 20270109100100 / 20270109100200 (rls-security-reviewer CHECK 4):
-- _recompute_standing_discount_20261231(uuid) writes invoice data and kept EXECUTE for service_role
-- (20270109100100:290 revoked it only from PUBLIC, anon and authenticated). Mason, 2026-11-19 (#2006): a later
-- migration that revokes EXECUTE on an internal helper from every API role clears it.
--
-- * REVOKE ALL on the helper from PUBLIC, anon, authenticated and service_role (any other role only ever had it
--   through PUBLIC). Its only callers are SECURITY DEFINER functions (the standing-discount triggers,
--   set_invoice_standing_discount, set_order_sales_tax); postflight checks their owners still can call it.
--   Nothing in the app, edge functions, smoke chains or cron calls it.
-- * No body change, no data change.

SET LOCAL lock_timeout = '10s';

REVOKE ALL ON FUNCTION public._recompute_standing_discount_20261231(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  -- No API role can call it: the three Supabase roles, metabase_ro, and any role the API gateway (authenticator) can
  -- switch to. A PUBLIC grant would show through each.
  SELECT string_agg(r.rolname, ', ') INTO v_bad
    FROM pg_roles r
   WHERE NOT r.rolsuper
     AND (r.rolname IN ('anon', 'authenticated', 'service_role', 'metabase_ro')
          OR (to_regrole('authenticator') IS NOT NULL AND r.rolname <> 'authenticator'
              AND pg_has_role('authenticator', r.oid, 'MEMBER')))
     AND has_function_privilege(r.oid, 'public._recompute_standing_discount_20261231(uuid)', 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECOMPUTE_HELPER_STILL_EXECUTABLE: %', v_bad;
  END IF;

  -- Every SECURITY DEFINER caller's owner can still call it.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
     AND p.prosrc LIKE '%_recompute_standing_discount_20261231(%'
     AND p.oid <> 'public._recompute_standing_discount_20261231(uuid)'::regprocedure
     AND NOT has_function_privilege(p.proowner, 'public._recompute_standing_discount_20261231(uuid)', 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECOMPUTE_HELPER_CALLER_LOST_ACCESS: %', v_bad;
  END IF;
END
$postflight$;
