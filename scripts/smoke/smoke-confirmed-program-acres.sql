-- Run through the smoke runner or against a disposable migrated database.
-- The final sentinel rolls back every invented fixture.
DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_driver uuid;
  v_product uuid;
  v_farm uuid;
  v_other_farm uuid;
  v_field uuid;
  v_other_field uuid;
  v_other_farm_field uuid;
  v_quotes uuid[] := ARRAY[]::uuid[];
  v_sections uuid[] := ARRAY[]::uuid[];
  v_jobs uuid[] := ARRAY[]::uuid[];
  v_quote uuid;
  v_section uuid;
  v_job uuid;
  v_ticket uuid;
  v_record uuid;
  v_report jsonb;
  v_row jsonb;
  v_season integer := public.current_season();
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_tag text := substr(gen_random_uuid()::text, 1, 8);
  v_pass record;
  i integer;
BEGIN
  SELECT id INTO STRICT v_admin FROM public.profiles
    WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO STRICT v_rep FROM public.profiles
    WHERE role = 'sales_rep' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO STRICT v_driver FROM public.profiles
    WHERE role = 'driver' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO STRICT v_product FROM public.products
    WHERE is_active AND current_cost > 0 ORDER BY id LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.customers (farm_name, assigned_sales_rep)
    VALUES ('Test program acres ' || v_tag, v_rep) RETURNING id INTO v_farm;
  INSERT INTO public.customers (farm_name)
    VALUES ('Other test program farm ' || v_tag) RETURNING id INTO v_other_farm;
  INSERT INTO public.fields (customer_id, field_name, total_acres)
    VALUES (v_farm, 'Confirmed field ' || v_tag, 100) RETURNING id INTO v_field;
  INSERT INTO public.fields (customer_id, field_name, total_acres)
    VALUES (v_farm, 'Different field ' || v_tag, 70) RETURNING id INTO v_other_field;
  INSERT INTO public.fields (customer_id, field_name, total_acres)
    VALUES (v_other_farm, 'Other farm field ' || v_tag, 30) RETURNING id INTO v_other_farm_field;

  FOR i IN 1..5 LOOP
    INSERT INTO public.quotes (quote_number, customer_id, created_by, is_planned, season)
      VALUES ('SMOKE-ACRES-' || v_tag || '-' || i, v_farm, v_admin, true,
        CASE WHEN i = 5 THEN v_season - 1 ELSE v_season END) RETURNING id INTO v_quote;
    INSERT INTO public.quote_sections (quote_id, section_name, field_id)
      VALUES (v_quote, 'Test program ' || v_tag || ' ' || i, CASE WHEN i <> 3 THEN v_field END)
      RETURNING id INTO v_section;
    INSERT INTO public.quote_items (quote_id, section_id, product_id, acres, price_per_unit)
      VALUES (v_quote, v_section, v_product, 100, 12);
    v_quotes := array_append(v_quotes, v_quote);
    v_sections := array_append(v_sections, v_section);

    IF i = 4 THEN
      UPDATE public.quotes SET deleted_at = now() WHERE id = v_quote;
      v_jobs := array_append(v_jobs, NULL::uuid);
    ELSE
      -- Scheduling can put a job in another season from the source quote.
      INSERT INTO public.jobs (job_number, customer_id, status, job_date, season, total_acres,
        quote_id, quote_section_id, created_by)
      VALUES ('SMOKE-ACRES-' || v_tag || '-' || i, v_farm, 'scheduled', v_today,
        CASE WHEN i = 1 THEN v_season + 1 ELSE v_season END, 100, v_quote, v_section, v_admin)
      RETURNING id INTO v_job;
      v_jobs := array_append(v_jobs, v_job);
      IF i <> 3 THEN
        INSERT INTO public.job_fields (job_id, field_id, acres_to_treat)
          VALUES (v_job, v_field, 100);
      END IF;
    END IF;
  END LOOP;
  INSERT INTO public.job_fields (job_id, field_id, acres_to_treat)
    VALUES (v_jobs[1], v_other_field, 70);

  -- Populate otherwise plausible acreage behind incorrect or retired job links.
  FOR v_pass IN SELECT * FROM (VALUES
    ('wrong-quote', v_farm, v_quotes[2], 'scheduled', false),
    ('wrong-farm', v_other_farm, v_quotes[1], 'scheduled', false),
    ('cancelled', v_farm, v_quotes[1], 'cancelled', false),
    ('removed', v_farm, v_quotes[1], 'scheduled', true)
  ) AS fixtures(label, farm_id, quote_id, job_status, removed)
  LOOP
    BEGIN
      INSERT INTO public.jobs (job_number, customer_id, status, job_date, season,
        quote_id, quote_section_id, created_by, deleted_at)
      VALUES ('SMOKE-ACRES-' || v_tag || '-' || v_pass.label, v_pass.farm_id, 'scheduled',
        v_today, v_season, v_pass.quote_id, v_sections[1], v_admin,
        CASE WHEN v_pass.removed THEN now() END)
      RETURNING id INTO v_job;
    EXCEPTION WHEN raise_exception THEN
      -- The current write guard blocks new mismatched jobs. If a legacy
      -- fixture can be inserted, the reader must still exclude its acres.
      IF v_pass.label IN ('wrong-quote', 'wrong-farm') AND SQLERRM LIKE 'JOB_NEEDS_BOOKING:%' THEN
        CONTINUE;
      END IF;
      RAISE;
    END;
    INSERT INTO public.job_applied_records (job_id, application_date, created_by)
      VALUES (v_job, v_today, v_admin) RETURNING id INTO v_record;
    INSERT INTO public.job_applied_record_fields (application_record_id, field_id, applied_acres)
      VALUES (v_record, v_field, 99);
    IF v_pass.job_status = 'cancelled' THEN
      UPDATE public.jobs SET status = 'cancelled' WHERE id = v_job;
    END IF;
  END LOOP;
  INSERT INTO public.job_applied_records (job_id, application_date, created_by)
    VALUES (v_jobs[1], v_today, v_admin) RETURNING id INTO v_record;
  INSERT INTO public.job_applied_record_fields (application_record_id, field_id, applied_acres)
    VALUES (v_record, v_field, 'NaN'::numeric);
  INSERT INTO public.job_applied_records (job_id, application_date, created_by, applied_acres)
    VALUES (v_jobs[3], v_today, v_admin, 30) RETURNING id INTO v_record;
  INSERT INTO public.job_applied_record_fields (application_record_id, field_id, applied_acres)
    VALUES (v_record, v_other_farm_field, 30);

  INSERT INTO public.blend_tickets (ticket_number, uploaded_by, customer_id, job_id, season,
    status, review_status)
  VALUES ('SMOKE-ACRES-TICKET-' || v_tag, v_admin, v_farm, v_jobs[1], v_season, 'completed', 'approved')
  RETURNING id INTO v_ticket;
  INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres, applied_at)
    VALUES (v_ticket, v_field, v_farm, 120, now());
  INSERT INTO public.invoices (customer_id, invoice_type, blend_ticket_id, total_amount_cents, season, created_by)
    VALUES (v_farm, 'field_application', v_ticket, 12345, v_season, v_admin);

  INSERT INTO public.blend_tickets (ticket_number, uploaded_by, customer_id, job_id, season)
    VALUES ('SMOKE-ACRES-PENDING-' || v_tag, v_admin, v_farm, v_jobs[2], v_season)
    RETURNING id INTO v_ticket;
  INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
    VALUES (v_ticket, v_field, v_farm, 100);
  INSERT INTO public.blend_tickets (ticket_number, uploaded_by, customer_id, job_id, season, status, review_status)
    VALUES ('SMOKE-ACRES-REVIEWED-' || v_tag, v_admin, v_farm, v_jobs[2], v_season, 'completed', 'approved')
    RETURNING id INTO v_ticket;
  INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres, applied_at)
    VALUES (v_ticket, v_field, v_farm, 100, now());

  SET LOCAL ROLE authenticated;
  FOR v_pass IN SELECT * FROM (VALUES
    (1, v_field, 40), (1, v_field, 80), (1, v_other_field, 70),
    (3, NULL::uuid, 40), (5, v_field, 25)
  ) AS inputs(job_index, field_id, acres)
  LOOP
    PERFORM public.save_job_applied_record(
      p_record => jsonb_build_object('job_id', v_jobs[v_pass.job_index],
        'application_date', v_today, 'applied_acres', v_pass.acres, 'created_by', v_admin),
      p_fields => CASE WHEN v_pass.field_id IS NULL THEN '[]'::jsonb
        ELSE jsonb_build_array(jsonb_build_object('field_id', v_pass.field_id, 'applied_acres', v_pass.acres)) END,
      p_crew => '[]'::jsonb, p_idempotency_key => 'smoke-program-acres-' || gen_random_uuid()
    );
  END LOOP;

  v_report := public.get_program_completion();
  IF v_report IS DISTINCT FROM public.get_program_completion(v_season) THEN
    RAISE EXCEPTION 'SMOKE_FAIL default and explicit current season disagree';
  END IF;
  SELECT row INTO STRICT v_row FROM jsonb_array_elements(v_report) AS rows(row)
    WHERE row->>'section_id' = v_sections[1]::text;
  IF NOT (v_row @> '{"completed_acres":120,"completion_pct":120,"status":"completed","job_count":1,
        "blend_ticket_count":1,"invoiced_amount_cents":12345}') THEN
    RAISE EXCEPTION 'SMOKE_FAIL confirmed passes, field binding or invoice amount: %', v_row;
  END IF;
  SELECT row INTO STRICT v_row FROM jsonb_array_elements(v_report) AS rows(row)
    WHERE row->>'section_id' = v_sections[2]::text;
  IF NOT (v_row @> '{"completed_acres":0,"completion_pct":0,"status":"in_progress","blend_ticket_count":2}') THEN
    RAISE EXCEPTION 'SMOKE_FAIL tickets alone credited application: %', v_row;
  END IF;
  SELECT row INTO STRICT v_row FROM jsonb_array_elements(v_report) AS rows(row)
    WHERE row->>'section_id' = v_sections[3]::text;
  IF NOT (v_row @> '{"completed_acres":40,"completion_pct":40,"status":"in_progress"}') THEN
    RAISE EXCEPTION 'SMOKE_FAIL fieldless confirmed pass: %', v_row;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_report) AS rows(row)
    WHERE (row->>'section_id')::uuid IN (v_sections[4], v_sections[5])) THEN
    RAISE EXCEPTION 'SMOKE_FAIL removed or other-season program appeared';
  END IF;
  SELECT row INTO STRICT v_row FROM jsonb_array_elements(public.get_program_completion(v_season - 1)) AS rows(row)
    WHERE row->>'section_id' = v_sections[5]::text;
  IF NOT (v_row @> '{"completed_acres":25,"completion_pct":25}') THEN
    RAISE EXCEPTION 'SMOKE_FAIL confirmed acres did not follow the quote season: %', v_row;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  IF public.get_program_completion(v_season) IS DISTINCT FROM v_report THEN
    RAISE EXCEPTION 'SMOKE_FAIL active sales rep did not receive the office report';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  BEGIN
    PERFORM public.get_program_completion(v_season);
    RAISE EXCEPTION 'SMOKE_FAIL driver was allowed to read the office report';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.get_program_completion(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL anonymous role can execute the office report';
  END IF;
  RESET ROLE;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
