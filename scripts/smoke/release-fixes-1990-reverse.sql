-- REVERSE of 20270129160000_release_fixes_1990 (apply as its own reviewed migration, one transaction).
-- Restores the five previous bodies byte-identical and service_role EXECUTE on _save_field_app_split_invoice_impl.
-- Proven by scripts/smoke/prove-release-fixes-1990-real-schema.mjs.
SET LOCAL lock_timeout = '5s';

DO $reverse_preflight$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(s.sig, ', ') INTO v_bad
    FROM (VALUES
      ('public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)', '6cbd5936bdb6af9eed48dedcfa2cebc6'),
      ('public._preview_field_app_invoice_split_impl_20260908(jsonb,jsonb,uuid,uuid,date)', '493f1256b3699729ccbfd5bfe67d9707'),
      ('public._refuse_stock_unit_change_with_history()', '20f02f8606621be4bc042d7787c34cdb'),
      ('public.get_purchasing_plan(integer)', 'e196689d988d1da81ff9e2c3e9208762'),
      ('public.auto_expire_quotes(text)', '1f9f7ffad3513fdc8280a1e714bcc3a3')) AS s(sig, md5)
   WHERE (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure(s.sig)) IS DISTINCT FROM s.md5;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RELEASE_FIXES_REVERSE_PREFLIGHT: not the 20270129160000 body: %', v_bad;
  END IF;
END;
$reverse_preflight$;

