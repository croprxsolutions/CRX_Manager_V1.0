-- Keep registration available to the existing Reports audience when the general
-- fleet lookup is narrowed. Other report data stays under caller row security.

SET LOCAL search_path = public, pg_temp;

CREATE TEMP TABLE logbook_report_pin ON COMMIT DROP AS
SELECT *, pg_current_xact_id()::text AS transaction_id
FROM (VALUES
  ('get_logbook_faa', 'date,date', 'ed749b3d8e621e7b43d22801a9f04a6e', '9302f0a0cc8b2e90d08763d65b2d6ad2',
   'cf3593de3f6270cf3648db8e53a6369f', 'c98cdcf38d7ec8b61325721aee66d0bc'),
  ('get_logbook_by_field', 'uuid,date,date', '04aea37b07a3c0463e129bc995234f1f', '61aa511789de5de1d2f4a9f96dda854e',
   '95c8a09822072eac78ca524e3c5d2e42', '8cf46c8fd439e185ca268132b89c3a6c'),
  ('get_logbook_by_customer', 'uuid,date,date', 'be23c3fca31b00a2db4d5409d19415ba', '388ae0991aaff234820ab0aaf1b0c39b',
   '1eee08175c6009d747b6a00412caa315', '8cf46c8fd439e185ca268132b89c3a6c'),
  ('get_logbook_by_applicator', 'uuid,date,date', 'f9ef04a194268b3ce6f9c528488b0ea7', '437813dedcab1c72526dd7c5341fe131',
   '98217454f7fc26d04c04623a015f886e', '8cf46c8fd439e185ca268132b89c3a6c')
) AS pin(name, args, before_md5, after_md5, args_md5, result_md5);

DO $preflight$
DECLARE
  v_changed text;
BEGIN
  IF to_regclass('pg_temp.logbook_report_pin') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_temp.logbook_report_pin WHERE transaction_id = pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'LOGBOOK_REGISTRATION_REQUIRES_ONE_TRANSACTION';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_logbook_vehicle_registrations') THEN
    RAISE EXCEPTION 'LOGBOOK_REGISTRATION_HELPER_ALREADY_EXISTS';
  END IF;

  SELECT string_agg(pin.name, ', ') INTO v_changed
  FROM pg_temp.logbook_report_pin pin
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(format('public.%I(%s)', pin.name, pin.args))
  WHERE p.oid IS NULL
    OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = pin.name) <> 1
    OR md5(replace(p.prosrc, chr(13), '')) <> pin.before_md5
    OR md5(pg_get_function_arguments(p.oid)) <> pin.args_md5
    OR md5(pg_get_function_result(p.oid)) <> pin.result_md5
    OR p.prosecdef OR p.provolatile <> 's' OR p.proowner <> 'postgres'::regrole
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
    OR has_function_privilege('anon', p.oid, 'EXECUTE')
    OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'LOGBOOK_REGISTRATION_REPORT_DEFINITION_CHANGED: %', v_changed;
  END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'),
      ('public.is_sales_rep()', 'fcb3133010fe3f4f56e3be31f709d102'),
      -- The later Purchasing Plan migration adds the inventory page to this helper.
      ('public._require_page_access(text)', 'f8d14bb0f4929894eea830a8cf723aba')
    ) pin(signature, body_md5)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.signature)
    WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) <> pin.body_md5
      OR NOT p.prosecdef OR p.provolatile <> 's'
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.application_records'::regclass AND relrowsecurity
  ) OR (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.application_records'::regclass AND polcmd IN ('r', '*')) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'application_records' AND policyname = 'app_records_select'
        AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles::text = '{public}'
        AND qual = '(is_admin() OR is_sales_rep() OR (is_applicator() AND (applicator_id = ( SELECT auth.uid() AS uid))))'
    ) THEN
    RAISE EXCEPTION 'LOGBOOK_REGISTRATION_REPORT_ACCESS_CHANGED';
  END IF;
END;
$preflight$;

