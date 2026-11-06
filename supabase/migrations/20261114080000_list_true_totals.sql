-- Goal 4: the Call Lists and the Dispatch Board say how many records really match, not only the first page.
--
-- Why: the five call-list functions stop at 200 rows and the dispatch board's applicator filter stops at
-- 500 jobs, and the screens then call the cut list complete ("Showing 200 of 200 customers"). Each now also
-- returns how many rows matched before the cut:
--   get_call_list_*          payload key 'total_count' beside 'rows' (rows themselves are unchanged)
--   get_dispatch_board_jobs  each job row carries '_total_count'; the 500 newest jobs now sort with the job
--                            id as a tie-breaker and the outer select keeps that order explicitly
-- The count is a window count over the same filtered rows, taken before LIMIT. Filters, role gates,
-- columns and limits are unchanged; today's screens ignore the new key until the screens PR reads it.
--
-- Read only: no table, row, grant or owner changes. CREATE OR REPLACE keeps each function's OID, owner,
-- grants, SECURITY DEFINER, search_path, volatility and argument defaults.
--
-- Safety: the preflight refuses unless each live body is exactly the one read from live on 2026-11-05
-- (md5 below, carriage returns removed); the postflight checks each new body and that owner, grants,
-- security mode, settings, return type, volatility and argument defaults did not move.

CREATE TEMP TABLE list_true_totals_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner,
       p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
       pg_get_function_arguments(p.oid) AS args,
       pg_current_xact_id()::text AS transaction_id
  FROM pg_proc p
 WHERE p.oid IN (
   to_regprocedure('public.get_call_list_prepay_prospects(uuid,bigint)'),
   to_regprocedure('public.get_call_list_no_recent_contact(uuid,integer)'),
   to_regprocedure('public.get_call_list_stale_quotes(uuid,integer)'),
   to_regprocedure('public.get_call_list_lapsed_products(uuid)'),
   to_regprocedure('public.get_call_list_unassigned_accounts(uuid)'),
   to_regprocedure('public.get_dispatch_board_jobs(uuid,text,date,date)')
 );

DO $preflight$
DECLARE
  v_expected constant jsonb := jsonb_build_object(
    'get_call_list_prepay_prospects(uuid,bigint)', '0d1fd06b4362531fb60ef3f27675ccf7',
    'get_call_list_no_recent_contact(uuid,integer)', '007bfd2acf96d7793c048a39e0f229ef',
    'get_call_list_stale_quotes(uuid,integer)', 'ee34f6da3c2349566c76ffc6582c0e15',
    'get_call_list_lapsed_products(uuid)', 'bd333801e1f7f2158645f51ff4c05bdb',
    'get_call_list_unassigned_accounts(uuid)', '7b3e8689760ad42ae581b2e5d5e49b33',
    'get_dispatch_board_jobs(uuid,text,date,date)', 'ad3303b06bac477613478d84122d0f25');
  v_row record;
