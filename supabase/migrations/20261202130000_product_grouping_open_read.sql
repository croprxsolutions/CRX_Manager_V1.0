-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261202130000_product_grouping_open_read.md. Re-read the live ledger before applying.
--
-- WHY (PAR-2 screens Sol round 1, BLOCKER: the Group products screen offers Approve while grouping is
--   switched off, so every approval is refused): the screen cannot see the switch, because
--   _product_parent_grouping_open() is private (no API-role EXECUTE). Split database-first from the
--   screens PR (2026-11-06).
--
-- WHAT: one read-only function, get_product_grouping_open(), that returns the switch for an admin and
--   refuses everyone else (AUTH_REQUIRED / ADMIN_REQUIRED, the same helper the grouping writers use).
--   EXECUTE goes to authenticated only. The screen uses it to hide Approve behind a "not switched on
--   yet" note.
--
-- NOT CHANGED: the switch itself (it stays off; turning it on is a separate, owner-approved step),
--   every table, row and other function. Read-only, so it takes no idempotency key.
--
-- ROLLBACK (its own reviewed migration): DROP FUNCTION public.get_product_grouping_open();
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public._product_parent_grouping_open()') IS NULL
     OR to_regprocedure('public._product_parent_require_admin()') IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_OPEN_READ_PREFLIGHT: the grouping switch or the admin check is missing';
  END IF;
  IF to_regprocedure('public.get_product_grouping_open()') IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_OPEN_READ_PREFLIGHT: get_product_grouping_open() already exists';
  END IF;
END
$preflight$;

CREATE FUNCTION public.get_product_grouping_open() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();
  RETURN public._product_parent_grouping_open();
END;
$function$;
ALTER FUNCTION public.get_product_grouping_open() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_product_grouping_open() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_grouping_open() TO authenticated;

DO $postflight$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.get_product_grouping_open()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_product_grouping_open()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_product_grouping_open()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_OPEN_READ_POSTFLIGHT: get_product_grouping_open() grants are not authenticated-only';
  END IF;
END
$postflight$;
