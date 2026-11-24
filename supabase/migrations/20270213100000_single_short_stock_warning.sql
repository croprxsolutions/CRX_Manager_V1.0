-- #2135, Lane C of the 2026-11-22 bug sprint. Contract:
-- docs/plans/2026-11-22-single-short-stock-warning-CONTRACT.md.
--
-- complete_delivery's outer wrapper (_complete_delivery_period_preflight_impl, body from 20260716191000, renamed by
-- 20260716202000, never redefined since) ran its own repeated-line short-stock check on top of the completion body's
-- (#1942, 20270203120000), which already counts each short product once against the delivery's total. Every product
-- the outer check flagged the inner one flags too, so one short product gave short_stock_count 2, a doubled warning,
-- two delivery_short_stock activity rows and two stock_warning notifications per admin. The outer check, its
-- activity/notification writes and its receipt rewrite are removed. Its authorization, replay lookup and
-- existing-stock-row lock pass are unchanged. Stock, ledger rows and their review flags are unchanged: the completion
-- body writes the same '[SHORT STOCK — review required]' note and requires_review itself. The ledger trigger
-- _mark_delivery_aggregate_short_stock stays; this wrapper was its only setter, so it no longer changes anything.
-- Receipts and notifications written before this change are left as they are.
--
-- idempotency-body-check: exempt -- private function; complete_delivery's signature and key handling are unchanged
--   (the replay lookup in this body is byte for byte the same).
-- caller-analysis: _complete_delivery_period_preflight_impl :: same name, signature, result shape, owner and grants
--   (EXECUTE revoked from API roles, called only by the complete_delivery chain); its result no longer adds a second
--   count of the same product.
--
-- ROLLBACK: scripts/smoke/single-short-stock-warning-reverse.sql (proven by
--   scripts/smoke/prove-single-short-stock-warning-real-schema.mjs).

CREATE TEMP TABLE single_short_stock_2135_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.single_short_stock_2135_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.single_short_stock_2135_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)'))
     IS DISTINCT FROM 'a9f80dc25207eba595e9998409e9ceb9' THEN
    RAISE EXCEPTION 'SINGLE_SHORT_STOCK_BASELINE_DRIFT: the wrapper body is not the one this file replaces (already applied?)';
  END IF;
  -- The warning this file keeps lives in the completion body (#1942): it must still check each product's total.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM '70e318a7f05d51d2cf6c3c6ea6226379' THEN
    RAISE EXCEPTION 'SINGLE_SHORT_STOCK_BASELINE_DRIFT: the completion body is not #1942''s (it must check each product''s total)';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._complete_delivery_period_preflight_impl(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamptz DEFAULT NULL::timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_delivery record;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT id, delivery_number, customer_id, assigned_driver
    INTO v_delivery
    FROM public.deliveries
   WHERE id = p_delivery_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- Authorization deliberately precedes replay lookup.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'complete_delivery'
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Lock every existing warehouse row involved before taking the aggregate
  -- snapshot. Missing rows are already handled by the proven inner function.
  PERFORM 1
    FROM public.inventory inv
   WHERE inv.location = 'Main Warehouse'
     AND inv.product_id IN (
       SELECT di.product_id
         FROM public.delivery_items di
        WHERE di.delivery_id = p_delivery_id
     )
   ORDER BY inv.product_id
   FOR UPDATE;

  -- #2135: the repeated-line short-stock check that stood here duplicated the completion body's own check
  -- (#1942 counts each product once against the delivery's total), so its warnings were written twice. Removed;
  -- the row lock pass above is kept as it was.
  v_result := public._complete_delivery_aggregate_impl(
    p_delivery_id,
    p_signed_by,
    p_performed_by,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key,
    p_completed_at
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)'))
     IS DISTINCT FROM 'f13018d7449506ff80c69facfb51b000' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: the wrapper is not this file''s body';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)')
              AND (NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']))
     OR has_function_privilege('anon', 'public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: definer, fixed search_path and no API-role EXECUTE on the wrapper';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
