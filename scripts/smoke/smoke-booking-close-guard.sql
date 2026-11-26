-- ============================================================================
-- ROLLED-BACK smoke: booking close guard (release #1990 known issues: Sol r54 HIGH 2, #2065)
-- ----------------------------------------------------------------------------
-- REQUIRES 20270308200000_booking_close_guard_applied_and_short. Planned bookings A1..A4 and B belong to rep A.
--   C1  close_quote_as_applied is refused BOOKING_HAS_JOB while a spray job from the booking is scheduled or in
--       progress, for rep A and for an admin
--   C2  it closes when the booking's job is completed or cancelled, or it has none
--   C3  a direct close as applied at REPEATABLE READ is refused BOOKING_NEEDS_READ_COMMITTED (checked by the prover;
--       a DO block cannot change its own isolation level)
--   S1  rep B cannot close rep A's booking short (close_quote_as_short) or as applied (close_quote_as_applied):
--       BOOKING_NOT_YOURS
--   S1c rep A, once no longer an active sales rep, cannot close their own booking (the trigger alone, no row policy)
--   S2  rep A, an admin and a system session (no auth.uid()) can each close it short
--   S3  close_quote_as_short still refuses a booking with a scheduled job, and other closes are unchanged
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
  v_customer uuid;
  v_q uuid[] := ARRAY[]::uuid[];
  v_s uuid[] := ARRAY[]::uuid[];
  v_qid uuid;
  v_sid uuid;
  v_job uuid;
  v_res jsonb;
  v_err text;
  v_who uuid;
  v_i int;
  v_n int := 0;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (v_admin, 'bcg-admin-' || v_sfx || '@example.invalid', '{"full_name":"[SMOKE] BCG Admin","role":"admin"}'::jsonb),
    (v_rep_a, 'bcg-repa-' || v_sfx || '@example.invalid', '{"full_name":"[SMOKE] BCG Rep A","role":"sales_rep"}'::jsonb),
    (v_rep_b, 'bcg-repb-' || v_sfx || '@example.invalid', '{"full_name":"[SMOKE] BCG Rep B","role":"sales_rep"}'::jsonb);
  UPDATE profiles SET role = 'admin', is_active = true WHERE id = v_admin;
  UPDATE profiles SET role = 'sales_rep', is_active = true WHERE id IN (v_rep_a, v_rep_b);
  IF (SELECT count(*) FROM profiles WHERE id IN (v_admin, v_rep_a, v_rep_b) AND is_active) <> 3 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the three test profiles were not created';
  END IF;

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] BCG Farm ' || v_sfx) RETURNING id INTO v_customer;
  -- Five planned bookings of rep A, each with one section, all sent.
  FOR v_i IN 1..5 LOOP
    INSERT INTO quotes (quote_number, customer_id, status, tier, created_by, is_planned)
    VALUES ('[SMOKE] BCG-' || v_i || '-' || v_sfx, v_customer, 'draft', 1, v_rep_a, true) RETURNING id INTO v_qid;
    INSERT INTO quote_sections (quote_id, section_name, sort_order) VALUES (v_qid, 'North', 0) RETURNING id INTO v_sid;
    INSERT INTO quote_versions (quote_id, sent_by, snapshot_data) VALUES (v_qid, v_admin, '{}'::jsonb);
    UPDATE quotes SET status = 'sent' WHERE id = v_qid;
    v_q := v_q || v_qid;
    v_s := v_s || v_sid;
  END LOOP;
  IF (SELECT count(*) FROM quotes WHERE id = ANY (v_q) AND status = 'sent' AND is_planned) <> 5 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the five planned bookings are not sent';
  END IF;
  -- Booking 1: a scheduled job, booking 2: an in-progress job (a section job must also name its booking, JOB_NEEDS_BOOKING).
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id)
  VALUES ('SMK-BCG1-' || v_sfx, v_customer, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_q[1], v_s[1]) RETURNING id INTO v_job;
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id)
  VALUES ('SMK-BCG2-' || v_sfx, v_customer, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_q[2], v_s[2]);
  UPDATE jobs SET status = 'in_progress' WHERE job_number = 'SMK-BCG2-' || v_sfx;

  -- C1. Close as applied is refused while the job is live, for rep A and an admin.
  FOREACH v_who IN ARRAY ARRAY[v_rep_a, v_admin] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_who, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_who::text, true);
    FOR v_i IN 1..2 LOOP
      v_err := NULL;
      BEGIN
        v_res := public.close_quote_as_applied(v_q[v_i], v_who, 'bcg-c1-' || v_i || '-' || v_who || '-' || v_sfx);
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      IF v_err IS NULL OR v_err <> 'BOOKING_HAS_JOB: spray job SMK-BCG' || v_i || '-' || v_sfx
           || ' was made from this booking, so the booking cannot be closed as applied. Cancel or complete the job first.' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: (C1) closing booking % as applied with a live job was not refused BOOKING_HAS_JOB: % %', v_i, v_err, v_res;
      END IF;
      v_n := v_n + 1;
    END LOOP;
  END LOOP;
  IF (SELECT count(*) FROM quotes WHERE id IN (v_q[1], v_q[2]) AND status = 'sent') <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C1) a refused close changed the booking';
  END IF;

  -- C2. Completed (booking 1) or cancelled (booking 2) job, or no job (booking 3): the close goes through.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  UPDATE jobs SET status = 'in_progress' WHERE id = v_job;
  UPDATE jobs SET status = 'completed' WHERE id = v_job;
  UPDATE jobs SET status = 'cancelled' WHERE job_number = 'SMK-BCG2-' || v_sfx;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  FOR v_i IN 1..3 LOOP
    v_res := public.close_quote_as_applied(v_q[v_i], v_rep_a, 'bcg-c2-' || v_i || '-' || v_sfx);
    IF (SELECT status FROM quotes WHERE id = v_q[v_i]) IS DISTINCT FROM 'closed_by_application' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (C2) booking % did not close as applied: %', v_i, v_res;
    END IF;
  END LOOP;

  -- S1. Rep B cannot close rep A's booking 4 short.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_b::text, true);
  v_err := NULL;
  BEGIN
    v_res := public.close_quote_as_short(v_q[4], v_rep_b, 'bcg-s1-' || v_sfx);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err <> 'BOOKING_NOT_YOURS: booking [SMOKE] BCG-4-' || v_sfx
       || ' is another rep''s, so only that rep or an admin can close it short.' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (S1) rep B closing rep A''s booking short was not refused BOOKING_NOT_YOURS: % %', v_err, v_res;
  END IF;
  v_n := v_n + 1;
  v_err := NULL;
  BEGIN
    v_res := public.close_quote_as_applied(v_q[4], v_rep_b, 'bcg-s1b-' || v_sfx);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err <> 'BOOKING_NOT_YOURS: booking [SMOKE] BCG-4-' || v_sfx
       || ' is another rep''s, so only that rep or an admin can close it as applied.' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (S1) rep B closing rep A''s booking as applied was not refused BOOKING_NOT_YOURS: % %', v_err, v_res;
  END IF;
  v_n := v_n + 1;
  IF (SELECT status FROM quotes WHERE id = v_q[4]) IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (S1) a refused close changed the booking';
  END IF;

  -- S1c. Rep A's profile deactivated: a direct close of their own booking is refused by the trigger itself.
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    UPDATE profiles SET is_active = false WHERE id = v_rep_a;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
    v_err := NULL;
    BEGIN
      UPDATE quotes SET status = 'closed_short' WHERE id = v_q[4];
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_NOT_YOURS: booking [SMOKE] BCG-4-%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (S1c) a deactivated owner closing their booking short was not refused BOOKING_NOT_YOURS: %', v_err;
    END IF;
    RAISE EXCEPTION 'BCG_UNDO';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'BCG_UNDO' THEN RAISE; END IF;
  END;
  v_n := v_n + 1;

  -- S2. Rep A, an admin and a system session can each close it short (each undone).
  FOREACH v_who IN ARRAY ARRAY[v_rep_a, v_admin, NULL] LOOP
    PERFORM set_config('request.jwt.claims', CASE WHEN v_who IS NULL THEN '' ELSE json_build_object('sub', v_who, 'role', 'authenticated')::text END, true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_who::text, ''), true);
    BEGIN
      IF v_who IS NULL THEN
        UPDATE quotes SET status = 'closed_short' WHERE id = v_q[4];
      ELSE
        v_res := public.close_quote_as_short(v_q[4], v_who, 'bcg-s2-' || v_who || '-' || v_sfx);
      END IF;
      IF (SELECT status FROM quotes WHERE id = v_q[4]) IS DISTINCT FROM 'closed_short' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: (S2) closing short as % did not land: %', COALESCE(v_who::text, 'system'), v_res;
      END IF;
      RAISE EXCEPTION 'BCG_UNDO';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'BCG_UNDO' THEN RAISE; END IF;
    END;
  END LOOP;

  -- S3. With a scheduled job on booking 5, close short is still refused (the RPC's own check comes first), and
  --     declining is refused as before; with the job cancelled, rep A declines it.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id)
  VALUES ('SMK-BCG5-' || v_sfx, v_customer, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_q[5], v_s[5]) RETURNING id INTO v_job;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  v_err := NULL;
  BEGIN
    v_res := public.close_quote_as_short(v_q[5], v_rep_a, 'bcg-s3-' || v_sfx);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_ACTIVE_JOBS:%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (S3) closing short with a scheduled job was not refused as before: %', v_err;
  END IF;
  v_err := NULL;
  BEGIN
    UPDATE quotes SET status = 'declined' WHERE id = v_q[5];
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_JOB: spray job SMK-BCG5-%cannot be marked declined. Cancel the job first.' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (S3) declining with a scheduled job was not refused as before: %', v_err;
  END IF;
  v_n := v_n + 2;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  UPDATE jobs SET status = 'cancelled' WHERE id = v_job;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  UPDATE quotes SET status = 'declined' WHERE id = v_q[5];
  IF (SELECT status FROM quotes WHERE id = v_q[5]) IS DISTINCT FROM 'declined' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (S3) declining with the job cancelled did not go through';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK booking close guard: % refusals, close as applied after complete/cancel/none, close short by owner/admin/system', v_n;
END
$smoke$;
