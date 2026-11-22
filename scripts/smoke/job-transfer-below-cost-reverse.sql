-- Reverses 20270207125000_job_transfer_below_cost_whole_line.sql (run as ONE transaction).
BEGIN;
-- Only undo this migration's own bodies: stop if a later migration has re-emitted either function.
DO $rev$
BEGIN
  IF to_regprocedure('public._job_transfer_line_clears_cost_20270207(uuid, text, numeric, text, bigint, boolean)') IS NULL
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid, uuid, text)'::regprocedure) IS DISTINCT FROM 'f6faf385be7d5785b7d700582e28b449'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = 'public._enforce_below_cost_line()'::regprocedure) IS DISTINCT FROM '4fd1f1040d9b4dc436ae16b5a5698016'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._job_transfer_line_clears_cost_20270207(uuid, text, numeric, text, bigint, boolean)')) IS DISTINCT FROM '9b0e6794781a83b2f2bcda5052a902c2' THEN
    RAISE EXCEPTION 'JOB_TRANSFER_BELOW_COST_ROLLBACK_PREFLIGHT: the live bodies are not the ones 20270207125000 installed; nothing changed';
  END IF;
END $rev$;
CREATE OR REPLACE FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_invoice_id uuid;
  v_invoice_number text;
  v_chem RECORD;
  v_item_order integer := 0;
  v_field_names text[];
  v_crop_types text[];
  v_crop_type text;
  v_total_acres numeric := 0;
  v_applicator_name text;
  v_vehicle_name text;
  v_field RECORD;
  v_billing RECORD;
  v_total_cost_cents bigint := 0;
  v_conversion RECORD;
  v_total_applied numeric;
  v_share RECORD;
  v_share_total bigint := 0;
  v_has_price_override boolean := false;
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-8 (G1 per-acre fee) locals
  v_fee jsonb;
  v_fee_total bigint := 0;
  v_fee_cost bigint := 0;
  v_fee_c bigint;
  v_cost_c bigint;
  v_fee_acres numeric := 0;
  -- U8 (#99 commissions on the application channel) locals
  v_commission_split jsonb;
  v_chem_profit_cents bigint := 0;
  -- U7 (#42/#100/#50 multi-owner group) locals
  v_n_owners integer := 0;
  v_group_id uuid;
  v_owner_ids uuid[];
  v_owner_names text[];
  v_owner_acres numeric[];
  v_owner_primary boolean[];
  v_total_billable_acres numeric := 0;
  v_acre_pcts numeric[];
  v_chem_price_split bigint[];
  v_chem_cost_split bigint[];
  v_oidx integer;
  v_member_id uuid;
  v_member_ids uuid[] := '{}';
  v_anchor_id uuid;
  v_member_acres numeric;
  v_member_total bigint;
  v_member_cost bigint;
  v_member_profit_cents bigint := 0;
  v_member_field_names text[];
BEGIN
  PERFORM set_config('crx.chicago_date_cutover', '20260905200400', true);
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  -- BEGIN DELTA-7 (G3 strict-actor): the role gate above is on auth.uid(), but
  -- p_performed_by was written verbatim to created_by / the activity log, so the
  -- recorded performer was forgeable. Bind the authenticated user and reject a
  -- mismatch (matches complete_job / start_job / save_field_app_invoice).
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  -- END DELTA-7

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transfer_job_to_invoice');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT j.* INTO v_job FROM jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found: %', p_job_id; END IF;
  IF v_job.status = 'invoiced' THEN RAISE EXCEPTION 'Job already invoiced'; END IF;
  IF v_job.status != 'completed' THEN RAISE EXCEPTION 'Job must be completed to invoice (status: %)', v_job.status; END IF;

  -- U6 #91b: refuse to invoice the job if a blend ticket for the SAME job has already
  -- been billed (payment_status='billed' = a live, non-voided invoice exists for it).
  -- The blend-ticket invoice and this job invoice bill the same application, so
  -- allowing both double-bills the customer. Block, do not warn. (The
  -- trg_sync_blend_ticket_payment trigger resets billed->unbilled when that invoice
  -- is voided, so a genuine re-bill after a void is unaffected.)
  -- Codex R3 P2: test for a LIVE blend-ticket invoice directly (mirror of the
  -- opposite guard's invoices.job_id test) — payment_status can be written
  -- manually via update_blend_ticket_billing_status and drift out of sync.
  IF EXISTS (
    SELECT 1 FROM blend_tickets bt
    JOIN invoices i ON i.blend_ticket_id = bt.id
    WHERE bt.job_id = p_job_id
      AND bt.deleted_at IS NULL  -- Codex R2 P2: a soft-deleted ticket must not block forever
      AND i.status NOT IN ('voided', 'cancelled')
      AND i.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ALREADY_BILLED: a blend ticket for this job has already been billed; invoicing the job too would double-bill the customer. Void that blend-ticket invoice first if you meant to re-bill here.';
  END IF;

  FOR v_field IN
    SELECT jf.field_id, jf.acres_to_treat, f.field_name, f.crop_type AS f_crop_type
    FROM job_fields jf JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = p_job_id ORDER BY f.field_name
  LOOP
    v_field_names := array_append(v_field_names, v_field.field_name);
    v_total_acres := v_total_acres + COALESCE(v_field.acres_to_treat, 0);
    IF v_field.f_crop_type IS NOT NULL THEN v_crop_types := array_append(v_crop_types, v_field.f_crop_type); END IF;
  END LOOP;

  IF v_crop_types IS NOT NULL AND array_length(v_crop_types, 1) > 0 THEN
    SELECT mode() WITHIN GROUP (ORDER BY unnest) INTO v_crop_type FROM unnest(v_crop_types);
  END IF;

  IF v_job.applicator_id IS NOT NULL THEN
    SELECT p.full_name INTO v_applicator_name FROM profiles p WHERE p.id = v_job.applicator_id;
  END IF;

  IF v_job.vehicle_id IS NOT NULL THEN
    SELECT v.vehicle_name INTO v_vehicle_name FROM vehicles v WHERE v.id = v_job.vehicle_id;
  END IF;

  -- ==========================================================================
  -- U7 (#42 / #100 / #50): MULTI-OWNER per-owner invoice GROUP.
  -- Trigger ONLY on EXPLICIT multi-owner billing: >1 distinct field_billing_defaults
  -- customer across the job's fields (the landlord/tenant setup the finding is about).
  -- A job with NO billing defaults keeps today's single-invoice behavior, even if its
  -- fields belong to different customers — no surprise change. In the group path, any
  -- field WITHOUT billing defaults falls back to the field's own customer at 100%
  -- (mirror of create_split_invoices_from_order).
  -- ==========================================================================
  SELECT count(DISTINCT fbd.customer_id) INTO v_n_owners
    FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id;

  IF COALESCE(v_n_owners, 0) > 1 THEN
    -- Scope guard: per-field $/acre overrides are not supported by the percentage/acre
    -- split. Refuse rather than silently drop an override the single-invoice path honors.
    IF EXISTS (
      SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      WHERE jf.job_id = p_job_id AND fbd.price_override_cents IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'SPLIT_OVERRIDE_UNSUPPORTED: this multi-owner job has per-field $/acre price overrides. Percentage split billing does not support overrides — bill it as a single invoice, or price each owner in the field-application editor.';
    END IF;

    -- Validate every billed field's splits total 100 (mirror FIELD_SPLIT_NOT_100), so the
    -- owner acre shares sum to the job acres and calculate_billing_splits stays penny-exact.
    IF EXISTS (
      SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      WHERE jf.job_id = p_job_id
      GROUP BY jf.field_id HAVING sum(fbd.split_pct) < 99.99 OR sum(fbd.split_pct) > 100.01
    ) THEN
      RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: one or more of this job''s fields has billing splits that do not total 100%%. Fix the field billing defaults before invoicing.';
    END IF;

    -- Ordered owner arrays (stable ORDER BY owner_id) with each owner's BILLABLE ACRES:
    -- fbd fields contribute acres_to_treat * split_pct/100; non-fbd fields contribute
    -- their full acres to the field's own customer.
    SELECT array_agg(owner_id ORDER BY owner_id),
           array_agg(farm_name ORDER BY owner_id),
           array_agg(billable_acres ORDER BY owner_id),
           array_agg(is_primary ORDER BY owner_id)
      INTO v_owner_ids, v_owner_names, v_owner_acres, v_owner_primary
    FROM (
      SELECT owner_id,
             sum(billable_acres) AS billable_acres,
             bool_or(is_primary) AS is_primary,
             max(farm_name) AS farm_name
      FROM (
        SELECT fbd.customer_id AS owner_id,
               COALESCE(jf.acres_to_treat, 0) * fbd.split_pct / 100.0 AS billable_acres,
               COALESCE(fbd.is_primary, false) AS is_primary, c.farm_name
          FROM job_fields jf
          JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
          JOIN customers c ON c.id = fbd.customer_id
          WHERE jf.job_id = p_job_id
        UNION ALL
        SELECT COALESCE(f.customer_id, v_job.customer_id) AS owner_id,
               COALESCE(jf.acres_to_treat, 0) AS billable_acres,
               false AS is_primary, c.farm_name
          FROM job_fields jf
          JOIN fields f ON f.id = jf.field_id
          JOIN customers c ON c.id = COALESCE(f.customer_id, v_job.customer_id)
          WHERE jf.job_id = p_job_id
            AND NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = jf.field_id)
      ) parts
      GROUP BY owner_id
    ) oa;

    v_total_billable_acres := COALESCE((SELECT sum(a) FROM unnest(v_owner_acres) a), 0);
    IF v_total_billable_acres <= 0 THEN
      RAISE EXCEPTION 'SPLIT_NO_ACRES: cannot split a multi-owner job with zero billable acres (job %)', v_job.job_number;
    END IF;

    -- Acre-share percentages across owners (sum to exactly 100 -> penny-exact splits).
    SELECT array_agg(a / v_total_billable_acres * 100 ORDER BY ord)
      INTO v_acre_pcts FROM unnest(v_owner_acres) WITH ORDINALITY AS u(a, ord);

    v_group_id := gen_random_uuid();

    -- Create one draft invoice per owner (empty; filled in the chemical/fee loops below).
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      v_member_acres := v_owner_acres[v_oidx];

      -- Fields this owner is billed for (informational header list).
      SELECT array_agg(DISTINCT fname ORDER BY fname) INTO v_member_field_names FROM (
        SELECT f.field_name AS fname
          FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
          JOIN fields f ON f.id = jf.field_id
          WHERE jf.job_id = p_job_id AND fbd.customer_id = v_owner_ids[v_oidx]
        UNION
        SELECT f.field_name AS fname
          FROM job_fields jf JOIN fields f ON f.id = jf.field_id
          WHERE jf.job_id = p_job_id AND f.customer_id = v_owner_ids[v_oidx]
            AND NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = jf.field_id)
      ) mf;

      v_invoice_number := next_invoice_number('field_application');
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents, paid_amount_cents, prepay_applied_cents,
        field_names, crop_type, total_acres, applicator_name, vehicle_name,
        application_date, header_notes, season, created_by, job_id,
        application_service_id, invoice_group_id
      ) VALUES (
        v_invoice_number, v_owner_ids[v_oidx], 'field_application', 'draft',
        (now() AT TIME ZONE 'America/Chicago')::date, NULL::date,  -- KI-14: the due-date trigger derives it from this owner's terms
        0, 0, 0, 0,
        COALESCE(v_member_field_names, v_field_names), v_crop_type, v_member_acres, v_applicator_name, v_vehicle_name,
        v_job.job_date, v_job.notes,
        COALESCE(
          v_job.season,
          CASE WHEN extract(month FROM (now() AT TIME ZONE 'America/Chicago')::date) >= 10
               THEN extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer + 1
               ELSE extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer END
        ),
        p_performed_by, p_job_id, v_job.application_service_id, v_group_id
      ) RETURNING id INTO v_member_id;
      v_member_ids := array_append(v_member_ids, v_member_id);
    END LOOP;

    -- Chemical lines: split each chemical's agreed price/cost across owners BY acre share
    -- (penny-exact). qty / applied-acres are prorated by the same share.
    v_item_order := 0;
    FOR v_chem IN
      SELECT jc.product_id, jc.rate_per_acre,
             safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost,
             safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price,
             jc.quantity,
             jc.customer_supplied,
             p.product_name, COALESCE(NULLIF(btrim(jc.unit), ''), p.unit_size) AS unit_size, p.epa_registration, p.product_form,
             COALESCE(NULLIF(btrim(jc.rate_unit), ''), NULLIF(btrim(jc.unit), ''), p.unit_size) AS rate_unit
      FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
      WHERE jc.job_id = p_job_id ORDER BY p.product_name
    LOOP
      v_item_order := v_item_order + 1;
      -- customer-supplied products carry $0 price AND $0 cost (we didn't buy them).
      v_chem_price_split := calculate_billing_splits(
        CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END, v_acre_pcts);
      v_chem_cost_split := calculate_billing_splits(
        CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END, v_acre_pcts);

      FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
        v_member_acres := v_owner_acres[v_oidx];
        -- Owner's applied amount = rate x their acres (their slice of the uniform-rate
        -- application). The line quantity stays 1 (a single job-chemical line, matching
        -- the single-owner path where unit_price == extended); the real applied amount
        -- lives in total_applied / total_applied_gl_lb.
        v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_member_acres > 0
          THEN v_chem.rate_per_acre * v_member_acres ELSE NULL END;
        SELECT * INTO v_conversion
          FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);

        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
          epa_registration, product_form, is_application_fee, price_source
        ) VALUES (
          v_member_ids[v_oidx], v_chem.product_id,
          CASE WHEN v_chem.customer_supplied THEN v_chem.product_name || ' (customer supplied)' ELSE v_chem.product_name END,
          1,
          v_chem.unit_size,
          v_chem_price_split[v_oidx],
          v_chem_price_split[v_oidx],
          v_chem_cost_split[v_oidx],
          v_item_order, v_member_acres,
          v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
          COALESCE(v_chem.rate_unit, v_chem.unit_size),
          v_conversion.converted_value, v_conversion.converted_unit,
          v_chem.epa_registration, v_chem.product_form, false,
          CASE WHEN v_chem.customer_supplied THEN 'manual' ELSE NULL END
        );
      END LOOP;
    END LOOP;

    -- Per-owner totals, per-acre application fee, header flip, and per-member commission.
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      v_member_id := v_member_ids[v_oidx];
      v_member_acres := v_owner_acres[v_oidx];

      SELECT COALESCE(SUM(extended_cents), 0), COALESCE(SUM(cost_cents), 0)
        INTO v_member_total, v_member_cost
        FROM invoice_items WHERE invoice_id = v_member_id;

      -- DELTA-8 per-acre machine fee at this owner's own rate, on this owner's acres.
      IF v_job.application_service_id IS NOT NULL AND v_member_acres > 0 THEN
        v_fee := compute_application_service_fee(
                   v_job.application_service_id, v_owner_ids[v_oidx], v_member_acres, v_job.season);
        v_fee_c  := COALESCE((v_fee->>'total_fee_cents')::bigint, 0);
        v_cost_c := COALESCE((v_fee->>'total_cost_cents')::bigint, 0);
        IF v_fee_c > 0 THEN
          v_item_order := v_item_order + 1;
          INSERT INTO invoice_items (
            invoice_id, description, quantity, unit_size, unit_price_cents, extended_cents,
            cost_cents, sort_order, acres, rate_per_acre, rate_unit,
            is_application_fee, price_source
          ) VALUES (
            v_member_id, COALESCE(v_fee->>'service_name', 'Application'), v_member_acres, 'acre',
            ROUND(v_fee_c / v_member_acres)::bigint, v_fee_c,
            v_cost_c, v_item_order, v_member_acres,
            ROUND(v_fee_c / v_member_acres)::bigint, 'acre',
            true, 'tier'
          );
          v_member_total := v_member_total + v_fee_c;
          v_member_cost  := v_member_cost + v_cost_c;
        END IF;
      END IF;

      UPDATE invoices SET total_amount_cents = v_member_total, total_cost_cents = v_member_cost
        WHERE id = v_member_id;

      -- one invoice_shares row (100% of this member -> itself) so statements/year-end read it.
      INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
      VALUES (v_member_id, v_owner_ids[v_oidx], v_owner_names[v_oidx], 100.0, v_member_acres, v_member_total,
              COALESCE(v_owner_primary[v_oidx], false), v_oidx);

      -- DELTA-4: draft -> unposted now that the member is fully built.
      UPDATE invoices SET status = 'unposted' WHERE id = v_member_id;
    END LOOP;

    -- Commission split resolution (mirror of the single-owner path: snapshot on the job,
    -- else the parent quote's split, else the customer default for pre-U8 jobs).
    v_commission_split := v_job.commission_split;
    IF v_commission_split IS NULL THEN
      IF v_job.quote_id IS NOT NULL THEN
        SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
      ELSE
        SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
      END IF;
    END IF;

    -- Anchor = the primary owner's member (else the first). jobs.invoice_id is a scalar,
    -- so it points at the anchor; siblings are found via invoices.invoice_group_id / job_id.
    -- v_member_ids[i] corresponds to v_owner_ids[i] / v_owner_primary[i] (same build order).
    v_anchor_id := v_member_ids[1];
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      IF COALESCE(v_owner_primary[v_oidx], false) THEN
        v_anchor_id := v_member_ids[v_oidx];
        EXIT;
      END IF;
    END LOOP;

    UPDATE jobs SET status = 'invoiced', invoice_id = v_anchor_id,
      commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
    WHERE id = p_job_id;
    UPDATE application_records SET invoice_id = v_anchor_id WHERE source_type = 'job' AND source_id = p_job_id;

    -- Per-member commission: on THAT member's chemical-line profit (product lines only,
    -- excludes the per-acre fee). Sum across members == the whole job's chemical profit.
    FOR v_oidx IN 1 .. array_length(v_member_ids, 1) LOOP
      v_member_id := v_member_ids[v_oidx];
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - COALESCE(ii.cost_cents, 0)), 0)
        INTO v_member_profit_cents
      FROM invoice_items ii
      WHERE ii.invoice_id = v_member_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      PERFORM _insert_commissions_for_job(
        p_job_id, v_member_id, v_owner_ids[v_oidx],
        v_member_profit_cents::numeric / 100.0,
        v_commission_split,
        (now() AT TIME ZONE 'America/Chicago')::date
      );

      -- Per-member creation audit row (mirror of the single path's invoice_created row).
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_user_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_member_id, auth.uid(),
        (SELECT role FROM profiles WHERE id = auth.uid()),
        jsonb_build_object(
          'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_member_id),
          'job_id', p_job_id,
          'customer_id', v_owner_ids[v_oidx],
          'invoice_group_id', v_group_id,
          'total_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_member_id)
        ),
        (SELECT total_amount_cents FROM invoices WHERE id = v_member_id),
        'Split invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_member_id) ||
          ' created from job ' || v_job.job_number || ' (per-owner group)'
      );
    END LOOP;

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('job_invoiced',
      'Job ' || v_job.job_number || ' transferred to a ' || array_length(v_member_ids, 1) ||
        '-owner split invoice group',
      COALESCE(p_performed_by, auth.uid()), 'job', p_job_id, v_job.customer_id);

    v_result := jsonb_build_object(
      'success', true, 'job_id', p_job_id,
      'invoice_id', v_anchor_id,
      'invoice_ids', to_jsonb(v_member_ids),
      'invoice_group_id', v_group_id,
      'invoice_count', array_length(v_member_ids, 1),
      'split', true
    );

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'transfer_job_to_invoice', v_result);
    END IF;

    RETURN v_result;
  END IF;
  -- ================= end multi-owner group path =================

  -- Fail-safe for legacy single-owner defaults that predate the deferred table guard.
  -- Match the multi-owner FIELD_SPLIT_NOT_100 validation before creating any invoice rows.
  IF EXISTS (
    SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id
    GROUP BY jf.field_id HAVING sum(fbd.split_pct) < 99.99 OR sum(fbd.split_pct) > 100.01
  ) THEN
    RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: one or more of this job''s fields has billing splits that do not total 100%%. Fix the field billing defaults before invoicing.';
  END IF;

  -- OVERNIGHT FIX (Run 2 cycle 6 — invoice-number canonicalization, Codex-confirmed MEDIUM):
  -- use the shared next_invoice_number() — the SAME invoice_number_seq, 'invoice_number:INV:<year>'
  -- advisory lock, and setval self-heal that every other invoice creator AND the
  -- invoices.invoice_number column default use. The previous inline
  -- `pg_advisory_xact_lock(hashtext('invoice_number'))` + MAX(regexp_replace(...))+1 scan took a
  -- DIFFERENT advisory-lock key, so it did not serialize against other INV creators (two callers
  -- could compute the same number -> 23505 on the UNIQUE index invoices_invoice_number_key,
  -- aborting the transfer) and it never advanced invoice_number_seq.
  v_invoice_number := next_invoice_number('field_application');

  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    total_amount_cents, total_cost_cents, paid_amount_cents, prepay_applied_cents,
    field_names, crop_type, total_acres, applicator_name, vehicle_name,
    application_date, header_notes, season, created_by, job_id,
    application_service_id
  ) VALUES (
    -- insert as 'draft' (DELTA-1) — trg_invoice_draft_insert rejects non-draft,
    -- non-credit_memo inserts; DELTA-4 flips to 'unposted' once fully built.
    v_invoice_number, v_job.customer_id, 'field_application', 'draft',
    (now() AT TIME ZONE 'America/Chicago')::date, NULL::date,  -- KI-14: the due-date trigger derives it from this owner's terms
    COALESCE(v_job.total_price_cents, 0), 0, 0, 0,
    v_field_names, v_crop_type, v_total_acres, v_applicator_name, v_vehicle_name,
    v_job.job_date, v_job.notes,
    -- N2-7 #109<<< stamp the JOB's season, not the season-of-now. An invoice cut in a
    -- later season for a prior-season job must file under the job's season (reports/
    -- year-end read invoices.season). invoices.season is NOT NULL and jobs.season is
    -- nullable, so COALESCE back to the ORIGINAL CURRENT_DATE-based expression when the
    -- job has no season — never stamp NULL, and legacy null-season jobs behave exactly
    -- as before this migration.
    COALESCE(
      v_job.season,
      CASE WHEN extract(month FROM (now() AT TIME ZONE 'America/Chicago')::date) >= 10
           THEN extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer + 1
           ELSE extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer END
    ),
    -- >>>N2-7 #109
    p_performed_by, p_job_id, v_job.application_service_id
  ) RETURNING id INTO v_invoice_id;

  FOR v_chem IN
    SELECT jc.product_id, jc.rate_per_acre,
           safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost,
           safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price,
           jc.customer_supplied,
           p.product_name, COALESCE(NULLIF(btrim(jc.unit), ''), p.unit_size) AS unit_size, p.epa_registration, p.product_form,
           COALESCE(NULLIF(btrim(jc.rate_unit), ''), NULLIF(btrim(jc.unit), ''), p.unit_size) AS rate_unit
    FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id ORDER BY p.product_name
  LOOP
    v_item_order := v_item_order + 1;
    -- U4<<< a grower-supplied product costs us nothing (we didn't buy it) — keep
    -- it OUT of the invoice cost so margin isn't understated. (#53/#54)
    v_total_cost_cents := v_total_cost_cents + CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END;
    -- >>>U4
    v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_total_acres > 0
      THEN v_chem.rate_per_acre * v_total_acres ELSE NULL END;
    -- DELTA-6: call convert_to_gl_lb unconditionally so v_conversion always receives a
    -- tuple structure (the helper returns one row even for NULL inputs); an unrated line
    -- yields (NULL, NULL) without leaving v_conversion unassigned.
    SELECT * INTO v_conversion
      FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);
    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
      cost_cents, sort_order, acres, rate_per_acre, rate_unit,
      total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
      epa_registration, product_form, is_application_fee, price_source
    ) VALUES (
      v_invoice_id, v_chem.product_id,
      -- U4<<< customer-supplied: keep the line (legal/application record) but at $0
      -- with a labeled description; force cost + price to 0. price_source='manual'
      -- pins the $0 (Codex R5 P1: a product-backed $0 line without it would be
      -- re-priced by tier when the unposted invoice is edited + re-saved). (#53/#54)
      CASE WHEN v_chem.customer_supplied THEN v_chem.product_name || ' (customer supplied)' ELSE v_chem.product_name END,
      1,
      v_chem.unit_size,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END,
      -- >>>U4
      v_item_order, v_total_acres,
      v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
      COALESCE(v_chem.rate_unit, v_chem.unit_size),
      v_conversion.converted_value, v_conversion.converted_unit,
      v_chem.epa_registration, v_chem.product_form, false,
      CASE WHEN v_chem.customer_supplied THEN 'manual' ELSE NULL END
    );
  END LOOP;

  UPDATE invoices SET total_cost_cents = v_total_cost_cents WHERE id = v_invoice_id;

  IF EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id) THEN
    SELECT EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id AND fbd.price_override_cents IS NOT NULL) INTO v_has_price_override;
    FOR v_share IN
      SELECT fbd.customer_id, c.farm_name,
        CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
          THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
          ELSE avg(fbd.split_pct) END AS avg_split_pct,
        sum(COALESCE(jf.acres_to_treat, 0)) *
          CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
            THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
            ELSE avg(fbd.split_pct) END / 100.0 AS share_acres,
        bool_or(fbd.is_primary) AS is_primary,
        CASE WHEN count(DISTINCT fbd.price_override_cents) = 1 AND min(fbd.price_override_cents) IS NOT NULL
          THEN min(fbd.price_override_cents) ELSE NULL END AS price_override_cents,
        max(fbd.pricing_note) AS pricing_note,
        row_number() OVER (ORDER BY bool_or(fbd.is_primary) DESC, c.farm_name) AS sort_ord
      FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      JOIN customers c ON c.id = fbd.customer_id WHERE jf.job_id = p_job_id
      GROUP BY fbd.customer_id, c.farm_name
    LOOP
      DECLARE v_amount bigint; v_ppa bigint;
      BEGIN
        IF v_share.price_override_cents IS NOT NULL THEN
          v_amount := safe_cents_qty(v_share.price_override_cents, v_share.share_acres);
          v_ppa := v_share.price_override_cents;
        ELSE
          v_amount := ROUND(COALESCE(v_job.total_price_cents, 0) * v_share.avg_split_pct / 100.0)::bigint;
          v_ppa := NULL;
        END IF;
        INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order, price_per_acre_cents, pricing_note)
        VALUES (v_invoice_id, v_share.customer_id, v_share.farm_name, v_share.avg_split_pct, v_share.share_acres, v_amount, v_share.is_primary, v_share.sort_ord, v_ppa, v_share.pricing_note);
        v_share_total := v_share_total + v_amount;
      END;
    END LOOP;
    -- OVERNIGHT FIX (Run 2 cycle 2, finding #3 — penny-drift): reconcile the header to the share
    -- sum for BOTH the override AND the percentage-split path (was override-only). Independent
    -- per-customer ROUND(total_price_cents * pct/100) can drift ±1c on odd-cent splits, so without
    -- this the percentage-split header stayed at total_price_cents while invoice_shares summed a cent
    -- off — and get_customer_year_end_summary / get_detailed_statement_data read invoice_shares.amount_cents,
    -- so statements wouldn't tie. v_share_total is the exact sum of the shares; DELTA-8 then adds the
    -- per-acre fee to both shares and header, preserving the tie. The single-customer ELSE branch
    -- already inserts header = its one share, so it ties without this.
    UPDATE invoices SET total_amount_cents = v_share_total WHERE id = v_invoice_id;
  ELSE
    INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
    SELECT v_invoice_id, v_job.customer_id, c.farm_name, 100.0, v_total_acres, COALESCE(v_job.total_price_cents, 0), true, 1
    FROM customers c WHERE c.id = v_job.customer_id;
  END IF;

  -- DELTA-8 (G1 per-acre application fee, PER-CUSTOMER rate): now that invoice_shares exist,
  -- charge each billed customer the per-acre machine fee at that customer's own rate; add each
  -- customer's fee to their share, emit one is_application_fee line, fold into the header.
  IF v_job.application_service_id IS NOT NULL AND v_total_acres > 0 THEN
    FOR v_share IN
      SELECT id, customer_id, COALESCE(acres, 0) AS acres, price_per_acre_cents
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    LOOP
      -- A grower on a price_override (all-inclusive $/acre) does NOT also pay the per-acre
      -- machine fee, or they'd be double-charged (mirrors save_field_app_invoice).
      IF v_share.price_per_acre_cents IS NOT NULL THEN CONTINUE; END IF;
      v_fee := compute_application_service_fee(
                 v_job.application_service_id, v_share.customer_id, v_share.acres, v_job.season);
      v_fee_c  := COALESCE((v_fee->>'total_fee_cents')::bigint, 0);
      v_cost_c := COALESCE((v_fee->>'total_cost_cents')::bigint, 0);
      v_fee_total := v_fee_total + v_fee_c;
      v_fee_cost  := v_fee_cost  + v_cost_c;
      v_fee_acres := v_fee_acres + v_share.acres;
      IF v_fee_c <> 0 THEN
        UPDATE invoice_shares SET amount_cents = amount_cents + v_fee_c WHERE id = v_share.id;
      END IF;
    END LOOP;

    IF v_fee_total > 0 AND v_fee_acres > 0 THEN
      v_item_order := v_item_order + 1;
      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id, COALESCE(v_fee->>'service_name', 'Application'), v_fee_acres, 'acre',
        ROUND(v_fee_total / v_fee_acres)::bigint, v_fee_total,
        v_fee_cost, v_item_order, v_fee_acres,
        ROUND(v_fee_total / v_fee_acres)::bigint, 'acre',
        true, 'tier'
      );
      UPDATE invoices SET
        total_amount_cents = COALESCE(total_amount_cents, 0) + v_fee_total,
        total_cost_cents   = total_cost_cents + v_fee_cost
      WHERE id = v_invoice_id;
    END IF;
  END IF;
  -- END DELTA-8

  -- U8<<< (#99): resolve the commission split. New jobs carry a creation-time
  -- snapshot (quote-born: the quote's split via create_job_from_quote_section;
  -- direct: the customer default via trg_jobs_snapshot_commission_split), so this
  -- fallback only fires for PRE-U8 jobs. Order-channel parity (Codex R3 P1): a
  -- quote-born job uses the parent quote's split and ONLY that — convert_quote_to_order
  -- passes only v_quote.commission_split, so a NULL quote split pays no commission,
  -- never the customer default. A pre-U8 direct job uses the customer default, like
  -- a direct order. Codex R2 P2: the resolved fallback is PERSISTED onto the job in
  -- the same UPDATE that flips it to 'invoiced', so attribution locks at first use.
  v_commission_split := v_job.commission_split;
  IF v_commission_split IS NULL THEN
    IF v_job.quote_id IS NOT NULL THEN
      SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
    ELSE
      SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
    END IF;
  END IF;
  -- >>>U8

  UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_id,
    -- U8 (Codex R2 P2 + R4 P1): persist the resolution — even a nothing-anywhere
    -- result locks as the empty sentinel so re-invoices never re-read live sources.
    commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
  WHERE id = p_job_id;
  UPDATE application_records SET invoice_id = v_invoice_id WHERE source_type = 'job' AND source_id = p_job_id;

  -- DELTA-4: invoice was inserted as 'draft'; flip to 'unposted' now that items, shares and
  -- totals are final. draft -> unposted is allowed by _enforce_invoice_status_transition.
  UPDATE invoices SET status = 'unposted' WHERE id = v_invoice_id;

  -- U8<<< (#99): mint the application-channel commissions — chemical-line profit only.
  -- Mirror of the order channel (convert_quote_to_order → _insert_commissions_for_order).
  -- Profit basis: the chemical lines just written to THIS invoice. The per-acre machine
  -- fee (is_application_fee=true, product_id NULL) is excluded per the owner rule, and
  -- customer-supplied lines carry $0 price AND $0 cost so they contribute exactly 0.
  -- invoice_items money is bigint CENTS; commissions are numeric DOLLARS → /100.0.
  -- The helper no-ops on a NULL/splits-less split and validates a present one
  -- (COMMISSION_SPLIT_INVALID aborts, matching the order-conversion behavior).
  -- Pending amounts stay in sync with later unposted-invoice edits via the
  -- recompute in the item-rewrite path (Codex R2 P1), mirroring update_order_items.
  SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - COALESCE(ii.cost_cents, 0)), 0)
    INTO v_chem_profit_cents
  FROM invoice_items ii
  WHERE ii.invoice_id = v_invoice_id
    AND COALESCE(ii.is_application_fee, false) = false
    AND ii.product_id IS NOT NULL;

  PERFORM _insert_commissions_for_job(
    p_job_id, v_invoice_id, v_job.customer_id,
    v_chem_profit_cents::numeric / 100.0,
    v_commission_split,
    (now() AT TIME ZONE 'America/Chicago')::date
  );
  -- >>>U8

  -- DELTA-5: log to activity_feed (performed_by NOT NULL: COALESCE to auth.uid()).
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('job_invoiced',
    'Job ' || v_job.job_number || ' transferred to invoice ' || v_invoice_number,
    COALESCE(p_performed_by, auth.uid()), 'job', p_job_id, v_job.customer_id);

  -- OVERNIGHT FIX (finding #3): write the canonical 'invoice_created' financial_audit_log row
  -- the other six invoice creators write, so the append-only money ledger records creation
  -- provenance for job-built invoices too. Read the FINAL header total back (DELTA-8 may have
  -- adjusted it). Shape mirrors save_field_app_invoice's invoice_created row.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id, auth.uid(),
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'job_id', p_job_id,
      'customer_id', v_job.customer_id,
      'total_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_invoice_id)
    ),
    (SELECT total_amount_cents FROM invoices WHERE id = v_invoice_id),
    'Invoice ' || v_invoice_number || ' created from job ' || v_job.job_number
  );

  v_result := jsonb_build_object('success', true, 'job_id', p_job_id, 'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transfer_job_to_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(uuid, uuid, text)
  TO postgres;

CREATE OR REPLACE FUNCTION public._enforce_below_cost_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_operation text := current_setting('app.crx_below_cost_operation', true);
  v_reason text := NULLIF(btrim(current_setting('app.crx_below_cost_reason', true)), '');
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_product_name text;
  v_cost numeric;
  v_cost_cents bigint;
  v_price_cents bigint;
  v_quantity numeric;
  v_entity_type text;
  v_entity_id uuid;
  v_line_id uuid;
  v_product_id uuid;
  v_is_application_fee boolean;
  v_detail jsonb;
  v_grower_share boolean := false;
BEGIN
  -- KI-156 (Mason, 2026-11-15: "Admins and reps"): _save_field_app_invoice_impl_20260714 declares
  -- 'field_app_grower_share' around its $0 "included in grower share" line only. That line is not a
  -- below-cost sale; it is judged at the refusal below. For every other check this context counts as none.
  IF v_operation = 'field_app_grower_share' THEN
    v_grower_share := TG_TABLE_NAME = 'invoice_items' AND TG_OP = 'INSERT';
    v_operation := NULL;
  END IF;

  IF TG_TABLE_NAME = 'order_items' THEN
    -- Delivery completion and cancellation update fulfillment counters on an
    -- already-approved sale. They do not make a new pricing decision. Let
    -- context-free bookkeeping (and exposure-reducing quantity corrections)
    -- proceed, while a product/price change or quantity increase still reaches
    -- the fail-closed approval wall below.
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') = ''
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.price_per_unit IS NOT DISTINCT FROM OLD.price_per_unit
       AND COALESCE(NEW.total_units_needed, 0)
           <= COALESCE(OLD.total_units_needed, 0) THEN
      RETURN NEW;
    END IF;
    -- Rush orders intentionally carry zero prices until price_order. They are
    -- not sales decisions yet, so defer the wall to the pricing RPC.
    IF NEW.pricing_pending = true AND NEW.price_per_unit = 0 THEN
      RETURN NEW;
    END IF;
    IF NEW.price_per_unit IS NULL
       OR NEW.price_per_unit::text IN ('NaN', 'Infinity', '-Infinity')
       OR NEW.price_per_unit <> round(NEW.price_per_unit, 2) THEN
      RAISE EXCEPTION 'INVALID_UNIT_PRICE_CENTS';
    END IF;
    v_entity_type := 'order';
    v_entity_id := NEW.order_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    v_price_cents := round(NEW.price_per_unit * 100)::bigint;
    v_quantity := NEW.total_units_needed;
  ELSIF TG_TABLE_NAME = 'invoice_items' THEN
    -- complete_delivery can materialize an invoice line from an already-made
    -- order pricing decision. Permit only an exact, exposure-bounded descendant
    -- of that governed order line; a caller cannot use this hatch to substitute
    -- another Product, price, cost snapshot, or larger quantity. Browser roles
    -- also have no direct INSERT privilege on invoice_items.
    -- save_invoice rebuilds a draft's lines; an order-linked line it writes back
    -- unchanged is the same descendant and is judged the same way (#13), not
    -- against today's product cost. A draft line repriced above its order price
    -- (checked against cost when it was repriced) keeps that higher price: it
    -- is less exposed below cost than the order decision it descends from.
    IF TG_OP = 'INSERT'
       AND COALESCE(v_operation, '') IN ('', 'save_invoice')
       AND NEW.order_item_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM public.order_items oi
         WHERE oi.id = NEW.order_item_id
           AND oi.product_id IS NOT DISTINCT FROM NEW.product_id
           AND (round(oi.price_per_unit * 100)::bigint = NEW.unit_price_cents
                OR (COALESCE(v_operation, '') = 'save_invoice'
                    AND NEW.unit_price_cents > round(oi.price_per_unit * 100)::bigint))
           AND round(COALESCE(oi.cost_per_unit, 0) * 100)::bigint = NEW.cost_cents
           AND COALESCE(NEW.quantity, 0) >= 0
           AND COALESCE(NEW.quantity, 0) <= COALESCE(oi.total_units_needed, 0)
       ) THEN
      RETURN NEW;
    END IF;
    -- Partial delivery can reduce a draft invoice line and tote-copy updates
    -- bookkeeping only. Neither increases the approved below-cost exposure.
    -- save_invoice restores a rebuilt line's identity the same way (#13).
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') IN ('', 'save_invoice')
       AND NEW.product_id IS NOT NULL
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id
       AND NEW.unit_price_cents IS NOT DISTINCT FROM OLD.unit_price_cents
       AND NEW.cost_cents IS NOT DISTINCT FROM OLD.cost_cents
       AND COALESCE(NEW.is_application_fee, false)
           IS NOT DISTINCT FROM COALESCE(OLD.is_application_fee, false)
       AND COALESCE(NEW.quantity, 0) <= COALESCE(OLD.quantity, 0) THEN
      RETURN NEW;
    END IF;
    v_is_application_fee := COALESCE(NEW.is_application_fee, false);
    IF v_is_application_fee AND NEW.product_id IS NOT NULL THEN
      RAISE EXCEPTION 'APPLICATION_FEE_PRODUCT_INVALID';
    END IF;
    v_entity_type := 'invoice';
    v_entity_id := NEW.invoice_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    IF v_product_id IS NULL THEN
      -- A non-product line has no catalog row to lock, but save_invoice lets a
      -- caller supply cost_cents. Zero-cost fees/miscellaneous charges are not
      -- below cost. Positive-cost lines compare their total stored revenue to
      -- total stored cost and use quantity=1 in the approval audit so neither
      -- an application fee nor a null-product misc line can bypass the wall.
      IF COALESCE(NEW.cost_cents, 0) < 0 THEN
        RAISE EXCEPTION 'INVALID_COST';
      END IF;
      IF NEW.quantity IS NULL
         OR NEW.quantity::text IN ('NaN', 'Infinity', '-Infinity')
         OR NEW.quantity <= 0 THEN
        RAISE EXCEPTION 'INVALID_QUANTITY';
      END IF;
      IF COALESCE(NEW.cost_cents, 0) = 0 THEN
        RETURN NEW;
      END IF;
      v_product_name := COALESCE(
        NULLIF(btrim(NEW.description), ''),
        CASE WHEN v_is_application_fee
          THEN 'Application fee'
          ELSE 'Non-product invoice line'
        END
      );
      v_price_cents := COALESCE(
        NEW.extended_cents,
        round(COALESCE(NEW.unit_price_cents, 0) * COALESCE(NEW.quantity, 0))::bigint
      );
      v_cost_cents := CASE
        WHEN v_is_application_fee THEN NEW.cost_cents
        ELSE round(NEW.cost_cents * COALESCE(NEW.quantity, 0))::bigint
      END;
      v_quantity := 1;
    ELSE
      v_price_cents := NEW.unit_price_cents;
      v_quantity := NEW.quantity;
    END IF;
  ELSIF TG_TABLE_NAME = 'quote_items' THEN
    -- save_quote first inserts the client shape and then, in the same
    -- transaction, recomputes every line from the locked Product row. App
    -- roles cannot insert quote_items directly. Defer this private transient
    -- INSERT so the authoritative UPDATE below is the single enforcement and
    -- approval-audit point; any failure there rolls the entire save back.
    IF TG_OP = 'INSERT' AND v_operation = 'save_quote' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') = ''
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.price_per_unit IS NOT DISTINCT FROM OLD.price_per_unit
       AND COALESCE(NEW.total_units_needed, 0)
           <= COALESCE(OLD.total_units_needed, 0) THEN
      RETURN NEW;
    END IF;
    IF NEW.price_per_unit IS NULL
       OR NEW.price_per_unit::text IN ('NaN', 'Infinity', '-Infinity')
       OR NEW.price_per_unit <> round(NEW.price_per_unit, 2) THEN
      RAISE EXCEPTION 'INVALID_UNIT_PRICE_CENTS';
    END IF;
    v_entity_type := 'quote';
    v_entity_id := NEW.quote_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    v_price_cents := round(NEW.price_per_unit * 100)::bigint;
    v_quantity := COALESCE(NEW.total_units_needed, 0);
  ELSE
    RAISE EXCEPTION 'BELOW_COST_TRIGGER_TABLE_INVALID';
  END IF;

  IF v_price_cents < 0 THEN RAISE EXCEPTION 'INVALID_PRICE'; END IF;

  IF v_product_id IS NOT NULL THEN
    -- FOR SHARE prevents products.current_cost from changing between the check
    -- and the line write, while allowing unrelated product rows to proceed.
    SELECT p.product_name, p.current_cost
      INTO v_product_name, v_cost
    FROM public.products p
    WHERE p.id = v_product_id
    FOR SHARE;

    IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;
    IF v_cost IS NULL
       OR v_cost::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_cost <= 0 THEN
      RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_product_id;
    END IF;
    IF v_cost <> round(v_cost, 2) THEN
      RAISE EXCEPTION 'COST_BASIS_CENTS_REQUIRED:%', v_product_id;
    END IF;

    v_cost_cents := round(v_cost * 100)::bigint;
  END IF;

  -- update_order_items previously trusted p_items.cost_per_unit, and
  -- price_order previously reused an older snapshot. Both must write the same
  -- locked current cost used by this guard, including every dependent amount.
  IF TG_TABLE_NAME = 'order_items'
     AND v_operation IN (
       'create_direct_order', 'bulk_import_order',
       'update_order_items', 'price_order'
     ) THEN
    NEW.cost_per_unit := v_cost_cents::numeric / 100;
    NEW.cost_at_time_cents := v_cost_cents;
    -- This trigger sorts after trg_order_items_round_money, so it must preserve
    -- that canonical whole-cent invariant after replacing caller/stale cost.
    NEW.total_price := round(NEW.price_per_unit * NEW.total_units_needed, 2);
    NEW.profit := NEW.total_price
                  - round(NEW.cost_per_unit * NEW.total_units_needed, 2);
    NEW.net_margin := CASE
      WHEN NEW.price_per_unit > 0
        THEN round(((NEW.price_per_unit - NEW.cost_per_unit) / NEW.price_per_unit) * 100, 2)
      ELSE 0
    END;
  END IF;

  IF v_price_cents >= v_cost_cents THEN
    RETURN NEW;
  END IF;

  -- KI-156: the declared $0 grower-share line (no price, no amount, not a fee, not from an order) saves for an
  -- active admin or sales rep. Nested so NEW's invoice columns are read only on an invoice_items row.
  IF v_grower_share THEN
    IF NEW.unit_price_cents = 0
       AND COALESCE(NEW.extended_cents, 0) = 0
       AND NOT COALESCE(NEW.is_application_fee, false)
       AND NEW.order_item_id IS NULL
       AND (public.is_admin() OR public.is_sales_rep()) THEN
      -- #1990 Sol (Mason, 2026-11-20: "Reps if price covers cost"): a sales rep's grower-share chemicals must be
      -- paid for by the per-acre price. The save writes this invoice's per-acre lines (no product, acres set, not a
      -- fee) before any $0 line, so these sums are the whole invoice's by its last $0 line. Earlier $0 lines are
      -- counted from their approval rows whose line still exists (a re-save deletes the old lines). An admin may
      -- save it uncovered, as before. The message never states a cost (cost is admin-only, 2026-10-15).
      -- Mason, 2026-11-21 (#2068 Sol round 3, chose "Add a cushion"): each $0 line's cost is counted as it is
      -- booked (rounded per line, as the invoice records it) plus 51 cents. The save already refuses a line whose
      -- booked cost differs from its exact cost by more than 50 cents (20270129171000), so the per-acre total then
      -- covers the chemicals' exact cost however the lines are split or rounded.
      IF NOT public.is_admin()
         AND (SELECT COALESCE(sum(a.total_shortfall_cents + 51), 0)
                FROM public.below_cost_approvals a
               WHERE a.operation = 'field_app_grower_share'
                 AND a.entity_type = 'invoice'
                 AND a.entity_id = NEW.invoice_id
                 AND EXISTS (SELECT 1 FROM public.invoice_items ii
                              WHERE ii.id = a.line_id AND ii.invoice_id = NEW.invoice_id))
             + round((v_cost_cents - v_price_cents) * v_quantity)::bigint + 51
           > (SELECT COALESCE(sum(ii.extended_cents), 0)
                FROM public.invoice_items ii
               WHERE ii.invoice_id = NEW.invoice_id
                 AND ii.product_id IS NULL
                 AND ii.acres IS NOT NULL
                 AND NOT COALESCE(ii.is_application_fee, false)
                 AND ii.order_item_id IS NULL) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'FIELD_APP_GROWER_SHARE_BELOW_COST: the grower''s per-acre price on this invoice does not cover the cost of the chemicals included in it, with a small allowance for rounding. Raise the per-acre price, bill the chemicals on their own lines, or ask an admin to save this invoice.';
      END IF;
      -- Mason, 2026-11-16 ("Yes, record it"): log who approved this $0 line, in this transaction.
      INSERT INTO public.below_cost_approvals (
        operation, entity_type, entity_id, line_id, product_id, actor_user_id,
        reason, unit_price_cents, locked_unit_cost_cents, quantity,
        total_shortfall_cents
      ) VALUES (
        'field_app_grower_share', v_entity_type, v_entity_id, v_line_id, v_product_id, v_actor,
        'Included in the grower''s per-acre price', v_price_cents, v_cost_cents, v_quantity,
        round((v_cost_cents - v_price_cents) * v_quantity)::bigint
      );
      RETURN NEW;
    END IF;
  END IF;

  -- Cost is admin-only (Mason, 2026-10-15). Look the caller up BEFORE the
  -- refusal detail is built: the detail travels back to the browser in the
  -- error message, so it may carry the locked cost only for an active admin.
  -- Without this, a sales rep could type a one-cent price and read the exact
  -- product cost out of BELOW_COST_ADMIN_REQUIRED.
  SELECT p.role INTO v_actor_role
  FROM public.profiles p
  WHERE p.id = v_actor
    AND p.is_active = true;

  v_detail := jsonb_build_object(
    'operation', v_operation,
    'entity_type', v_entity_type,
    'entity_id', v_entity_id,
    'line_id', v_line_id,
    'product_id', v_product_id,
    'product_name', v_product_name,
    'unit_price_cents', v_price_cents,
    'locked_unit_cost_cents', v_cost_cents
  );
  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    v_detail := v_detail - 'locked_unit_cost_cents';
  END IF;

  -- There are many owner-run RPCs and triggers that can write these shared line
  -- tables. A missing context may proceed above cost, but it can never create a
  -- below-cost sale. Known customer-facing paths declare context through thin
  -- wrappers below; any missed future path fails closed here automatically.
  IF v_operation IS NULL OR v_operation = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_CONTEXT_REQUIRED:' || v_detail::text;
  END IF;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_ADMIN_REQUIRED:' || v_detail::text;
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_REASON_REQUIRED:' || v_detail::text;
  END IF;

  INSERT INTO public.below_cost_approvals (
    operation, entity_type, entity_id, line_id, product_id, actor_user_id,
    reason, unit_price_cents, locked_unit_cost_cents, quantity,
    total_shortfall_cents
  ) VALUES (
    v_operation, v_entity_type, v_entity_id, v_line_id, v_product_id, v_actor,
    left(v_reason, 1000), v_price_cents, v_cost_cents, v_quantity,
    round((v_cost_cents - v_price_cents) * v_quantity)::bigint
  );

  RETURN NEW;
END;
$function$;

DROP FUNCTION public._job_transfer_line_clears_cost_20270207(uuid, text, numeric, text, bigint, boolean);

-- The old bodies are back and the helper is gone.
DO $rev$
BEGIN
  IF to_regprocedure('public._job_transfer_line_clears_cost_20270207(uuid, text, numeric, text, bigint, boolean)') IS NOT NULL
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid, uuid, text)'::regprocedure) IS DISTINCT FROM 'a54e3e6a3a2b920e9bcd1a350cd92423'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = 'public._enforce_below_cost_line()'::regprocedure) IS DISTINCT FROM '5fa0a5f975dc2a84b3c6599a84b8cc55' THEN
    RAISE EXCEPTION 'JOB_TRANSFER_BELOW_COST_ROLLBACK_POSTFLIGHT: the old bodies were not restored';
  END IF;
END $rev$;
COMMIT;
