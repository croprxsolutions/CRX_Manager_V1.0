-- ============================================================================
-- SMOKE TEST (rolled back by design): edit_jobs (#1979 PR A)
-- migration 20270131100000_job_writes_through_rpcs.sql
-- Contract: docs/plans/2026-11-19-job-writes-through-rpcs-CONTRACT.md (proof cases 1-11)
--
-- CONTAINER ONLY (smoke-specs container_only): probe P5 deactivates a sales rep inside the transaction,
-- which locks that user's auth session rows until rollback; never run it against a live database.
-- Every call runs as a signed-in user (SET LOCAL ROLE authenticated + jwt sub); checks read as owner.
--   P1-P5  auth probes: no user, anon, applicator, forged actor, inactive admin -> refused, nothing written
--   C1  rep cancels {scheduled, in_progress, completed, deleted, missing}: 2 cancelled, 3 skipped with reasons;
--       the cancelled scheduled job's stock holds are gone
--   C2  same key + same payload replays; same key + other ids refused
--   C3  delete {scheduled, completed, invoiced}: 2 deleted, invoiced skipped and still live
--   C4  refused shapes and values (other columns, null job_date, wrong types, bad numbers, delete+changes)
--   C5  {loader_comment} only changes that column; null clears; batch_ref set then cleared; absent keys untouched
--   C6  expired license refused; no license rows allowed (today's rule)
--   C7  rep schedule_date on {scheduled, invoiced} -> whole call refused, nothing changed; admin -> both updated
--   C8  changes + cancel on {scheduled, completed}: both dated, only scheduled cancelled
--   C9  rep changes + cancel on {scheduled (sorts first), invoiced}: billed lock aborts all, scheduled not cancelled
--   C10 500 scheduled jobs holding stock, changes + cancel in one call: all updated, cancelled, holds released, under 4 s
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'. Any other error = FAIL.
-- ============================================================================
DO $smoke$
DECLARE
  v_sfx    text := substr(gen_random_uuid()::text, 1, 8);
  v_admin  uuid;
  v_rep    uuid;
  v_appl   uuid;
  v_rep2   uuid;
  v_cust   uuid;
  v_prod   uuid;
  v_jS     uuid; v_jP uuid; v_jC uuid; v_jD uuid; v_jI uuid; v_jS2 uuid; v_jC2 uuid;
  v_missing uuid := gen_random_uuid();
  v_res    jsonb;
  v_n      int;
  v_r      record;
  v_date   date := (now() AT TIME ZONE 'America/Chicago')::date + 20;
  v_many   uuid[];
  v_t0     timestamptz;
  v_batch  uuid;
  v_ms     numeric;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep   FROM profiles WHERE role = 'sales_rep' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep2  FROM profiles WHERE role = 'sales_rep' AND is_active AND id <> v_rep ORDER BY created_at LIMIT 1;
  SELECT id INTO v_appl  FROM profiles p WHERE role = 'applicator' AND is_active
     AND NOT EXISTS (SELECT 1 FROM applicator_licenses l WHERE l.profile_id = p.id) ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_rep2 IS NULL OR v_appl IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an active admin, two sales reps and an applicator with no license rows';
  END IF;

  -- ── SETUP (owner) ─────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] EJ ' || v_sfx) RETURNING id INTO v_cust;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form)
    VALUES ('[SMOKE] EJ Prod ' || v_sfx, 'GL', '999999-99998', 'liquid') RETURNING id INTO v_prod;
  INSERT INTO jobs (job_number, customer_id, job_date, created_by) VALUES
    ('[SMOKE] EJ-S-'  || v_sfx, v_cust, CURRENT_DATE + 5, v_admin) RETURNING id INTO v_jS;
  INSERT INTO jobs (job_number, customer_id, job_date, created_by) VALUES
    ('[SMOKE] EJ-P-'  || v_sfx, v_cust, CURRENT_DATE + 5, v_admin) RETURNING id INTO v_jP;
  INSERT INTO jobs (job_number, customer_id, job_date, created_by) VALUES
    ('[SMOKE] EJ-C-'  || v_sfx, v_cust, CURRENT_DATE + 5, v_admin) RETURNING id INTO v_jC;
  INSERT INTO jobs (job_number, customer_id, job_date, created_by) VALUES
    ('[SMOKE] EJ-D-'  || v_sfx, v_cust, CURRENT_DATE + 5, v_admin) RETURNING id INTO v_jD;
  INSERT INTO jobs (job_number, customer_id, job_date, created_by) VALUES
    ('[SMOKE] EJ-I-'  || v_sfx, v_cust, CURRENT_DATE + 5, v_admin) RETURNING id INTO v_jI;
  INSERT INTO jobs (job_number, customer_id, job_date, created_by) VALUES
    ('[SMOKE] EJ-S2-' || v_sfx, v_cust, CURRENT_DATE + 5, v_admin) RETURNING id INTO v_jS2;
  INSERT INTO jobs (job_number, customer_id, job_date, created_by) VALUES
    ('[SMOKE] EJ-C2-' || v_sfx, v_cust, CURRENT_DATE + 5, v_admin) RETURNING id INTO v_jC2;
  UPDATE jobs SET status = 'in_progress' WHERE id IN (v_jP, v_jC, v_jI, v_jC2);
  UPDATE jobs SET status = 'completed'   WHERE id IN (v_jC, v_jI, v_jC2);
  UPDATE jobs SET status = 'invoiced'    WHERE id = v_jI;
  UPDATE jobs SET deleted_at = now()     WHERE id = v_jD;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_jS, v_prod, 10, 'GL', 0.5, 'PT', 2000, 5000, 1);
  PERFORM _sync_job_holds(v_jS, v_admin);
  SELECT count(*) INTO v_n FROM inventory_holds WHERE source_id = v_jS AND hold_type = 'job';
  IF v_n = 0 THEN RAISE EXCEPTION 'SMOKE_SETUP: the scheduled job has no stock hold to release'; END IF;

  -- ── P1-P5 auth probes ─────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM edit_jobs(ARRAY[v_jS], NULL, 'cancel', NULL, 'ej-p1-' || v_sfx);
    RAISE EXCEPTION 'SMOKE_FAIL: P1 no user was not refused';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: P1 wrong error: %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM edit_jobs(ARRAY[v_jS], NULL, 'cancel', NULL, 'ej-p2-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: P2 anon was not refused';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%permission denied%' AND SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: P2 wrong error: %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_appl, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM edit_jobs(ARRAY[v_jS], NULL, 'cancel', v_appl, 'ej-p3-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: P3 applicator was not refused';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN RAISE EXCEPTION 'SMOKE_FAIL: P3 wrong error: %', SQLERRM; END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM edit_jobs(ARRAY[v_jS], NULL, 'cancel', v_admin, 'ej-p4-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: P4 forged actor was not refused';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: P4 wrong error: %', SQLERRM; END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  UPDATE profiles SET is_active = false WHERE id = v_rep2;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep2, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM edit_jobs(ARRAY[v_jS], NULL, 'cancel', v_rep2, 'ej-p5-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: P5 inactive rep was not refused';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN RAISE EXCEPTION 'SMOKE_FAIL: P5 wrong error: %', SQLERRM; END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  UPDATE profiles SET is_active = true WHERE id = v_rep2;
  SELECT count(*) INTO v_n FROM jobs WHERE id = v_jS AND status = 'scheduled';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: a refused probe changed the job'; END IF;

  -- ── C1 rep cancels a mixed selection ──────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := edit_jobs(ARRAY[v_jS, v_jP, v_jC, v_jD, v_missing, v_jS, NULL], NULL, 'cancel', v_rep, 'ej-c1-' || v_sfx);
  RESET ROLE;
  IF jsonb_array_length(v_res -> 'cancelled') <> 2
     OR NOT (v_res -> 'cancelled') @> to_jsonb(ARRAY[v_jS, v_jP])
     OR NOT (v_res -> 'skipped') @> jsonb_build_array(
          jsonb_build_object('id', v_jC, 'reason', 'status', 'status', 'completed'),
          jsonb_build_object('id', v_jD, 'reason', 'deleted'),
          jsonb_build_object('id', v_missing, 'reason', 'not_found'))
     OR jsonb_array_length(v_res -> 'skipped') <> 3
     OR jsonb_array_length(v_res -> 'updated') <> 0 OR jsonb_array_length(v_res -> 'deleted') <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: C1 result %', v_res;
  END IF;
  SELECT count(*) INTO v_n FROM jobs WHERE id IN (v_jS, v_jP) AND status = 'cancelled' AND updated_by = v_rep;
  IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: C1 jobs not cancelled by the rep'; END IF;
  SELECT count(*) INTO v_n FROM jobs WHERE id = v_jC AND status = 'completed';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C1 completed job changed'; END IF;
  SELECT count(*) INTO v_n FROM inventory_holds WHERE source_id = v_jS AND hold_type = 'job';
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: C1 cancelled job kept % stock hold(s)', v_n; END IF;

  -- ── C2 replay ─────────────────────────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  IF edit_jobs(ARRAY[v_jP, v_jS, v_jC, v_jD, v_missing], NULL, 'cancel', v_rep, 'ej-c1-' || v_sfx) IS DISTINCT FROM v_res THEN
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C2 replay (same ids, other order) did not return the first result';
  END IF;
  BEGIN
    PERFORM edit_jobs(ARRAY[v_jS2], NULL, 'cancel', v_rep, 'ej-c1-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C2 same key with other ids was not refused';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: C2 wrong error: %', SQLERRM; END IF;
  END;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM edit_jobs(ARRAY[v_jS, v_jP, v_jC, v_jD, v_missing], NULL, 'delete', v_rep, 'ej-c1-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C2 same key with another action was not refused';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: C2 action wrong error: %', SQLERRM; END IF;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM jobs WHERE id = v_jC AND deleted_at IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C2 refused action deleted a job'; END IF;
  SELECT count(*) INTO v_n FROM jobs WHERE id = v_jS2 AND status = 'scheduled';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C2 refused replay changed a job'; END IF;

  -- ── C3 delete ─────────────────────────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  v_res := edit_jobs(ARRAY[v_jS2, v_jC, v_jI], NULL, 'delete', v_rep, 'ej-c3-' || v_sfx);
  RESET ROLE;
  IF NOT (v_res -> 'deleted') @> to_jsonb(ARRAY[v_jS2, v_jC]) OR jsonb_array_length(v_res -> 'deleted') <> 2
     OR v_res -> 'skipped' <> jsonb_build_array(jsonb_build_object('id', v_jI, 'reason', 'status', 'status', 'invoiced')) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: C3 result %', v_res;
  END IF;
  SELECT count(*) INTO v_n FROM jobs WHERE id IN (v_jS2, v_jC) AND deleted_at IS NOT NULL;
  IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: C3 jobs not deleted'; END IF;
  SELECT count(*) INTO v_n FROM jobs WHERE id = v_jI AND deleted_at IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C3 invoiced job was deleted'; END IF;
  UPDATE jobs SET deleted_at = NULL WHERE id IN (v_jS2, v_jC);   -- owner restores for the next cases

  -- ── C4 refused shapes and values ──────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  FOR v_r IN SELECT * FROM (VALUES
      ('{"total_price_cents": 1}'::jsonb, NULL::text, 'FIELD_NOT_EDITABLE%'),
      ('{"status": "completed"}', NULL, 'FIELD_NOT_EDITABLE%'),
      ('{"customer_id": "00000000-0000-4000-8000-000000000000"}', NULL, 'FIELD_NOT_EDITABLE%'),
      ('{"job_date": null}', NULL, 'JOB_DATE_REQUIRED%'),
      ('{"job_date": 20270101}', NULL, 'BAD_VALUE%'),
      ('{"carrier_rate_gpa": "5"}', NULL, 'BAD_VALUE%'),
      ('{"applicator_id": ["x"]}', NULL, 'BAD_VALUE%'),
      ('{"job_date": "2027-13-45"}', NULL, '%date%'),
      ('{"job_date": "2027-02-30"}', NULL, '%date%'),
      ('{"schedule_date": "tomorrow"}', NULL, 'BAD_VALUE%'),
      ('{"schedule_date": "infinity"}', NULL, 'BAD_VALUE%'),
      ('{"schedule_date": "01/02/2027"}', NULL, 'BAD_VALUE%'),
      ('{"ground_crew_id": "not-a-uuid"}', NULL, '%uuid%'),
      ('{"carrier_rate_gpa": -1}', NULL, '%carrier_rate_gpa%'),
      ('{"loader_tank_capacity": 0}', NULL, '%loader_tank_capacity%'),
      ('{"loader_comment": "x"}', 'delete', 'DELETE_WITH_CHANGES%'),
      ('{}', NULL, 'NO_CHANGES%'),
      (NULL, NULL, 'NOTHING_TO_DO%'),
      (NULL, 'archive', 'UNKNOWN_ACTION%')
    ) AS t(changes, action, pattern)
  LOOP
    BEGIN
      PERFORM edit_jobs(ARRAY[v_jS2], v_r.changes, v_r.action, v_rep, 'ej-c4-' || md5(coalesce(v_r.changes::text, '') || coalesce(v_r.action, '')) || v_sfx);
      RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C4 % / % was not refused', v_r.changes, v_r.action;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
      IF SQLERRM NOT LIKE v_r.pattern THEN
        RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C4 % / % wrong error: %', v_r.changes, v_r.action, SQLERRM;
      END IF;
    END;
  END LOOP;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM jobs WHERE id = v_jS2 AND status = 'scheduled' AND deleted_at IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C4 a refused call changed the job'; END IF;
  -- Bad values are refused even when every selected job would be skipped; bad list shapes too.
  SET LOCAL ROLE authenticated;
  FOR v_r IN SELECT * FROM (VALUES
      ('{"carrier_rate_gpa": -1}'::jsonb, 'BAD_VALUE%'), ('{"loader_tank_capacity": 0}', 'BAD_VALUE%'), ('{"loader_tank_capacity": 1e400}', 'BAD_VALUE%'),
      ('{"job_date": "2027-02-30"}', '%date%'), ('{"applicator_id": "bad-id"}', '%uuid%')
    ) AS t(changes, pattern)
  LOOP
    BEGIN
      PERFORM edit_jobs(ARRAY[v_jD, v_missing], v_r.changes, NULL, v_rep, 'ej-c4s-' || md5(v_r.changes::text) || v_sfx);
      RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C4 % on an all-skipped selection was not refused', v_r.changes;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
      IF SQLERRM NOT LIKE v_r.pattern THEN RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C4s % wrong error: %', v_r.changes, SQLERRM; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM edit_jobs(ARRAY[[v_jS2, v_jC]], NULL, 'cancel', v_rep, 'ej-c4n-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C4 a two-dimensional list was not refused';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
    IF SQLERRM NOT LIKE 'BAD_JOB_LIST%' THEN RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C4 2-D wrong error: %', SQLERRM; END IF;
  END;
  BEGIN
    PERFORM edit_jobs(array_fill(v_jS2, ARRAY[1001]), NULL, 'cancel', v_rep, 'ej-c4m-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C4 1001 entries were not refused';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
    IF SQLERRM NOT LIKE 'TOO_MANY_ENTRIES%' THEN RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C4 1001 wrong error: %', SQLERRM; END IF;
  END;
  RESET ROLE;

  -- ── C5 patch meaning ──────────────────────────────────────────────────────
  UPDATE jobs SET batch_ref = NULL, applicator_id = v_appl, carrier_rate_gpa = 12, schedule_date = CURRENT_DATE + 3 WHERE id = v_jS2;
  SET LOCAL ROLE authenticated;
  v_res := edit_jobs(ARRAY[v_jS2], '{"loader_comment": "fill north tank"}', NULL, v_rep, 'ej-c5a-' || v_sfx);
  RESET ROLE;
  SELECT * INTO v_r FROM jobs WHERE id = v_jS2;
  IF v_r.loader_comment IS DISTINCT FROM 'fill north tank' OR v_r.applicator_id IS DISTINCT FROM v_appl
     OR v_r.carrier_rate_gpa IS DISTINCT FROM 12 OR v_r.schedule_date IS DISTINCT FROM CURRENT_DATE + 3
     OR v_res -> 'updated' <> to_jsonb(ARRAY[v_jS2]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: C5 comment-only edit touched other fields or wrong result %', v_res;
  END IF;
  SET LOCAL ROLE authenticated;
  PERFORM edit_jobs(ARRAY[v_jS2], '{"schedule_date": null, "carrier_rate_gpa": 7.5}', NULL, v_rep, 'ej-c5b-' || v_sfx);
  RESET ROLE;
  SELECT * INTO v_r FROM jobs WHERE id = v_jS2;
  IF v_r.schedule_date IS NOT NULL OR v_r.carrier_rate_gpa IS DISTINCT FROM 7.5 OR v_r.loader_comment IS DISTINCT FROM 'fill north tank' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: C5 null did not clear or an absent key changed';
  END IF;
  INSERT INTO job_batches (name, created_by) VALUES ('[SMOKE] EJ batch ' || v_sfx, v_admin) RETURNING id INTO v_batch;
  SET LOCAL ROLE authenticated;
  PERFORM edit_jobs(ARRAY[v_jS2], jsonb_build_object('batch_ref', v_batch), NULL, v_rep, 'ej-c5c-' || v_sfx);
  RESET ROLE;
  SELECT count(*) INTO v_n FROM jobs WHERE id = v_jS2 AND batch_ref = v_batch;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C5 batch not set'; END IF;
  SET LOCAL ROLE authenticated;
  PERFORM edit_jobs(ARRAY[v_jS2], '{"batch_ref": null}', NULL, v_rep, 'ej-c5d-' || v_sfx);
  RESET ROLE;
  SELECT * INTO v_r FROM jobs WHERE id = v_jS2;
  IF v_r.batch_ref IS NOT NULL OR v_r.carrier_rate_gpa IS DISTINCT FROM 7.5 OR v_r.loader_comment IS DISTINCT FROM 'fill north tank' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: C5 batch not cleared or another field changed';
  END IF;

  -- ── C6 license rule (unchanged) ───────────────────────────────────────────
  UPDATE jobs SET applicator_id = NULL WHERE id = v_jS2;
  SET LOCAL ROLE authenticated;
  PERFORM edit_jobs(ARRAY[v_jS2], jsonb_build_object('applicator_id', v_appl), NULL, v_rep, 'ej-c6a-' || v_sfx);
  RESET ROLE;
  SELECT count(*) INTO v_n FROM jobs WHERE id = v_jS2 AND applicator_id = v_appl;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C6 applicator with no license rows was not assigned'; END IF;
  UPDATE jobs SET applicator_id = NULL WHERE id = v_jS2;
  INSERT INTO applicator_licenses (license_number, license_type, holder_name, expiry_date, profile_id, is_active)
    VALUES ('SMOKE-' || v_sfx, 'commercial', '[SMOKE] holder', (now() AT TIME ZONE 'America/Chicago')::date - 1, v_appl, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM edit_jobs(ARRAY[v_jS2], jsonb_build_object('applicator_id', v_appl), NULL, v_rep, 'ej-c6b-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C6 expired applicator was assigned';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'LICENSE_EXPIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: C6 wrong error: %', SQLERRM; END IF;
  END;
  RESET ROLE;
  DELETE FROM applicator_licenses WHERE license_number = 'SMOKE-' || v_sfx;

  -- ── C7 billed-job lock aborts the whole call for a rep; admin passes ──────
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM edit_jobs(ARRAY[v_jS2, v_jI], jsonb_build_object('schedule_date', v_date), NULL, v_rep, 'ej-c7a-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C7 rep edit of an invoiced job was not refused';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%billed-relevant fields%' THEN RAISE EXCEPTION 'SMOKE_FAIL: C7 wrong error: %', SQLERRM; END IF;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM jobs WHERE id IN (v_jS2, v_jI) AND schedule_date = v_date;
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: C7 refused call saved % job(s)', v_n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := edit_jobs(ARRAY[v_jS2, v_jI], jsonb_build_object('schedule_date', v_date), NULL, v_admin, 'ej-c7b-' || v_sfx);
  RESET ROLE;
  SELECT count(*) INTO v_n FROM jobs WHERE id IN (v_jS2, v_jI) AND schedule_date = v_date;
  IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: C7 admin edit saved % of 2 jobs', v_n; END IF;

  -- ── C8 changes + cancel in one call ───────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := edit_jobs(ARRAY[v_jS2, v_jC2], jsonb_build_object('job_date', v_date), 'cancel', v_rep, 'ej-c8-' || v_sfx);
  RESET ROLE;
  IF NOT (v_res -> 'updated') @> to_jsonb(ARRAY[v_jS2, v_jC2]) OR v_res -> 'cancelled' <> to_jsonb(ARRAY[v_jS2])
     OR v_res -> 'skipped' <> jsonb_build_array(jsonb_build_object('id', v_jC2, 'reason', 'status', 'status', 'completed')) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: C8 result %', v_res;
  END IF;
  SELECT count(*) INTO v_n FROM jobs WHERE id IN (v_jS2, v_jC2) AND job_date = v_date;
  IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: C8 date change saved on % of 2 jobs', v_n; END IF;
  SELECT count(*) INTO v_n FROM jobs WHERE id = v_jS2 AND status = 'cancelled';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C8 scheduled job not cancelled'; END IF;

  -- ── C9 combined call: a refused patch on the invoiced job aborts the scheduled cancel too ──
  -- The scheduled job's id sorts before the invoiced one, so it is edited and cancelled first and the
  -- refusal must undo both.
  INSERT INTO jobs (id, job_number, customer_id, job_date, schedule_date, created_by)
    VALUES (('00000000-0000-4000-8000-' || substr(md5(v_sfx), 1, 12))::uuid, '[SMOKE] EJ-S3-' || v_sfx, v_cust,
            CURRENT_DATE + 5, v_date, v_admin) RETURNING id INTO v_jS2;
  IF v_jS2 > v_jI THEN RAISE EXCEPTION 'SMOKE_SETUP: C9 job does not sort first'; END IF;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM edit_jobs(ARRAY[v_jS2, v_jI], jsonb_build_object('schedule_date', v_date + 1), 'cancel', v_rep, 'ej-c9-' || v_sfx);
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: C9 rep patch of an invoiced job was not refused';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%billed-relevant fields%' THEN RAISE EXCEPTION 'SMOKE_FAIL: C9 wrong error: %', SQLERRM; END IF;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM jobs WHERE id = v_jS2 AND status = 'scheduled' AND schedule_date = v_date;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C9 refused call changed the scheduled job'; END IF;

  -- ── C10 the 500-job maximum, changes + cancel ─────────────────────────────
  WITH ins AS (
    INSERT INTO jobs (job_number, customer_id, job_date, created_by)
    SELECT '[SMOKE] EJ-M' || g || '-' || v_sfx, v_cust, CURRENT_DATE + 5, v_admin FROM generate_series(1, 500) g
    RETURNING id)
  SELECT array_agg(id) INTO v_many FROM ins;
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    SELECT j, v_prod, 1, 'GL', 0.5, 'PT', 2000, 5000, 1 FROM unnest(v_many) j;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM _sync_job_holds(j, v_admin) FROM unnest(v_many) j;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  SELECT count(DISTINCT source_id) INTO v_n FROM inventory_holds WHERE source_id = ANY (v_many) AND hold_type = 'job';
  IF v_n <> 500 THEN RAISE EXCEPTION 'SMOKE_SETUP: C10 % of 500 jobs hold stock', v_n; END IF;
  v_t0 := clock_timestamp();
  SET LOCAL ROLE authenticated;
  v_res := edit_jobs(v_many, jsonb_build_object('job_date', v_date), 'cancel', v_rep, 'ej-c10-' || v_sfx);
  RESET ROLE;
  v_ms := round(extract(epoch FROM clock_timestamp() - v_t0) * 1000);
  RAISE NOTICE 'C10 500 jobs edited + cancelled in % ms', v_ms;
  IF v_ms > 4000 THEN RAISE EXCEPTION 'SMOKE_FAIL: C10 took % ms, over half the 8 s request limit', v_ms; END IF;
  IF jsonb_array_length(v_res -> 'updated') <> 500 OR jsonb_array_length(v_res -> 'cancelled') <> 500
     OR jsonb_array_length(v_res -> 'skipped') <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: C10 counts %/%/%', jsonb_array_length(v_res -> 'updated'),
      jsonb_array_length(v_res -> 'cancelled'), jsonb_array_length(v_res -> 'skipped');
  END IF;
  SELECT count(*) INTO v_n FROM jobs WHERE id = ANY (v_many) AND status = 'cancelled' AND job_date = v_date;
  IF v_n <> 500 THEN RAISE EXCEPTION 'SMOKE_FAIL: C10 % of 500 saved', v_n; END IF;
  SELECT count(*) INTO v_n FROM inventory_holds WHERE source_id = ANY (v_many) AND hold_type = 'job';
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: C10 % stock hold(s) left on cancelled jobs', v_n; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
