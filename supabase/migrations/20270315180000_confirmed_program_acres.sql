-- STATUS: NOT APPLIED (local candidate).
-- Today and Program Tracker share this office report. A planned acreage estimate
-- or a pending ticket is not evidence of application. Preserve the office-wide
-- role gate and result contract already used by both browser callers.
CREATE OR REPLACE FUNCTION public.get_program_completion(p_season integer DEFAULT NULL::integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_season integer;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can read program completion'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_season := COALESCE(p_season, public.current_season());

  WITH planned AS (
    SELECT q.customer_id, c.farm_name AS customer_name, q.id AS quote_id, q.quote_number,
      qs.id AS section_id, qs.section_name AS program_name, qs.needed_by_date, qs.field_id,
      COALESCE(MAX(qi.acres) FILTER (WHERE qi.acres >= 0 AND qi.acres < 'Infinity'::numeric), 0) AS planned_acres
    FROM public.quotes q
    JOIN public.customers c ON c.id = q.customer_id
    JOIN public.quote_sections qs ON qs.quote_id = q.id
    LEFT JOIN public.quote_items qi ON qi.section_id = qs.id
    WHERE q.is_planned = true AND q.season = v_season AND q.deleted_at IS NULL
      AND q.status NOT IN ('declined', 'expired', 'cancelled')
    GROUP BY q.id, c.farm_name, qs.id
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(result) ORDER BY result.customer_name, result.program_name), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT p.customer_id, p.customer_name, p.quote_id, p.quote_number, p.section_id,
      p.program_name, p.needed_by_date, p.planned_acres, progress.completed_acres,
      CASE WHEN p.planned_acres > 0
        THEN ROUND(progress.completed_acres / p.planned_acres * 100, 1)
        ELSE 0 END AS completion_pct,
      CASE
        WHEN progress.job_count = 0 THEN 'not_started'
        WHEN p.planned_acres > 0 AND progress.completed_acres >= p.planned_acres THEN 'completed'
        ELSE 'in_progress'
      END AS status,
      progress.job_count,
      (SELECT COUNT(*) FROM public.jobs j JOIN public.blend_tickets bt ON bt.job_id = j.id
        WHERE j.quote_section_id = p.section_id AND j.deleted_at IS NULL)::integer AS blend_ticket_count,
      COALESCE((SELECT SUM(inv.total_amount_cents)
        FROM public.jobs j JOIN public.blend_tickets bt ON bt.job_id = j.id
        JOIN public.invoices inv ON inv.blend_ticket_id = bt.id
        WHERE j.quote_section_id = p.section_id AND j.deleted_at IS NULL
          AND inv.status NOT IN ('voided', 'cancelled')), 0)::bigint AS invoiced_amount_cents
    FROM planned p
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::integer AS job_count,
        COALESCE(SUM(applied.acres), 0) AS completed_acres
      FROM public.jobs j
      LEFT JOIN LATERAL (
        SELECT SUM(COALESCE(applied_fields.acres,
          CASE WHEN p.field_id IS NULL AND r.applied_acres >= 0
            AND r.applied_acres < 'Infinity'::numeric THEN r.applied_acres END)) AS acres
        FROM public.job_applied_records r
        CROSS JOIN LATERAL (
          -- A pass with field details uses those details. Only a fieldless
          -- section can use a manual acreage total from a pass with no details.
          SELECT SUM(CASE WHEN (p.field_id IS NULL OR f.field_id = p.field_id)
            AND (field.customer_id = p.customer_id OR EXISTS (
              SELECT 1 FROM public._job_transfer_shares_20270207(j.id) payer
              WHERE payer.field_id = f.field_id AND payer.customer_id = p.customer_id AND payer.split_pct > 0
            ))
            AND f.applied_acres >= 0 AND f.applied_acres < 'Infinity'::numeric
            THEN f.applied_acres ELSE 0 END) AS acres
          FROM public.job_applied_record_fields f
          JOIN public.fields field ON field.id = f.field_id
          WHERE f.application_record_id = r.id
        ) applied_fields
        WHERE r.job_id = j.id
      ) applied ON true
      WHERE j.quote_section_id = p.section_id AND j.quote_id = p.quote_id
        AND j.customer_id = p.customer_id AND j.deleted_at IS NULL AND j.status <> 'cancelled'
    ) progress
  ) result;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_program_completion(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_program_completion(integer) TO authenticated, service_role;