CREATE OR REPLACE FUNCTION public._save_field_app_invoice_impl_20260714(p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid := auth.uid();
  v_existing            jsonb;
  v_existing_group_id   uuid;
  v_existing_status     text;
  v_locked_count        int;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_total_applied_acres numeric := 0;
  v_this_applied        numeric;
  v_loc                 jsonb;
  v_chem                jsonb;
  v_shares              jsonb;
  v_customers           jsonb;
  v_customer            jsonb;
  v_customer_id         uuid;
  v_customer_name       text;
  v_customer_tier       int;
  v_is_primary          boolean;
  v_has_override        boolean;
  v_invoice_id          uuid;
  v_invoice_number      text;
  v_invoice_group_id    uuid;
  v_invoice_ids         uuid[] := '{}';
  v_app_service         record;
  v_fee_rate            bigint;
  v_loc_id              uuid;
  v_share_row           jsonb;
  v_share_pct           numeric;
  v_share_acres         numeric;
  v_field_id            uuid;
  v_field_applied_acres numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quote_price_date    date;
  v_quoted_price        bigint;
  v_price_source        text;
  v_extended            bigint;
  v_invoice_total       bigint;
  v_invoice_cost        bigint;
  v_total_share_acres   numeric;
  v_grower_share_amount bigint;
  v_fee_acres           numeric;
  v_fee_extended        bigint;
  v_fee_cost            bigint;
  v_result              jsonb;
  v_customer_count      int;
  v_orphan              record;
  v_req_salesman        uuid;
  v_salesman_id         uuid;
  v_skipped_customer_ids uuid[] := '{}';
  v_is_new_invoice      boolean;
  v_surcharge_acres     numeric;
  v_surcharge_cents     bigint;
  v_season              integer;
  v_invoice_season      integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save field application invoices';
  END IF;

  v_req_salesman := (p_invoice->>'salesman_id')::uuid;
  IF is_admin() THEN
    v_salesman_id := v_req_salesman;
  ELSE
    IF v_req_salesman IS NOT NULL AND v_req_salesman IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Not authorized: cannot attribute this invoice to another user (salesman_id)';
    END IF;
    v_salesman_id := v_actor;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'save_field_app_invoice';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT status, invoice_group_id INTO v_existing_status, v_existing_group_id
      FROM invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
    -- KI-156 follow-up: only field-application invoices are rebuilt here (the invoice and every live member of its
    -- group, whose lines are deleted below); any other draft keeps its own lines.
    IF EXISTS (SELECT 1 FROM invoices
                WHERE (id = p_invoice_id
                       OR (v_existing_group_id IS NOT NULL AND invoice_group_id = v_existing_group_id AND deleted_at IS NULL))
                  AND invoice_type IS DISTINCT FROM 'field_application') THEN
      RAISE EXCEPTION 'FIELD_APP_INVOICE_REQUIRED: invoice % is not a field application invoice', p_invoice_id;
    END IF;
    SELECT COUNT(*) INTO v_locked_count
      FROM invoices
     WHERE (id = p_invoice_id OR invoice_group_id = v_existing_group_id)
       AND v_existing_group_id IS NOT NULL
       AND deleted_at IS NULL
       AND status NOT IN ('draft', 'unposted');
    IF v_locked_count > 0 OR v_existing_status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot edit field app invoice — % invoice(s) in this group are posted/voided. Use void/reissue.', GREATEST(v_locked_count, 1);
    END IF;

    IF v_existing_group_id IS NOT NULL THEN
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_group_id = v_existing_group_id
      );
      DELETE FROM field_app_locations WHERE invoice_group_id = v_existing_group_id;
      DELETE FROM invoice_items   WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL);
      DELETE FROM invoice_shares  WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL);
    ELSE
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_id = p_invoice_id
      );
      DELETE FROM field_app_locations WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_items  WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_shares WHERE invoice_id = p_invoice_id;
    END IF;
  END IF;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_this_applied := (v_loc->>'applied_acres')::numeric;
    IF v_this_applied IS NULL OR v_this_applied <= 0 THEN
      RAISE EXCEPTION 'ZERO_APPLIED_ACRES: applied acres must be greater than 0 for field % (enter applied acres, or remove the field)', v_loc->>'field_id';
    END IF;
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_total_applied_acres := v_total_applied_acres + v_this_applied;
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(v_loc->>'field_id', v_this_applied);
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one field is required';
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from selected fields';
  END IF;

  IF v_existing_group_id IS NOT NULL THEN
    FOR v_orphan IN
      SELECT id, invoice_number, customer_id
        FROM invoices
       WHERE invoice_group_id = v_existing_group_id
         AND deleted_at IS NULL
         AND customer_id NOT IN (
           SELECT (c->>'customer_id')::uuid FROM jsonb_array_elements(v_customers) c
         )
    LOOP
      UPDATE invoices SET
        status              = 'cancelled',
        invoice_group_id    = NULL,
        total_amount_cents  = 0,
        total_cost_cents    = 0,
        updated_at          = now()
      WHERE id = v_orphan.id;

      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'invoice_orphan_cancelled',
        'Field app invoice ' || v_orphan.invoice_number ||
          ' cancelled — customer removed from group during edit',
        p_performed_by, 'invoice', v_orphan.id, v_orphan.customer_id
      );
    END LOOP;
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
  END IF;

  IF v_customer_count > 1 THEN
    v_invoice_group_id := COALESCE(v_existing_group_id, gen_random_uuid());
  ELSE
    v_invoice_group_id := NULL;
  END IF;

  -- Season stamped on a NEW invoice, derived from the same date that invoice is stamped with
  -- (2026-09-04). This previously read the current-season helper, which is compute_season of
  -- the UTC current-date built-in -- an INDEPENDENT clock read of the UTC calendar day. From
  -- 7 pm America/Chicago on 2026-09-30 that helper returns 2027 while invoice_date is stamped
  -- 2026-09-30 (season 2026), and season drives customer_application_rates lookups and
  -- year-end statements. Deriving it from the invoice date also files a backdated invoice under
  -- THAT season, which is the rule _save_field_app_split_invoice_impl already follows
  -- (Codex round-3 P1). p_invoice is loop-invariant, so this is computed once.
  v_season := compute_season(COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date));

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id   := (v_customer->>'customer_id')::uuid;
    v_customer_name := v_customer->>'customer_name';
    v_customer_tier := COALESCE((v_customer->>'tier')::int, 1);
    v_is_primary    := COALESCE((v_customer->>'is_primary')::boolean, false);
    v_has_override  := COALESCE((v_customer->>'has_override')::boolean, false);

    v_invoice_total := 0;
    v_invoice_cost  := 0;

    v_invoice_id := NULL;
    IF v_existing_group_id IS NOT NULL THEN
      SELECT id INTO v_invoice_id FROM invoices
       WHERE invoice_group_id = v_existing_group_id AND customer_id = v_customer_id AND deleted_at IS NULL LIMIT 1;
    ELSIF p_invoice_id IS NOT NULL AND v_customer_count = 1 THEN
      v_invoice_id := p_invoice_id;
    END IF;

    IF v_invoice_id IS NULL AND v_existing_group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoices
       WHERE invoice_group_id = v_existing_group_id
         AND customer_id = v_customer_id
         AND deleted_at IS NOT NULL
    ) THEN
      v_skipped_customer_ids := array_append(v_skipped_customer_ids, v_customer_id);
      CONTINUE;
    END IF;

    v_is_new_invoice := (v_invoice_id IS NULL);

    IF v_invoice_id IS NULL THEN
      v_invoice_number := next_invoice_number();
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id,
        season
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date),  -- fallback is the America/Chicago business date, never UTC (2026-09-03)
        v_salesman_id,
        p_invoice->>'header_notes',
        p_performed_by,
        0, 0,
        v_invoice_group_id,
        p_application_service_id,
        v_season
      ) RETURNING id, season INTO v_invoice_id, v_invoice_season;
    ELSE
      UPDATE invoices SET
        invoice_date            = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id             = CASE WHEN is_admin() THEN COALESCE(v_salesman_id, salesman_id) ELSE salesman_id END,
        header_notes            = COALESCE(p_invoice->>'header_notes', header_notes),
        application_service_id  = p_application_service_id,
        invoice_group_id        = v_invoice_group_id,
        total_amount_cents      = 0,
        total_cost_cents        = 0,
        updated_at              = now()
      WHERE id = v_invoice_id
      -- Season is deliberately NOT rewritten on an edit: that would move an existing invoice to
      -- a different year-end statement, and the split-provenance triggers refuse it outright.
      -- Read back what the row carries so the rate lookup below prices at THAT season.
      RETURNING season INTO v_invoice_season;
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);
    -- KI-81: quotes must be valid on the date this invoice carries (an edit keeps its stored date).
    SELECT invoice_date INTO v_quote_price_date FROM invoices WHERE id = v_invoice_id;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_field_id            := (v_share_row->>'field_id')::uuid;
      v_field_applied_acres := (v_share_row->>'field_applied_acres')::numeric;
      v_share_pct           := (v_share_row->>'split_pct')::numeric;
      v_share_acres         := (v_share_row->>'share_acres')::numeric;
      v_field_override      := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note  := v_share_row->>'pricing_note';

      v_grower_share_amount := safe_cents_qty(v_field_override, v_share_acres);

      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id,
        (v_share_row->>'field_name') || ' — grower share @ $' ||
          (v_field_override / 100.0)::numeric(12,2) || '/ac' ||
          CASE WHEN v_field_pricing_note IS NOT NULL AND v_field_pricing_note <> ''
               THEN ' (' || v_field_pricing_note || ')' ELSE '' END,
        v_share_acres, 'acre',
        v_field_override, v_grower_share_amount, 0,
        0, v_share_acres, v_field_override, 'acre',
        false, 'manual'
      );

      v_invoice_total := v_invoice_total + v_grower_share_amount;
    END LOOP;

    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      DECLARE
        v_chem_qty_a   numeric := 0;
        v_chem_qty_b   numeric := 0;
        v_rate         numeric;
        v_qa_unit_cost bigint;
        v_wh           text := NULLIF(v_chem->>'warehouse', '');
        v_vendor       text := NULLIF(v_chem->>'vendor', '');
        v_form         text;
        v_epa          text := NULLIF(v_chem->>'epa_registration', '');
        v_ta_unit      text := COALESCE(NULLIF(v_chem->>'rate_unit',''), NULLIF(v_chem->>'unit_size',''));
        v_conv         record;
        v_inv_unit     text;       -- PARKED-010: product's sold/pricing unit (inventory_unit)
        v_priced_qty   numeric;    -- PARKED-010: applied qty converted into the pricing unit
        v_qa_unit      text;       -- KI-156: unit the grower-share line's cost is per
        v_qa_qty       numeric;    -- KI-156: grower-share applied qty converted into v_qa_unit
        v_prev_op      text;       -- KI-156: below-cost context to restore after the grower-share line
        v_srv_cost     bigint;     -- KI-156: product current cost (cents per sold unit), read with its unit
      BEGIN
        v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);

        IF (v_chem->>'product_id') IS NOT NULL THEN
          -- KI-156: read the sold unit and the current cost together, locked, so a grower-share line never pairs a
          -- quantity in one unit with a cost per another (the below-cost wall locks the same row at the insert).
          SELECT p.product_form::text, COALESCE(v_epa, p.epa_registration), COALESCE(v_vendor, p.vendor), p.inventory_unit,
                 round(p.current_cost * 100)::bigint
            INTO v_form, v_epa, v_vendor, v_inv_unit, v_srv_cost
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid
           FOR SHARE;
        END IF;

        FOR v_share_row IN
          SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
          WHERE (value ->> 'customer_id')::uuid = v_customer_id
        LOOP
          v_share_acres := (v_share_row->>'share_acres')::numeric;
          IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
            v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
          ELSE
            v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
          END IF;
        END LOOP;

        IF v_chem_qty_a > 0 THEN
          -- KI-156 (Mason, 2026-11-16): a grower-share chemical with a product is ALWAYS costed at the server cost,
          -- even for an admin: the product's current cost per its sold unit; a typed cost_cents is ignored. A
          -- hand-typed line with no product has no server cost: an admin's typed cost stands ("Yes, allow it"),
          -- anyone else's books 0.
          v_qa_unit_cost := CASE WHEN (v_chem->>'product_id') IS NOT NULL THEN COALESCE(v_srv_cost, 0)
                                 WHEN is_admin() THEN COALESCE((v_chem->>'cost_cents')::bigint, 0)
                                 ELSE 0 END;
          -- KI-156: cost_cents is per the product's SOLD unit (inventory_unit); on a line with no
          -- product it is per the unit the line is entered in (unit_size, which the screen keeps
          -- equal to the rate unit). Convert the applied amount (rate unit) into that unit before
          -- costing, as the billed branch below does, so 16 oz/ac x 100 ac of a $30/gal product
          -- costs 12.5 gal x $30 = $375, not 1,600 x $30. Round once to the stored precision and
          -- cost THAT quantity, so quantity x cost_cents on the saved line equals what is booked.
          -- A product line takes its unit from the server exactly as the billed branch does, never
          -- from the request.
          -- Its cost is per the sold unit, so a product with no sold unit cannot be costed: refuse rather than
          -- cost a rate-unit quantity at a sold-unit price (live 2026-11-16: 0 such products).
          IF (v_chem->>'product_id') IS NOT NULL AND NULLIF(btrim(v_inv_unit), '') IS NULL THEN
            RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: cannot cost "%" in the grower share — the product has no sold unit. Fix this product''s units before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id'));
          END IF;
          v_qa_unit := CASE WHEN (v_chem->>'product_id') IS NOT NULL
                            THEN v_inv_unit
                            ELSE COALESCE(NULLIF(v_chem->>'unit_size', ''), v_ta_unit) END;
          v_qa_qty  := field_app_priced_quantity(v_chem_qty_a, v_ta_unit, v_qa_unit, v_form);
          IF v_qa_qty IS NULL THEN
            RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: cannot price "%" — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id')), v_ta_unit, v_qa_unit;
          END IF;
          -- The line stores 4 decimals (invoice_items.quantity numeric(12,4)). Mason, 2026-11-17 ("Refuse if off
          -- >$0.50"): refuse a grower-share line whose booked cost would differ from the exact cost by more than
          -- 50 cents (a tiny amount of a costly product rounding to 0, #1926); smaller differences save as before.
          IF abs(safe_cents_qty(v_qa_unit_cost, ROUND(v_qa_qty, 4)) - v_qa_qty * v_qa_unit_cost) > 50 THEN
            RAISE EXCEPTION 'FIELD_APP_GROWER_SHARE_ROUNDING: cannot cost "%" in the grower share — % % is too small to record to 4 decimals without its cost changing by more than $0.50. Record this product in a smaller sold unit before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id')), trim_scale(v_qa_qty), v_qa_unit;
          END IF;
          v_qa_qty := ROUND(v_qa_qty, 4);
          SELECT * INTO v_conv FROM convert_to_gl_lb(ROUND(v_chem_qty_a, 4), v_ta_unit, v_form);
          -- KI-156 (Mason, 2026-11-15: "Admins and reps"): this $0 line is the chemical the grower's per-acre
          -- price already covers, not a sale below cost. Declare that to the below-cost wall for THIS insert
          -- only; the wall lets an active admin or sales rep save it and judges every other line as before.
          v_prev_op := current_setting('app.crx_below_cost_operation', true);
          PERFORM set_config('app.crx_below_cost_operation', 'field_app_grower_share', true);
          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            is_application_fee, price_source,
            warehouse, vendor, total_applied, total_applied_unit,
            total_applied_gl_lb, gl_lb_unit, epa_registration, product_form
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            (v_chem->>'description') || ' — included in grower share',
            v_qa_qty,
            v_qa_unit,
            0, 0, v_qa_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            false,
            'manual',
            v_wh, v_vendor, ROUND(v_chem_qty_a, 4), v_ta_unit,
            v_conv.converted_value, v_conv.converted_unit, v_epa, v_form
          );
          PERFORM set_config('app.crx_below_cost_operation', COALESCE(v_prev_op, ''), true);
          v_invoice_cost := v_invoice_cost + safe_cents_qty(v_qa_unit_cost, v_qa_qty);
        END IF;

        IF v_chem_qty_b > 0 THEN
          v_unit_price   := NULL;
          v_quoted_price := NULL;
          v_price_source := NULL;

          IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
             AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
            v_unit_price   := (v_chem->>'unit_price_cents')::bigint;
            v_price_source := 'manual';
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            -- KI-81 (Mason, 2026-11-17): only the price this customer was sent, on a field they have a share of.
            v_qi_price := public._field_app_sent_quote_price_cents(
                            (v_chem->>'product_id')::uuid,
                            ARRAY(SELECT DISTINCT (r->>'field_id')::uuid FROM jsonb_array_elements(v_shares -> 'rows') r
                                     WHERE (r->>'customer_id')::uuid = v_customer_id AND COALESCE((r->>'split_pct')::numeric, 0) > 0),
                            ARRAY[v_customer_id], v_quote_price_date);
            IF v_qi_price IS NOT NULL THEN
              v_unit_price   := v_qi_price::bigint;
              v_quoted_price := v_unit_price;
              v_price_source := 'quoted';
            END IF;
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT CASE v_customer_tier
              WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
              WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
              WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
              ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
            END INTO v_unit_price
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
            v_price_source := 'tier';
          END IF;

          v_unit_price := COALESCE(v_unit_price, 0);
          v_unit_cost  := COALESCE((v_chem->>'cost_cents')::bigint, 0);

          -- PARKED-010 (field-app billing unit fix): the applied amount (v_chem_qty_b) is in the
          -- RATE unit (e.g. oz), but v_unit_price is per the product's SOLD unit (inventory_unit,
          -- e.g. $/gal). Convert the applied amount into the pricing unit BEFORE multiplying, so a
          -- 16 oz/ac product at $32.10/gal bills $/gal x gallons (not $/gal x ounces = ~128x high).
          -- Manual line (no product_id): no inventory_unit, so price in the rate unit as entered
          -- (identity). If the units genuinely do not convert (e.g. an oz rate on a product sold
          -- "per unit"), refuse rather than silently mis-bill.
          v_priced_qty := field_app_priced_quantity(v_chem_qty_b, v_ta_unit, COALESCE(v_inv_unit, v_ta_unit), v_form);
          IF v_priced_qty IS NULL THEN
            RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: cannot price "%" — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id')), v_ta_unit, COALESCE(v_inv_unit, v_ta_unit);
          END IF;
          -- Round once to the stored precision so quantity x unit_price == extended_cents
          -- (the invoice line stays internally consistent on any later re-compute).
          v_priced_qty := ROUND(v_priced_qty, 4);
          v_extended   := safe_cents_qty(v_unit_price, v_priced_qty);

          SELECT * INTO v_conv FROM convert_to_gl_lb(ROUND(v_chem_qty_b, 4), v_ta_unit, v_form);

          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            quoted_price_cents, is_application_fee, price_source,
            warehouse, vendor, total_applied, total_applied_unit,
            total_applied_gl_lb, gl_lb_unit, epa_registration, product_form
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            v_chem->>'description',
            ROUND(v_priced_qty, 4),
            COALESCE(v_inv_unit, v_chem->>'unit_size'),
            v_unit_price, v_extended, v_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            v_quoted_price, false, v_price_source,
            v_wh, v_vendor, ROUND(v_chem_qty_b, 4), v_ta_unit,
            v_conv.converted_value, v_conv.converted_unit, v_epa, v_form
          );

          v_invoice_total := v_invoice_total + v_extended;
          -- PARKED-010: cost (v_unit_cost is also per the SOLD unit) must use the converted
          -- quantity too, otherwise margin = revenue(gallons) - cost(ounces) is wildly wrong.
          v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_priced_qty);
        END IF;
      END;
    END LOOP;

    IF p_application_service_id IS NOT NULL THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = p_application_service_id
         -- Price the application fee at the season THIS INVOICE IS FILED UNDER, whether it was
         -- just inserted (v_season, from the invoice date) or already existed (its stored
         -- season). Reading the clock here instead let a row be filed in one season and priced
         -- in another (rls-security-reviewer M3 / migration-drift-reviewer H1, 2026-09-04).
         AND car.season                 = v_invoice_season
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
        INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;

      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := safe_cents_qty(v_fee_rate, v_fee_acres);
        v_fee_cost     := safe_cents_qty(v_app_service.cost_per_acre_cents, v_fee_acres);
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost,
          9999, v_fee_acres, v_fee_rate, 'acre',
          true, 'tier'
        );
        v_invoice_total := v_invoice_total + v_fee_extended;
        v_invoice_cost  := v_invoice_cost + v_fee_cost;
      END IF;
    END IF;

    -- #32: FUEL SURCHARGE LINE (owner-configured; OFF + blank by default = NOTHING here).
    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
      INTO v_surcharge_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id
       AND (value->>'price_override_cents') IS NULL;

    v_surcharge_cents := compute_fuel_surcharge_cents(v_surcharge_acres, v_invoice_total);

    IF v_surcharge_cents > 0 THEN
      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id, 'Fuel Surcharge', 1,
        v_surcharge_cents, v_surcharge_cents, 0,
        9998, NULL, NULL, NULL,
        true, 'manual'
      );
      v_invoice_total := v_invoice_total + v_surcharge_cents;
    END IF;
    -- #32 END

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost,
      updated_at         = now()
    WHERE id = v_invoice_id;

    IF v_is_new_invoice THEN
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object(
          'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
          'customer_id', v_customer_id,
          'total_cents', v_invoice_total
        ),
        v_invoice_total,
        'Field application invoice created'
      );
    END IF;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
      INTO v_total_share_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id;

    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order,
      price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_total_share_acres, v_invoice_total,
      v_is_primary, 0,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'price_override_cents')::bigint
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'pricing_note')
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END
    );
  END LOOP;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    INSERT INTO field_app_locations (
      invoice_id, invoice_group_id,
      field_id, map_number, total_acres, planted_acres,
      applied_acres, crop_type, wind_direction, sort_order
    ) VALUES (
      CASE WHEN v_invoice_group_id IS NULL THEN v_invoice_ids[1] ELSE NULL END,
      v_invoice_group_id,
      (v_loc->>'field_id')::uuid,
      (v_loc->>'map_number')::int,
      (v_loc->>'total_acres')::numeric,
      (v_loc->>'planted_acres')::numeric,
      (v_loc->>'applied_acres')::numeric,
      v_loc->>'crop_type',
      v_loc->>'wind_direction',
      COALESCE((v_loc->>'sort_order')::int, 0)
    ) RETURNING id INTO v_loc_id;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'field_id')::uuid = (v_loc->>'field_id')::uuid
        AND NOT ((value->>'customer_id')::uuid = ANY(v_skipped_customer_ids))
    LOOP
      INSERT INTO field_app_location_shares (
        location_id, customer_id, split_pct, acres, amount_cents
      ) VALUES (
        v_loc_id,
        (v_share_row->>'customer_id')::uuid,
        (v_share_row->>'split_pct')::numeric,
        (v_share_row->>'share_acres')::numeric,
        0
      );
    END LOOP;
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN p_invoice_id IS NULL THEN 'field_app_invoice_created' ELSE 'field_app_invoice_updated' END,
    'Field app invoice ' ||
      CASE WHEN v_invoice_group_id IS NOT NULL
           THEN '(group of ' || v_customer_count || ') '
           ELSE '' END ||
      'saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_field_app_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._preview_field_app_invoice_split_impl_20260908(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid DEFAULT NULL::uuid, p_invoice_id uuid DEFAULT NULL::uuid, p_invoice_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_field_ids         uuid[];
  v_applied_acres_map jsonb := '{}'::jsonb;
  v_loc               jsonb;
  v_shares            jsonb;
  v_customers         jsonb;
  v_customer          jsonb;
  v_customer_id       uuid;
  v_customer_tier     int;
  v_app_service       record;
  v_per_customer      jsonb := '[]'::jsonb;
  v_customer_lines    jsonb;
  v_grand_total       bigint := 0;
  v_chem              jsonb;
  v_share_row         jsonb;
  v_chem_qty_a        numeric;
  v_chem_qty_b        numeric;
  v_share_acres       numeric;
  v_field_override    bigint;
  v_unit_price        bigint;
  v_extended          bigint;
  v_fee_rate          bigint;
  v_fee_acres         numeric;
  v_fee_extended      bigint;
  v_customer_total    bigint;
  v_rate              numeric;
  v_ta_unit           text;       -- PARKED-010: rate unit of the applied amount
  v_inv_unit          text;       -- PARKED-010: product's sold/pricing unit
  v_form              text;       -- PARKED-010: product_form (liquid/dry)
  v_priced_qty        numeric;    -- PARKED-010: applied qty converted into the pricing unit
  v_group_id          uuid;
  v_skipped_customer_ids uuid[] := '{}';
  v_qi_prices         bigint[];
  v_quote_price_date  date;
  v_surcharge_acres   numeric;
  v_surcharge_cents   bigint;
  v_customer_count    int;        -- CRX-SEC-001: mirrors save's single-customer test
  v_new_season        integer;    -- CRX-SEC-001: season a NOT-YET-SAVED invoice would be filed under
  v_row_season        integer;    -- CRX-SEC-001: season an ALREADY-SAVED member carries
  v_price_season      integer;    -- CRX-SEC-001: the season the fee is actually priced at
