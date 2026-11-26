-- Invented screen-walk database only. Roll back fixtures and column grants.
BEGIN;
SELECT id AS actor, gen_random_uuid() AS farm, gen_random_uuid() AS field
FROM public.profiles
WHERE email = 'admin@crx-local-app.test' AND role = 'admin' AND is_active
\gset

CREATE TEMP TABLE logbook_fixture AS
SELECT label, kind, state, registration, gen_random_uuid() AS vehicle_id, gen_random_uuid() AS record_id
FROM (VALUES
  ('active aircraft', 'air', 'active', 'INVENTED-A'),
  ('inactive aircraft', 'air', 'inactive', 'INVENTED-B'),
  ('ground', 'ground', 'active', ''),
  ('unlinked', 'air', 'active', 'INVENTED-UNLINKED'),
  ('no vehicle', 'ground', 'active', NULL)
) AS fixture(label, kind, state, registration);
INSERT INTO logbook_fixture (label, kind, state, registration, vehicle_id, record_id)
SELECT 'second active application', kind, state, registration, vehicle_id, gen_random_uuid()
FROM logbook_fixture WHERE label = 'active aircraft';
GRANT SELECT ON logbook_fixture TO authenticated;

SET LOCAL session_replication_role = replica;
INSERT INTO public.customers (id, farm_name) VALUES (:'farm', 'Invented Logbook Smoke Farm');
INSERT INTO public.fields (id, field_name, customer_id) VALUES (:'field', 'Invented Logbook Smoke Field', :'farm');
INSERT INTO public.vehicles (id, vehicle_name, vehicle_type, status, registration)
SELECT vehicle_id, 'Invented Logbook ' || label, kind, state, registration
FROM logbook_fixture WHERE label NOT IN ('no vehicle', 'second active application');
INSERT INTO public.application_records (id, record_number, source_type, source_id,
    customer_id, field_id, applicator_id, application_date, vehicle_id)
SELECT record_id, 'INVENTED-LOGBOOK-' || record_id, 'job', gen_random_uuid(),
    :'farm', :'field', :'actor', current_date, CASE WHEN label <> 'no vehicle' THEN vehicle_id END
FROM logbook_fixture WHERE label <> 'unlinked';
SET LOCAL session_replication_role = origin;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', :'actor', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'actor', true);
SELECT set_config('crx.test_logbook_farm', :'farm', true);
SELECT set_config('crx.test_logbook_field', :'field', true);

-- Mark the correct future grant with the same seven columns as Job Detail.
REVOKE SELECT ON public.vehicles FROM authenticated;
GRANT SELECT (id, vehicle_name, vehicle_type, category, capacity_gallons, capacity_unit, status)
  ON public.vehicles TO authenticated;

CREATE FUNCTION pg_temp.check_logbook_registration() RETURNS void LANGUAGE plpgsql AS $check$
DECLARE
  v_difference integer;
BEGIN
  WITH expected AS (
    SELECT 'faa' AS report, f.record_id, f.registration FROM logbook_fixture f WHERE f.kind = 'air' AND label <> 'unlinked'
    UNION ALL
    SELECT reports.report, f.record_id, f.registration FROM logbook_fixture f
    CROSS JOIN (VALUES ('field'), ('customer'), ('applicator')) AS reports(report) WHERE label <> 'unlinked'
  ), actual AS (
    SELECT records.* FROM (
      SELECT 'faa' AS report, record_id, vehicle_registration AS registration FROM public.get_logbook_faa(current_date, current_date)
      UNION ALL
      SELECT 'field', record_id, vehicle_registration FROM public.get_logbook_by_field(current_setting('crx.test_logbook_field')::uuid, current_date, current_date)
      UNION ALL
      SELECT 'customer', record_id, vehicle_registration FROM public.get_logbook_by_customer(current_setting('crx.test_logbook_farm')::uuid, current_date, current_date)
      UNION ALL
      SELECT 'applicator', record_id, vehicle_registration FROM public.get_logbook_by_applicator(auth.uid(), current_date, current_date)
    ) records JOIN logbook_fixture f USING (record_id)
  )
  SELECT count(*) INTO v_difference FROM (
    (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
  ) differences;
  IF v_difference <> 0 THEN RAISE EXCEPTION 'Logbook rows did not match expected registrations'; END IF;

  IF EXISTS (SELECT 1 FROM public.get_logbook_faa(current_date, current_date) log
      JOIN logbook_fixture f USING (record_id) WHERE f.kind <> 'air')
     OR (SELECT count(*) FROM public._logbook_vehicle_registrations() r
       WHERE EXISTS (SELECT 1 FROM logbook_fixture f WHERE f.vehicle_id = r.vehicle_id)) <> 3
     OR EXISTS (SELECT 1 FROM public._logbook_vehicle_registrations() r JOIN logbook_fixture f USING (vehicle_id)
       WHERE label = 'unlinked' OR r.registration IS DISTINCT FROM f.registration) THEN
    RAISE EXCEPTION 'Unexpected vehicle or registration in the logbooks';
  END IF;
END;
$check$;

SET LOCAL ROLE authenticated;
SELECT pg_temp.check_logbook_registration();
RESET ROLE;
SET LOCAL session_replication_role = replica;
UPDATE public.profiles SET role = 'sales_rep', denied_pages = '{}' WHERE id = :'actor';
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_logbook_registration();
RESET ROLE;

DO $denied$
DECLARE
  v_case text;
BEGIN
  FOREACH v_case IN ARRAY ARRAY['reports-denied', 'inactive', 'driver', 'applicator'] LOOP
    SET LOCAL session_replication_role = replica;
    UPDATE public.profiles SET
      role = CASE WHEN v_case IN ('driver', 'applicator') THEN v_case ELSE 'sales_rep' END,
      is_active = v_case <> 'inactive',
      denied_pages = CASE WHEN v_case = 'reports-denied' THEN ARRAY['reports'] ELSE ARRAY[]::text[] END
    WHERE id = auth.uid();
    SET LOCAL session_replication_role = origin;
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public._logbook_vehicle_registrations();
      RAISE EXCEPTION 'The registration lookup accepted %', v_case;
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM <> 'PAGE_ACCESS_DENIED: reports' THEN RAISE; END IF;
    END;
    RESET ROLE;
  END LOOP;

  IF has_function_privilege('anon', 'public._logbook_vehicle_registrations()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._logbook_vehicle_registrations()', 'EXECUTE') THEN
    RAISE EXCEPTION 'The registration lookup has an unexpected grant';
  END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$denied$;
