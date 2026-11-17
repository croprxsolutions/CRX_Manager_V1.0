-- ============================================================================
-- ROLLED-BACK smoke: a booking with a spray job can be saved (bookings Phase A, PR 1a)
-- ----------------------------------------------------------------------------
-- REQUIRES 20270124100000_save_quote_keeps_section_ids. Proof cases P1-P4 of
-- docs/plans/2026-11-17-bookings-phase-a-CONTRACT.md, through the real save_quote:
--   1. a new quote with two sections returns section_ids keyed by client_key
--   P1 a job points at section S1; a save with the marker naming both sections
--      succeeds, S1 keeps its id, the deferred FK check passes, the job still points at S1
--   P2 a marked save leaving S1 out is refused SECTION_HAS_JOB and nothing changes;
--      the same with the job cancelled, then soft-deleted; an old (unmarked) save of
--      this booking gets SECTION_HAS_JOB, not a raw foreign-key error
--   P3 another quote's section id, the same id twice, a malformed id, and an id on a
--      new quote are each refused SECTION_ID_INVALID; neither quote changes
--   P4 an old (unmarked) save of a quote with no job behaves as before: it saves and
--      its sections take new ids; a marked save adding a new section gives it a new id
--   R  an exact idempotent replay returns the same section_ids
--   L  while the job is live: a customer change is refused BOOKING_HAS_JOB; a change to the
--      job's section quantity, price, line order, line id (cost basis), units, its place among the
--      sections, or moving its line away is refused SECTION_HAS_JOB_LOCKED; the section without a job may change. Once the job is
--      cancelled its section may change. Two sections with one client_key: SECTION_ID_INVALID.
--
-- HOW TO RUN: execute this whole file as ONE statement. It ALWAYS ends with
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so nothing persists. Any other error is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer_id uuid;
  v_product_id uuid;
  v_products uuid[] := ARRAY[]::uuid[];
  v_i int;
  v_la jsonb;
  v_la1 jsonb;
  v_lb jsonb;
  v_lc jsonb;
  v_quote_id uuid;
  v_quote2_id uuid;
  v_version bigint;
  v_version2 bigint;
  v_res jsonb;
  v_replay jsonb;
  v_err text;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_line jsonb;
  v_payload jsonb;
  v_payload2 jsonb;
  v_s1 uuid;
  v_s2 uuid;
  v_q2s1 uuid;
  v_job_id uuid;
  v_sections_before text;
  v_price_res jsonb;
  v_count int;
  v_customer2_id uuid;