-- The owner privilege is needed only for the restricted registration column.
-- Reports-enabled office roles already see every application record. Keep
-- this helper aligned with that policy if office record access is narrowed.
CREATE FUNCTION public._logbook_vehicle_registrations()
RETURNS TABLE(vehicle_id uuid, registration text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_page_access('reports');

  RETURN QUERY
  SELECT v.id, v.registration
  FROM public.vehicles v
  WHERE EXISTS (SELECT 1 FROM public.application_records ar WHERE ar.vehicle_id = v.id);
END;
$function$;

REVOKE ALL ON FUNCTION public._logbook_vehicle_registrations() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._logbook_vehicle_registrations() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_logbook_faa(p_start_date date, p_end_date date)
 RETURNS TABLE(record_id uuid, record_number text, application_date date, application_time time without time zone, customer_name text, applicator_name text, applicator_license text, faa_certificate text, field_name text, field_legal_description text, field_county text, field_state text, total_acres numeric, total_volume numeric, total_volume_unit text, vehicle_name text, vehicle_registration text, vehicle_category text, weather_conditions jsonb, product_data jsonb, invoice_number text, season integer, created_at timestamp with time zone)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $function$
#variable_conflict use_column
BEGIN
  -- KI-119 (Mason, 2026-11-19): admins, and sales reps without Reports hidden, only.
  PERFORM public._require_page_access('reports');
  RETURN QUERY
  SELECT
    ar.id, ar.record_number, ar.application_date, ar.application_time,
    c.farm_name, COALESCE(ar.applicator_name, p.full_name), COALESCE(ar.applicator_license_number, p.applicator_license_number), p.faa_certificate_number, -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
    f.field_name, f.legal_description, f.county, f.state,
    ar.total_acres, ar.total_volume, ar.total_volume_unit,
    v.vehicle_name, registration.registration, v.category,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.created_at
  FROM public.application_records ar
  INNER JOIN public.vehicles v ON v.id = ar.vehicle_id AND v.vehicle_type = 'air'
  LEFT JOIN public._logbook_vehicle_registrations() registration ON registration.vehicle_id = v.id
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_logbook_by_field(p_field_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(record_id uuid, record_number text, application_date date, application_time time without time zone, customer_name text, applicator_name text, field_name text, field_legal_description text, total_acres numeric, total_volume numeric, total_volume_unit text, vehicle_name text, vehicle_type text, vehicle_registration text, weather_conditions jsonb, product_data jsonb, invoice_number text, season integer, source_type text, created_at timestamp with time zone)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $function$
#variable_conflict use_column
BEGIN
  -- KI-119 (Mason, 2026-11-19): admins, and sales reps without Reports hidden, only.
  PERFORM public._require_page_access('reports');
  RETURN QUERY
  SELECT
    ar.id, ar.record_number, ar.application_date, ar.application_time,
    c.farm_name, COALESCE(ar.applicator_name, p.full_name), f.field_name, f.legal_description, -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
    ar.total_acres, ar.total_volume, ar.total_volume_unit,
    v.vehicle_name, v.vehicle_type, registration.registration,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.source_type, ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
  LEFT JOIN public._logbook_vehicle_registrations() registration ON registration.vehicle_id = v.id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.field_id = p_field_id
    AND ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_logbook_by_customer(p_customer_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(record_id uuid, record_number text, application_date date, application_time time without time zone, customer_name text, applicator_name text, field_name text, field_legal_description text, total_acres numeric, total_volume numeric, total_volume_unit text, vehicle_name text, vehicle_type text, vehicle_registration text, weather_conditions jsonb, product_data jsonb, invoice_number text, season integer, source_type text, created_at timestamp with time zone)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $function$
#variable_conflict use_column
BEGIN
  -- KI-119 (Mason, 2026-11-19): admins, and sales reps without Reports hidden, only.
  PERFORM public._require_page_access('reports');
  RETURN QUERY
  SELECT
    ar.id, ar.record_number, ar.application_date, ar.application_time,
    c.farm_name, COALESCE(ar.applicator_name, p.full_name), f.field_name, f.legal_description, -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
    ar.total_acres, ar.total_volume, ar.total_volume_unit,
    v.vehicle_name, v.vehicle_type, registration.registration,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.source_type, ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
  LEFT JOIN public._logbook_vehicle_registrations() registration ON registration.vehicle_id = v.id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.customer_id = p_customer_id
    AND ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_logbook_by_applicator(p_applicator_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(record_id uuid, record_number text, application_date date, application_time time without time zone, customer_name text, applicator_name text, field_name text, field_legal_description text, total_acres numeric, total_volume numeric, total_volume_unit text, vehicle_name text, vehicle_type text, vehicle_registration text, weather_conditions jsonb, product_data jsonb, invoice_number text, season integer, source_type text, created_at timestamp with time zone)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $function$
#variable_conflict use_column
BEGIN
  -- KI-119 (Mason, 2026-11-19): admins, and sales reps without Reports hidden, only.
  PERFORM public._require_page_access('reports');
  RETURN QUERY
  SELECT
    ar.id, ar.record_number, ar.application_date, ar.application_time,
    c.farm_name, COALESCE(ar.applicator_name, p.full_name), f.field_name, f.legal_description, -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
    ar.total_acres, ar.total_volume, ar.total_volume_unit,
    v.vehicle_name, v.vehicle_type, registration.registration,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.source_type, ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
  LEFT JOIN public._logbook_vehicle_registrations() registration ON registration.vehicle_id = v.id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.applicator_id = p_applicator_id
    AND ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
END;
$function$;

DO $postflight$
DECLARE
  v_report record;
  v_oid regprocedure;
BEGIN
  FOR v_report IN SELECT * FROM pg_temp.logbook_report_pin LOOP
    v_oid := to_regprocedure(format('public.%I(%s)', v_report.name, v_report.args));
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
        AND md5(replace(p.prosrc, chr(13), '')) = v_report.after_md5
        AND NOT p.prosecdef AND p.provolatile = 's'
        AND p.proconfig = ARRAY['search_path=public, pg_temp']
    ) THEN
      RAISE EXCEPTION 'LOGBOOK_REGISTRATION_POSTFLIGHT_REPORT_MISMATCH: %', v_report.name;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public._logbook_vehicle_registrations()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._logbook_vehicle_registrations()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public._logbook_vehicle_registrations()', 'EXECUTE') THEN
    RAISE EXCEPTION 'LOGBOOK_REGISTRATION_POSTFLIGHT_HELPER_GRANTS';
  END IF;
END;
$postflight$;
