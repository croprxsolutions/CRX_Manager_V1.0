-- v0.1.0 release (#1990), apply review of 20270109100100 / 20270109100200 (rls-security-reviewer CHECK 4):
-- _recompute_standing_discount_20261231(uuid) writes invoice data and kept EXECUTE for service_role
-- (20270109100100:290 revoked it only from PUBLIC, anon and authenticated). Mason, 2026-11-19 (#2006): a later
-- migration that revokes EXECUTE on an internal helper from every API role clears it.
--
-- * REVOKE ALL on the helper from PUBLIC, anon, authenticated, service_role and metabase_ro. Its only callers are
--   SECURITY DEFINER functions (the standing-discount triggers, set_invoice_standing_discount, set_order_sales_tax),
--   so they keep working. Nothing in the app, edge functions, smoke chains or cron calls it.
-- * No body change, no data change.

SET LOCAL lock_timeout = '10s';

REVOKE ALL ON FUNCTION public._recompute_standing_discount_20261231(uuid)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  -- A PUBLIC grant would show up here too: every role inherits it.
  SELECT string_agg(r.role, ', ') INTO v_bad
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro']) r(role)
   WHERE has_function_privilege(r.role, 'public._recompute_standing_discount_20261231(uuid)', 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECOMPUTE_HELPER_STILL_EXECUTABLE: %', v_bad;
  END IF;
END
$postflight$;