BEGIN
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Section Ids Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;
  -- One product per section, so no save repeats a product (QUOTE_ITEM_AMBIGUOUS_COST is not under test).
  FOR v_i IN 1..3 LOOP
    INSERT INTO products (product_name, unit_size, product_form)
    VALUES ('[SMOKE] Section Ids Product ' || v_i || ' ' || v_suffix, 'gal', 'liquid')
    RETURNING id INTO v_product_id;
    v_products := v_products || v_product_id;
  END LOOP;
  -- Pricing sets a transaction-wide pricing mode, so every product is inserted before any is priced.
  FOREACH v_product_id IN ARRAY v_products LOOP
    v_i := array_position(v_products, v_product_id);
    v_price_res := preview_product_pricing_changes(
      'product_page', NULL,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_product_id,
        'row_version', (SELECT pricing_version FROM products WHERE id = v_product_id),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke section-ids fixture setup')),
      v_admin, 'smk-sqsi-price-preview-' || v_i || '-' || v_suffix);
    PERFORM apply_product_pricing_change_set(
      (v_price_res->>'change_set_id')::uuid, v_price_res->>'request_fingerprint',
      v_admin, 'smk-sqsi-price-apply-' || v_i || '-' || v_suffix);
  END LOOP;

  v_line := jsonb_build_object(
    'sort_order', 0, 'notes', null,
    'calc_mode', 'units_direct', 'total_units_needed', 10,
    'price_override', 20, 'price_per_unit', 20, 'current_cost', 6,
    'unit_size', 'gal', 'acres', 0);
  v_la := v_line || jsonb_build_object('product_id', v_products[1]);
  v_lb := v_line || jsonb_build_object('product_id', v_products[2]);
  v_lc := v_line || jsonb_build_object('product_id', v_products[3]);

  -- 1. New quote, two sections, marked.
  v_payload := jsonb_build_object(
    'quote_number', '[SMOKE] QSI-' || v_suffix,
    'customer_id', v_customer_id, 'status', 'draft', 'tier', 1,
    'commission_split', '{"splits": []}'::jsonb, 'section_ids_v1', true);
  v_res := save_quote(NULL, v_payload, jsonb_build_array(
    jsonb_build_object('client_key', '_s1', 'section_name', 'North', 'sort_order', 0,
      'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_k1'))),
    jsonb_build_object('client_key', '_s2', 'section_name', 'South', 'sort_order', 1,
      'items', jsonb_build_array(v_lb || jsonb_build_object('client_key', '_k2')))),
    v_admin, 'smk-sqsi-save-1-' || v_suffix);
  v_quote_id := (v_res->>'quote_id')::uuid;
  v_version := (v_res->>'row_version')::bigint;
  v_s1 := (v_res->'section_ids'->>'_s1')::uuid;
  v_s2 := (v_res->'section_ids'->>'_s2')::uuid;
  -- S1's line, named by its saved id (as the screen does): a job's section keeps its line ids.
  v_la1 := v_la || jsonb_build_object('id', v_res->'item_ids'->>'_k1');
  IF v_la1->>'id' IS NULL OR v_s1 IS NULL OR v_s2 IS NULL OR v_s1 = v_s2
     OR NOT EXISTS (SELECT 1 FROM quote_sections WHERE id = v_s1 AND quote_id = v_quote_id AND section_name = 'North')
     OR NOT EXISTS (SELECT 1 FROM quote_sections WHERE id = v_s2 AND quote_id = v_quote_id AND section_name = 'South') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) section_ids did not name the two new sections: %', v_res;
  END IF;

  -- A job scheduled from S1 (the link is what matters, not how the job was made).
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id, quote_section_id)
  VALUES ('SMK-' || v_suffix, v_customer_id, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_quote_id, v_s1)
  RETURNING id INTO v_job_id;

  -- P1. Marked save naming both sections succeeds; S1 keeps its id.
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_version, 'header_notes', 'P1');
  v_res := save_quote(v_quote_id, v_payload, jsonb_build_array(
    jsonb_build_object('id', v_s1, 'client_key', '_s1', 'section_name', 'North renamed', 'sort_order', 0,
      'items', jsonb_build_array(v_la1 || jsonb_build_object('client_key', '_k1'))),
    jsonb_build_object('id', v_s2, 'client_key', '_s2', 'section_name', 'South', 'sort_order', 1,
      'items', jsonb_build_array(v_lb || jsonb_build_object('client_key', '_k2')))),
    v_admin, 'smk-sqsi-save-p1-' || v_suffix);
  -- Run the deferred foreign-key check now (a rolled-back chain never reaches COMMIT).
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
  v_version := (v_res->>'row_version')::bigint;
  IF (v_res->'section_ids'->>'_s1')::uuid IS DISTINCT FROM v_s1
     OR (v_res->'section_ids'->>'_s2')::uuid IS DISTINCT FROM v_s2
     OR (SELECT quote_section_id FROM jobs WHERE id = v_job_id) IS DISTINCT FROM v_s1
     OR (SELECT section_name FROM quote_sections WHERE id = v_s1) IS DISTINCT FROM 'North renamed'
     OR (SELECT count(*) FROM quote_items WHERE quote_id = v_quote_id) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P1) save did not keep S1 and the job link: %', v_res;
  END IF;

  -- L. While the job is live, its customer and its section's lines are locked.
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Section Ids Farm Two ' || v_suffix)
  RETURNING id INTO v_customer2_id;
  SELECT string_agg(id::text || ':' || section_name, ',' ORDER BY sort_order) INTO v_sections_before
  FROM quote_sections WHERE quote_id = v_quote_id;
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_version, 'header_notes', 'L');
  FOR v_count IN 1..8 LOOP
    CONTINUE WHEN v_count = 6;   -- (an id-less line re-matches its saved line; accepted in L ok)
    v_err := NULL;
    BEGIN
      PERFORM save_quote(v_quote_id,
        CASE WHEN v_count = 1 THEN v_payload || jsonb_build_object('customer_id', v_customer2_id) ELSE v_payload END,
        jsonb_build_array(
          jsonb_build_object('id', v_s1, 'client_key', '_s1', 'section_name', 'North renamed',
            'sort_order', (v_count = 7)::int * 2,   -- 7: the section moves after South
            'items', CASE v_count
              WHEN 2 THEN jsonb_build_array(v_la1 || jsonb_build_object('client_key', '_k1', 'total_units_needed', 12))
              WHEN 3 THEN jsonb_build_array(v_la1 || jsonb_build_object('client_key', '_k1', 'price_override', 25, 'price_per_unit', 25))
              WHEN 4 THEN '[]'::jsonb
              WHEN 5 THEN jsonb_build_array(v_la1 || jsonb_build_object('client_key', '_k1', 'sort_order', 3))   -- line order
              WHEN 8 THEN jsonb_build_array(v_la1 || jsonb_build_object('client_key', '_k1', 'unit_size', NULL, 'price_unit', 'gal'))   -- units swap through null
              ELSE jsonb_build_array(v_la1 || jsonb_build_object('client_key', '_k1')) END),
          jsonb_build_object('id', v_s2, 'client_key', '_s2', 'section_name', 'South', 'sort_order', 1,
            'items', CASE WHEN v_count = 4
              THEN jsonb_build_array(v_lb || jsonb_build_object('client_key', '_k2'), v_la1 || jsonb_build_object('client_key', '_k1'))
              ELSE jsonb_build_array(v_lb || jsonb_build_object('client_key', '_k2')) END)),
        v_admin, 'smk-sqsi-save-l-' || v_count || '-' || v_suffix);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE (CASE WHEN v_count = 1 THEN 'BOOKING_HAS_JOB:%' ELSE 'SECTION_HAS_JOB_LOCKED:%' END) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (L.%) expected a lock refusal, got %', v_count, COALESCE(v_err, 'success');
    END IF;
  END LOOP;
  IF (SELECT string_agg(id::text || ':' || section_name, ',' ORDER BY sort_order) FROM quote_sections WHERE quote_id = v_quote_id)
       IS DISTINCT FROM v_sections_before
     OR (SELECT row_version FROM quotes WHERE id = v_quote_id) IS DISTINCT FROM v_version
     OR (SELECT customer_id FROM quotes WHERE id = v_quote_id) IS DISTINCT FROM v_customer_id
     OR (SELECT total_units_needed FROM quote_items WHERE section_id = v_s1) IS DISTINCT FROM 10::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (L) a refused save changed the quote';
  END IF;
  -- The section without a job may change; the job's section may be renamed (P1) and re-dated.
  v_res := save_quote(v_quote_id, v_payload, jsonb_build_array(
    jsonb_build_object('id', v_s1, 'client_key', '_s1', 'section_name', 'North renamed', 'sort_order', 0,
      'needed_by_date', (now() AT TIME ZONE 'America/Chicago')::date + 30,
      'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_k1'))),   -- no line id: re-matched to the same line
    jsonb_build_object('id', v_s2, 'client_key', '_s2', 'section_name', 'South', 'sort_order', 1,
      'items', jsonb_build_array(v_lb || jsonb_build_object('client_key', '_k2', 'total_units_needed', 12)))),
    v_admin, 'smk-sqsi-save-l-ok-' || v_suffix);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
  v_version := (v_res->>'row_version')::bigint;
  IF (SELECT total_units_needed FROM quote_items WHERE section_id = v_s2) IS DISTINCT FROM 12::numeric
     OR (SELECT needed_by_date FROM quote_sections WHERE id = v_s1) IS NULL
     OR (SELECT id::text FROM quote_items WHERE section_id = v_s1) IS DISTINCT FROM v_la1->>'id' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (L ok) the unlocked change did not save: %', v_res;
  END IF;


  -- P2. Leaving S1 out is refused, for an active, a cancelled and a soft-deleted job.
  SELECT string_agg(id::text || ':' || section_name, ',' ORDER BY sort_order) INTO v_sections_before
  FROM quote_sections WHERE quote_id = v_quote_id;
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_version, 'header_notes', 'P2');
  FOR v_count IN 1..3 LOOP
    IF v_count = 2 THEN
      UPDATE jobs SET status = 'cancelled' WHERE id = v_job_id;
    ELSIF v_count = 3 THEN
      UPDATE jobs SET deleted_at = now() WHERE id = v_job_id;
    END IF;
    v_err := NULL;
    BEGIN
      PERFORM save_quote(v_quote_id, v_payload, jsonb_build_array(
        jsonb_build_object('id', v_s2, 'client_key', '_s2', 'section_name', 'South', 'sort_order', 0,
          'items', jsonb_build_array(v_lb || jsonb_build_object('client_key', '_k2')))),
        v_admin, 'smk-sqsi-save-p2-' || v_count || '-' || v_suffix);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'SECTION_HAS_JOB:%SMK-' || v_suffix || '%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (P2.%) expected SECTION_HAS_JOB naming the job, got %', v_count, COALESCE(v_err, 'success');
    END IF;
  END LOOP;
  -- An old screen (no marker) gets the same clear refusal, not the raw FK error.
  v_err := NULL;
  BEGIN
    PERFORM save_quote(v_quote_id, v_payload - 'section_ids_v1', jsonb_build_array(
      jsonb_build_object('section_name', 'North', 'sort_order', 0,
        'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_k1'))),
      jsonb_build_object('section_name', 'South', 'sort_order', 1,
        'items', jsonb_build_array(v_lb || jsonb_build_object('client_key', '_k2')))),
      v_admin, 'smk-sqsi-save-p2-old-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'SECTION_HAS_JOB:%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P2 old screen) expected SECTION_HAS_JOB, got %', COALESCE(v_err, 'success');
  END IF;
  IF (SELECT string_agg(id::text || ':' || section_name, ',' ORDER BY sort_order) FROM quote_sections WHERE quote_id = v_quote_id)
       IS DISTINCT FROM v_sections_before
     OR (SELECT row_version FROM quotes WHERE id = v_quote_id) IS DISTINCT FROM v_version
     OR (SELECT header_notes FROM quotes WHERE id = v_quote_id) IS DISTINCT FROM 'L' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P2) a refused save changed the quote';
  END IF;

  -- P3. A second quote with one section; ids that are not this quote's, or repeated.
  v_payload2 := jsonb_build_object(
    'quote_number', '[SMOKE] QSI2-' || v_suffix,
    'customer_id', v_customer_id, 'status', 'draft', 'tier', 1,
    'commission_split', '{"splits": []}'::jsonb);
  v_res := save_quote(NULL, v_payload2, jsonb_build_array(
    jsonb_build_object('client_key', '_t1', 'section_name', 'East', 'sort_order', 0,
      'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_m1')))),
    v_admin, 'smk-sqsi-save-q2-' || v_suffix);
  v_quote2_id := (v_res->>'quote_id')::uuid;
  v_version2 := (v_res->>'row_version')::bigint;
  v_q2s1 := (v_res->'section_ids'->>'_t1')::uuid;
  IF v_q2s1 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P3) an unmarked create did not return section_ids: %', v_res;
  END IF;
  FOR v_count IN 1..5 LOOP
    v_err := NULL;
    BEGIN
      IF v_count = 1 THEN      -- another quote's section id
        PERFORM save_quote(v_quote_id, v_payload, jsonb_build_array(
          jsonb_build_object('id', v_s1, 'section_name', 'North', 'sort_order', 0,
            'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_k1'))),
          jsonb_build_object('id', v_q2s1, 'section_name', 'Stolen', 'sort_order', 1, 'items', '[]'::jsonb)),
          v_admin, 'smk-sqsi-save-p3-' || v_count || '-' || v_suffix);
      ELSIF v_count = 2 THEN   -- the same id twice
        PERFORM save_quote(v_quote_id, v_payload, jsonb_build_array(
          jsonb_build_object('id', v_s1, 'section_name', 'North', 'sort_order', 0,
            'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_k1'))),
          jsonb_build_object('id', v_s1, 'section_name', 'Twice', 'sort_order', 1, 'items', '[]'::jsonb)),
          v_admin, 'smk-sqsi-save-p3-' || v_count || '-' || v_suffix);
      ELSIF v_count = 3 THEN   -- not a uuid
        PERFORM save_quote(v_quote_id, v_payload, jsonb_build_array(
          jsonb_build_object('id', v_s1, 'section_name', 'North', 'sort_order', 0,
            'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_k1'))),
          jsonb_build_object('id', 'not-a-uuid', 'section_name', 'Bad', 'sort_order', 1, 'items', '[]'::jsonb)),
          v_admin, 'smk-sqsi-save-p3-' || v_count || '-' || v_suffix);
      ELSIF v_count = 5 THEN   -- two sections with one client_key
        PERFORM save_quote(v_quote_id, v_payload, jsonb_build_array(
          jsonb_build_object('id', v_s1, 'client_key', '_dup', 'section_name', 'North', 'sort_order', 0,
            'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_k1'))),
          jsonb_build_object('client_key', '_dup', 'section_name', 'Dup', 'sort_order', 1, 'items', '[]'::jsonb)),
          v_admin, 'smk-sqsi-save-p3-' || v_count || '-' || v_suffix);
      ELSE                     -- an id on a brand-new quote
        PERFORM save_quote(NULL, v_payload2 || jsonb_build_object('section_ids_v1', true,
            'quote_number', '[SMOKE] QSI3-' || v_suffix), jsonb_build_array(
          jsonb_build_object('id', v_q2s1, 'section_name', 'Copied', 'sort_order', 0,
            'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_m1')))),
          v_admin, 'smk-sqsi-save-p3-' || v_count || '-' || v_suffix);
      END IF;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'SECTION_ID_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (P3.%) expected SECTION_ID_INVALID, got %', v_count, COALESCE(v_err, 'success');
    END IF;
  END LOOP;
  IF (SELECT string_agg(id::text || ':' || section_name, ',' ORDER BY sort_order) FROM quote_sections WHERE quote_id = v_quote_id)
       IS DISTINCT FROM v_sections_before
     OR (SELECT row_version FROM quotes WHERE id = v_quote_id) IS DISTINCT FROM v_version
     OR (SELECT row_version FROM quotes WHERE id = v_quote2_id) IS DISTINCT FROM v_version2
     OR NOT EXISTS (SELECT 1 FROM quote_sections WHERE id = v_q2s1 AND quote_id = v_quote2_id AND section_name = 'East')
     OR EXISTS (SELECT 1 FROM quotes WHERE quote_number = '[SMOKE] QSI3-' || v_suffix) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P3) a refused save changed a quote';
  END IF;

  -- P4. Old (unmarked) save of the job-free quote: saves, ids are not reused (as before).
  v_res := save_quote(v_quote2_id, v_payload2 || jsonb_build_object('row_version_expected', v_version2), jsonb_build_array(
    jsonb_build_object('id', v_q2s1, 'client_key', '_t1', 'section_name', 'East', 'sort_order', 0,
      'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_m1')))),
    v_admin, 'smk-sqsi-save-p4-' || v_suffix);
  IF (v_res->>'status') IS DISTINCT FROM 'saved'
     OR (v_res->'section_ids'->>'_t1')::uuid = v_q2s1
     OR EXISTS (SELECT 1 FROM quote_sections WHERE id = v_q2s1)
     OR (SELECT count(*) FROM quote_sections WHERE quote_id = v_quote2_id) <> 1
     OR (SELECT count(*) FROM quote_items WHERE quote_id = v_quote2_id) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P4) old save did not behave as before: %', v_res;
  END IF;

  -- A marked save that adds a section with no id gives it a new one; replay returns the same map.
  UPDATE jobs SET deleted_at = NULL WHERE id = v_job_id;  -- still cancelled; any job keeps its section
  v_payload := v_payload || jsonb_build_object('header_notes', 'P4');
  v_res := save_quote(v_quote_id, v_payload, jsonb_build_array(
    jsonb_build_object('id', v_s1, 'client_key', '_s1', 'section_name', 'North', 'sort_order', 0,
      'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_k1'))),
    jsonb_build_object('id', v_s2, 'client_key', '_s2', 'section_name', 'South', 'sort_order', 1,
      'items', jsonb_build_array(v_lb || jsonb_build_object('client_key', '_k2'))),
    jsonb_build_object('client_key', '_s3', 'section_name', 'West', 'sort_order', 2,
      'items', jsonb_build_array(v_lc || jsonb_build_object('client_key', '_k3')))),
    v_admin, 'smk-sqsi-save-p4b-' || v_suffix);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
  IF (v_res->'section_ids'->>'_s3') IS NULL
     OR (v_res->'section_ids'->>'_s3')::uuid IN (v_s1, v_s2)
     OR (SELECT count(*) FROM quote_sections WHERE quote_id = v_quote_id) <> 3
     OR (SELECT quote_section_id FROM jobs WHERE id = v_job_id) IS DISTINCT FROM v_s1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (P4b) adding a section: %', v_res;
  END IF;
  v_replay := save_quote(v_quote_id, v_payload, jsonb_build_array(
    jsonb_build_object('id', v_s1, 'client_key', '_s1', 'section_name', 'North', 'sort_order', 0,
      'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_k1'))),
    jsonb_build_object('id', v_s2, 'client_key', '_s2', 'section_name', 'South', 'sort_order', 1,
      'items', jsonb_build_array(v_lb || jsonb_build_object('client_key', '_k2'))),
    jsonb_build_object('client_key', '_s3', 'section_name', 'West', 'sort_order', 2,
      'items', jsonb_build_array(v_lc || jsonb_build_object('client_key', '_k3')))),
    v_admin, 'smk-sqsi-save-p4b-' || v_suffix);
  IF v_replay->'section_ids' IS DISTINCT FROM v_res->'section_ids' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (R) replay returned different section_ids';
  END IF;

  -- L. The job is cancelled now, so its section's lines may change.
  v_res := save_quote(v_quote_id, v_payload || jsonb_build_object('row_version_expected', (v_res->>'row_version')::bigint, 'header_notes', 'L2'),
    jsonb_build_array(
      jsonb_build_object('id', v_s1, 'client_key', '_s1', 'section_name', 'North', 'sort_order', 0,
        'items', jsonb_build_array(v_la || jsonb_build_object('client_key', '_k1', 'total_units_needed', 12))),
      jsonb_build_object('id', v_s2, 'client_key', '_s2', 'section_name', 'South', 'sort_order', 1,
        'items', jsonb_build_array(v_lb || jsonb_build_object('client_key', '_k2'))),
      jsonb_build_object('id', (v_res->'section_ids'->>'_s3')::uuid, 'client_key', '_s3', 'section_name', 'West', 'sort_order', 2,
        'items', jsonb_build_array(v_lc || jsonb_build_object('client_key', '_k3')))),
    v_admin, 'smk-sqsi-save-l-cancelled-' || v_suffix);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  IF (SELECT total_units_needed FROM quote_items WHERE section_id = v_s1) IS DISTINCT FROM 12::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (L cancelled) the section of a cancelled job did not change: %', v_res;
  END IF;

  -- I. A sent booking with a live job cannot be accepted, declined or expired (rule i); once the
  --    job is completed it still cannot be accepted.
  INSERT INTO jobs (job_number, customer_id, job_date, quote_id)
  VALUES ('SMK-I-' || v_suffix, v_customer_id, (now() AT TIME ZONE 'America/Chicago')::date + 7, v_quote_id);
  INSERT INTO quote_versions (quote_id, sent_by, snapshot_data) VALUES (v_quote_id, v_admin, '{}'::jsonb);
  UPDATE quotes SET status = 'sent' WHERE id = v_quote_id;
  SELECT row_version INTO v_version FROM quotes WHERE id = v_quote_id;
  FOR v_count IN 1..4 LOOP
    IF v_count = 4 THEN
      UPDATE jobs SET status = 'in_progress' WHERE job_number = 'SMK-I-' || v_suffix;
      UPDATE jobs SET status = 'completed' WHERE job_number = 'SMK-I-' || v_suffix;
    END IF;
    v_err := NULL;
    BEGIN
      PERFORM save_quote(v_quote_id,
        v_payload || jsonb_build_object('row_version_expected', v_version, 'header_notes', 'I',
          'status', (ARRAY['accepted', 'declined', 'expired', 'accepted'])[v_count]),
        '[]'::jsonb, v_admin, 'smk-sqsi-save-i-' || v_count || '-' || v_suffix);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'BOOKING_HAS_JOB:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (I.%) expected BOOKING_HAS_JOB, got %', v_count, COALESCE(v_err, 'success');
    END IF;
  END LOOP;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK section ids kept; job link held; refusals SECTION_HAS_JOB x4, SECTION_ID_INVALID x5, BOOKING_HAS_JOB x5, SECTION_HAS_JOB_LOCKED x6';
END;
$smoke$;
