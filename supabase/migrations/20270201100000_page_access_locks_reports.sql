-- KI-119: Settings > Page Access becomes a real lock for report data (Mason, 2026-11-19: a real lock; scope
-- "actions + reports"; the invoice and payment actions wait for Taha after 2026-12-15; logbooks are for admins and
-- sales reps only). Contract: docs/plans/2026-11-19-ki119-page-access-lock-CONTRACT.md.
--
-- * New internal helper public._require_page_access(p_page) raises PAGE_ACCESS_DENIED unless the signed-in caller
--   has an active profile and is an admin, or is a sales rep without that page in profiles.denied_pages. Only
--   'reports' and 'sales-reports' are known keys (both pages are admin and sales_rep in src/appPages.tsx).
-- * Nine report functions call it first. Each body is the live pre-image (md5 pinned by the preflight; read live
--   2026-11-19) with only the guard added. The four logbook functions become plpgsql SECURITY INVOKER wrappers around
--   the same query, so row security still limits their rows.
-- * Already admin-only and unchanged: profitability, inventory cost, gross sales, P&L and the commission reports.
--   get_customer_year_end_summary (one customer; the Customer page uses it) refuses only a sales rep with BOTH Reports
--   and Customers hidden (Mason, 2026-11-21, Sol r4); either page alone still allows it.
-- * The commissions read policy (the Reports Library Commissions tab reads the table directly) also hides a sales
--   rep's own rows while Reports is hidden for them.
-- * EXECUTE: PUBLIC and anon lose the logbooks; the helper is for authenticated only. No data change.
-- caller-analysis: get_logbook_faa :: LogbookReport.tsx calls it signed in (authenticated keeps EXECUTE); only PUBLIC and anon lose it
-- caller-analysis: get_logbook_by_field :: LogbookReport.tsx calls it signed in (authenticated keeps EXECUTE); only PUBLIC and anon lose it
-- caller-analysis: get_logbook_by_customer :: LogbookReport.tsx calls it signed in (authenticated keeps EXECUTE); only PUBLIC and anon lose it
-- caller-analysis: get_logbook_by_applicator :: LogbookReport.tsx calls it signed in (authenticated keeps EXECUTE); only PUBLIC and anon lose it
-- Rollback: a follow-up migration re-emits the pinned pre-image bodies (get_customer_year_end_summary: 20261013220000's) (newest earlier definitions of each), restores
-- the logbook grants and the comm_select USING expression read live 2026-11-19
-- (is_admin() OR (is_sales_rep() AND recipient_user_id = (SELECT auth.uid()))), then drops
-- public._require_page_access(text).

SET LOCAL lock_timeout = '10s';

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  -- No helper of any signature (an overload would make the one-argument guard call ambiguous; Astra r2).
  IF EXISTS (SELECT 1 FROM pg_proc x JOIN pg_namespace n ON n.oid = x.pronamespace
              WHERE n.nspname = 'public' AND x.proname = '_require_page_access') THEN
    RAISE EXCEPTION 'PREFLIGHT_PAGE_ACCESS_HELPER_EXISTS';
  END IF;
  SELECT string_agg(t.sig, ', ') INTO v_bad
    FROM (VALUES
      ('public.get_customer_balance_listing(date)', 'get_customer_balance_listing', 'reports', true, 's', 'f08de6dccd6ec4fb7d62d0e2e83d9b5d', 'ebd306d0ea35290216330af67b27a24a', '1a4f6a0d7a472c87ba2134f706e98537', '77dd2146a565bbcea718d4454c42a891'),
      ('public.get_chemical_history(uuid,date,date)', 'get_chemical_history', 'reports', true, 's', '7bb1a941abe7919910717d4f939289ed', 'e070abfd1432ec3262d83d2b448361fe', 'd507cba7acafda3b9d838aa50825dace', 'c1bde406e68e9120d810f10b795eb4c1'),
      ('public.get_batch_year_end_summaries(uuid[],integer)', 'get_batch_year_end_summaries', 'reports', true, 'v', '98e8b1de00708a0027103a6fccaf271d', '8a53b2fa806169261090ebb6a73da2e6', 'b248ac497ea98e44cb91f7bcc1874a8b', 'cd8a1292080b231b3e9a85d440b02023'),
      ('public.get_logbook_faa(date,date)', 'get_logbook_faa', 'reports', false, 's', '4a6ebeb9b06523c3a3da28eb24abdcb3', 'ed749b3d8e621e7b43d22801a9f04a6e', 'cf3593de3f6270cf3648db8e53a6369f', 'c98cdcf38d7ec8b61325721aee66d0bc'),
      ('public.get_logbook_by_field(uuid,date,date)', 'get_logbook_by_field', 'reports', false, 's', '46abdabc79f130a39bf292a955007562', '04aea37b07a3c0463e129bc995234f1f', '95c8a09822072eac78ca524e3c5d2e42', '8cf46c8fd439e185ca268132b89c3a6c'),
      ('public.get_logbook_by_customer(uuid,date,date)', 'get_logbook_by_customer', 'reports', false, 's', '9ef22a9ef2b64feee1a0ba4591d9fe95', 'be23c3fca31b00a2db4d5409d19415ba', '1eee08175c6009d747b6a00412caa315', '8cf46c8fd439e185ca268132b89c3a6c'),
      ('public.get_logbook_by_applicator(uuid,date,date)', 'get_logbook_by_applicator', 'reports', false, 's', '495de6f68b6176092a612a2f30da1569', 'f9ef04a194268b3ce6f9c528488b0ea7', '98217454f7fc26d04c04623a015f886e', '8cf46c8fd439e185ca268132b89c3a6c'),
      ('public.get_sales_summary_report(text,date,date,uuid,uuid[],uuid,text,integer)', 'get_sales_summary_report', 'sales-reports', true, 's', '2b67599d9afe448a28db1297955ad3bc', 'af36f2d3f3903c535d65aa6fd9d2e04c', 'c222f5736bc0e766a8279b102717bf15', 'fa7a95dbbfc2648391db1f524d7a9301'),
      ('public.get_sales_detail_report(date,date,uuid,uuid[],uuid,text,integer)', 'get_sales_detail_report', 'sales-reports', true, 's', 'd28c19a5af636bd3dd46eca93b80b228', '8d6eac5a6300e8b1338aebca19e931a6', '87f65d7099a8253903e80ff231d1d7c0', '14efdc3a6bfe788abd2d1461b59211ab')
    ) AS t(sig, fname, page, secdef, vol, pre_md5, post_md5, args_md5, result_md5)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
   WHERE p.oid IS NULL
      OR (SELECT count(*) FROM pg_proc x JOIN pg_namespace n ON n.oid = x.pronamespace
           WHERE n.nspname = 'public' AND x.proname = t.fname) <> 1
      OR md5(replace(p.prosrc, E'\r', '')) <> t.pre_md5
      OR md5(pg_get_function_arguments(p.oid)) <> t.args_md5
      OR md5(pg_get_function_result(p.oid)) <> t.result_md5
      OR pg_get_userbyid(p.proowner) <> 'postgres'
      -- Live attributes too, so the replacement never silently changes a security setting (Astra r2).
      OR p.prosecdef <> t.secdef
      OR p.provolatile <> t.vol
      OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = CASE WHEN t.secdef THEN 'plpgsql' ELSE 'sql' END)
      OR p.proconfig IS DISTINCT FROM CASE WHEN t.secdef THEN ARRAY['search_path=public, pg_temp'] ELSE ARRAY['search_path=public'] END;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REPORT_FUNCTION_NOT_LIVE_PRE_IMAGE: %', v_bad;
  END IF;
  -- The one-customer year-end summary (Sol r4): live pre-image, attributes and owner.
  IF (SELECT count(*) FROM pg_proc x JOIN pg_namespace n ON n.oid = x.pronamespace
       WHERE n.nspname = 'public' AND x.proname = 'get_customer_year_end_summary') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.get_customer_year_end_summary(uuid,integer)')
                       AND md5(replace(p.prosrc, E'', '')) = '04524d3562036cc5a4770d132391d0b3'
                       AND md5(pg_get_function_arguments(p.oid)) = 'a5f2709374435b5cc27737e6b011ac6f'
                       AND md5(pg_get_function_result(p.oid)) = 'cd8a1292080b231b3e9a85d440b02023'
                       AND pg_get_userbyid(p.proowner) = 'postgres'
                       AND p.prosecdef AND p.provolatile = 'v'
                       AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                       AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'PREFLIGHT_YEAR_END_SUMMARY_NOT_LIVE_PRE_IMAGE';
  END IF;
  -- The Reports Library Commissions tab reads public.commissions directly (Sol r1): its one read policy is live's.
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'public.commissions'::regclass AND polname = 'comm_select' AND polcmd = 'r'
                    AND polpermissive AND polroles = ARRAY['authenticated'::regrole::oid]
                    AND md5(pg_get_expr(polqual, polrelid)) = 'ff30dd8bde662aa7132abbe987601317')
     OR (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.commissions'::regclass AND polcmd IN ('r', '*')) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_COMMISSIONS_READ_POLICY_NOT_LIVE';
  END IF;
END
$preflight$;

CREATE FUNCTION public._require_page_access(p_page text)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_role text;
  v_denied text[];
BEGIN
  IF p_page IS NULL OR p_page NOT IN ('reports', 'sales-reports') THEN
    RAISE EXCEPTION 'PAGE_ACCESS_UNKNOWN_PAGE: %', p_page;
  END IF;
  -- The caller's own active profile: no user, no profile or an inactive one is refused below.
  SELECT p.role, p.denied_pages INTO v_role, v_denied
    FROM public.profiles p
   WHERE p.id = auth.uid() AND p.is_active = true;
  IF v_role = 'admin' THEN
    RETURN;
  END IF;
  -- Both pages are admin and sales_rep only (src/appPages.tsx); the same rule as hasPageAccess.
  IF v_role IS DISTINCT FROM 'sales_rep' OR p_page = ANY (COALESCE(v_denied, ARRAY[]::text[])) THEN
    RAISE EXCEPTION 'PAGE_ACCESS_DENIED: %', p_page USING ERRCODE = '42501';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public._require_page_access(text) IS
  'KI-119 (2026-11-19): raises PAGE_ACCESS_DENIED unless the active caller is an admin, or a sales rep without p_page in profiles.denied_pages. Called first by the report functions; reveals only the caller''s own access.';

REVOKE ALL ON FUNCTION public._require_page_access(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public._require_page_access(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_customer_balance_listing(p_as_of_date date)
 RETURNS TABLE(customer_id uuid, farm_name text, total_invoiced numeric, total_paid numeric, prepay_applied numeric, outstanding_balance numeric, open_credit numeric, invoice_count bigint, oldest_unpaid_date date, unavailable_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_is_admin boolean;
  v_customer_id uuid;
  v_code text;
  v_posted bigint;
  v_unavailable_ids uuid[] := ARRAY[]::uuid[];
  v_unavailable_codes text[] := ARRAY[]::text[];
BEGIN
  -- KI-119 (Mason, 2026-11-19): Settings > Page Access is enforced here, before any other check.
  PERFORM public._require_page_access('reports');
  IF v_actor IS NULL OR p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_HISTORICAL_REPORT_INPUT';
  END IF;

  SELECT p.role
    INTO v_role
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Permission denied: requires admin or sales_rep role';
  END IF;
  v_is_admin := v_role = 'admin';
  -- Reps list balances of ANY customer (Mason, 2026-10-13; 20261013220000 removed the
  -- assigned-rep filters), still counting only invoices they created or are the salesperson on.

  IF NOT v_is_admin
     AND p_as_of_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'Admin access required for historical customer balance report';
  END IF;

  FOR v_customer_id IN
    SELECT DISTINCT i.customer_id
      FROM public.invoices i
      JOIN public.customers c ON c.id = i.customer_id
     WHERE i.invoice_date <= p_as_of_date
       AND (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)
  LOOP
    BEGIN
      -- Reads the posting state of every invoice the listing reads for this customer, here, so an
      -- unreadable posting history flags only this customer instead of failing the listing.
      SELECT count(*) FILTER (WHERE public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date))
        INTO v_posted
        FROM public.invoices i
       WHERE i.customer_id = v_customer_id
         AND i.invoice_date <= p_as_of_date
         AND (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor);
      IF v_posted > 0 THEN
        PERFORM public.assert_customer_balance_reconstructable_as_of(v_customer_id, p_as_of_date);
      END IF;
    EXCEPTION WHEN raise_exception THEN
      v_code := split_part(SQLERRM, ':', 1);
      -- Only the four reconstruction refusals become a flag; any other error still fails the listing.
      IF v_code NOT IN ('HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE',
                        'HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE') THEN
        RAISE;
      END IF;
      v_unavailable_ids := v_unavailable_ids || v_customer_id;
      v_unavailable_codes := v_unavailable_codes || v_code;
    END;
  END LOOP;

  RETURN QUERY
  WITH eligible_invoices AS (
    SELECT
      i.id,
      i.customer_id,
      i.invoice_date::date,
      i.total_amount_cents,
      i.paid_amount_cents,
      i.prepay_applied_cents,
      (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      )::bigint AS statement_balance_cents
    FROM public.invoices i
    JOIN public.customers scoped_customer ON scoped_customer.id = i.customer_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(cma.amount_cents), 0)::bigint AS applied_cents
        FROM public.credit_memo_applications cma
       WHERE cma.target_invoice_id = i.id
         AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
         AND (
           cma.reversed_at IS NULL
           OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
         )
    ) credit_at_cutoff
    WHERE i.invoice_type <> 'credit_memo'
      AND i.invoice_date <= p_as_of_date
      AND (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)
      -- CASE fixes the order (a plain AND has none): the helper reads only invoices the loop
      -- already read, never one dated after the cutoff, outside a rep's scope, or a flagged customer's.
      AND CASE WHEN i.invoice_date > p_as_of_date
                    OR NOT (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)
                    OR i.customer_id = ANY (v_unavailable_ids) THEN false
               ELSE public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date) END
      AND (i.voided_at IS NULL OR (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
  ),
  open_credits AS (
    SELECT
      ci.customer_id,
      COALESCE(sum(
        greatest(
          -ci.total_amount_cents - COALESCE((
            SELECT sum(cma.amount_cents)
              FROM public.credit_memo_applications cma
             WHERE cma.credit_memo_id = ci.id
               AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
               AND (
                 cma.reversed_at IS NULL
                 OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
               )
          ), 0),
          0::bigint
        )
      ), 0)::bigint AS credit_cents
    FROM public.invoices ci
    JOIN public.customers scoped_customer ON scoped_customer.id = ci.customer_id
    WHERE ci.invoice_type = 'credit_memo'
      AND ci.invoice_date <= p_as_of_date
      AND (v_is_admin OR ci.created_by = v_actor OR ci.salesman_id = v_actor)
      AND CASE WHEN ci.invoice_date > p_as_of_date
                    OR NOT (v_is_admin OR ci.created_by = v_actor OR ci.salesman_id = v_actor)
                    OR ci.customer_id = ANY (v_unavailable_ids) THEN false
               ELSE public.statement_invoice_was_posted_as_of(ci.id, ci.posted_at, p_as_of_date) END
      AND (ci.voided_at IS NULL OR (ci.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (ci.deleted_at IS NULL OR (ci.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    GROUP BY ci.customer_id
  )
  SELECT
    c.id,
    c.farm_name,
    round(COALESCE(sum(ei.total_amount_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.paid_amount_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.prepay_applied_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) / 100.0, 2),
    round(COALESCE(oc.credit_cents, 0) / 100.0, 2),
    count(ei.id),
    min(ei.invoice_date) FILTER (WHERE ei.statement_balance_cents > 0),
    NULL::text
  FROM public.customers c
  LEFT JOIN eligible_invoices ei ON ei.customer_id = c.id
  LEFT JOIN open_credits oc ON oc.customer_id = c.id
  WHERE c.id <> ALL (v_unavailable_ids)
  GROUP BY c.id, c.farm_name, oc.credit_cents
  HAVING COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) > 0
      OR COALESCE(oc.credit_cents, 0) > 0
  ORDER BY COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) DESC;

  -- Customers whose balance cannot be rebuilt as of this date: listed, with no amounts.
  RETURN QUERY
  SELECT
    c.id, c.farm_name,
    NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    NULL::bigint, NULL::date,
    u.code
  FROM unnest(v_unavailable_ids, v_unavailable_codes) AS u(id, code)
  JOIN public.customers c ON c.id = u.id
  ORDER BY c.farm_name, c.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_chemical_history(p_product_id uuid, p_start_date date, p_end_date date)
RETURNS TABLE(transaction_date text, transaction_type text, reference_number text, customer_name text,
              quantity numeric, unit text, unit_price numeric, total_amount numeric, notes text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin boolean := public.is_admin();
BEGIN
  -- KI-119 (Mason, 2026-11-19): Settings > Page Access is enforced here, before any other check.
  PERFORM public._require_page_access('reports');
  -- Orders and purchase orders are readable by admins and sales reps only (RLS); every other
  -- role got no rows from the old SECURITY INVOKER body and still gets none.
  IF NOT (v_admin OR public.is_sales_rep()) THEN
    RETURN;
  END IF;
  -- Purchase cost is admin-only (Mason, 2026-10-15 and 2026-10-18).
  RETURN QUERY
  SELECT r.transaction_date, r.transaction_type, r.reference_number, r.customer_name, r.quantity, r.unit,
         CASE WHEN v_admin OR r.transaction_type IS DISTINCT FROM 'Purchase' THEN r.unit_price END,
         CASE WHEN v_admin OR r.transaction_type IS DISTINCT FROM 'Purchase' THEN r.total_amount END,
         r.notes
    FROM public._get_chemical_history_cost_step2_impl(p_product_id, p_start_date, p_end_date) AS r
   ORDER BY r.transaction_date DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_batch_year_end_summaries(
  p_customer_ids uuid[],
  p_season       integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_results jsonb := '[]'::jsonb;
  v_cid     uuid;
  v_summary jsonb;
BEGIN
  -- KI-119 (Mason, 2026-11-19): Settings > Page Access is enforced here, before any other check.
  PERFORM public._require_page_access('reports');
  FOREACH v_cid IN ARRAY p_customer_ids LOOP
    SELECT public.get_customer_year_end_summary(v_cid, p_season) INTO v_summary;
    IF v_summary IS NOT NULL THEN
      v_results := v_results || jsonb_build_array(v_summary);
    END IF;
  END LOOP;
  RETURN v_results;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_year_end_summary(p_customer_id uuid, p_season integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cust record;
  v_season_start date;
  v_season_end date;
  v_financial jsonb;
  v_product_usage jsonb;
  v_acreage jsonb;
  v_invoices jsonb;
  v_shares jsonb;
  v_prior_season jsonb;
BEGIN
  PERFORM public.require_admin_or_sales_rep();
  -- KI-119 (Mason, 2026-11-21; Sol r4): a sales rep with both Reports and Customers hidden has no page that offers
  -- this summary, so the database refuses it too. Either page alone still allows it (the Customer page uses it).
  IF NOT public.is_admin() AND EXISTS (
       SELECT 1 FROM public.profiles pr
        WHERE pr.id = auth.uid()
          AND COALESCE(pr.denied_pages, ARRAY[]::text[]) @> ARRAY['reports', 'customers']::text[]) THEN
    RAISE EXCEPTION 'PAGE_ACCESS_DENIED: reports, customers' USING ERRCODE = '42501';
  END IF;
  -- Reps read ANY customer's year-end summary (Mason, 2026-10-13); the
  -- assigned-rep check is removed by 20261013220000.

  SELECT * INTO v_cust FROM public.customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;
  v_season_start := public.season_start_date(p_season);
  v_season_end := public.season_end_date(p_season);

  SELECT jsonb_build_object(
    'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
    'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0),
    'prepay_applied_cents', COALESCE(SUM(prepay_applied_cents), 0),
    'outstanding_balance_cents', COALESCE(SUM(balance_cents), 0),
    'invoice_count', COUNT(*)
  ) INTO v_financial
  FROM public.invoices
  WHERE customer_id = p_customer_id AND season = p_season
    AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.category, t.product_name), '[]'::jsonb)
  INTO v_product_usage
  FROM (
    SELECT COALESCE(p.category, 'Uncategorized') AS category,
      COALESCE(p.product_name, ii.description) AS product_name,
      p.epa_registration, SUM(ii.quantity) AS total_quantity,
      MAX(ii.unit_size) AS unit_size,
      CASE WHEN SUM(COALESCE(ii.acres, 0)) > 0 THEN ROUND(AVG(ii.rate_per_acre)::numeric, 2) ELSE NULL END AS avg_rate_per_acre,
      MAX(ii.rate_unit) AS rate_unit, SUM(COALESCE(ii.acres, 0)) AS total_acres_treated,
      SUM(ii.extended_cents) AS total_cost_cents,
      SUM(COALESCE(ii.total_applied, 0)) AS total_applied,
      MAX(ii.total_applied_unit) AS total_applied_unit,
      SUM(COALESCE(ii.total_applied_gl_lb, 0)) AS total_applied_gl_lb,
      MAX(ii.gl_lb_unit) AS gl_lb_unit, ii.is_application_fee
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    LEFT JOIN public.products p ON p.id = ii.product_id
    WHERE i.customer_id = p_customer_id AND i.season = p_season
      AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL
    GROUP BY COALESCE(p.category, 'Uncategorized'), COALESCE(p.product_name, ii.description),
      p.epa_registration, ii.is_application_fee
  ) t;

  SELECT jsonb_build_object(
    'total_acres', COALESCE(SUM(i.total_acres), 0),
    'by_crop', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('crop_type', sub.crop_type, 'acres', sub.total_acres) ORDER BY sub.total_acres DESC)
      FROM (
        SELECT COALESCE(crop_type, 'Unknown') AS crop_type, SUM(total_acres) AS total_acres
        FROM public.invoices
        WHERE customer_id = p_customer_id AND season = p_season AND invoice_type = 'field_application'
          AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL AND total_acres IS NOT NULL
        GROUP BY COALESCE(crop_type, 'Unknown')
      ) sub
    ), '[]'::jsonb)
  ) INTO v_acreage
  FROM public.invoices i
  WHERE i.customer_id = p_customer_id AND i.season = p_season AND i.invoice_type = 'field_application'
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number, 'invoice_date', i.invoice_date, 'invoice_type', i.invoice_type,
    'field_names', i.field_names, 'total_acres', i.total_acres, 'crop_type', i.crop_type,
    'total_amount_cents', i.total_amount_cents, 'balance_cents', i.balance_cents, 'status', i.status
  ) ORDER BY i.invoice_date, i.created_at), '[]'::jsonb)
  INTO v_invoices
  FROM public.invoices i
  WHERE i.customer_id = p_customer_id AND i.season = p_season
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number, 'field_names', i.field_names,
    'share_customer_name', s.customer_name, 'split_percentage', s.split_percentage,
    'acres', s.acres, 'amount_cents', s.amount_cents,
    'price_per_acre_cents', s.price_per_acre_cents, 'pricing_note', s.pricing_note
  ) ORDER BY i.invoice_date, s.sort_order), '[]'::jsonb)
  INTO v_shares
  FROM public.invoice_shares s JOIN public.invoices i ON i.id = s.invoice_id
  WHERE i.customer_id = p_customer_id AND i.season = p_season
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT CASE WHEN COUNT(*) > 0 THEN jsonb_build_object(
    'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
    'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0), 'invoice_count', COUNT(*),
    'total_acres', COALESCE((
      SELECT SUM(total_acres) FROM public.invoices
      WHERE customer_id = p_customer_id AND season = p_season - 1 AND invoice_type = 'field_application'
        AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL
    ), 0)
  ) ELSE NULL END INTO v_prior_season
  FROM public.invoices
  WHERE customer_id = p_customer_id AND season = p_season - 1
    AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object('id', v_cust.id, 'farm_name', v_cust.farm_name,
      'contact_name', v_cust.contact_name, 'account_number', v_cust.account_number,
      'email', v_cust.email, 'phone', v_cust.phone, 'billing_address', v_cust.billing_address,
      'city', v_cust.city, 'state', v_cust.state, 'zip', v_cust.zip,
      'assigned_tier', v_cust.assigned_tier, 'payment_terms', v_cust.payment_terms),
    'season', p_season, 'season_start', v_season_start, 'season_end', v_season_end,
    'financial', v_financial, 'product_usage', v_product_usage, 'acreage', v_acreage,
    'invoices', v_invoices, 'shares', v_shares, 'prior_season', v_prior_season
  );