BEGIN
  IF (SELECT count(*) FROM pg_temp.list_true_totals_attrs) <> 6 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: one of the six list functions is missing';
  END IF;
  FOR v_row IN
    SELECT a.sig, md5(replace(p.prosrc, chr(13), '')) AS body_md5
      FROM pg_temp.list_true_totals_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
  LOOP
    IF v_row.body_md5 IS DISTINCT FROM v_expected ->> v_row.sig THEN
      -- Already applied, or live drifted from the body read on 2026-11-05.
      RAISE EXCEPTION 'LIST_TRUE_TOTALS_BASELINE_DRIFT: % body md5 %', v_row.sig, v_row.body_md5;
    END IF;
  END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_call_list_prepay_prospects(
  p_rep_id uuid DEFAULT NULL,
  p_min_prior_spend_cents bigint DEFAULT 100000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season integer := public.current_season();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  RETURN (
    WITH prior_spend AS (
      SELECT i.customer_id, SUM(i.total_amount_cents)::bigint AS prior_season_spend_cents
      FROM public.invoices i
      WHERE i.season = v_season - 1
        AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
      GROUP BY i.customer_id
    ),
    current_prepay AS (
      SELECT pc.customer_id, SUM(pc.balance_cents)::bigint AS current_season_prepay_cents
      FROM public.prepay_credits pc
      WHERE pc.season = v_season
        AND pc.balance_cents > 0
      GROUP BY pc.customer_id
    )
    SELECT jsonb_build_object(
      'success', true,
      -- Every matching row, before the 200-row cut, so the screen can say "200 of N".
      'total_count', COALESCE(MAX(rows.total_count), 0),
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'prior_season_spend_cents', rows.prior_season_spend_cents,
        'current_season_prepay_cents', rows.current_season_prepay_cents
      ) ORDER BY rows.prior_season_spend_cents DESC, rows.farm_name, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        count(*) OVER () AS total_count,
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        ps.prior_season_spend_cents,
        COALESCE(cp.current_season_prepay_cents, 0)::bigint AS current_season_prepay_cents
      FROM public.customers c
      JOIN prior_spend ps ON ps.customer_id = c.id
      LEFT JOIN current_prepay cp ON cp.customer_id = c.id
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      WHERE c.is_active
        AND ps.prior_season_spend_cents >= p_min_prior_spend_cents
        AND COALESCE(cp.current_season_prepay_cents, 0) = 0
        AND (
          (public.is_admin() AND (p_rep_id IS NULL OR c.assigned_sales_rep = p_rep_id))
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
      ORDER BY ps.prior_season_spend_cents DESC, c.farm_name, c.id
      LIMIT 200
    ) rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_call_list_no_recent_contact(
  p_rep_id uuid DEFAULT NULL,
  p_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  IF p_days < 0 THEN
    RAISE EXCEPTION 'CALL_LIST_INVALID_DAYS';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'success', true,
      -- Every matching row, before the 200-row cut, so the screen can say "200 of N".
      'total_count', COALESCE(MAX(rows.total_count), 0),
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'days_since_last_interaction', rows.days_since_last_interaction
      ) ORDER BY rows.last_interaction_at NULLS FIRST, rows.farm_name, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        count(*) OVER () AS total_count,
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        -- Same rolling-clock boundary as the WHERE filter below: a row shown with
        -- days_since >= p_days is always one the filter admitted (Codex M2).
        CASE
          WHEN interaction.last_interaction_at IS NULL THEN NULL
          ELSE floor(EXTRACT(epoch FROM (now() - interaction.last_interaction_at)) / 86400)::int
        END AS days_since_last_interaction
      FROM public.customers c
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      WHERE c.is_active
        AND (
          interaction.last_interaction_at IS NULL
          OR interaction.last_interaction_at < now() - make_interval(days => p_days)
        )
        AND (
          (public.is_admin() AND (p_rep_id IS NULL OR c.assigned_sales_rep = p_rep_id))
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
      ORDER BY interaction.last_interaction_at NULLS FIRST, c.farm_name, c.id
      LIMIT 200
    ) rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_call_list_stale_quotes(
  p_rep_id uuid DEFAULT NULL,
  p_days integer DEFAULT 14
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  IF p_days < 0 THEN
    RAISE EXCEPTION 'CALL_LIST_INVALID_DAYS';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'success', true,
      -- Every matching row, before the 200-row cut, so the screen can say "200 of N".
      'total_count', COALESCE(MAX(rows.total_count), 0),
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'quote_id', rows.quote_id,
        'quote_number', rows.quote_number,
        'quote_total_cents', rows.quote_total_cents,
        'quote_updated_at', rows.quote_updated_at,
        'quote_age_days', rows.quote_age_days
      ) ORDER BY rows.quote_updated_at, rows.quote_number, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        count(*) OVER () AS total_count,
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        q.id AS quote_id,
        q.quote_number,
        ROUND(q.total_price * 100)::bigint AS quote_total_cents,
        q.updated_at AS quote_updated_at,
        (CURRENT_DATE - q.updated_at::date) AS quote_age_days
      FROM public.quotes q
      JOIN public.customers c ON c.id = q.customer_id
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      WHERE c.is_active
        AND q.deleted_at IS NULL
        AND q.status IN ('draft', 'sent', 'revised')
        AND q.updated_at < now() - make_interval(days => p_days)
        AND (
          (public.is_admin() AND (p_rep_id IS NULL OR c.assigned_sales_rep = p_rep_id))
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
      ORDER BY q.updated_at, q.quote_number, c.id
      LIMIT 200
    ) rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_call_list_lapsed_products(
  p_rep_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season integer := public.current_season();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  RETURN (
    -- Authorization scope comes FIRST so the invoice-item aggregation below only
    -- ever runs over customers the caller may see (Codex gate finding: aggregating
    -- all customers' items before the rep filter wastes work at scale).
    WITH authorized_customers AS (
      SELECT c.id, c.farm_name, c.assigned_sales_rep
      FROM public.customers c
      WHERE c.is_active
        AND (
          (public.is_admin() AND (p_rep_id IS NULL OR c.assigned_sales_rep = p_rep_id))
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
    ),
    lapsed_products AS (
      SELECT
        i.customer_id,
        ii.product_id,
        COALESCE(p.product_name, ii.description) AS product_name,
        SUM(ii.extended_cents)::bigint AS prior_revenue_cents
      FROM public.invoices i
      JOIN authorized_customers ac ON ac.id = i.customer_id
      JOIN public.invoice_items ii ON ii.invoice_id = i.id
      LEFT JOIN public.products p ON p.id = ii.product_id
      WHERE i.season = v_season - 1
        AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
        AND ii.product_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.invoices current_invoice
          JOIN public.invoice_items current_item ON current_item.invoice_id = current_invoice.id
          WHERE current_invoice.customer_id = i.customer_id
            AND current_invoice.season = v_season
            AND current_invoice.deleted_at IS NULL
            AND COALESCE(current_invoice.invoice_type, 'invoice') <> 'credit_memo'
            AND current_invoice.status IN ('posted', 'paid', 'overdue')
            AND current_item.product_id = ii.product_id
        )
      GROUP BY i.customer_id, ii.product_id, COALESCE(p.product_name, ii.description)
    ),
    ranked_lapsed_products AS (
      SELECT
        lp.*,
        ROW_NUMBER() OVER (
          PARTITION BY lp.customer_id
          ORDER BY lp.prior_revenue_cents DESC, lp.product_name, lp.product_id
        ) AS product_rank
      FROM lapsed_products lp
    ),
    lapsed_accounts AS (
      SELECT
        rlp.customer_id,
        COUNT(*)::integer AS lapsed_count,
        MAX(rlp.product_name) FILTER (WHERE rlp.product_rank = 1) AS top_lapsed_product_name,
        MAX(rlp.prior_revenue_cents) FILTER (WHERE rlp.product_rank = 1)::bigint
          AS top_lapsed_product_prior_revenue_cents
      FROM ranked_lapsed_products rlp
      GROUP BY rlp.customer_id
    )
    SELECT jsonb_build_object(
      'success', true,
      -- Every matching row, before the 200-row cut, so the screen can say "200 of N".
      'total_count', COALESCE(MAX(rows.total_count), 0),
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'lapsed_count', rows.lapsed_count,
        'top_lapsed_product_name', rows.top_lapsed_product_name,
        'top_lapsed_product_prior_revenue_cents', rows.top_lapsed_product_prior_revenue_cents
      ) ORDER BY rows.lapsed_count DESC, rows.top_lapsed_product_prior_revenue_cents DESC, rows.farm_name, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        count(*) OVER () AS total_count,
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        la.lapsed_count,
        la.top_lapsed_product_name,
        la.top_lapsed_product_prior_revenue_cents
      FROM lapsed_accounts la
      JOIN authorized_customers c ON c.id = la.customer_id
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      ORDER BY la.lapsed_count DESC, la.top_lapsed_product_prior_revenue_cents DESC, c.farm_name, c.id
      LIMIT 200
    ) rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_call_list_unassigned_accounts(
  p_rep_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'success', true,
      -- Every matching row, before the 200-row cut, so the screen can say "200 of N".
      'total_count', COALESCE(MAX(rows.total_count), 0),
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'account_created_at', rows.account_created_at
      ) ORDER BY rows.account_created_at DESC, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        count(*) OVER () AS total_count,
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        c.created_at AS account_created_at
      FROM public.customers c
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      WHERE c.is_active
        AND c.assigned_sales_rep IS NULL
        AND (
          (public.is_admin() AND p_rep_id IS NULL)
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
      ORDER BY c.created_at DESC, c.id
      LIMIT 200
    ) rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_dispatch_board_jobs(p_applicator_id uuid, p_status text DEFAULT NULL::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- A dispatch row is VISIBLE to the caller (mirrors job_location_dispatches_select):
  --   admin/sales see all; the job's whole-job applicator sees every row on their job;
  --   otherwise a field user sees a row where they are the assignee or an active member
  --   of the assigned active crew.
  WITH matched AS (
    -- _total_count: every matching job before the 500-row cut, so the board can say "500 of N".
    SELECT j.*, count(*) OVER () AS _total_count
      FROM public.jobs j
     WHERE j.deleted_at IS NULL
       AND p_applicator_id IS NOT NULL
       AND (p_status IS NULL OR j.status = p_status)
       AND (p_start_date IS NULL OR j.job_date >= p_start_date)
       AND (p_end_date IS NULL OR j.job_date <= p_end_date)
       AND (
         -- (a) a CURRENT per-location dispatch to this applicator the CALLER can see
         EXISTS (
           SELECT 1 FROM public.job_location_dispatches d
            WHERE d.job_id = j.id
              AND d.dispatch_status = 'dispatched'
              AND d.applicator_id = p_applicator_id
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND j.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
              )
         )
         OR (
           -- (b) whole-job applicator = this one AND the job has NO per-location dispatch
           j.applicator_id = p_applicator_id
           AND NOT EXISTS (
             SELECT 1 FROM public.job_location_dispatches d2
              WHERE d2.job_id = j.id
                AND d2.dispatch_status = 'dispatched'
           )
         )
       )
       -- VISIBILITY GATE — the live jobs SELECT predicate. Never return a hidden job.
       AND (
         is_admin()
         OR is_sales_rep()
         OR (is_applicator() AND j.applicator_id = (select auth.uid()))
         OR public._is_dispatched_to_me(j.id)
       )
     ORDER BY j.job_date DESC NULLS LAST, j.id DESC
     LIMIT 500
  )
  SELECT
    -- Job cost is admin-only and readable through get_admin_cost_fields; never send it here.
    (to_jsonb(m) - 'total_cost_cents')
    || jsonb_build_object(
         -- CUSTOMER NAME — RLS-equivalent (Codex re-review-3 P2): this function is
         -- SECURITY DEFINER, so a raw `customers` read would bypass customers_select and
         -- could leak a farm_name the caller can't otherwise see (a sales_rep is limited
         -- to assigned customers; an applicator/driver to a time-windowed set). Return the
         -- name ONLY when the caller would pass customers_select OR
         -- customers_select_location_dispatchee for THIS job's customer; else farm_name
         -- is null (the board renders 'Unknown', exactly as the unfiltered RLS embed would).
         'customer',
         (SELECT jsonb_build_object(
                   'farm_name',
                   CASE WHEN (
                     is_admin()
                     OR is_sales_rep()  -- any customer since 20261013220000 (Mason, 2026-10-13)
                     OR (is_driver() AND EXISTS (
                           SELECT 1 FROM public.deliveries d
                            WHERE d.customer_id = c.id
                              AND d.assigned_driver = (select auth.uid())
                              AND d.scheduled_date >= (CURRENT_DATE - interval '1 day')))
                     OR (is_applicator() AND EXISTS (
                           SELECT 1 FROM public.jobs j2
                            WHERE j2.customer_id = c.id
                              AND j2.applicator_id = (select auth.uid())
                              AND j2.job_date >= (CURRENT_DATE - interval '7 days')))
                     OR EXISTS (
                           SELECT 1 FROM public.jobs j3
                            WHERE j3.customer_id = c.id
                              AND public._is_dispatched_to_me(j3.id))
                   ) THEN c.farm_name ELSE NULL END)
            FROM public.customers c WHERE c.id = m.customer_id),
         -- JOB_FIELDS — job_fields_select is satisfied for every job that passed this
         -- function's visibility gate (admin/sales_rep/whole-job applicator/_is_dispatched_to_me
         -- are exactly its conditions), so listing the rows leaks nothing. field_name is
         -- gated to the fields_select predicate (admin/sales_rep/applicator) so a dispatched
         -- crew member whose role is NOT applicator doesn't get a field name they couldn't
         -- read under RLS (null → the board falls back to 'Field'). (Codex re-review-3 P2.)
         'job_fields',
         coalesce((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', jf.id,
                      'field_id', jf.field_id,
                      'acres_to_treat', jf.acres_to_treat,
                      'sort_order', jf.sort_order,
                      'field', jsonb_build_object(
                        'id', f.id,
                        'field_name', CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                                           THEN f.field_name ELSE NULL END)
                    ) ORDER BY jf.sort_order
                  )
             FROM public.job_fields jf
             JOIN public.fields f ON f.id = jf.field_id
            WHERE jf.job_id = m.id
         ), '[]'::jsonb),
         -- per-location dispatch rows the CALLER can see, for client-side label aggregation
         '_dispatches',
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('applicator_id', d.applicator_id, 'crew_id', d.crew_id))
             FROM public.job_location_dispatches d
            WHERE d.job_id = m.id
              AND d.dispatch_status = 'dispatched'
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND m.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
                OR (
                  d.crew_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM public.ground_crew_members gcm
                      JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                     WHERE gcm.crew_id = d.crew_id
                       AND gcm.profile_id = (select auth.uid())
                       AND gcm.is_active
                       AND gc.is_active
                  )
                )
              )
         ), '[]'::jsonb)
       )
    FROM matched m
   ORDER BY m.job_date DESC NULLS LAST, m.id DESC;
