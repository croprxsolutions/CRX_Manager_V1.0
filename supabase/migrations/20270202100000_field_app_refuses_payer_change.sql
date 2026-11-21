-- Written 2026-11-21. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270202100000_field_app_refuses_payer_change.md.
--
-- WHY (#2058, #2070, release #1990 Sol, already live before that release): editing a STANDALONE field-application
--   invoice (one payer, no group) through save_field_app_invoice
--   1. so every field belongs to another farm reused the invoice for the new payer but never changed its customer_id,
--      so the old farm would be billed for the new farm's work (#2070: header and pricing then disagree);
--   2. so the fields split across several payers left the original invoice live with its old total and no lines
--      (its lines were deleted; every payer got a new draft).
--   Live 2026-11-21 (read-only): 3 field-application invoices; neither shape exists.
--
-- WHAT (Mason, 2026-11-21: "refuse the save ... explain the problem"): _save_field_app_invoice_impl_20260714 refuses
--   that save with FIELD_APP_PAYER_CHANGED and a plain sentence naming the farm(s) the fields now bill, the farm the
--   invoice bills, and what to do (make a new invoice for those fields; delete or void this one). Nothing is written.
--   An invoice never changes which farm it bills; grouped invoices keep their existing rules. Contract:
--   docs/plans/2026-11-21-field-app-refuses-payer-change-CONTRACT.md.
--
-- NOT CHANGED: everything else in the body (pinned below), its owner, grants, SECURITY DEFINER and search_path
--   (CREATE OR REPLACE keeps them), every other function, table, row and policy.
--
-- ROLLBACK (its own reviewed migration): re-emit the body from
--   20270129171000_field_app_refuses_product_without_sold_unit.sql (md5 1a4a2655e43392d867b195289df9b9a1).
--
-- ORDERING: after 20270129171000. Not re-runnable (preflight refuses). Postflight pins the new body md5 b594d6f12001cccf5fbe41d5dbf6ec2c.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)'))
     IS DISTINCT FROM '1a4a2655e43392d867b195289df9b9a1' THEN
    RAISE EXCEPTION 'FIELD_APP_STANDALONE_DRAFT_PREFLIGHT: _save_field_app_invoice_impl_20260714 is not the reviewed body (missing, drifted or already replaced)';
  END IF;
END;
$preflight$;

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
  v_existing_customer_id uuid;
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
    RAISE EXCEPTION 'ACTOR_MISMATCH';
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
    SELECT status, invoice_group_id, customer_id INTO v_existing_status, v_existing_group_id, v_existing_customer_id
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

  -- #2058/#2070: a standalone invoice bills one farm for good. When its fields now bill another farm, or several,
  -- refuse with a sentence the office can act on (Mason, 2026-11-21) rather than move or orphan the invoice.
  IF p_invoice_id IS NOT NULL AND v_existing_group_id IS NULL AND (v_customer_count > 1 OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_customers) c WHERE (c->>'customer_id')::uuid = v_existing_customer_id)) THEN
    RAISE EXCEPTION 'FIELD_APP_PAYER_CHANGED: Nothing was saved. The fields on this invoice now bill %, but invoice % bills %, and an invoice cannot change which farm it bills. Make a new field application invoice for these fields, then delete this one (void it if it was posted), or put back the fields for %.',
      (SELECT string_agg(COALESCE(NULLIF(btrim(c->>'customer_name'), ''), 'another farm'), ' and ' ORDER BY c->>'customer_name')
         FROM jsonb_array_elements(v_customers) c),
      (SELECT invoice_number FROM invoices WHERE id = p_invoice_id),
      (SELECT farm_name FROM customers WHERE id = v_existing_customer_id),
      (SELECT farm_name FROM customers WHERE id = v_existing_customer_id);
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
          IF (v_chem->>'product_id') IS NOT NULL AND COALESCE(v_inv_unit, '') !~ '[[:alnum:]]' THEN
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
            -- #1990 Sol: and that is billed per unit here, on some acres; a per-acre field's quote, or one on a field
            -- whose share rounds to no acres, never prices another field's units.
            v_qi_price := public._field_app_sent_quote_price_cents(
                            (v_chem->>'product_id')::uuid,
                            ARRAY(SELECT DISTINCT (r->>'field_id')::uuid FROM jsonb_array_elements(v_shares -> 'rows') r
                                     WHERE (r->>'customer_id')::uuid = v_customer_id AND COALESCE((r->>'split_pct')::numeric, 0) > 0 AND COALESCE((r->>'share_acres')::numeric, 0) > 0 AND (r->>'price_override_cents') IS NULL),
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
          -- #1990 Sol: a product with no sold unit has no unit its price is per (the sent-quote check reads unit_size,
          -- this would price the rate unit), so refuse it here as the grower share already does.
          IF (v_chem->>'product_id') IS NOT NULL AND COALESCE(v_inv_unit, '') !~ '[[:alnum:]]' THEN
            RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: cannot price "%" — the product has no sold unit. Fix this product''s units before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id'));
          END IF;
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

DO $postflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)'))
     IS DISTINCT FROM 'b594d6f12001cccf5fbe41d5dbf6ec2c' THEN
    RAISE EXCEPTION 'FIELD_APP_STANDALONE_DRAFT_POSTFLIGHT: _save_field_app_invoice_impl_20260714 is not the reviewed new body';
  END IF;
END;
$postflight$;
