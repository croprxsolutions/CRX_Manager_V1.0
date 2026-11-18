-- ============================================================================
-- ROLLED-BACK smoke: the live-job booking rules hold for every write path (#1959)
-- ----------------------------------------------------------------------------
-- REQUIRES 20270125183000_booking_live_job_guard. Proof cases of
-- docs/plans/2026-11-18-booking-live-job-guard-CONTRACT.md, through direct UPDATEs (the booking
-- screen's Decline/Cancel path), convert_quote_to_order and auto_expire_quotes:
--   1/2 a sent booking with a scheduled job on it: a direct UPDATE to accepted, declined, expired or
--       cancelled is refused BOOKING_HAS_JOB naming the job and the status stays sent
--   3   convert_quote_to_order of that booking is refused BOOKING_HAS_JOB; no order is written
--   4   a direct customer change is refused BOOKING_HAS_JOB
--   6   a job on one of the booking's sections (no quote_id) blocks too; a completed job's refusal says
--       ask an admin; a cancelled job and a soft-deleted job do not block (the decline goes through)
--   S   closing short is refused while a job on a section (no quote_id) is scheduled; once completed it goes through
--   F   a job's booking links cannot change (unlink, re-point, re-point while cancelling or deleted); Mason 2026-11-18
--   M   the section a live job comes from cannot move to another booking
--   N   a job made from a section must also name that section's booking (JOB_NEEDS_BOOKING)
--   R   nor be deleted and re-created under the same id on a closed booking; re-created on its own booking is fine
--   8   with the job live: sent -> revised, and a notes edit, go through
--   5   auto_expire_quotes with two past-date bookings, one with a live job: the other expires, the one
--       with the job stays sent, the run does not fail, and its rep gets one "Booking past its date" alert
--       naming the spray job; a second run adds no second alert
--   J   on the expired booking a job cannot become live: direct insert on it or its section, re-link, un-delete,
--       or a live unlinked job gaining a link (a section-only link is refused JOB_NEEDS_BOOKING)
--       (BOOKING_CLOSED); a cancelled job may be written; a live job on an open booking still starts
--   D   with a live job: a Partial Order of part of the booking keeps it sent; the one that draws the last
--       booked unit closes it as accepted (Mason 2026-11-18)
--
-- HOW TO RUN: execute this whole file as ONE statement. It ALWAYS ends with
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so nothing persists. Any other error is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer_id uuid;
  v_customer2_id uuid;
  v_product_id uuid;
  v_price_res jsonb;
  v_line jsonb;
  v_res jsonb;
  v_q uuid;
  v_q2 uuid;
  v_s uuid;
  v_job uuid;
  v_err text;
  v_status text;
  v_i int;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_refusals int := 0;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Live Job Farm ' || v_suffix) RETURNING id INTO v_customer_id;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Live Job Farm B ' || v_suffix) RETURNING id INTO v_customer2_id;
  INSERT INTO products (product_name, unit_size, product_form)
  VALUES ('[SMOKE] Live Job Product ' || v_suffix, 'gal', 'liquid') RETURNING id INTO v_product_id;
  v_price_res := preview_product_pricing_changes('product_page', NULL, jsonb_build_array(jsonb_build_object(
    'product_id', v_product_id, 'row_version', (SELECT pricing_version FROM products WHERE id = v_product_id),
    'pricing_mode', 'margin_driven', 'new_cost', '6.00', 'tier1_margin_percent', '20',
    'tier2_margin_percent', '25', 'tier3_margin_percent', '30', 'change_reason', 'Rollback smoke live-job guard')),
    v_admin, 'smk-bljg-pp-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid, v_price_res->>'request_fingerprint',
    v_admin, 'smk-bljg-pa-' || v_suffix);
  v_line := jsonb_build_object('product_id', v_product_id, 'sort_order', 0, 'calc_mode', 'units_direct',
    'total_units_needed', 10, 'price_override', 20, 'price_per_unit', 20, 'current_cost', 6, 'unit_size', 'gal', 'acres', 0);

  -- Two sent bookings, A (v_q) and B (v_q2), each with one section.
  FOR v_i IN 1..2 LOOP
    v_res := save_quote(NULL, jsonb_build_object('quote_number', '[SMOKE] BLJG-' || v_i || '-' || v_suffix,
        'customer_id', v_customer_id, 'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
      jsonb_build_array(jsonb_build_object('section_name', 'North', 'sort_order', 0, 'items', jsonb_build_array(v_line))),
      v_admin, 'smk-bljg-save-' || v_i || '-' || v_suffix);
    PERFORM create_quote_version((v_res->>'quote_id')::uuid, v_admin, 'presented', 'smk-bljg-present-' || v_i || '-' || v_suffix,
      (v_res->>'row_version')::bigint);
    IF v_i = 1 THEN v_q := (v_res->>'quote_id')::uuid; ELSE v_q2 := (v_res->>'quote_id')::uuid; END IF;
  END LOOP;
  IF (SELECT count(*) FROM quotes WHERE id IN (v_q, v_q2) AND status = 'sent') <> 2 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the two bookings are not sent';
  END IF;
  SELECT id INTO v_s FROM quote_sections WHERE quote_id = v_q;

  INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id)
  VALUES ('SMK-LJ-' || v_suffix, v_customer_id, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_q, v_s)
  RETURNING id INTO v_job;

  -- 1/2. Direct status updates.
  FOREACH v_status IN ARRAY ARRAY['accepted', 'declined', 'expired', 'cancelled'] LOOP
    v_err := NULL;
    BEGIN
      UPDATE quotes SET status = v_status, updated_at = now() WHERE id = v_q;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_JOB: spray job SMK-LJ-' || v_suffix || ' was made from this booking, so the booking cannot be marked ' || v_status || '. Cancel the job first.' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (1) direct update to % was not refused BOOKING_HAS_JOB: %', v_status, v_err;
    END IF;
    v_refusals := v_refusals + 1;
  END LOOP;
  IF (SELECT status FROM quotes WHERE id = v_q) <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) the booking left sent';
  END IF;

  -- 3. Convert.
  v_err := NULL;
  BEGIN
    PERFORM convert_quote_to_order(v_q, v_admin, 'smk-bljg-convert-' || v_suffix,
      (SELECT row_version FROM quotes WHERE id = v_q), NULL);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_JOB:%cannot be marked accepted%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (3) convert of a booking with a live job was not refused BOOKING_HAS_JOB: %', v_err;
  END IF;
  v_refusals := v_refusals + 1;
  IF EXISTS (SELECT 1 FROM orders WHERE quote_id = v_q) OR (SELECT status FROM quotes WHERE id = v_q) <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (3) the refused convert left an order or a status change';
  END IF;

  -- 4. Customer change.
  v_err := NULL;
  BEGIN
    UPDATE quotes SET customer_id = v_customer2_id WHERE id = v_q;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_JOB: job SMK-LJ-' || v_suffix || ' was scheduled from this booking, so its customer cannot change.%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (4) customer change was not refused BOOKING_HAS_JOB: %', v_err;
  END IF;
  v_refusals := v_refusals + 1;

  -- 8. Changes outside the rule go through with the job live.
  UPDATE quotes SET status = 'revised' WHERE id = v_q;
  UPDATE quotes SET header_notes = 'live-job edit' WHERE id = v_q;
  UPDATE quotes SET status = 'sent' WHERE id = v_q;
  IF (SELECT header_notes FROM quotes WHERE id = v_q) IS DISTINCT FROM 'live-job edit' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (8) an edit outside the rule did not land';
  END IF;

  -- 6. A soft-deleted job does not block; nor does a cancelled one. Each decline is rolled back.
  FOR v_i IN 1..2 LOOP
    v_err := NULL;
    BEGIN
      IF v_i = 1 THEN
        UPDATE jobs SET deleted_at = now() WHERE id = v_job;
      ELSE
        UPDATE jobs SET status = 'cancelled' WHERE id = v_job;
      END IF;
      UPDATE quotes SET status = 'declined' WHERE id = v_q;
      IF (SELECT status FROM quotes WHERE id = v_q) <> 'declined' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: (6) decline did not land';
      END IF;
      RAISE EXCEPTION 'SMOKE_INNER_OK';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS DISTINCT FROM 'SMOKE_INNER_OK' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (6) case % (1 deleted, 2 cancelled job) did not let the decline through: %', v_i, v_err;
    END IF;
  END LOOP;

  -- 6. A job made from the section blocks too; completed says ask an admin.
  -- F. A job's booking links are fixed (Mason 2026-11-18, "A"): unlinking or re-pointing it is refused, also in
  --    the same update that cancels it (F3) and once it is deleted (F4), so it cannot be revived on another booking.
  FOR v_i IN 1..4 LOOP
    v_err := NULL;
    BEGIN
      IF v_i = 1 THEN
        UPDATE jobs SET quote_id = NULL, quote_section_id = NULL WHERE id = v_job;
      ELSIF v_i = 2 THEN
        UPDATE jobs SET quote_id = v_q2 WHERE id = v_job;
      ELSIF v_i = 3 THEN
        UPDATE jobs SET status = 'cancelled', quote_id = v_q2 WHERE id = v_job;
      ELSE
        UPDATE jobs SET deleted_at = now() WHERE id = v_job;
        UPDATE jobs SET quote_id = v_q2 WHERE id = v_job;
      END IF;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_JOB: spray job SMK-LJ-' || v_suffix || ' stays linked to the booking it was scheduled from. To move it, cancel it and schedule a new one.' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (F%) a live job''s booking link changed: %', v_i, v_err;
    END IF;
    v_refusals := v_refusals + 1;
  END LOOP;
  -- From here the job comes from the section (naming its booking too, as the scheduler does).
  UPDATE jobs SET deleted_at = now() WHERE id = v_job;
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id)
  VALUES ('SMK-LJ-' || v_suffix || '-S', v_customer_id, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_q, v_s)
  RETURNING id INTO v_job;
  v_err := NULL;
  BEGIN
    UPDATE quotes SET status = 'declined' WHERE id = v_q;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_JOB: spray job SMK-LJ-%cannot be marked declined. Cancel the job first.' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (6) a job on the section did not block decline: %', v_err;
  END IF;
  v_refusals := v_refusals + 1;
  -- S. Closing short releases the holds: refused while the section's job is scheduled (Sol HIGH, #1959).
  v_err := NULL;
  BEGIN
    UPDATE quotes SET status = 'closed_short' WHERE id = v_q;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  -- The job names its booking (Require both), so the existing 20261105160000 rule refuses first.
  IF v_err IS NULL OR (v_err NOT LIKE 'BOOKING_HAS_JOB: spray job SMK-LJ-% so the booking cannot be closed short. Cancel or complete the job first.'
                       AND v_err NOT LIKE 'BOOKING_HAS_ACTIVE_JOBS: %') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (S) closing short with a scheduled section job was not refused: %', v_err;
  END IF;
  v_refusals := v_refusals + 1;
  -- M. The section its live job comes from cannot move to booking B (Sol HIGH, #1959).
  v_err := NULL;
  BEGIN
    UPDATE quote_sections SET quote_id = v_q2 WHERE id = v_s;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_JOB: spray job SMK-LJ-' || v_suffix || '-S was made from this section, so the section cannot move to another booking.' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (M) a section with a live job moved to another booking: %', v_err;
  END IF;
  v_refusals := v_refusals + 1;
  -- N. A job made from A's section must name A (Mason 2026-11-18, "Require both"): naming no booking, or the
  --    other (open) booking B, is refused JOB_NEEDS_BOOKING.
  FOR v_i IN 1..2 LOOP
    v_err := NULL;
    BEGIN
      INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id)
      VALUES ('SMK-N' || v_i || '-' || v_suffix, v_customer_id, (now() AT TIME ZONE 'America/Chicago')::date + 7,
              CASE WHEN v_i = 2 THEN v_q2 END, v_s);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'JOB_NEEDS_BOOKING: spray job SMK-N' || v_i || '-' || v_suffix || ' comes from a booking section, so it must also name that section''s booking.' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (N%) a section job not naming its booking went through: %', v_i, v_err;
    END IF;
    v_refusals := v_refusals + 1;
  END LOOP;
  UPDATE jobs SET status = 'in_progress' WHERE id = v_job;
  UPDATE jobs SET status = 'completed' WHERE id = v_job;
  -- S. With the job completed, closing short goes through (rolled back).
  v_err := NULL;
  BEGIN
    UPDATE quotes SET status = 'closed_short' WHERE id = v_q;
    IF (SELECT status FROM quotes WHERE id = v_q) <> 'closed_short' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (S) close short did not land';
    END IF;
    RAISE EXCEPTION 'SMOKE_INNER_OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS DISTINCT FROM 'SMOKE_INNER_OK' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (S) closing short with only a completed job was refused: %', v_err;
  END IF;
  v_err := NULL;
  BEGIN
    UPDATE quotes SET status = 'accepted' WHERE id = v_q;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_JOB: spray job SMK-LJ-% and is completed, so the booking cannot be marked accepted. Ask an admin.' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (6) a completed job did not block accept with the ask-an-admin message: %', v_err;
  END IF;
  v_refusals := v_refusals + 1;

  -- 5. Nightly expiry: both bookings past their date; A has a live (scheduled) job, B has none.
  UPDATE jobs SET deleted_at = now() WHERE id = v_job;
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id)
  VALUES ('SMK-LJ2-' || v_suffix, v_customer_id, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_q);
  UPDATE quotes SET expires_at = CURRENT_DATE - 2 WHERE id IN (v_q, v_q2);
  v_res := auto_expire_quotes();
  IF (SELECT status FROM quotes WHERE id = v_q2) <> 'expired' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (5) the booking with no job did not expire: %', v_res;
  END IF;
  IF (SELECT status FROM quotes WHERE id = v_q) <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (5) the booking with a live job left sent';
  END IF;
  IF (SELECT count(*) FROM notifications WHERE related_entity_id = v_q AND notification_type = 'booking_past_expiry'
        AND message LIKE '%with a spray job made from it, so it stays open. Re-check it with the grower.') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (5) the rep did not get exactly one spray-job alert';
  END IF;
  PERFORM auto_expire_quotes();
  IF (SELECT count(*) FROM notifications WHERE related_entity_id = v_q AND notification_type = 'booking_past_expiry') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (5) a second run alerted again';
  END IF;

  -- R. The section FK is deferred: with a live job on A's section, deleting the section and re-inserting it under
  --    the same id on the expired booking B is refused (Sol HIGH r3; Mason 2026-11-18 "close it"); re-inserting it
  --    on A, as save_quote does, is not. Each re-insert is rolled back (a section delete cascades its lines).
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id)
  VALUES ('SMK-R-' || v_suffix, v_customer_id, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_q, v_s)
  RETURNING id INTO v_job;
  v_err := NULL;
  BEGIN
    DECLARE v_row quote_sections%ROWTYPE;
    BEGIN
      SELECT * INTO v_row FROM quote_sections WHERE id = v_s;
      DELETE FROM quote_sections WHERE id = v_s;
      v_row.quote_id := v_q2;
      INSERT INTO quote_sections SELECT v_row.*;
    END;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_JOB: spray job SMK-R-' || v_suffix || ' was made from this section, so the section cannot move to another booking.' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (R) a section with a live job was re-created on a closed booking: %', v_err;
  END IF;
  v_refusals := v_refusals + 1;
  v_err := NULL;
  BEGIN
    DECLARE v_row quote_sections%ROWTYPE;
    BEGIN
      SELECT * INTO v_row FROM quote_sections WHERE id = v_s;
      DELETE FROM quote_sections WHERE id = v_s;
      INSERT INTO quote_sections SELECT v_row.*;
      RAISE EXCEPTION 'SMK_R_REINSERT_OK';
    END;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS DISTINCT FROM 'SMK_R_REINSERT_OK' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (R) re-inserting the section on its own booking was refused: %', v_err;
  END IF;
  UPDATE jobs SET deleted_at = now() WHERE id = v_job;

  -- J. The other direction: B is now expired. A job cannot become live on it by a direct insert (on the
  --    booking or on its section), a re-link, or an un-delete; a cancelled or deleted job may still be written,
  --    and a live job on an open booking keeps moving through its own statuses.
  SELECT id INTO v_s FROM quote_sections WHERE quote_id = v_q2;
  FOR v_i IN 1..5 LOOP
    v_err := NULL;
    BEGIN
      IF v_i = 1 THEN
        INSERT INTO jobs (job_number, customer_id, job_date, quote_id)
        VALUES ('SMK-J1-' || v_suffix, v_customer_id, CURRENT_DATE + 7, v_q2);
      ELSIF v_i = 2 THEN
        INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id)
        VALUES ('SMK-J2-' || v_suffix, v_customer_id, CURRENT_DATE + 7, v_q2, v_s);
      ELSIF v_i = 3 THEN
        -- a deleted, never-linked job linked to B and restored in one update
        INSERT INTO jobs (job_number, customer_id, job_date, deleted_at)
        VALUES ('SMK-J3-' || v_suffix, v_customer_id, CURRENT_DATE + 7, now());
        UPDATE jobs SET quote_id = v_q2, deleted_at = NULL WHERE job_number = 'SMK-J3-' || v_suffix;
      ELSIF v_i = 4 THEN
        INSERT INTO jobs (job_number, customer_id, job_date, quote_id, deleted_at)
        VALUES ('SMK-J4-' || v_suffix, v_customer_id, CURRENT_DATE + 7, v_q2, now());
        UPDATE jobs SET deleted_at = NULL WHERE job_number = 'SMK-J4-' || v_suffix;
      ELSE
        -- a live, never-linked job gaining a link to B (Luna HIGH)
        INSERT INTO jobs (job_number, customer_id, job_date)
        VALUES ('SMK-J5L-' || v_suffix, v_customer_id, CURRENT_DATE + 7);
        UPDATE jobs SET quote_id = v_q2 WHERE job_number = 'SMK-J5L-' || v_suffix;
      END IF;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_CLOSED: booking [SMOKE] BLJG-2-' || v_suffix || ' is expired, so a spray job cannot be scheduled from it.' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (J%) a job became live on an expired booking: %', v_i, v_err;
    END IF;
    v_refusals := v_refusals + 1;
  END LOOP;
  -- J6. A live, never-linked job gaining only a section link is refused JOB_NEEDS_BOOKING (Luna HIGH).
  v_err := NULL;
  BEGIN
    INSERT INTO jobs (job_number, customer_id, job_date)
    VALUES ('SMK-J6-' || v_suffix, v_customer_id, CURRENT_DATE + 7);
    UPDATE jobs SET quote_section_id = v_s WHERE job_number = 'SMK-J6-' || v_suffix;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'JOB_NEEDS_BOOKING: spray job SMK-J6-' || v_suffix || ' comes from a booking section, so it must also name that section''s booking.' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (J6) a live job gained a section link without its booking: %', v_err;
  END IF;
  v_refusals := v_refusals + 1;
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id, status)
  VALUES ('SMK-J5-' || v_suffix, v_customer_id, CURRENT_DATE + 7, v_q2, 'cancelled');
  UPDATE jobs SET status = 'in_progress' WHERE job_number = 'SMK-LJ2-' || v_suffix;
  IF (SELECT status FROM jobs WHERE job_number = 'SMK-LJ2-' || v_suffix) <> 'in_progress' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (J) a live job on an open booking could not start';
  END IF;

  -- D. Partial Orders on A, which still has its live job SMK-LJ2 (Mason 2026-11-18, "Let it close"): a part
  --    draw keeps the booking sent; the draw that takes the last booked unit closes it as accepted.
  UPDATE quotes SET expires_at = CURRENT_DATE + 30 WHERE id = v_q;
  PERFORM draw_down_quote(v_q, jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 4)),
    v_admin, 'smk-bljg-draw-1-' || v_suffix, NULL);
  IF (SELECT status FROM quotes WHERE id = v_q) <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (D) a part draw moved the booking off sent';
  END IF;
  PERFORM draw_down_quote(v_q, jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 6)),
    v_admin, 'smk-bljg-draw-2-' || v_suffix, NULL);
  IF (SELECT status FROM quotes WHERE id = v_q) <> 'accepted'
     OR (SELECT count(*) FROM orders WHERE quote_id = v_q) <> 2
     OR NOT EXISTS (SELECT 1 FROM jobs WHERE job_number = 'SMK-LJ2-' || v_suffix AND status = 'in_progress' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (D) the last draw did not close the booking as accepted with two orders and its live job';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK live-job guard: BOOKING_HAS_JOB/BOOKING_CLOSED x%, nightly expiry skipped the booking with a job and alerted once, the last Partial Order closed it', v_refusals;
END;
$smoke$;
