-- Goal 4 part 4: three list functions sort with a unique tie-breaker so the screens can page them.
--
-- Why: the Receiving Log, the Watchdog exceptions list and the Fields map read these functions in one
-- request. The Receiving Log screen asks for 500 rows and stops; the other two return table rows, which
-- the Data API cuts at 1,000. The screens will read every row page by page (fetchAllRows), and that is
-- only correct when the sort order is total. Today each sorts by a value that can repeat:
--   get_receiving_log       ORDER BY received_at DESC  (a multi-line receipt saves its rows at one time)
--   get_watchdog_flags      ORDER BY created_at DESC   (one sweep inserts many flags at one time)
--   get_fields_with_geojson ORDER BY field_name        (many farms have a "North 80")
-- Rows that tie can then swap between page requests, so a page boundary can repeat one row and skip
-- another. Each now adds the row id as the last sort key. Nothing else in any body changes.
--
-- Read only: no table, row, grant or owner changes. CREATE OR REPLACE keeps each function's OID, owner,
-- grants, SECURITY DEFINER, search_path, volatility and its role gate. Columns and filters are unchanged.
--
-- Safety: the preflight refuses unless each live body is exactly the one read from live on 2026-11-05
-- (md5 below, carriage returns removed); the postflight checks each new body and that owner, grants,
-- security mode, settings, return type and volatility did not move.

CREATE TEMP TABLE paged_read_tiebreakers_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner,
       p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
       pg_current_xact_id()::text AS transaction_id
  FROM pg_proc p
 WHERE p.oid IN (
   to_regprocedure('public.get_receiving_log(integer,integer,text,text,uuid,date,date)'),
   to_regprocedure('public.get_watchdog_flags(uuid,uuid,text,boolean)'),
   to_regprocedure('public.get_fields_with_geojson(uuid)')
 );

DO $preflight$
DECLARE
  v_expected constant jsonb := jsonb_build_object(
    'get_receiving_log(integer,integer,text,text,uuid,date,date)', '3550b9c81a6289654bf592d6b6525f77',
    'get_watchdog_flags(uuid,uuid,text,boolean)', 'f7203d27d64dd493a972926438b9c3fe',
    'get_fields_with_geojson(uuid)', 'c3b67d317374c73c6e2dd237989334b4');
  v_row record;
