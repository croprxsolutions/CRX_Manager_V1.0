-- v0.1.0 release (#1990), apply review of 20270109100100 / 20270109100200 (rls-security-reviewer CHECK 4):
-- _recompute_standing_discount_20261231(uuid) writes invoice data and kept EXECUTE for service_role
-- (20270109100100:290 revoked it only from PUBLIC, anon and authenticated; 20270109100200's preflight pins its ACL
-- to postgres and service_role). Mason, 2026-11-19 (#2006): a later migration that revokes EXECUTE on an internal
-- helper from every API role clears it.
--
-- * REVOKE ALL on the helper from PUBLIC, anon, authenticated and service_role. Postflight: its ACL names its owner
--   and nobody else (any other grantee, gateway or custom role included, stops the apply).
-- * Its five callers stay SECURITY DEFINER functions owned by the helper's owner (postflight), so they keep working:
--   set_invoice_standing_discount, set_order_sales_tax and the three standing-discount trigger functions. Nothing
--   in the app, edge functions, smoke chains or cron calls the helper.
-- * No body change, no data change.

SET LOCAL lock_timeout = '10s';

REVOKE ALL ON FUNCTION public._recompute_standing_discount_20261231(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  c_helper constant regprocedure := 'public._recompute_standing_discount_20261231(uuid)'::regprocedure;
  v_bad text;
BEGIN
  SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, ', ') INTO v_bad
    FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
   WHERE p.oid = c_helper AND a.grantee <> p.proowner;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECOMPUTE_HELPER_STILL_GRANTED: %', v_bad;
  END IF;

  SELECT string_agg(c.sig, ', ') INTO v_bad
    FROM unnest(ARRAY['public.set_invoice_standing_discount(uuid,numeric,text)',
                      'public.set_order_sales_tax(uuid,boolean,text)',
                      'public._standing_discount_after_line_change_20261231()',
                      'public._standing_discount_after_invoice_change_20261231()',
                      'public._standing_discount_before_fingerprint_20261231()']) c(sig)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(c.sig)
   WHERE p.oid IS NULL OR NOT p.prosecdef
      OR p.proowner <> (SELECT proowner FROM pg_proc WHERE oid = c_helper);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECOMPUTE_HELPER_CALLER_NOT_OWNER_DEFINER: %', v_bad;
  END IF;
END
$postflight$;
