-- Written 2026-11-02. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261103090000_retire_admin_set_application_service_cost.md.
--
-- WHAT (KI-02, To-Do 11.3: cost and margin are admin-only): drop the unused
--   admin_set_application_service_cost(uuid, bigint, text). Since 20260729035923 admins save a
--   service's cost through admin_save_application_service; this function was kept "for one
--   release only" and no screen calls it.
--
-- WHY: one fewer signed-in-executable function that writes cost.
--
-- HOW: a plain DROP of the exact live argument list (read-only catalog check, 2026-11-02: one
--   version, no pg_depend dependents, no trigger, no other function body names it). No CASCADE,
--   so the drop fails if anything has come to depend on it. No table, row or grant elsewhere
--   changes.
--
-- ROLLBACK: a reviewed migration re-creating the function from 20260729015706 with its grants.

DROP FUNCTION public.admin_set_application_service_cost(uuid, bigint, text);

DO $postflight$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
               AND p.proname = 'admin_set_application_service_cost') THEN
    RAISE EXCEPTION 'RETIRE_ADMIN_SET_APPLICATION_SERVICE_COST_POSTFLIGHT: a version still exists';
  END IF;
END
$postflight$;