BEGIN
  -- PARKED-007 (codex-driven cycle 5 #1 HIGH): in-body role gate — without it
  -- ANY authenticated role (applicator, driver, etc.) can call this SECDEF
  -- function with arbitrary field_ids and receive private customer pricing
  -- and split detail. RLS doesn't apply (we're SECDEF), the EXECUTE grant to
  -- `authenticated` widens beyond billing roles. Mirrors the save side's gate.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can preview field-app invoice splits'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(
      v_loc->>'field_id',
      GREATEST(COALESCE((v_loc->>'applied_acres')::numeric, 0), 0)
    );
  END LOOP;

  IF v_field_ids IS NULL THEN
    RETURN jsonb_build_object('per_customer', '[]'::jsonb, 'grand_total_cents', 0, 'customer_count', 0);
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  -- CRX-SEC-001 (2026-09-06): counted BEFORE the deleted-member skip, exactly like save's
  -- v_customer_count, because save's single-customer branch tests the DERIVED list.
  v_customer_count := jsonb_array_length(v_customers);
  -- The season a customer WITHOUT an existing invoice would be filed under. Same expression
  -- and same America/Chicago fallback as _save_field_app_invoice_impl_20260714's v_season, so
  -- a preview and the save it precedes cannot land on different sides of October 1.
  v_new_season := compute_season(COALESCE(p_invoice_date, (now() AT TIME ZONE 'America/Chicago')::date));

  IF p_invoice_id IS NOT NULL THEN
    SELECT invoice_group_id INTO v_group_id FROM invoices WHERE id = p_invoice_id;
    IF v_group_id IS NOT NULL THEN
      SELECT COALESCE(array_agg(DISTINCT d.customer_id), '{}') INTO v_skipped_customer_ids
        FROM invoices d
       WHERE d.invoice_group_id = v_group_id
         AND d.deleted_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM invoices l
            WHERE l.invoice_group_id = v_group_id
              AND l.customer_id = d.customer_id
              AND l.deleted_at IS NULL
         );
    END IF;
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id    := (v_customer->>'customer_id')::uuid;
    IF v_customer_id = ANY(v_skipped_customer_ids) THEN CONTINUE; END IF;
    v_customer_tier  := COALESCE((v_customer->>'tier')::int, 1);
    -- KI-81 (Luna round 7): the date the save checks THIS customer's quotes on, the date their invoice will carry.
    v_quote_price_date := COALESCE(p_invoice_date,
                                   (SELECT i.invoice_date FROM invoices i
                                     WHERE v_group_id IS NOT NULL AND i.invoice_group_id = v_group_id
                                       AND i.customer_id = v_customer_id AND i.deleted_at IS NULL
                                       AND i.status IN ('draft', 'unposted')  -- as the save: a voided child is replaced, dated today
                                     ORDER BY i.invoice_date DESC LIMIT 1),
                                   -- CodeRabbit: the edited invoice's date only for its own grower; a new member's invoice is dated today
                                   (SELECT invoice_date FROM invoices WHERE id = p_invoice_id AND customer_id = v_customer_id
                                                                         AND status IN ('draft', 'unposted')),
                                   (now() AT TIME ZONE 'America/Chicago')::date);
    v_customer_total := 0;
    v_customer_lines := '[]'::jsonb;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'customer_id')::uuid = v_customer_id
        AND (value->>'price_override_cents') IS NOT NULL
    LOOP
      v_share_acres    := (v_share_row->>'share_acres')::numeric;
      v_field_override := (v_share_row->>'price_override_cents')::bigint;
      v_extended := ROUND(v_field_override * v_share_acres)::bigint;
      v_customer_lines := v_customer_lines || jsonb_build_object(
        'kind', 'grower_share',
        'description', (v_share_row->>'field_name') || ' grower share @ $' ||
                       (v_field_override / 100.0)::numeric(12,2) || '/ac',
        'quantity', v_share_acres,
        'unit_price_cents', v_field_override,
        'extended_cents', v_extended
      );
      v_customer_total := v_customer_total + v_extended;
    END LOOP;

    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      v_chem_qty_a := 0;
      v_chem_qty_b := 0;
      v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);
      FOR v_share_row IN
        SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
        WHERE (value->>'customer_id')::uuid = v_customer_id
      LOOP
        v_share_acres := (v_share_row->>'share_acres')::numeric;
        IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
          v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
        ELSE
          v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
        END IF;
      END LOOP;

      IF v_chem_qty_b > 0 THEN
        v_unit_price := NULL;
        IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
           AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
          v_unit_price := (v_chem->>'unit_price_cents')::bigint;
        END IF;
        IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
          -- KI-81 (Mason, 2026-11-17): only THIS customer's own sent, unexpired quote prices the chemical,
          -- the same quotes the save uses (no locks here; the save also runs the sent-price lock).
          SELECT array_agg(DISTINCT ROUND(qi.price_per_unit * 100)::bigint) INTO v_qi_prices
            FROM quotes q
            JOIN quote_sections qs ON qs.quote_id = q.id
                                  AND qs.field_id = ANY(ARRAY(SELECT DISTINCT (r->>'field_id')::uuid FROM jsonb_array_elements(v_shares -> 'rows') r
                                     WHERE (r->>'customer_id')::uuid = v_customer_id AND COALESCE((r->>'split_pct')::numeric, 0) > 0))
            JOIN quote_items qi ON qi.section_id = qs.id AND qi.quote_id = qs.quote_id
           WHERE q.customer_id = v_customer_id
             AND public._field_app_quote_eligible(q, (v_chem->>'product_id')::uuid,
                   ARRAY(SELECT DISTINCT (r->>'field_id')::uuid FROM jsonb_array_elements(v_shares -> 'rows') r
                                     WHERE (r->>'customer_id')::uuid = v_customer_id AND COALESCE((r->>'split_pct')::numeric, 0) > 0), v_quote_price_date)
             AND qi.product_id = (v_chem->>'product_id')::uuid
             AND qi.price_per_unit >= 0;
          IF cardinality(v_qi_prices) > 1 THEN
            RAISE EXCEPTION 'FIELD_APP_QUOTE_PRICE_CONFLICT: % is quoted at more than one price for these fields. Type the agreed price on that line, then save again.',
              COALESCE((SELECT product_name FROM products WHERE id = (v_chem->>'product_id')::uuid), 'A product')
              USING ERRCODE = 'P0001';
          END IF;
          v_unit_price := v_qi_prices[1];
        END IF;
        IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
          SELECT CASE v_customer_tier
            WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
            WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
            WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
            ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
          END INTO v_unit_price FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        END IF;
        v_unit_price := COALESCE(v_unit_price, 0);

        -- PARKED-010 (preview parity with save_field_app_invoice): the applied amount is in the
        -- RATE unit but v_unit_price is per the product's SOLD unit; convert before pricing so this
        -- on-page customer-split preview shows the same dollars the saved invoice will (not ~128x).
        v_ta_unit  := COALESCE(NULLIF(v_chem->>'rate_unit', ''), NULLIF(v_chem->>'unit_size', ''));
        v_inv_unit := NULL;
        v_form     := NULL;
        IF (v_chem->>'product_id') IS NOT NULL THEN
          SELECT p.inventory_unit, p.product_form::text INTO v_inv_unit, v_form
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        END IF;
        v_priced_qty := field_app_priced_quantity(v_chem_qty_b, v_ta_unit, COALESCE(v_inv_unit, v_ta_unit), v_form);
        -- Unconvertible units (save blocks with FIELD_APP_UNIT_UNCONVERTIBLE): preview the line at
        -- $0 rather than the old ~128x figure or crashing the preview.
        v_priced_qty := CASE WHEN v_priced_qty IS NULL THEN 0 ELSE ROUND(v_priced_qty, 4) END;
        v_extended := ROUND(v_unit_price * v_priced_qty)::bigint;
        v_customer_lines := v_customer_lines || jsonb_build_object(
          'kind', 'chemical', 'description', v_chem->>'description',
          'quantity', v_priced_qty,
          'unit_price_cents', v_unit_price, 'extended_cents', v_extended
        );
        v_customer_total := v_customer_total + v_extended;
      END IF;
    END LOOP;

    IF p_application_service_id IS NOT NULL THEN
      -- CRX-SEC-001: resolve the season THIS customer's invoice is (or would be) filed under,
      -- reproducing _save_field_app_invoice_impl_20260714's branch order exactly:
      --   1. an existing live member of the group  -> that row's stored season
      --   2. a single-customer edit of p_invoice_id -> that row's stored season
      --   3. otherwise (a new invoice)              -> compute_season(invoice date)
      -- Save never re-seasons an existing invoice (DECISION_LOG 2026-09-04), so branches 1
      -- and 2 must read the STORED season rather than recompute one.
      --
      -- v_row_season is reset at the top of every iteration. The hazard is not the SELECT INTO
      -- itself -- PL/pgSQL assigns NULL to the target when the query returns no row -- it is the
      -- IF/ELSIF below, which can take NEITHER branch (no group, and either no p_invoice_id or a
      -- multi-customer split). In that case nothing assigns v_row_season at all and, without this
      -- reset, it would still hold the PREVIOUS customer's season and price this customer's fee
      -- against the wrong year. The reset makes branch 3 reachable rather than inherited.
      --
      -- COALESCE treats "no row found" and "row found with a NULL season" the same way, falling
      -- through to the computed season where save would instead match no rate row and use the
      -- service default. That divergence cannot occur today because invoices.season is NOT NULL
      -- with a default; if that constraint is ever relaxed, this line must be revisited.
      v_row_season := NULL;
      IF v_group_id IS NOT NULL THEN
        SELECT i.season INTO v_row_season
          FROM invoices i
         WHERE i.invoice_group_id = v_group_id
           AND i.customer_id      = v_customer_id
           AND i.deleted_at IS NULL
         LIMIT 1;
      ELSIF p_invoice_id IS NOT NULL AND v_customer_count = 1 THEN
        SELECT i.season INTO v_row_season FROM invoices i WHERE i.id = p_invoice_id;
      END IF;
      v_price_season := COALESCE(v_row_season, v_new_season);

      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id = v_customer_id
         AND car.application_service_id = p_application_service_id
         AND car.season = v_price_season LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;
      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;
      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := ROUND(v_fee_rate * v_fee_acres)::bigint;
        v_customer_lines := v_customer_lines || jsonb_build_object(
          'kind', 'service_fee', 'description', v_app_service.name,
          'quantity', v_fee_acres, 'unit_price_cents', v_fee_rate,
          'extended_cents', v_fee_extended
        );
        v_customer_total := v_customer_total + v_fee_extended;
      END IF;
    END IF;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_surcharge_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id
       AND (value->>'price_override_cents') IS NULL;

    v_surcharge_cents := compute_fuel_surcharge_cents(v_surcharge_acres, v_customer_total);

    IF v_surcharge_cents > 0 THEN
      v_customer_lines := v_customer_lines || jsonb_build_object(
        'kind', 'fuel_surcharge', 'description', 'Fuel Surcharge',
        'quantity', 1, 'unit_price_cents', v_surcharge_cents,
        'extended_cents', v_surcharge_cents
      );
      v_customer_total := v_customer_total + v_surcharge_cents;
    END IF;

    v_per_customer := v_per_customer || jsonb_build_object(
      'customer_id',   v_customer_id,
      'customer_name', v_customer->>'customer_name',
      'is_primary',    COALESCE((v_customer->>'is_primary')::boolean, false),
      'tier',          v_customer_tier,
      'total_cents',   v_customer_total,
      'lines',         v_customer_lines
    );
    v_grand_total := v_grand_total + v_customer_total;
  END LOOP;

  RETURN jsonb_build_object(
    'per_customer',      v_per_customer,
    'grand_total_cents', v_grand_total,
    'customer_count',    jsonb_array_length(v_per_customer),
    'shares_detail',     v_shares
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public._save_field_app_split_invoice_impl(uuid, uuid, jsonb, jsonb, jsonb, uuid, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public._refuse_stock_unit_change_with_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_new text := lower(COALESCE(NULLIF(btrim(NEW.inventory_unit), ''), NULLIF(btrim(NEW.unit_size), '')));
  v_old text := lower(COALESCE(NULLIF(btrim(OLD.inventory_unit), ''), NULLIF(btrim(OLD.unit_size), '')));
  v_what text;
BEGIN
  -- Clearing is a1's to refuse; a case or outer-space change keeps every comparison (receive_return lowers and trims).
  IF v_new IS NULL OR v_new IS NOT DISTINCT FROM v_old THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_items WHERE product_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.delivery_items WHERE product_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.purchase_order_items WHERE product_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.receiving_records WHERE product_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.return_items WHERE product_id = NEW.id)
     -- Every other stock movement (jobs, blend tickets, adjustments, counts) writes a transaction; a hold keeps a quantity.
     OR EXISTS (SELECT 1 FROM public.inventory_transactions WHERE product_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.inventory_holds WHERE product_id = NEW.id AND is_active) THEN
    SELECT string_agg(x, ', ') INTO v_what FROM (
      SELECT x FROM (
        SELECT 'order ' || COALESCE(o.order_number, l.order_id::text) AS x
          FROM public.order_items l LEFT JOIN public.orders o ON o.id = l.order_id WHERE l.product_id = NEW.id
        UNION
        SELECT 'delivery ' || COALESCE(d.delivery_number, l.delivery_id::text)
          FROM public.delivery_items l LEFT JOIN public.deliveries d ON d.id = l.delivery_id WHERE l.product_id = NEW.id
        UNION
        SELECT 'PO ' || COALESCE(po.po_number, l.purchase_order_id::text)
          FROM public.purchase_order_items l LEFT JOIN public.purchase_orders po ON po.id = l.purchase_order_id WHERE l.product_id = NEW.id
        UNION
        SELECT 'return ' || COALESCE(r.return_number, ri.return_id::text)
          FROM public.return_items ri LEFT JOIN public.returns r ON r.id = ri.return_id WHERE ri.product_id = NEW.id
        UNION
        SELECT 'PO ' || COALESCE(po.po_number, rr.purchase_order_id::text)
          FROM public.receiving_records rr LEFT JOIN public.purchase_orders po ON po.id = rr.purchase_order_id WHERE rr.product_id = NEW.id
      ) a ORDER BY x LIMIT 5
    ) s;
    RAISE EXCEPTION 'PRODUCT_UNIT_HAS_HISTORY: this product''s stock unit cannot change to "%" because it already has orders, purchases, deliveries, returns, stock movements or holds (%). Set up a new product for the new unit.',
      btrim(COALESCE(NULLIF(btrim(NEW.inventory_unit), ''), NEW.unit_size)), COALESCE(v_what, 'stock movements or holds')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_purchasing_plan(p_months_ahead integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required' USING ERRCODE = '42501';
  END IF;

  RETURN (
  WITH
  prm AS (
    SELECT t.today, t.months,
           (date_trunc('month', t.today) + make_interval(months => t.months) - interval '1 day')::date AS horizon_end,
           COALESCE((SELECT CASE WHEN btrim(a.setting_value) ~ '^[0-9]{1,3}$' AND btrim(a.setting_value)::int <= 120
                                 THEN btrim(a.setting_value)::int END
                       FROM app_settings a WHERE a.setting_key = 'purchasing_lead_days'
                      ORDER BY a.updated_at DESC NULLS LAST LIMIT 1), 14) AS lead_days
      FROM (SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today,
                   LEAST(GREATEST(COALESCE(p_months_ahead, 6), 1), 12) AS months) t
  ),
  -- Timing windows: a missing, invalid or impossible month-day falls back to that timing's default.
  win_json AS (
    SELECT CASE WHEN pg_input_is_valid(a.setting_value, 'jsonb') THEN a.setting_value::jsonb END AS j
      FROM app_settings a WHERE a.setting_key = 'booking_timing_windows'
     ORDER BY a.updated_at DESC NULLS LAST LIMIT 1
  ),
  win AS (
    SELECT d.timing,
           CASE WHEN e.v ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN
                  CASE WHEN substr(e.v, 4, 2)::int
                            <= extract(day from make_date(2001, substr(e.v, 1, 2)::int, 1) + interval '1 month - 1 day')::int
                       THEN e.v END
           END AS end_md,
           d.dflt
      FROM (VALUES ('pre_plant', '05-15'), ('in_season', '07-15'), ('late_summer', '09-15')) d(timing, dflt)
      LEFT JOIN LATERAL (
        SELECT CASE WHEN jsonb_typeof(w.j) = 'object' AND jsonb_typeof(w.j -> d.timing) = 'object'
                    THEN w.j -> d.timing ->> 'end' END AS v
          FROM win_json w
      ) e ON true
  ),
  win_end AS (SELECT timing, COALESCE(end_md, dflt) AS end_md FROM win),
  -- Rule 1: bookings that still promise product.
  eq AS (
    SELECT q.id, q.quote_number, q.customer_id
      FROM quotes q
     WHERE q.deleted_at IS NULL
       AND (q.status IN ('sent', 'revised')
            OR (q.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.quote_id = q.id)))
  ),
  bla AS (
    SELECT qi.id AS item_id, eq.id AS quote_id, qi.product_id, s.id AS section_id,
           -- A non-finite date ('infinity') counts as no date, so one bad section cannot fail the plan.
           CASE WHEN isfinite(s.needed_by_date) THEN s.needed_by_date END AS needed_by_date,
           s.timing, s.confidence, COALESCE(s.sort_order, 0) AS s_sort, COALESCE(qi.sort_order, 0) AS i_sort,
           GREATEST(COALESCE(qi.total_units_needed, 0), 0) AS qty,
           -- A line saved in a unit that no longer matches the stock unit is set aside (Mason, 2026-11-18):
           -- listed under Check units only; it absorbs no draw and covers no hold.
           NOT _unit_matches_stock_unit(qi.unit_size, COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)) AS unit_problem
      FROM eq
      JOIN quote_items qi ON qi.quote_id = eq.id
      JOIN products p ON p.id = qi.product_id
      LEFT JOIN quote_sections s ON s.id = qi.section_id
     WHERE qi.product_id IS NOT NULL
  ),
  bl AS (
    SELECT * FROM bla WHERE NOT bla.unit_problem
  ),
  -- Active job lines, with the reservation engine's own quantity (20261107070000).
  jcl AS (
    SELECT jc.job_id, jc.product_id, j.job_date, j.quote_id, j.quote_section_id, j.customer_id,
           COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity) AS qty,
           (field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form) IS NULL
            AND NOT _unit_matches_stock_unit(jc.unit, COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))) AS unit_problem
      FROM jobs j
      JOIN job_chemicals jc ON jc.job_id = j.id
      JOIN products p ON p.id = jc.product_id
     WHERE j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress')
       AND jc.customer_supplied IS NOT TRUE AND COALESCE(jc.quantity, 0) > 0
  ),
  -- Draws. A job draw belongs to the job's section when that section is on the same booking;
  -- an order draw (quote_product_draws) never records a section. An active job whose line for
  -- the product cannot be converted (Check units, not counted) draws nothing here, so the
  -- booking's demand stays counted instead of vanishing into an uncounted job.
  jd AS (
    SELECT jpd.quote_id, jpd.product_id, s.id AS section_id, COALESCE(jpd.quantity_drawn, 0) AS qty
      FROM job_product_draws jpd
      JOIN eq ON eq.id = jpd.quote_id
      JOIN jobs j ON j.id = jpd.job_id
      LEFT JOIN quote_sections s ON s.id = j.quote_section_id AND s.quote_id = jpd.quote_id
     WHERE NOT EXISTS (SELECT 1 FROM jcl WHERE jcl.job_id = jpd.job_id AND jcl.product_id = jpd.product_id AND jcl.unit_problem)
  ),
  alld AS (
    SELECT qpd.quote_id, qpd.product_id, NULL::uuid AS section_id, COALESCE(qpd.quantity_drawn, 0) AS qty
      FROM quote_product_draws qpd JOIN eq ON eq.id = qpd.quote_id
    UNION ALL
    SELECT quote_id, product_id, section_id, qty FROM jd
  ),
  dt AS (
    SELECT quote_id, product_id, SUM(qty) AS total,
           COALESCE(SUM(qty) FILTER (WHERE section_id IS NULL), 0) AS unknown
      FROM alld GROUP BY quote_id, product_id
  ),
  kd AS (
    SELECT quote_id, product_id, section_id, SUM(qty) AS drawn
      FROM jd WHERE section_id IS NOT NULL GROUP BY quote_id, product_id, section_id
  ),
  -- Step 1: a job draw comes off its own section first.
  s1 AS (
    SELECT bl.*,
           bl.qty - LEAST(bl.qty, GREATEST(0, COALESCE(kd.drawn, 0)
             - (SUM(bl.qty) OVER (PARTITION BY bl.quote_id, bl.product_id, bl.section_id
                                  ORDER BY bl.i_sort, bl.item_id ROWS UNBOUNDED PRECEDING) - bl.qty))) AS rem1
      FROM bl
      LEFT JOIN kd ON kd.quote_id = bl.quote_id AND kd.product_id = bl.product_id AND kd.section_id = bl.section_id
  ),
  ap1 AS (
    SELECT quote_id, product_id, SUM(qty - rem1) AS applied, SUM(qty) AS booked FROM s1 GROUP BY quote_id, product_id
  ),
  -- Step 2: every other draw (order draws, and job draws beyond their section) comes off the
  -- LATEST-needed lines first. Totals stay exact and needs can only move earlier, so the plan
  -- never buys short or late while the real section of an order draw is unknown (Phase B records it).
  -- Undated lines come off last, so a Firm line with no date stays on the needs-a-date list.
  -- Less sure lines come off before surer ones (Maybe, then Likely or unset, then Firm), so an
  -- unknown draw never erases Firm demand while a Maybe line of the same product stays.
  s2a AS (
    SELECT s1.*, GREATEST(COALESCE(dt.total, 0) - COALESCE(ap1.applied, 0), 0) AS pool
      FROM s1
      LEFT JOIN dt ON dt.quote_id = s1.quote_id AND dt.product_id = s1.product_id
      LEFT JOIN ap1 ON ap1.quote_id = s1.quote_id AND ap1.product_id = s1.product_id
  ),
  s2 AS (
    SELECT s2a.*,
           s2a.rem1 - LEAST(s2a.rem1, GREATEST(0, s2a.pool
             - (SUM(s2a.rem1) OVER (PARTITION BY s2a.quote_id, s2a.product_id
                                    ORDER BY CASE s2a.confidence WHEN 'maybe' THEN 0 WHEN 'firm' THEN 2 ELSE 1 END,
                                             s2a.needed_by_date DESC NULLS LAST, s2a.s_sort DESC, s2a.i_sort DESC, s2a.item_id DESC
                                    ROWS UNBOUNDED PRECEDING) - s2a.rem1))) AS rem
      FROM s2a
  ),
  overdrawn AS (
    SELECT dt.quote_id, dt.product_id, dt.total - COALESCE(ap1.booked, 0) AS qty
      FROM dt LEFT JOIN ap1 ON ap1.quote_id = dt.quote_id AND ap1.product_id = dt.product_id
     WHERE dt.total > COALESCE(ap1.booked, 0)
  ),
  -- Every demand row, in stock units.
  dem AS (
    SELECT s2.product_id, 'booking'::text AS kind,
           CASE s2.confidence WHEN 'firm' THEN 'committed' WHEN 'maybe' THEN 'shown' ELSE 'could_add' END AS cls,
           s2.needed_by_date AS raw_date, s2.rem AS qty, s2.quote_id, NULL::uuid AS order_id, NULL::uuid AS job_id,
           s2.section_id, s2.confidence, (s2.rem < s2.rem1) AS estimated, s2.unit_problem,
           (SELECT eq.customer_id FROM eq WHERE eq.id = s2.quote_id) AS customer_id
      FROM s2 WHERE s2.rem > 0
    UNION ALL
    -- Set-aside lines (unit does not match stock): Check units, in full.
    SELECT bla.product_id, 'booking',
           CASE bla.confidence WHEN 'firm' THEN 'committed' WHEN 'maybe' THEN 'shown' ELSE 'could_add' END,
           bla.needed_by_date, bla.qty, bla.quote_id, NULL::uuid, NULL::uuid,
           bla.section_id, bla.confidence, false, true,
           (SELECT eq.customer_id FROM eq WHERE eq.id = bla.quote_id)
      FROM bla WHERE bla.unit_problem AND bla.qty > 0
    UNION ALL
    -- Open orders: dated by the earliest scheduled, undelivered delivery of the line only when the
    -- scheduled deliveries cover all of what remains; otherwise today, so the plan never buys late.
    SELECT oi.product_id, 'order', 'committed',
           COALESCE((SELECT MIN(d.scheduled_date)
                       FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
                      WHERE di.order_item_id = oi.id AND d.deleted_at IS NULL
                        AND d.status IN ('scheduled', 'in_progress') AND d.scheduled_date IS NOT NULL
                     HAVING SUM(COALESCE(di.quantity, 0)) >= oi.quantity_remaining),
                    (SELECT today FROM prm)),
           oi.quantity_remaining, o.quote_id, o.id, NULL::uuid, NULL::uuid, NULL::text, false, false, o.customer_id
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.deleted_at IS NULL AND o.status IN ('confirmed', 'partially_fulfilled')
       AND oi.product_id IS NOT NULL AND oi.quantity_remaining > 0
    UNION ALL
    -- Active jobs (jcl).
    SELECT x.product_id, 'job', 'committed', x.job_date, x.qty, x.quote_id, NULL::uuid, x.job_id,
           x.quote_section_id, NULL::text, false, x.unit_problem, x.customer_id
      FROM jcl x
    UNION ALL
    -- Manual holds, and crop-program holds whose booking does not count that product above (a
    -- draft Planned booking, one that is gone or closed, or one with no line for the product),
    -- count now. A counted booking's hold on a product it books is that booking's own line.
    SELECT ih.product_id, 'hold', 'committed', (SELECT today FROM prm), ih.quantity, NULL::uuid, NULL::uuid, NULL::uuid,
           NULL::uuid, NULL::text, false, false, ih.customer_id
      FROM inventory_holds ih
     WHERE ih.is_active = true AND ih.quantity > 0
       -- An expired hold reserves nothing (as in the inventory position, 20261204100000).
       AND (ih.expires_at IS NULL OR ih.expires_at >= (SELECT today FROM prm))
       AND (ih.hold_type = 'manual'
            OR (ih.hold_type = 'crop_program'
                AND (NOT EXISTS (SELECT 1 FROM bl WHERE bl.quote_id = ih.source_id AND bl.product_id = ih.product_id)
                     -- A hold cannot say which line it is for: when the booking also has a set-aside
                     -- line of the product, the hold counts (it may belong to that line).
                     OR EXISTS (SELECT 1 FROM bla WHERE bla.quote_id = ih.source_id AND bla.product_id = ih.product_id
                                                  AND bla.unit_problem))))
  ),
  demb AS (
    SELECT dem.*,
           CASE WHEN dem.unit_problem THEN 'check_units'
                WHEN dem.raw_date IS NULL THEN 'needs_date'
                WHEN dem.raw_date > prm.horizon_end THEN 'later'
                ELSE 'dated' END AS bucket,
           GREATEST(dem.raw_date, prm.today) AS need_date,
           (dem.raw_date < prm.today) AS overdue
      FROM dem CROSS JOIN prm
  ),
  po AS (
    SELECT poi.product_id, p.id AS po_id, p.po_number, p.status, p.expected_delivery_date AS raw_date,
           poi.quantity_ordered - COALESCE(poi.quantity_received, 0) AS qty,
           CASE WHEN p.status = 'draft' THEN 'draft'
                WHEN p.expected_delivery_date IS NULL THEN 'undated'
                WHEN p.expected_delivery_date > prm.horizon_end THEN 'later'
                WHEN p.expected_delivery_date < prm.today THEN 'late'
                ELSE 'counted' END AS flag,
           GREATEST(p.expected_delivery_date, prm.today) AS eff_date
      FROM purchase_order_items poi
      JOIN purchase_orders p ON p.id = poi.purchase_order_id
      CROSS JOIN prm
     WHERE p.status IN ('draft', 'submitted', 'partially_received') AND poi.product_id IS NOT NULL
       AND poi.quantity_ordered - COALESCE(poi.quantity_received, 0) > 0
  ),
  onhand AS (
    SELECT i.product_id, SUM(COALESCE(i.quantity_available, 0)) AS qty
      FROM inventory i WHERE i.location = 'Main Warehouse' GROUP BY i.product_id
  ),
  prod AS (
    SELECT p.id AS product_id, p.product_name, p.sku, p.container_size, p.unit_size,
           COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size) AS stock_unit,
           COALESCE(oh.qty, 0) AS on_hand
      FROM products p LEFT JOIN onhand oh ON oh.product_id = p.id
     WHERE EXISTS (SELECT 1 FROM demb WHERE demb.product_id = p.id)
        OR EXISTS (SELECT 1 FROM po WHERE po.product_id = p.id)
        OR EXISTS (SELECT 1 FROM overdrawn WHERE overdrawn.product_id = p.id)
        OR COALESCE(oh.qty, 0) < 0
  ),
  -- Rule 5: per product and date, supply before demand, starting at on hand.
  ev AS (
    SELECT product_id, need_date AS d,
           COALESCE(SUM(qty) FILTER (WHERE cls = 'committed'), 0) AS dc,
           COALESCE(SUM(qty) FILTER (WHERE cls IN ('committed', 'could_add')), 0) AS da,
           0::numeric AS s
      FROM demb WHERE bucket = 'dated' GROUP BY product_id, need_date
    UNION ALL
    SELECT product_id, eff_date, 0, 0, SUM(qty) FROM po WHERE flag IN ('counted', 'late') GROUP BY product_id, eff_date
    UNION ALL
    SELECT product_id, (SELECT today FROM prm), 0, 0, 0 FROM prod
  ),
  evd AS (SELECT product_id, d, SUM(dc) AS dc, SUM(da) AS da, SUM(s) AS s FROM ev GROUP BY product_id, d),
  walk AS (
    SELECT evd.*,
           prod.on_hand + SUM(evd.s - evd.dc) OVER w AS bal_c,
           prod.on_hand + SUM(evd.s - evd.da) OVER w AS bal_a
      FROM evd JOIN prod USING (product_id)
    WINDOW w AS (PARTITION BY evd.product_id ORDER BY evd.d ROWS UNBOUNDED PRECEDING)
  ),
  walk2 AS (
    SELECT walk.*,
           MAX(GREATEST(0, -bal_c)) OVER w AS cum_c,
           MAX(GREATEST(0, -bal_a)) OVER w AS cum_a
      FROM walk
    WINDOW w AS (PARTITION BY product_id ORDER BY d ROWS UNBOUNDED PRECEDING)
  ),
  sugg AS (
    SELECT product_id, d, cum_c - COALESCE(LAG(cum_c) OVER (PARTITION BY product_id ORDER BY d), 0) AS qty
      FROM walk2
  ),
  totals AS (
    SELECT product_id, MAX(cum_c) AS suggested, MAX(cum_a) - MAX(cum_c) AS could_add FROM walk2 GROUP BY product_id
  ),
  -- Rule 6 reasons.
  reasons AS (
    SELECT prod.product_id, array_remove(ARRAY[
             CASE WHEN EXISTS (SELECT 1 FROM demb WHERE demb.product_id = prod.product_id AND demb.cls = 'committed' AND demb.bucket = 'needs_date') THEN 'needs_date' END,
             CASE WHEN EXISTS (SELECT 1 FROM demb WHERE demb.product_id = prod.product_id AND demb.cls = 'committed' AND demb.bucket = 'check_units') THEN 'check_units' END,
             CASE WHEN EXISTS (SELECT 1 FROM demb WHERE demb.product_id = prod.product_id AND demb.cls = 'committed' AND demb.bucket = 'later') THEN 'later' END,
             CASE WHEN EXISTS (SELECT 1 FROM overdrawn WHERE overdrawn.product_id = prod.product_id) THEN 'over_drawn' END,
             CASE WHEN EXISTS (SELECT 1 FROM po WHERE po.product_id = prod.product_id AND po.flag = 'late') THEN 'late_po' END,
             CASE WHEN EXISTS (SELECT 1 FROM po WHERE po.product_id = prod.product_id AND po.flag = 'undated') THEN 'undated_po' END
           ], NULL) AS list
      FROM prod
  ),
  months AS (
    SELECT prod.product_id, gs.m::date AS m FROM prod
     CROSS JOIN prm
     CROSS JOIN LATERAL generate_series(date_trunc('month', prm.today), date_trunc('month', prm.horizon_end), interval '1 month') gs(m)
  ),
  -- Review list: a section with a needed-by date (A-R2) and something still to deliver, from 14 days
  -- before the end of its timing window (in the needed-by date's year), or of its needed-by date when untimed.
  rev AS (
    SELECT s2.quote_id, s2.section_id, s2.timing, s2.confidence, s2.needed_by_date,
           CASE WHEN we.end_md IS NOT NULL
                THEN make_date(extract(year FROM s2.needed_by_date)::int, substr(we.end_md, 1, 2)::int, substr(we.end_md, 4, 2)::int)
                ELSE s2.needed_by_date END AS window_end,
           jsonb_agg(jsonb_build_object('product_id', s2.product_id, 'product_name', p.product_name, 'quantity', s2.rem)
                     ORDER BY p.product_name) AS products
      FROM s2
      JOIN products p ON p.id = s2.product_id
      LEFT JOIN win_end we ON we.timing = s2.timing
     WHERE s2.rem > 0 AND s2.needed_by_date IS NOT NULL AND s2.section_id IS NOT NULL
     GROUP BY s2.quote_id, s2.section_id, s2.timing, s2.confidence, s2.needed_by_date, we.end_md
  )
  SELECT jsonb_build_object(
    'today', prm.today,
    'horizon_end', prm.horizon_end,
    'months_ahead', prm.months,
    'lead_days', prm.lead_days,
    'firm_needs_date', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'quote_id', demb.quote_id, 'quote_number', eq.quote_number, 'customer_name', c.farm_name,
               'section_name', qs.section_name, 'product_id', demb.product_id, 'product_name', p.product_name,
               'quantity', demb.qty) ORDER BY c.farm_name, eq.quote_number, qs.section_name, p.product_name)
        FROM demb
        JOIN eq ON eq.id = demb.quote_id
        LEFT JOIN customers c ON c.id = eq.customer_id
        LEFT JOIN quote_sections qs ON qs.id = demb.section_id
        JOIN products p ON p.id = demb.product_id
       WHERE demb.kind = 'booking' AND demb.confidence = 'firm' AND demb.bucket = 'needs_date'), '[]'::jsonb),
    'drawn_section_unknown', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'quote_id', dt.quote_id, 'quote_number', eq.quote_number, 'customer_name', c.farm_name,
               'product_id', dt.product_id, 'product_name', p.product_name, 'quantity', dt.unknown)
               ORDER BY eq.quote_number, p.product_name)
        FROM dt JOIN eq ON eq.id = dt.quote_id
        LEFT JOIN customers c ON c.id = eq.customer_id
        JOIN products p ON p.id = dt.product_id
       WHERE dt.unknown > 0), '[]'::jsonb),
    'review', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'quote_id', rev.quote_id, 'quote_number', eq.quote_number, 'customer_name', c.farm_name,
               'section_id', rev.section_id, 'section_name', qs.section_name, 'timing', rev.timing,
               'confidence', rev.confidence, 'needed_by_date', rev.needed_by_date, 'window_end', rev.window_end,
               'products', rev.products) ORDER BY rev.window_end, eq.quote_number, qs.section_name)
        FROM rev JOIN eq ON eq.id = rev.quote_id
        LEFT JOIN customers c ON c.id = eq.customer_id
        LEFT JOIN quote_sections qs ON qs.id = rev.section_id
       WHERE prm.today >= rev.window_end - 14), '[]'::jsonb),
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'product_id', prod.product_id, 'product_name', prod.product_name, 'sku', prod.sku,
               'stock_unit', prod.stock_unit, 'container_size', prod.container_size, 'unit_size', prod.unit_size,
               'on_hand', prod.on_hand,
               'incoming', COALESCE((SELECT SUM(po.qty) FROM po WHERE po.product_id = prod.product_id AND po.flag IN ('counted', 'late')), 0),
               'drafted', COALESCE((SELECT SUM(po.qty) FROM po WHERE po.product_id = prod.product_id AND po.flag = 'draft'), 0),
               'committed', COALESCE((SELECT SUM(demb.qty) FROM demb WHERE demb.product_id = prod.product_id AND demb.cls = 'committed' AND demb.bucket = 'dated'), 0),
               'suggested', COALESCE(t.suggested, 0),
               'could_add', COALESCE(t.could_add, 0),
               'over_drawn', COALESCE((SELECT SUM(od.qty) FROM overdrawn od WHERE od.product_id = prod.product_id), 0),
               'not_complete', cardinality(r.list) > 0,
               'reasons', to_jsonb(r.list),
               'suggestions', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'need_date', sg.d,
                          'order_by', GREATEST(sg.d - prm.lead_days, prm.today),
                          'order_now', sg.d - prm.lead_days <= prm.today,
                          -- No "expedite a later PO instead" alternative (Mason, 2026-11-18): it could not show
                          -- the shortage that moving a PO earlier leaves behind. Open POs stay listed.
                          'quantity', sg.qty)
                          ORDER BY sg.d)
                   FROM sugg sg WHERE sg.product_id = prod.product_id AND sg.qty > 0), '[]'::jsonb),
               'months', (
                 SELECT jsonb_agg(jsonb_build_object(
                          'month', mo.m,
                          'committed', COALESCE((SELECT SUM(qty) FROM demb WHERE demb.product_id = mo.product_id AND demb.bucket = 'dated' AND demb.cls = 'committed' AND date_trunc('month', demb.need_date) = mo.m), 0),
                          'could_add', COALESCE((SELECT SUM(qty) FROM demb WHERE demb.product_id = mo.product_id AND demb.bucket = 'dated' AND demb.cls = 'could_add' AND date_trunc('month', demb.need_date) = mo.m), 0),
                          'maybe', COALESCE((SELECT SUM(qty) FROM demb WHERE demb.product_id = mo.product_id AND demb.bucket = 'dated' AND demb.cls = 'shown' AND date_trunc('month', demb.need_date) = mo.m), 0),
                          'incoming', COALESCE((SELECT SUM(qty) FROM po WHERE po.product_id = mo.product_id AND po.flag IN ('counted', 'late') AND date_trunc('month', po.eff_date) = mo.m), 0))
                          ORDER BY mo.m)
                   FROM months mo WHERE mo.product_id = prod.product_id),
               'rows', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'kind', demb.kind, 'class', demb.cls, 'bucket', demb.bucket,
                          'need_date', CASE WHEN demb.bucket = 'needs_date' THEN NULL ELSE demb.need_date END,
                          'raw_date', demb.raw_date, 'overdue', COALESCE(demb.overdue, false),
                          'quantity', demb.qty, 'confidence', demb.confidence, 'estimated', demb.estimated,
                          'quote_id', demb.quote_id, 'quote_number', q.quote_number,
                          'order_id', demb.order_id, 'order_number', o.order_number,
                          'job_id', demb.job_id, 'job_number', j.job_number,
                          'customer_name', c.farm_name, 'section_name', qs.section_name)
                          ORDER BY demb.raw_date NULLS FIRST, demb.kind, c.farm_name)
                   FROM demb
                   LEFT JOIN quotes q ON q.id = demb.quote_id
                   LEFT JOIN orders o ON o.id = demb.order_id
                   LEFT JOIN jobs j ON j.id = demb.job_id
                   LEFT JOIN customers c ON c.id = demb.customer_id
                   LEFT JOIN quote_sections qs ON qs.id = demb.section_id
                  WHERE demb.product_id = prod.product_id), '[]'::jsonb),
               'purchase_orders', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'po_id', po.po_id, 'po_number', po.po_number, 'status', po.status,
                          'expected_date', po.raw_date, 'flag', po.flag, 'quantity', po.qty)
                          ORDER BY po.raw_date NULLS LAST, po.po_number)
                   FROM po WHERE po.product_id = prod.product_id), '[]'::jsonb))
             ORDER BY (cardinality(r.list) > 0 OR COALESCE(t.suggested, 0) > 0) DESC, prod.product_name)
        FROM prod
        LEFT JOIN totals t ON t.product_id = prod.product_id
        LEFT JOIN reasons r ON r.product_id = prod.product_id), '[]'::jsonb)
  )
  FROM prm
  );
