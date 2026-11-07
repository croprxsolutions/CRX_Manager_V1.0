-- Written 2026-11-07. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261206120000_product_duplicate_parents_read.md. Re-read the live ledger before applying.
--
-- WHY (PAR-2 follow-up after PR #1602): build_product_parent_proposal returns duplicate_parents (active
--   parents that already duplicate one another) only in its reply, so the Group products screen shows the
--   warning only right after Build and loses it on reload. The list reflects today's parents, not the
--   proposal, so it is read fresh rather than stored. Split database-first from the screen change.
--
-- WHAT: one read-only function, get_duplicate_product_parents(), that returns the same list the build
--   returns: active parents grouped by EPA number, form and identity name, where a group holds two or more,
--   as [{generic_epa_registration, product_form, names}]. Admin only (AUTH_REQUIRED / ADMIN_REQUIRED, the
--   helper the grouping writers use); EXECUTE goes to authenticated only. Its query is the build's,
--   character for character, so both always agree.
--
-- NOT CHANGED: build_product_parent_proposal (still returns the list too), every table, row and other
--   function. Read-only, so it takes no idempotency key.
--
-- ROLLBACK (its own reviewed migration): DROP FUNCTION public.get_duplicate_product_parents();
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public._product_parent_identity_name(text)') IS NULL
     OR to_regprocedure('public._product_parent_require_admin()') IS NULL
     OR to_regclass('public.product_parents') IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_DUPLICATE_PARENTS_READ_PREFLIGHT: product_parents, the identity name or the admin check is missing';
  END IF;
  IF to_regprocedure('public.get_duplicate_product_parents()') IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_DUPLICATE_PARENTS_READ_PREFLIGHT: get_duplicate_product_parents() already exists';
  END IF;
END
$preflight$;

CREATE FUNCTION public.get_duplicate_product_parents() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();
  -- The same query as build_product_parent_proposal's duplicate_parents (20261201110000).
  RETURN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('generic_epa_registration', d.epa, 'product_form', d.form, 'names', d.names)
                       ORDER BY d.epa, d.form)
        FROM (SELECT pp.generic_epa_registration AS epa, pp.product_form AS form,
                     jsonb_agg(pp.name ORDER BY pp.name) AS names
                FROM public.product_parents pp
               WHERE pp.is_active
               GROUP BY pp.generic_epa_registration, pp.product_form, public._product_parent_identity_name(pp.name)
              HAVING count(*) > 1) d), '[]'::jsonb);
END;
$function$;
ALTER FUNCTION public.get_duplicate_product_parents() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_duplicate_product_parents() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_duplicate_product_parents() TO authenticated;

DO $postflight$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.get_duplicate_product_parents()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_duplicate_product_parents()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_duplicate_product_parents()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRODUCT_DUPLICATE_PARENTS_READ_POSTFLIGHT: get_duplicate_product_parents() grants are not authenticated-only';
  END IF;
END
$postflight$;
