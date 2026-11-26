-- Add a checked read path for the admin registry before clients move to it.
-- Existing vehicle policies and workflows stay compatible during the transition.
-- Roll back with a reviewed view removal after restoring any dependent client.
SET LOCAL lock_timeout = '5s';

CREATE VIEW public.admin_vehicle_register
WITH (security_barrier = true) AS
SELECT
  v.id, v.vehicle_name, v.vehicle_type, v.category, v.capacity_gallons,
  v.capacity_unit, v.registration, v.status, v.notes, v.created_by,
  v.created_at, v.updated_at
FROM public.vehicles AS v
WHERE (SELECT public.is_admin());

ALTER VIEW public.admin_vehicle_register OWNER TO postgres;
-- Server and reporting paths continue to use their existing base relation.
REVOKE ALL ON TABLE public.admin_vehicle_register FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.admin_vehicle_register TO authenticated;

COMMENT ON VIEW public.admin_vehicle_register IS
  'Full administrative vehicle register. Active administrators only. Read-only browser grant.';

DO $postflight$
BEGIN
  IF has_table_privilege('anon', 'public.admin_vehicle_register', 'SELECT')
    OR has_table_privilege('metabase_ro', 'public.admin_vehicle_register', 'SELECT')
    OR has_table_privilege('service_role', 'public.admin_vehicle_register', 'SELECT')
    OR NOT has_table_privilege('authenticated', 'public.admin_vehicle_register', 'SELECT')
    OR has_table_privilege('authenticated', 'public.admin_vehicle_register', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  THEN RAISE EXCEPTION 'ADMIN_VEHICLE_REGISTER_GRANT_MISMATCH'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = 'public.admin_vehicle_register'::regclass AND relowner = 'postgres'::regrole
      AND reloptions @> ARRAY['security_barrier=true']
  ) THEN RAISE EXCEPTION 'ADMIN_VEHICLE_REGISTER_VIEW_MISMATCH'; END IF;
END
$postflight$;
