-- Restore the report bodies before retiring their registration helper.
-- Run in one transaction. Restore the prior vehicle grant before this reversal.
DO $preflight$
DECLARE
  v_report record;
  v_oid regprocedure;
BEGIN
  IF NOT has_column_privilege('authenticated', 'public.vehicles', 'registration', 'SELECT') THEN
    RAISE EXCEPTION 'LOGBOOK_REGISTRATION_REVERSE_NEEDS_PRIOR_VEHICLE_GRANT';
  END IF;
  FOR v_report IN
    SELECT * FROM (VALUES
      ('get_logbook_faa', 'date,date', '9302f0a0cc8b2e90d08763d65b2d6ad2', 'ed749b3d8e621e7b43d22801a9f04a6e'),
      ('get_logbook_by_field', 'uuid,date,date', '61aa511789de5de1d2f4a9f96dda854e', '04aea37b07a3c0463e129bc995234f1f'),
      ('get_logbook_by_customer', 'uuid,date,date', '388ae0991aaff234820ab0aaf1b0c39b', 'be23c3fca31b00a2db4d5409d19415ba'),
      ('get_logbook_by_applicator', 'uuid,date,date', '437813dedcab1c72526dd7c5341fe131', 'f9ef04a194268b3ce6f9c528488b0ea7')
    ) AS pin(name, args, installed_md5, restored_md5)
  LOOP
    v_oid := to_regprocedure(format('public.%I(%s)', v_report.name, v_report.args));
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid
      AND md5(replace(prosrc, chr(13), '')) = v_report.installed_md5 AND NOT prosecdef) THEN
      RAISE EXCEPTION 'LOGBOOK_REGISTRATION_REVERSE_REPORT_CHANGED: %', v_report.name;
    END IF;
  END LOOP;
END;
$preflight$;

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
    v.vehicle_name, v.registration, v.category,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.created_at
  FROM public.application_records ar
  INNER JOIN public.vehicles v ON v.id = ar.vehicle_id AND v.vehicle_type = 'air'
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
    v.vehicle_name, v.vehicle_type, v.registration,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.source_type, ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
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
    v.vehicle_name, v.vehicle_type, v.registration,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.source_type, ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
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
    v.vehicle_name, v.vehicle_type, v.registration,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.source_type, ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.applicator_id = p_applicator_id
    AND ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
END;
$function$;

DROP FUNCTION public._logbook_vehicle_registrations();