BEGIN
  IF (SELECT count(*) FROM pg_temp.paged_read_tiebreakers_attrs) <> 3 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: one of the three list functions is missing';
  END IF;
  FOR v_row IN
    SELECT a.sig, md5(replace(p.prosrc, chr(13), '')) AS body_md5
      FROM pg_temp.paged_read_tiebreakers_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
  LOOP
    IF v_row.body_md5 IS DISTINCT FROM v_expected ->> v_row.sig THEN
      -- Already applied, or live drifted from the body read on 2026-11-05.
      RAISE EXCEPTION 'PAGED_READ_TIEBREAKERS_BASELINE_DRIFT: % body md5 %', v_row.sig, v_row.body_md5;
    END IF;
  END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_receiving_log(p_limit integer DEFAULT 200, p_offset integer DEFAULT 0, p_vendor text DEFAULT NULL::text, p_condition text DEFAULT NULL::text, p_received_by uuid DEFAULT NULL::uuid, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (select auth.uid()) AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      rr.id,
      rr.purchase_order_id,
      rr.po_item_id,
      rr.product_id,
      rr.quantity_received,
      rr.received_at,
      rr.notes,
      rr.condition,
      rr.lot_number,
      rr.storage_location,
      rr.unit_size,
      po.po_number,
      po.vendor,
      p.product_name,
      prof.full_name AS received_by_name,
      (SELECT count(*) FROM receiving_photos rp
       WHERE rp.receiving_record_id = rr.id) AS photo_count
    FROM receiving_records rr
    JOIN purchase_orders po ON po.id = rr.purchase_order_id
    JOIN products p ON p.id = rr.product_id
    JOIN profiles prof ON prof.id = rr.received_by
    WHERE (p_vendor IS NULL OR po.vendor ILIKE '%' || p_vendor || '%')
      AND (p_condition IS NULL OR rr.condition = p_condition)
      AND (p_received_by IS NULL OR rr.received_by = p_received_by)
      AND (p_date_from IS NULL OR rr.received_at::date >= p_date_from)
      AND (p_date_to IS NULL OR rr.received_at::date <= p_date_to)
    ORDER BY rr.received_at DESC, rr.id DESC
    LIMIT p_limit OFFSET p_offset
  ) r;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_watchdog_flags(p_job_id uuid DEFAULT NULL::uuid, p_invoice_id uuid DEFAULT NULL::uuid, p_flag_type text DEFAULT NULL::text, p_include_dismissed boolean DEFAULT false)
 RETURNS TABLE(id uuid, flag_type text, severity text, entity_type text, entity_id uuid, job_id uuid, invoice_id uuid, product_id uuid, field_id uuid, customer_id uuid, message text, detail jsonb, created_at timestamp with time zone, is_dismissed boolean, dismissed_at timestamp with time zone, dismissed_by uuid, resolution text, dismiss_note text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Gate: authenticated admin or sales_rep only
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'WATCHDOG_ACCESS_DENIED: admin or sales_rep role required';
  END IF;

  RETURN QUERY
  SELECT
    wf.id,
    wf.flag_type,
    wf.severity,
    wf.entity_type,
    wf.entity_id,
    wf.job_id,
    wf.invoice_id,
    wf.product_id,
    wf.field_id,
    wf.customer_id,
    wf.message,
    wf.detail,
    wf.created_at,
    (wd.id IS NOT NULL)  AS is_dismissed,
    wd.dismissed_at,
    wd.dismissed_by,
    wd.resolution,
    wd.note              AS dismiss_note
  FROM watchdog_flags wf
  LEFT JOIN LATERAL (
    SELECT d.id, d.dismissed_at, d.dismissed_by, d.resolution, d.note
    FROM watchdog_flag_dismissals d
    WHERE d.flag_id = wf.id
    ORDER BY d.dismissed_at DESC
    LIMIT 1
  ) wd ON true
  WHERE
    (p_job_id     IS NULL OR wf.job_id     = p_job_id)
    AND (p_invoice_id IS NULL OR wf.invoice_id = p_invoice_id)
    AND (p_flag_type  IS NULL OR wf.flag_type  = p_flag_type)
    AND (p_include_dismissed OR wd.id IS NULL)
  ORDER BY wf.created_at DESC, wf.id DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_fields_with_geojson(p_customer_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, customer_id uuid, field_name text, legal_description text, county text, state text, total_acres numeric, fsa_farm_number text, fsa_tract_number text, fsa_field_number text, crop_type text, soil_type text, irrigation boolean, notes text, is_active boolean, centroid_geojson text, boundary_geojson text, customer_name text, created_at timestamp with time zone, updated_at timestamp with time zone, parent_field_id uuid, child_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();

  RETURN QUERY
  SELECT f.id, f.customer_id, f.field_name, f.legal_description,
      f.county, f.state, f.total_acres,
      f.fsa_farm_number, f.fsa_tract_number, f.fsa_field_number,
      f.crop_type, f.soil_type, f.irrigation, f.notes, f.is_active,
      ST_AsGeoJSON(f.centroid)::text AS centroid_geojson,
      ST_AsGeoJSON(f.boundary)::text AS boundary_geojson,
      c.farm_name AS customer_name, f.created_at, f.updated_at,
      f.parent_field_id,
      (SELECT count(*) FROM fields ch WHERE ch.parent_field_id = f.id) AS child_count
    FROM fields f LEFT JOIN customers c ON c.id = f.customer_id
    WHERE (p_customer_id IS NULL OR f.customer_id = p_customer_id)
    ORDER BY f.field_name, f.id;
END;
$function$;

DO $postflight$
DECLARE
  v_expected constant jsonb := jsonb_build_object(
    'get_receiving_log(integer,integer,text,text,uuid,date,date)', 'e9ca68d79929a513433eb6359a44268c',
    'get_watchdog_flags(uuid,uuid,text,boolean)', 'da55772ecdba29ff44d1745763640a49',
    'get_fields_with_geojson(uuid)', '46f5feeb3675925bc9978f79de5eb172');
  v_fn record;
  v_seen integer := 0;
BEGIN
  FOR v_fn IN
    SELECT a.sig, md5(replace(p.prosrc, chr(13), '')) AS body_md5, pg_get_userbyid(p.proowner) AS owner,
           p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
           a.owner AS was_owner, a.acl AS was_acl, a.proconfig AS was_config, a.prorettype AS was_rettype,
           a.provolatile AS was_volatile, a.prosecdef AS was_secdef, a.transaction_id
      FROM pg_temp.paged_read_tiebreakers_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
  LOOP
    v_seen := v_seen + 1;
    IF v_fn.transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
    END IF;
    IF v_fn.body_md5 IS DISTINCT FROM v_expected ->> v_fn.sig
       OR v_fn.owner IS DISTINCT FROM v_fn.was_owner
       OR v_fn.acl IS DISTINCT FROM v_fn.was_acl
       OR v_fn.proconfig IS DISTINCT FROM v_fn.was_config
       OR v_fn.prorettype IS DISTINCT FROM v_fn.was_rettype
       OR v_fn.provolatile IS DISTINCT FROM v_fn.was_volatile
       OR v_fn.prosecdef IS DISTINCT FROM v_fn.was_secdef
       OR NOT v_fn.prosecdef THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % is not the expected body/attributes (md5 %)', v_fn.sig, v_fn.body_md5;
    END IF;
  END LOOP;
  IF v_seen <> 3 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected 3 functions, saw %', v_seen;
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: three list functions sort with a unique tie-breaker';
END;
$postflight$;
