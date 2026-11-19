-- ============================================================================
-- ROLLED-BACK smoke: booking guard gaps from the release Sol review (#1990, PR-D1)
-- ----------------------------------------------------------------------------
-- REQUIRES 20270128170000_booking_guard_rep_and_delete. Booking A belongs to rep A and has a scheduled spray
-- job made from its section:
--   N1  rep B cannot mark that job completed or invoiced (BOOKING_NOT_YOURS), from scheduled or in_progress;
--       rep B can still start it (in_progress stays cancellable by any rep)
--   N2  rep A (the booking's rep), an admin, a system session (no auth.uid()) and the job's applicator (as
--       complete_job runs it) can each mark it completed
--   N3  a job on a booking with no rep (created_by NULL) can be completed by an admin only, not by a rep
--   D1  rep A cannot soft-delete booking A while the job is scheduled or in progress (BOOKING_HAS_JOB)
--   D2  once the job is completed, or cancelled, the delete goes through; a booking with no job deletes as before
--   D3  a notes edit and a status-only change with the job live behave as before (sent -> revised goes through)
--
-- HOW TO RUN: execute this whole file as ONE statement. It ALWAYS ends with
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so nothing persists. Any other error is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_sfx text := substr(md5(random()::text), 1, 8);
  v_admin uuid := gen_random_uuid();
  v_rep_a uuid := gen_random_uuid();
  v_rep_b uuid := gen_random_uuid();
  v_appl uuid := gen_random_uuid();
  v_customer uuid;
  v_q uuid;
  v_q_none uuid;
  v_q_orphan uuid;
  v_s uuid;
  v_job uuid;
  v_job_orphan uuid;
  v_err text;
  v_status text;
  v_who uuid;
  v_n int := 0;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (v_admin, 'd1-admin-' || v_sfx || '@example.invalid', '{"full_name":"[SMOKE] D1 Admin","role":"admin"}'::jsonb),
    (v_rep_a, 'd1-repa-' || v_sfx || '@example.invalid', '{"full_name":"[SMOKE] D1 Rep A","role":"sales_rep"}'::jsonb),
    (v_rep_b, 'd1-repb-' || v_sfx || '@example.invalid', '{"full_name":"[SMOKE] D1 Rep B","role":"sales_rep"}'::jsonb),
    (v_appl, 'd1-appl-' || v_sfx || '@example.invalid', '{"full_name":"[SMOKE] D1 Applicator","role":"applicator"}'::jsonb);
  UPDATE profiles SET role = 'admin', is_active = true WHERE id = v_admin;
  UPDATE profiles SET role = 'sales_rep', is_active = true WHERE id IN (v_rep_a, v_rep_b);
  UPDATE profiles SET role = 'applicator', is_active = true WHERE id = v_appl;
  IF (SELECT count(*) FROM profiles WHERE id IN (v_admin, v_rep_a, v_rep_b, v_appl) AND is_active) <> 4 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the four test profiles were not created';
  END IF;

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] D1 Farm ' || v_sfx) RETURNING id INTO v_customer;
  -- Booking A (rep A's), a booking with no job, and a booking with no rep; each sent, with one section.
  INSERT INTO quotes (quote_number, customer_id, status, tier, created_by) VALUES
    ('[SMOKE] D1-A-' || v_sfx, v_customer, 'draft', 1, v_rep_a) RETURNING id INTO v_q;
  INSERT INTO quotes (quote_number, customer_id, status, tier, created_by) VALUES
    ('[SMOKE] D1-N-' || v_sfx, v_customer, 'draft', 1, v_rep_a) RETURNING id INTO v_q_none;
  INSERT INTO quotes (quote_number, customer_id, status, tier, created_by) VALUES
    ('[SMOKE] D1-O-' || v_sfx, v_customer, 'draft', 1, NULL) RETURNING id INTO v_q_orphan;
  INSERT INTO quote_sections (quote_id, section_name, sort_order) VALUES (v_q, 'North', 0) RETURNING id INTO v_s;
  INSERT INTO quote_versions (quote_id, sent_by, snapshot_data)
    SELECT id, v_admin, '{}'::jsonb FROM quotes WHERE id IN (v_q, v_q_none, v_q_orphan);
  UPDATE quotes SET status = 'sent' WHERE id IN (v_q, v_q_none, v_q_orphan);
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id, applicator_id)
  VALUES ('SMK-D1-' || v_sfx, v_customer, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_q, v_s, v_appl)
  RETURNING id INTO v_job;
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id)
  VALUES ('SMK-D1O-' || v_sfx, v_customer, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_q_orphan)
  RETURNING id INTO v_job_orphan;

  -- N1. Rep B: completed and invoiced refused from scheduled; in_progress allowed; then completed refused from in_progress.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_b::text, true);
  FOREACH v_status IN ARRAY ARRAY['completed', 'invoiced', 'start', 'completed'] LOOP
    IF v_status = 'start' THEN
      UPDATE jobs SET status = 'in_progress' WHERE id = v_job;
      CONTINUE;
    END IF;
    v_err := NULL;
    BEGIN
      UPDATE jobs SET status = v_status WHERE id = v_job;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_NOT_YOURS: spray job SMK-D1-' || v_sfx || ' comes from booking [SMOKE] D1-A-' || v_sfx
         || ', which is another rep''s, so only that rep or an admin can mark it ' || v_status || '.' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (N1) rep B moving rep A''s booked job to % was not refused BOOKING_NOT_YOURS: %', v_status, v_err;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  IF (SELECT status FROM jobs WHERE id = v_job) <> 'in_progress' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (N1) rep B could not start the job, or a refused change landed';
  END IF;

  -- D1. Rep A cannot delete booking A while the job is in progress, nor while scheduled.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  FOREACH v_status IN ARRAY ARRAY['in_progress', 'scheduled'] LOOP
    UPDATE jobs SET status = v_status WHERE id = v_job;
    v_err := NULL;
    BEGIN
      UPDATE quotes SET deleted_at = now() WHERE id = v_q;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err <> 'BOOKING_HAS_JOB: spray job SMK-D1-' || v_sfx
         || ' was made from this booking, so the booking cannot be deleted. Cancel or complete the job first.' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (D1) deleting a booking with a % job was not refused BOOKING_HAS_JOB: %', v_status, v_err;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  -- D3. With the job live: sent -> revised and a notes edit go through.
  UPDATE quotes SET status = 'revised', header_notes = 'D1 smoke' WHERE id = v_q;
  IF (SELECT status FROM quotes WHERE id = v_q) <> 'revised' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (D3) a revise with a live job did not go through';
  END IF;

  -- N2. Each allowed caller can complete it (each in a sub-transaction that is undone).
  FOREACH v_who IN ARRAY ARRAY[v_rep_a, v_admin, v_appl, NULL] LOOP
    PERFORM set_config('request.jwt.claims', CASE WHEN v_who IS NULL THEN '' ELSE json_build_object('sub', v_who, 'role', 'authenticated')::text END, true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_who::text, ''), true);
    BEGIN
      UPDATE jobs SET status = 'completed' WHERE id = v_job;
      IF (SELECT status FROM jobs WHERE id = v_job) <> 'completed' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: (N2) completing as % did not land', COALESCE(v_who::text, 'system');
      END IF;
      RAISE EXCEPTION 'D1_UNDO';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'D1_UNDO' THEN RAISE; END IF;
    END;
  END LOOP;

  -- N3. A booking with no rep: a rep cannot complete its job, an admin can.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  v_err := NULL;
  BEGIN
    UPDATE jobs SET status = 'completed' WHERE id = v_job_orphan;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_NOT_YOURS:%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (N3) a rep completing a job on a booking with no rep was not refused: %', v_err;
  END IF;
  v_n := v_n + 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE jobs SET status = 'completed' WHERE id = v_job_orphan;

  -- D2. Completed job: the delete goes through; then cancelled; and a booking with no job.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  BEGIN
    UPDATE jobs SET status = 'completed' WHERE id = v_job;
    UPDATE quotes SET deleted_at = now() WHERE id = v_q;
    RAISE EXCEPTION 'D1_UNDO';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'D1_UNDO' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  UPDATE jobs SET status = 'cancelled' WHERE id = v_job;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  UPDATE quotes SET deleted_at = now() WHERE id IN (v_q, v_q_none);
  IF (SELECT count(*) FROM quotes WHERE id IN (v_q, v_q_none) AND deleted_at IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (D2) deleting with a cancelled job, or with no job, did not go through';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK booking guard rep and delete: % refusals, owner/admin/applicator/system complete, delete after complete or cancel', v_n;
END;
$smoke$;
