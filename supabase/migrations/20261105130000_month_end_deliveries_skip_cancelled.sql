-- To-do 3.9: Month-End Close never showed "Deliveries completed" as done,
-- because get_monthly_summary's deliveries.count included cancelled and voided
-- deliveries, which can never become completed. Count now leaves out those two
-- terminal statuses. Nothing else changes: same signature, SECURITY DEFINER,
-- search_path, admin-only gate (require_admin), owner and grants
-- (CREATE OR REPLACE keeps the existing ACL; the postflight asserts it).
-- Report-only: writes no rows.

DO $preflight$
DECLARE
  v_monthly regprocedure := to_regprocedure('public.get_monthly_summary(date,date)');
  v_src text;
BEGIN
  IF v_monthly IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_monthly_summary') <> 1 THEN
    RAISE EXCEPTION 'MONTH_END_DELIVERIES_PREFLIGHT_SIGNATURE';
  END IF;
  -- Rebuild only from the body installed by 20260827041000 (verified live 2026-11-03).
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_monthly;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> 'c90c10378f5fc2feb8c41554f0fbc85280f55ca3b637e7b24654055e3dfe8330'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_monthly AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_monthly, 'EXECUTE')
     OR has_function_privilege('authenticated', v_monthly, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_monthly, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'MONTH_END_DELIVERIES_PREFLIGHT_DRIFT';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_monthly_summary(
  p_period_start date,
  p_period_end date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_result jsonb;
BEGIN
  PERFORM require_admin();
  SELECT jsonb_build_object(
    'period_start', p_period_start,
    'period_end', p_period_end,
    'invoices', jsonb_build_object(
      'posted_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL),
      'total_amount_cents', COALESCE((SELECT sum(total_amount_cents) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL), 0),
      'total_cost_cents', COALESCE((SELECT sum(CASE
        WHEN inv.invoice_type = 'credit_memo'
         AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = inv.id)
          THEN inv.total_cost_cents
        ELSE (SELECT COALESCE(sum(ROUND(ii.cost_cents * ii.quantity)::bigint), 0)
              FROM public.invoice_items ii WHERE ii.invoice_id = inv.id)
      END) FROM public.invoices inv WHERE inv.invoice_date BETWEEN p_period_start AND p_period_end AND inv.status IN ('posted', 'overdue', 'paid') AND inv.deleted_at IS NULL), 0),
      'draft_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('draft', 'unposted') AND deleted_at IS NULL),
      'voided_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'voided' AND deleted_at IS NULL)
    ),
    'payments', jsonb_build_object('count', (SELECT count(*) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 'total_cents', COALESCE((SELECT sum((amount * 100)::bigint) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 0)),
    'orders', jsonb_build_object('count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 'total_cents', COALESCE((SELECT sum((total_price * 100)::bigint) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 0)),
    'deliveries', jsonb_build_object('count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status NOT IN ('cancelled', 'voided') AND deleted_at IS NULL), 'completed_count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status = 'completed' AND deleted_at IS NULL)),
    'applications', jsonb_build_object('count', (SELECT count(*) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 'total_acres', COALESCE((SELECT sum(total_acres) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 0)),
    'commissions', jsonb_build_object('earned_cents', COALESCE((SELECT sum((commission_amount * 100)::bigint) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end), 0), 'paid_count', (SELECT count(*) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end AND status = 'paid')),
    'ar_balance_cents', COALESCE((SELECT sum(balance_cents) FROM public.invoices WHERE status IN ('posted', 'overdue') AND balance_cents > 0 AND deleted_at IS NULL), 0)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

DO $postflight$
DECLARE
  v_monthly regprocedure := to_regprocedure('public.get_monthly_summary(date,date)');
  v_src text;
BEGIN
  IF v_monthly IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_monthly_summary') <> 1 THEN
    RAISE EXCEPTION 'MONTH_END_DELIVERIES_POSTFLIGHT_SIGNATURE';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_monthly;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> '079f77c1628821088ea02830ac12a4ae918b297419aaf8d4e4dc3e804ca96c10'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_monthly AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_monthly, 'EXECUTE')
     OR has_function_privilege('authenticated', v_monthly, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_monthly, 'EXECUTE') IS NOT TRUE
     OR position('PERFORM require_admin();' IN v_src) = 0
     OR position('status NOT IN (''cancelled'', ''voided'')' IN v_src) = 0 THEN
    RAISE EXCEPTION 'MONTH_END_DELIVERIES_POSTFLIGHT_DRIFT';
  END IF;
END;
$postflight$;
