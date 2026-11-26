-- Add a checked read path for the admin registry before clients move to it.
-- Existing vehicle policies and workflows stay compatible during the transition.
SET LOCAL lock_timeout = '5s';

CREATE VIEW public.admin_vehicle_register
WITH (security_barrier = true) AS
SELECT
  v.id, v.vehicle_name, v.vehicle_type, v.category, v.capacity_gallons,
  v.capacity_unit, v.registration, v.status, v.notes, v.created_by,
  v.created_at, v.updated_at
FROM public.vehicles AS v
WHERE (SELECT public.is_admin());

REVOKE ALL ON TABLE public.admin_vehicle_register FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.admin_vehicle_register TO authenticated;

COMMENT ON VIEW public.admin_vehicle_register IS
  'Full administrative vehicle register. Active administrators only. Read-only browser grant.';

DO $postflight$
BEGIN
  IF has_table_privilege('anon', 'public.admin_vehicle_register', 'SELECT')
    OR NOT has_table_privilege('authenticated', 'public.admin_vehicle_register', 'SELECT')
    OR has_table_privilege('authenticated', 'public.admin_vehicle_register', 'INSERT, UPDATE, DELETE')
  THEN RAISE EXCEPTION 'ADMIN_VEHICLE_REGISTER_GRANT_MISMATCH'; END IF;
END
$postflight$;
