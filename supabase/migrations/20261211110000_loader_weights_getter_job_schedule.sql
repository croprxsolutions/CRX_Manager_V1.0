-- DM-2 follow-up (Sol MED deferred from #1631): the loader worksheet PDF printed its "Scheduled" date, time and
-- applicator from an earlier jobs read than the getter's lines and weights, so an edit between the two reads could
-- print an old date over the new mix. get_loader_worksheet_weights now also returns each job's job_date,
-- scheduled_time and applicator_id from the same read as its lines.
--
-- Non-destructive: CREATE OR REPLACE with the same signature, return type, STABLE, SECURITY INVOKER and
-- search_path. The body is the 20261207100000 body with three added keys in each job's "job" object; nothing else
-- changes. CREATE OR REPLACE keeps the owner and grants (EXECUTE for postgres and authenticated only), so no
-- grant statement is restated; the check at the end proves they are unchanged.

CREATE OR REPLACE FUNCTION public.get_loader_worksheet_weights(p_worksheet_ids uuid[] DEFAULT NULL, p_job_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE
  v_ids uuid[];
  v_jobs uuid[];
  v_pids uuid[];
  v_units jsonb;
  v_current jsonb := '{}'::jsonb;
  v_r jsonb;
  v_i int := 1;
BEGIN
  IF (p_worksheet_ids IS NULL) = (p_job_ids IS NULL) THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_REQUEST: send worksheet IDs or job IDs, exactly one';
  END IF;
  v_ids := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_worksheet_ids, p_job_ids)) x WHERE x IS NOT NULL);
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_TOO_MANY: at most 200 worksheets or jobs at once';
  END IF;
  IF p_worksheet_ids IS NOT NULL THEN
    v_jobs := ARRAY(SELECT DISTINCT w.job_id FROM public.job_loader_worksheets w WHERE w.id = ANY (v_ids));
  ELSE
    v_jobs := v_ids;
  END IF;
  v_pids := ARRAY(SELECT DISTINCT c.product_id FROM public.job_chemicals c
                   WHERE c.job_id = ANY (v_jobs) AND c.product_id IS NOT NULL ORDER BY 1);
  LOOP
    v_r := public.get_product_weights(COALESCE(v_pids[v_i:v_i + 499], '{}'::uuid[]));
    v_units := COALESCE(v_units, v_r->'units');
    v_current := v_current || COALESCE(v_r->'products', '{}'::jsonb);
    v_i := v_i + 500;
    EXIT WHEN v_i > COALESCE(cardinality(v_pids), 0);
  END LOOP;

  RETURN jsonb_build_object(
    'read_at', statement_timestamp(),
    'unit_factors', v_units,
    'worksheets', CASE WHEN p_worksheet_ids IS NULL THEN NULL ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'worksheet_id', w.id, 'job_id', w.job_id, 'worksheet', to_jsonb(w),
          'vehicle_name', CASE WHEN w.vehicle_id IS NULL THEN 'Manual'
                               ELSE COALESCE((SELECT v.vehicle_name FROM public.vehicles v WHERE v.id = w.vehicle_id), 'Manual') END,
          'acres', (SELECT COALESCE(sum(f.acres_to_treat), 0) FROM public.job_fields f WHERE f.job_id = w.job_id),
          'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'product_id', c.product_id,
                        'quantity', c.quantity, 'unit', c.unit,
                        'product_name', COALESCE(NULLIF(p.product_name, ''), 'Product'), 'product_form', p.product_form)
                      ORDER BY c.sort_order NULLS LAST, c.id), '[]'::jsonb)
                      FROM public.job_chemicals c LEFT JOIN public.products p ON p.id = c.product_id
                     WHERE c.job_id = w.job_id),
          'weights', (SELECT COALESCE(jsonb_object_agg(pc.product_id::text, jsonb_build_object(
                          'saved', (SELECT to_jsonb(s) FROM public.job_loader_worksheet_weights s
                                     WHERE s.worksheet_id = w.id AND s.product_id = pc.product_id
                                       AND public.worksheet_weight_is_valid(s)),
                          'current', v_current->(pc.product_id::text)->'weight')), '{}'::jsonb)
                        FROM (SELECT DISTINCT c.product_id FROM public.job_chemicals c
                               WHERE c.job_id = w.job_id AND c.product_id IS NOT NULL) pc))
          ORDER BY w.id)
        FROM public.job_loader_worksheets w WHERE w.id = ANY (v_ids)), '[]'::jsonb) END,
    'jobs', CASE WHEN p_job_ids IS NULL THEN NULL ELSE COALESCE((
      SELECT jsonb_agg(CASE WHEN j.id IS NULL THEN jsonb_build_object('job_id', i.id, 'found', false)
        ELSE jsonb_build_object(
          'job_id', j.id, 'found', true,
          'job', jsonb_build_object('job_number', j.job_number, 'job_date', j.job_date, 'scheduled_time', j.scheduled_time,
            'applicator_id', j.applicator_id, 'carrier_rate_gpa', j.carrier_rate_gpa,
            'loader_tank_capacity', j.loader_tank_capacity, 'loader_comment', j.loader_comment,
            'vehicle', (SELECT jsonb_build_object('vehicle_name', v.vehicle_name, 'capacity_gallons', v.capacity_gallons,
                          'capacity_unit', v.capacity_unit) FROM public.vehicles v WHERE v.id = j.vehicle_id)),
          'acres', (SELECT COALESCE(sum(f.acres_to_treat), 0) FROM public.job_fields f WHERE f.job_id = j.id),
          'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'product_id', c.product_id,
                        'quantity', c.quantity, 'unit', c.unit,
                        'product_name', COALESCE(NULLIF(p.product_name, ''), 'Product'), 'product_form', p.product_form)
                      ORDER BY c.sort_order NULLS LAST, c.id), '[]'::jsonb)
                      FROM public.job_chemicals c LEFT JOIN public.products p ON p.id = c.product_id
                     WHERE c.job_id = j.id),
          'current', (SELECT COALESCE(jsonb_object_agg(pc.product_id::text, v_current->(pc.product_id::text)->'weight'), '{}'::jsonb)
                        FROM (SELECT DISTINCT c.product_id FROM public.job_chemicals c
                               WHERE c.job_id = j.id AND c.product_id IS NOT NULL) pc),
          'worksheet', (SELECT jsonb_build_object(
              'id', w.id, 'worksheet', to_jsonb(w),
              'vehicle_name', CASE WHEN w.vehicle_id IS NULL THEN 'Manual'
                                   ELSE COALESCE((SELECT v.vehicle_name FROM public.vehicles v WHERE v.id = w.vehicle_id), 'Manual') END,
              'saved', (SELECT COALESCE(jsonb_object_agg(s.product_id::text, to_jsonb(s)), '{}'::jsonb)
                          FROM public.job_loader_worksheet_weights s
                         WHERE s.worksheet_id = w.id AND public.worksheet_weight_is_valid(s)))
            FROM public.job_loader_worksheets w WHERE w.job_id = j.id AND w.is_selected))
        END ORDER BY i.ord)
        FROM unnest(v_ids) WITH ORDINALITY i(id, ord)
        LEFT JOIN public.jobs j ON j.id = i.id), '[]'::jsonb) END);
END;
$function$;

DO $check$
DECLARE
  v_fn regprocedure := 'public.get_loader_worksheet_weights(uuid[],uuid[])'::regprocedure;
BEGIN
  IF (SELECT provolatile <> 's' OR prosecdef OR proowner <> 'postgres'::regrole
        OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres}'
        OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
      FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'get_loader_worksheet_weights: volatility, security, owner, grants or search_path changed';
  END IF;
END
$check$;
