-- Written 2026-11-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270227100000_parent_epa_correction_on.md. Re-read the live ledger before applying.
--
-- PAR-1 EPA-correction enable (build sheet docs/plans/2026-11-04-product-stage2-BUILD-SHEET.md section 7.7;
-- contract docs/plans/2026-11-23-par1-epa-correction-on-CONTRACT.md). Mason, 2026-11-06: "yes i want to be able to
-- fix epa issues".
--
-- WHY: 20261207113000 built the parent EPA correction and left it switched off until every old record that prints an
--   EPA number keeps its own copy (docs/reference/product-corrections-record-map.md). With KI-195 (job printouts and the
--   sent spray proof read the job's kept number, 20270225193000) the last old record still reading the product's
--   current number is the customer year-end summary.
--
-- WHAT (no rows written):
--   1. get_customer_year_end_summary(uuid, integer): re-emitted from the 20270201100000 body with one change. The
--      product-usage rows show and group by the invoice line's own EPA copy (_epa_norm), the product's only for a line
--      with none (a correction is refused while a live line for a size that has a number has none, 20261207113000).
--      get_batch_year_end_summaries only calls it and is unchanged.
--   1b. _product_parent_identity_after re-emitted from 20261207113000 with one change: clearing a parent's EPA
--      number is refused (PRODUCT_PARENT_INVALID; Mason 2026-11-23, Sol r1 #1).
--   2. _product_parent_epa_correction_enabled() returns true: an admin can correct a parent's EPA number with reason
--      and evidence (the live correct_product_parent_identity, unchanged).
--
-- NOT CHANGED: correct_product_parent_identity and its other checks, grants, every writer, invoices, jobs, prices, stock.
--
-- ORDERING: after 20270201100000_page_access_locks_reports and 20270225193000_job_proof_kept_epa (the preflight
--   refuses otherwise). Deploy KI-195's app (#2330) to production before applying: until then a sprayed job printed
--   from the old app reads the product's number.
--
-- ROLLBACK (its own reviewed migration): re-emit _product_parent_epa_correction_enabled() as SELECT false ONLY. Keep
--   this file's year-end body: once a parent is corrected, the 20270201100000 body would print the new number on old
--   invoices (Astra 2026-11-23 #45). Corrections already made stay (each is a logged event; correct back through the
--   same screen, which is a new event, not a restore).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE parent_epa_correction_on_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Two statements: outside a transaction the table is already dropped, and the second would fail to plan.
  IF to_regclass('pg_temp.parent_epa_correction_on_tx') IS NULL THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_ON_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.parent_epa_correction_on_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_ON_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._product_parent_epa_correction_enabled()') IS NULL
     OR public._product_parent_epa_correction_enabled() THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_ON_PREFLIGHT: the switch is missing or already on';
  END IF;
  -- KI-195: the sent spray proof reads the job's kept number (the 20270225193000 body; source md5, CR stripped).
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.get_job_proof_data(uuid,uuid)')
                    AND md5(replace(prosrc, chr(13), '')) = '4cd0d1e134bef72ed51db34577629c2a') THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_ON_PREFLIGHT: apply 20270225193000_job_proof_kept_epa first';
  END IF;
  -- Every sprayed or finished job keeps a number for each of its products (the 20261204120000 invariant); a missing
  -- row would let a printout fall back to the corrected product number.
  IF EXISTS (SELECT 1 FROM public.jobs j
              WHERE (j.status IN ('completed', 'invoiced')
                     OR EXISTS (SELECT 1 FROM public.job_applied_records r WHERE r.job_id = j.id))
                AND NOT EXISTS (SELECT 1 FROM public.job_epa_sprayed s WHERE s.job_id = j.id))
     OR EXISTS (SELECT 1 FROM public.job_chemicals jc JOIN public.job_epa_sprayed s ON s.job_id = jc.job_id
                 WHERE NOT EXISTS (SELECT 1 FROM public.job_product_epa l
                                    WHERE l.job_id = jc.job_id AND l.product_id = jc.product_id)) THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_ON_PREFLIGHT: a sprayed or finished job is missing a kept EPA number';
  END IF;
  -- The identity check this file re-emits is exactly 20261207113000's (owner-only, no grants).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public._product_parent_identity_after(public.product_parents,jsonb)')
                    AND md5(replace(p.prosrc, chr(13), '')) = '0adf80976cebf56021579d30bc5a8e06'
                    AND p.proowner = 'postgres'::regrole) THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_ON_PREFLIGHT: _product_parent_identity_after is not the 20261207113000 body';
  END IF;
  -- The year-end body this file re-emits is exactly 20270201100000's.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_customer_year_end_summary') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.get_customer_year_end_summary(uuid,integer)')
                       AND md5(replace(p.prosrc, chr(13), '')) = 'd7b64aefdb2699854ab257c2893376e0'
                       AND p.prosecdef AND p.provolatile = 'v' AND p.proowner = 'postgres'::regrole
                       AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_ON_PREFLIGHT: get_customer_year_end_summary is not the 20270201100000 body; apply that file first';
  END IF;