$function$;

DO $postflight$
DECLARE
  v_expected constant jsonb := jsonb_build_object(
    'get_call_list_prepay_prospects(uuid,bigint)', 'b0123ae8181da251b70eccd8a434d4fa',
    'get_call_list_no_recent_contact(uuid,integer)', 'd7a5b6e7ec1b0762bb1d514c3fde3792',
    'get_call_list_stale_quotes(uuid,integer)', '6ddc2b4b3bbbfcf0304b7879261643de',
    'get_call_list_lapsed_products(uuid)', '85c53890e7e4a9c82c792ae3cb5d14c6',
    'get_call_list_unassigned_accounts(uuid)', '78285c6e9f837cdb0f051b17daf1681f',
    'get_dispatch_board_jobs(uuid,text,date,date)', 'a0cb35e0fae1e2fd0c7cddbd2b33ac13');
  v_fn record;
  v_seen integer := 0;
BEGIN
  FOR v_fn IN
    SELECT a.sig, md5(replace(p.prosrc, chr(13), '')) AS body_md5, pg_get_userbyid(p.proowner) AS owner,
           p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
           pg_get_function_arguments(p.oid) AS args, a.args AS was_args,
           a.owner AS was_owner, a.acl AS was_acl, a.proconfig AS was_config, a.prorettype AS was_rettype,
           a.provolatile AS was_volatile, a.prosecdef AS was_secdef, a.transaction_id
      FROM pg_temp.list_true_totals_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
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
       OR v_fn.args IS DISTINCT FROM v_fn.was_args
       OR NOT v_fn.prosecdef THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % is not the expected body/attributes (md5 %)', v_fn.sig, v_fn.body_md5;
    END IF;
  END LOOP;
  IF v_seen <> 6 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected 6 functions, saw %', v_seen;
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: six list functions report their true totals';
END;
$postflight$;
