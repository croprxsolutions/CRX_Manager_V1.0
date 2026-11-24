-- ============================================================================
-- 20270303140000_price_sheet_refusal_reason
-- Price-sheet audit follow-up (Mason, 2026-11-24). Contract: docs/plans/2026-11-24-price-sheet-refusal-reason-CONTRACT.md
--
-- WHY: the price-sheet preview and apply refuse a sheet with one combined code (WORKBOOK_V2_EXPORT_REQUIRED,
--   WORKBOOK_EXPORT_INVALID_OR_EXPIRED, WORKBOOK_EXPORT_CONSUMED_OR_EXPIRED), so the screen cannot say which cause
--   applies: already applied, downloaded by another user, past its expiry, or an older template.
-- WHAT (new read-only function only):
--   get_pricing_workbook_export_refusal_reason(uuid) returns one code, or NULL when the export passes the
--   export-level check (owned, active, v2, not past expiry; row-level refusals keep their own codes):
--   EXPORT_NOT_FOUND, DOWNLOADED_BY_OTHER_USER, ALREADY_APPLIED, OLD_TEMPLATE, EXPIRED (checked in that order).
--   "Not yours" is checked first, so another user's export reveals nothing else. Never returns names or prices.
--   ALREADY_APPLIED means a change set from this export was applied, not that these exact edits went live.
--   It describes the export now, so the screen asks only after one of the three combined codes above.
--   SECURITY DEFINER because pricing_workbook_exports is RPC-only (every table privilege revoked from authenticated);
--   the admin check is inside the body. Read-only, so it takes no p_idempotency_key.
-- NOT CHANGED: the preview and apply functions, their refusal codes, the table, its policies and grants.
-- ROLLBACK: a NEW forward migration: DROP FUNCTION public.get_pricing_workbook_export_refusal_reason(uuid).
-- ============================================================================

CREATE TEMP TABLE price_sheet_refusal_reason_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.price_sheet_refusal_reason_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.price_sheet_refusal_reason_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regprocedure('public.get_pricing_workbook_export_refusal_reason(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                  AND p.proname = 'get_pricing_workbook_export_refusal_reason') THEN
    RAISE EXCEPTION 'PRICE_SHEET_REFUSAL_REASON_BASELINE_DRIFT: the function already exists';
  END IF;
  IF (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attname)
      FROM pg_attribute a
      WHERE a.attrelid = 'public.pricing_workbook_exports'::regclass
        AND a.attname IN ('id', 'created_by', 'status', 'expires_at', 'format_version')
        AND NOT a.attisdropped)
     IS DISTINCT FROM 'created_by:uuid,expires_at:timestamp with time zone,format_version:text,id:uuid,status:text' THEN
    RAISE EXCEPTION 'PRICE_SHEET_REFUSAL_REASON_BASELINE_DRIFT: pricing_workbook_exports columns changed';
  END IF;
  -- The body maps every allowed status; a new status must be mapped before this can apply.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
      WHERE c.conrelid = 'public.pricing_workbook_exports'::regclass AND c.conname = 'pricing_workbook_exports_status_check')
     IS DISTINCT FROM 'CHECK ((status = ANY (ARRAY[''active''::text, ''consumed''::text, ''expired''::text])))' THEN
    RAISE EXCEPTION 'PRICE_SHEET_REFUSAL_REASON_BASELINE_DRIFT: pricing_workbook_exports status list changed';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.get_pricing_workbook_export_refusal_reason(p_export_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_export public.pricing_workbook_exports%ROWTYPE;
BEGIN
  -- Read-only: no p_idempotency_key (nothing is written, so a retry is harmless).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;

  SELECT * INTO v_export FROM public.pricing_workbook_exports e WHERE e.id = p_export_id;
  IF NOT FOUND THEN RETURN 'EXPORT_NOT_FOUND'; END IF;
  -- First, so another user's export reveals nothing about its state.
  IF v_export.created_by IS DISTINCT FROM v_actor THEN RETURN 'DOWNLOADED_BY_OTHER_USER'; END IF;
  IF v_export.status = 'consumed' THEN RETURN 'ALREADY_APPLIED'; END IF;
  IF v_export.format_version IS DISTINCT FROM 'crx-product-pricing-phase2-v2' THEN RETURN 'OLD_TEMPLATE'; END IF;
  IF v_export.status IS DISTINCT FROM 'active' OR v_export.expires_at <= now() THEN RETURN 'EXPIRED'; END IF;
  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.get_pricing_workbook_export_refusal_reason(uuid) IS
  'Admin-only, read-only: which single reason a price-sheet export is refused (EXPORT_NOT_FOUND, DOWNLOADED_BY_OTHER_USER, ALREADY_APPLIED, OLD_TEMPLATE, EXPIRED), or NULL when the export passes the export-level check. No idempotency key: it writes nothing.';

REVOKE ALL ON FUNCTION public.get_pricing_workbook_export_refusal_reason(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_pricing_workbook_export_refusal_reason(uuid) TO authenticated;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = 'get_pricing_workbook_export_refusal_reason') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: expected exactly one get_pricing_workbook_export_refusal_reason';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid = 'public.get_pricing_workbook_export_refusal_reason(uuid)'::regprocedure
        AND p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SECURITY: security definer, volatility or search_path wrong';
  END IF;
  IF has_function_privilege('anon', 'public.get_pricing_workbook_export_refusal_reason(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_pricing_workbook_export_refusal_reason(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_pricing_workbook_export_refusal_reason(uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                WHERE p.oid = 'public.get_pricing_workbook_export_refusal_reason(uuid)'::regprocedure
                  AND x.grantee = 0 AND x.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANTS: execute must be authenticated only';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
