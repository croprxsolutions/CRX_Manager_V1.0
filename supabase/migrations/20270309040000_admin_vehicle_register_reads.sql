-- Step 1 of docs/plans/2026-11-26-vehicle-register-access-CONTRACT.md.
-- Add a separate admin read path before the app moves to it. Base-table reads remain open.
-- Roll back with a reviewed view removal after restoring any dependent client.
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE admin_vehicle_register_tx ON COMMIT DROP AS
  SELECT pg_current_xact_id() AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.admin_vehicle_register_tx') IS NULL THEN
    RAISE EXCEPTION 'ADMIN_VEHICLE_REGISTER_NEEDS_TRANSACTION';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'vehicles' AND policyname = 'vehicles_select'
      AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles = ARRAY['authenticated']::name[]
      AND regexp_replace(replace(qual, 'public.', ''), '\s+', '', 'g') = '(SELECTis_active_profile()ASis_active_profile)'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'vehicles' AND policyname <> 'vehicles_select'
      AND cmd IN ('SELECT', 'ALL')
  ) THEN RAISE EXCEPTION 'ADMIN_VEHICLE_REGISTER_BASE_POLICY_CHANGED'; END IF;
END
$preflight$;

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