END;
$function$;

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

CREATE OR REPLACE FUNCTION public.get_sales_summary_report(
  p_group_by text DEFAULT 'product'::text, p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid,
  p_customer_ids uuid[] DEFAULT NULL::uuid[], p_sales_rep_id uuid DEFAULT NULL::uuid,
  p_category text DEFAULT NULL::text, p_season integer DEFAULT NULL::integer
)
RETURNS TABLE(group_key text, group_id uuid, total_quantity numeric, total_revenue numeric,
              total_cost numeric, total_profit numeric, margin_pct numeric, order_count bigint,
              line_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin boolean := public.is_admin();
BEGIN
  -- KI-119 (Mason, 2026-11-19): Settings > Page Access is enforced here, before any other check.
  PERFORM public._require_page_access('sales-reports');
  -- Cost and margin are admin-only (Mason, 2026-10-15); the impl keeps its own
  -- admin-or-sales-rep check.
  RETURN QUERY
  SELECT r.group_key, r.group_id, r.total_quantity, r.total_revenue,
         CASE WHEN v_admin THEN r.total_cost END,
         CASE WHEN v_admin THEN r.total_profit END,
         CASE WHEN v_admin THEN r.margin_pct END,
         r.order_count, r.line_count
  FROM public._get_sales_summary_report_cost_impl_20261019(
    p_group_by, p_start_date, p_end_date, p_product_id, p_customer_ids, p_sales_rep_id,
    p_category, p_season
  ) r;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_detail_report(
  p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date,
  p_product_id uuid DEFAULT NULL::uuid, p_customer_ids uuid[] DEFAULT NULL::uuid[],
  p_sales_rep_id uuid DEFAULT NULL::uuid, p_category text DEFAULT NULL::text,
  p_season integer DEFAULT NULL::integer
)
RETURNS TABLE(order_date date, order_number text, customer_name text, customer_id uuid,
              product_name text, product_id uuid, sku text, category text, quantity numeric,
              unit text, unit_price numeric, total_price numeric, cost numeric, profit numeric,
              margin_pct numeric, sales_rep_name text, invoice_number text, season integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin boolean := public.is_admin();
BEGIN
  -- KI-119 (Mason, 2026-11-19): Settings > Page Access is enforced here, before any other check.
  PERFORM public._require_page_access('sales-reports');
  -- Cost and margin are admin-only (Mason, 2026-10-15); the impl keeps its own
  -- admin-or-sales-rep check.
  RETURN QUERY
  SELECT r.order_date, r.order_number, r.customer_name, r.customer_id, r.product_name,
         r.product_id, r.sku, r.category, r.quantity, r.unit, r.unit_price, r.total_price,
         CASE WHEN v_admin THEN r.cost END,
         CASE WHEN v_admin THEN r.profit END,
         CASE WHEN v_admin THEN r.margin_pct END,
         r.sales_rep_name, r.invoice_number, r.season
  FROM public._get_sales_detail_report_cost_impl_20261019(
    p_start_date, p_end_date, p_product_id, p_customer_ids, p_sales_rep_id, p_category, p_season
  ) r;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_logbook_faa(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_logbook_by_field(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_logbook_by_customer(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_logbook_by_applicator(uuid, date, date) FROM PUBLIC, anon;

-- The Commissions tab of the Reports Library: a sales rep with Reports hidden no longer reads their own commission
-- rows. Admins are unchanged; a NULL hidden list hides nothing.
ALTER POLICY comm_select ON public.commissions
  USING (is_admin() OR (is_sales_rep() AND recipient_user_id = (SELECT auth.uid())
         AND NOT EXISTS (SELECT 1 FROM public.profiles pr
                          WHERE pr.id = (SELECT auth.uid()) AND 'reports' = ANY (pr.denied_pages))));

DO $postflight$
DECLARE
  c_helper constant regprocedure := 'public._require_page_access(text)'::regprocedure;
  v_bad text;
BEGIN
  SELECT string_agg(t.sig, ', ') INTO v_bad
    FROM (VALUES
      ('public.get_customer_balance_listing(date)', 'get_customer_balance_listing', 'reports', true, 's', 'f08de6dccd6ec4fb7d62d0e2e83d9b5d', 'ebd306d0ea35290216330af67b27a24a', '1a4f6a0d7a472c87ba2134f706e98537', '77dd2146a565bbcea718d4454c42a891'),
      ('public.get_chemical_history(uuid,date,date)', 'get_chemical_history', 'reports', true, 's', '7bb1a941abe7919910717d4f939289ed', 'e070abfd1432ec3262d83d2b448361fe', 'd507cba7acafda3b9d838aa50825dace', 'c1bde406e68e9120d810f10b795eb4c1'),
      ('public.get_batch_year_end_summaries(uuid[],integer)', 'get_batch_year_end_summaries', 'reports', true, 'v', '98e8b1de00708a0027103a6fccaf271d', '8a53b2fa806169261090ebb6a73da2e6', 'b248ac497ea98e44cb91f7bcc1874a8b', 'cd8a1292080b231b3e9a85d440b02023'),
      ('public.get_logbook_faa(date,date)', 'get_logbook_faa', 'reports', false, 's', '4a6ebeb9b06523c3a3da28eb24abdcb3', 'ed749b3d8e621e7b43d22801a9f04a6e', 'cf3593de3f6270cf3648db8e53a6369f', 'c98cdcf38d7ec8b61325721aee66d0bc'),
      ('public.get_logbook_by_field(uuid,date,date)', 'get_logbook_by_field', 'reports', false, 's', '46abdabc79f130a39bf292a955007562', '04aea37b07a3c0463e129bc995234f1f', '95c8a09822072eac78ca524e3c5d2e42', '8cf46c8fd439e185ca268132b89c3a6c'),
      ('public.get_logbook_by_customer(uuid,date,date)', 'get_logbook_by_customer', 'reports', false, 's', '9ef22a9ef2b64feee1a0ba4591d9fe95', 'be23c3fca31b00a2db4d5409d19415ba', '1eee08175c6009d747b6a00412caa315', '8cf46c8fd439e185ca268132b89c3a6c'),
      ('public.get_logbook_by_applicator(uuid,date,date)', 'get_logbook_by_applicator', 'reports', false, 's', '495de6f68b6176092a612a2f30da1569', 'f9ef04a194268b3ce6f9c528488b0ea7', '98217454f7fc26d04c04623a015f886e', '8cf46c8fd439e185ca268132b89c3a6c'),
      ('public.get_sales_summary_report(text,date,date,uuid,uuid[],uuid,text,integer)', 'get_sales_summary_report', 'sales-reports', true, 's', '2b67599d9afe448a28db1297955ad3bc', 'af36f2d3f3903c535d65aa6fd9d2e04c', 'c222f5736bc0e766a8279b102717bf15', 'fa7a95dbbfc2648391db1f524d7a9301'),
      ('public.get_sales_detail_report(date,date,uuid,uuid[],uuid,text,integer)', 'get_sales_detail_report', 'sales-reports', true, 's', 'd28c19a5af636bd3dd46eca93b80b228', '8d6eac5a6300e8b1338aebca19e931a6', '87f65d7099a8253903e80ff231d1d7c0', '14efdc3a6bfe788abd2d1461b59211ab')
    ) AS t(sig, fname, page, secdef, vol, pre_md5, post_md5, args_md5, result_md5)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
   WHERE p.oid IS NULL
      OR md5(replace(p.prosrc, E'\r', '')) <> t.post_md5
      OR p.prosecdef <> t.secdef
      OR p.provolatile <> t.vol
      OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
      OR md5(pg_get_function_arguments(p.oid)) <> t.args_md5
      OR md5(pg_get_function_result(p.oid)) <> t.result_md5
      OR (SELECT count(*) FROM regexp_matches(p.prosrc, 'PERFORM public\._require_page_access\(''' || t.page || '''\);', 'g')) <> 1
      OR has_function_privilege('anon', p.oid, 'EXECUTE')
      OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_REPORT_FUNCTION_NOT_GUARDED: %', v_bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public.get_customer_year_end_summary(uuid,integer)')
                    AND md5(replace(p.prosrc, E'', '')) = 'd7b64aefdb2699854ab257c2893376e0'
                    AND md5(pg_get_function_arguments(p.oid)) = 'a5f2709374435b5cc27737e6b011ac6f'
                    AND md5(pg_get_function_result(p.oid)) = 'cd8a1292080b231b3e9a85d440b02023'
                    AND p.prosecdef AND p.provolatile = 'v'
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'POSTFLIGHT_YEAR_END_SUMMARY_NOT_GUARDED';
  END IF;

  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = c_helper)
     OR (SELECT proconfig FROM pg_proc WHERE oid = c_helper) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR has_function_privilege('anon', c_helper, 'EXECUTE')
     OR has_function_privilege('service_role', c_helper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', c_helper, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = c_helper AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTFLIGHT_PAGE_ACCESS_HELPER_GRANTS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'public.commissions'::regclass AND polname = 'comm_select' AND polcmd = 'r'
                    AND polpermissive AND polroles = ARRAY['authenticated'::regrole::oid]
                    AND pg_get_expr(polqual, polrelid) LIKE '%''reports''::text = ANY (pr.denied_pages)%')
     OR (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.commissions'::regclass AND polcmd IN ('r', '*')) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_COMMISSIONS_READ_POLICY';
  END IF;
END
$postflight$;