END
$preflight$;

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

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.category, t.product_name, t.epa_registration NULLS LAST), '[]'::jsonb)
  INTO v_product_usage
  FROM (
    SELECT COALESCE(p.category, 'Uncategorized') AS category,
      COALESCE(p.product_name, ii.description) AS product_name,
      -- The line's own EPA copy (what the invoice printed); the product's only for a line with none (PAR-1 7.7).
      COALESCE(public._epa_norm(ii.epa_registration), public._epa_norm(p.epa_registration)) AS epa_registration,
      SUM(ii.quantity) AS total_quantity,
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
      COALESCE(public._epa_norm(ii.epa_registration), public._epa_norm(p.epa_registration)), ii.is_application_fee
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

-- Re-emitted from 20261207113000 with one change: clearing the EPA number is refused (Mason, 2026-11-23).
CREATE OR REPLACE FUNCTION public._product_parent_identity_after(p_parent public.product_parents, p_changes jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_epa text := p_parent.generic_epa_registration;
  v_unsaved text;
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('formulation_type', 'safener', 'generic_epa_registration'))
     OR EXISTS (SELECT 1 FROM jsonb_each(p_changes) e WHERE jsonb_typeof(e.value) NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: the identity correction takes formulation_type, safener and generic_epa_registration';
  END IF;
  IF p_changes ? 'generic_epa_registration'
     AND public._normalize_epa_registration(p_changes->>'generic_epa_registration') IS DISTINCT FROM p_parent.generic_epa_registration THEN
    IF NOT public._product_parent_epa_correction_enabled() THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_EPA_CORRECTION_OFF: EPA number correction is switched off until the screens that keep old records'' EPA numbers are live';
    END IF;
    v_epa := public._normalize_epa_registration(p_changes->>'generic_epa_registration');
    -- PAR-1 7.7 (Mason, 2026-11-23, Sol r1 #1): a number is corrected, never cleared; a cleared number would also
    -- stop restricted-use sales of a size flagged only through it from being recorded.
    IF v_epa IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: an EPA number cannot be cleared; type the correct number';
    END IF;
    -- The same rule every product's EPA number follows (guard_product_setup_fields).
    IF v_epa IS NOT NULL AND v_epa !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: "%" is not an EPA number (for example 524-475 or 100-1070-12345)', v_epa;
    END IF;
    SELECT string_agg(DISTINCT COALESCE(i.invoice_number, i.id::text) || ' (' || i.status || ')', ', ')
      INTO v_unsaved
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.product_parent_members m ON m.product_id = ii.product_id
      JOIN public.products p ON p.id = ii.product_id
     WHERE m.parent_id = p_parent.id AND i.deleted_at IS NULL AND public._epa_norm(ii.epa_registration) IS NULL
       AND public._epa_norm(p.epa_registration) IS NOT NULL
       AND public._epa_norm(p.epa_registration) IS DISTINCT FROM v_epa;
    IF v_unsaved IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_EPA_RECORD_UNSAVED: invoice % has a line for this product with no saved EPA number, so it would change too. Open and save a draft invoice to give it one; a posted one must be unposted, saved and posted again', v_unsaved;
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'formulation_type', CASE WHEN p_changes ? 'formulation_type' THEN NULLIF(btrim(p_changes->>'formulation_type'), '') ELSE p_parent.formulation_type END,
    'safener', CASE WHEN p_changes ? 'safener' THEN NULLIF(btrim(p_changes->>'safener'), '') ELSE p_parent.safener END,
    'generic_epa_registration', v_epa);
END;
$function$;

CREATE OR REPLACE FUNCTION public._product_parent_epa_correction_enabled() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$ SELECT true $function$;

DO $postflight$
BEGIN
  IF NOT public._product_parent_epa_correction_enabled()
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._product_parent_epa_correction_enabled()'::regprocedure)
          IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[] THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_ON_POSTFLIGHT: the switch is not on, or its grants changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public._product_parent_identity_after(public.product_parents,jsonb)'::regprocedure
                    AND md5(replace(p.prosrc, chr(13), '')) = 'b734bf0030abd302f9b95b72c5e2d515'
                    AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_ON_POSTFLIGHT: the identity check is not the clearing-refused body, or its grants changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.get_customer_year_end_summary(uuid,integer)'::regprocedure
                    AND md5(replace(p.prosrc, chr(13), '')) = 'cfdeae60a2726f32f3936a0bfeabaf2e'
                    AND p.proowner = 'postgres'::regrole
                    AND p.prosecdef AND p.provolatile = 'v'
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_ON_POSTFLIGHT: the year-end summary does not read the invoice line copy, or its attributes changed';
  END IF;
END
$postflight$;