END;
$function$;

DROP FUNCTION public.auto_expire_quotes(text);
CREATE OR REPLACE FUNCTION public.auto_expire_quotes()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_quote record;
  v_expired_count integer := 0;
  v_holds_released integer := 0;
  v_hold_count integer;
  v_actor uuid;
BEGIN
  FOR v_quote IN
    SELECT q.* FROM public.quotes q
    WHERE q.expires_at < CURRENT_DATE
      AND q.status IN ('sent', 'revised')
      AND q.deleted_at IS NULL
      -- A5 (2026-06-10): a quote with partial draw-downs is an open season
      -- booking — being past its quote-expiry date is normal business, not an
      -- expired quote. Never auto-expire it (the undrawn balance would be
      -- destroyed: 'expired' is terminal and releases the booking's holds).
      AND NOT EXISTS (
        SELECT 1 FROM public.quote_product_draws d
        WHERE d.quote_id = q.id AND d.quantity_drawn > 0
      )
      -- #5 (2026-06-13, owner gate G-AE = Option 1): Planned Programs are
      -- deliberate season commitments that reserve inventory on purpose — never
      -- silently auto-expire them (that would release the booking's holds out
      -- from under the forecast). Staff close planned quotes by hand if needed.
      AND q.is_planned = false
      -- #1959 (Mason 2026-11-17): a booking with a live spray job cannot expire; the
      -- quotes_booking_live_job_rules trigger would refuse it and fail the whole batch.
      AND NOT EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE (j.quote_id = q.id
               OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = q.id))
          AND j.deleted_at IS NULL AND j.status <> 'cancelled'
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    -- #1959: a job committed after the loop's snapshot but before this row was locked is not in the
    -- filter above; re-check under the lock (fresh snapshot) and skip it rather than fail the night.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE (j.quote_id = v_quote.id
             OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = v_quote.id))
        AND j.deleted_at IS NULL AND j.status <> 'cancelled'
    );
    -- M1 (2026-06-10): release holds BEFORE the status flip so the AFTER
    -- UPDATE trigger finds 0 active holds and its FK-fragile log insert does
    -- not run. End state identical.
    UPDATE public.inventory_holds SET is_active = false, updated_at = now()
      WHERE source_id = v_quote.id AND is_active = true;
    GET DIAGNOSTICS v_hold_count = ROW_COUNT;
    v_holds_released := v_holds_released + v_hold_count;

    UPDATE public.quotes SET status = 'expired', updated_at = now() WHERE id = v_quote.id;
    v_expired_count := v_expired_count + 1;

    INSERT INTO public.notifications (
      user_id, title, message, notification_type, related_entity_type, related_entity_id
    )
    SELECT
      v_quote.created_by,
      'Quote expired',
      'Quote ' || v_quote.quote_number || ' expired',
      'quote_expired',
      'quote',
      v_quote.id
    FROM public.profiles p
    WHERE v_quote.created_by IS NOT NULL
      AND p.id = v_quote.created_by
      AND p.is_active = true;
  END LOOP;

  -- SEASON END (20261029100000, Mason 2026-10-26): a part-drawn booking stays open past its date
  -- (A5 above), so its rep gets one alert per expiry date to re-check it with the grower. A
  -- re-send sets a new date, which can alert again once it passes. #1959: so does a booking kept
  -- open by a live spray job.
  INSERT INTO public.notifications (
    user_id, title, message, notification_type, related_entity_type, related_entity_id
  )
  SELECT
    q.created_by,
    'Booking past its date',
    'Booking ' || q.quote_number || ' passed its expiry date (' || to_char(q.expires_at, 'Mon DD, YYYY')
      || CASE WHEN EXISTS (
                SELECT 1 FROM public.quote_product_draws d
                WHERE d.quote_id = q.id AND d.quantity_drawn > 0)
              THEN ') with product still to draw. Re-check it with the grower.'
              ELSE ') with a spray job made from it, so it stays open. Re-check it with the grower.'
         END,
    'booking_past_expiry',
    'quote',
    q.id
  FROM public.quotes q
  JOIN public.profiles p ON p.id = q.created_by AND p.is_active = true
  WHERE q.expires_at < CURRENT_DATE
    AND q.status IN ('sent', 'revised')
    AND q.deleted_at IS NULL
    AND (
      (q.is_planned = false AND EXISTS (
        SELECT 1 FROM public.quote_product_draws d
        WHERE d.quote_id = q.id AND d.quantity_drawn > 0
      ))
      -- #1959 (Sol HIGH r4): the scheduler only makes jobs from planned bookings, so a job alerts planned or not.
      OR EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE (j.quote_id = q.id
               OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = q.id))
          AND j.deleted_at IS NULL AND j.status <> 'cancelled'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.related_entity_id = q.id
        AND n.notification_type = 'booking_past_expiry'
        AND n.created_at >= q.expires_at
    );

  IF v_expired_count > 0 THEN
    v_actor := (
      SELECT id
      FROM public.profiles
      WHERE role = 'admin' AND is_active = true
      ORDER BY created_at
      LIMIT 1
    );

    -- Best-effort summary row using a real active admin actor when one exists;
    -- logging must never cancel the expiry work it summarizes.
    IF v_actor IS NOT NULL THEN
      BEGIN
        INSERT INTO public.activity_feed (event_type, description, performed_by)
        VALUES (
          'quotes_auto_expired',
          'Auto-expired ' || v_expired_count || ' quotes, deactivated ' || v_holds_released || ' inventory hold(s)',
          v_actor
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object('expired_count', v_expired_count, 'holds_released', v_holds_released);
END;
$function$;
ALTER FUNCTION public.auto_expire_quotes() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.auto_expire_quotes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_expire_quotes() TO service_role;
