-- Create Invoice on a spray job writes each chemical line's real quantity (Mason, 2026-11-21 and 2026-11-22).
-- Contract: docs/plans/2026-11-21-job-transfer-below-cost-CONTRACT.md ("Redesign: real quantities").
-- actor-binding-check: exempt -- no new caller-facing function; the transfer's public wrapper (transfer_job_to_invoice)
-- and its actor binding and p_idempotency_key are unchanged; the two helpers are not callable by API roles.
--
-- WHY: the transfer wrote each chemical line as quantity 1 with the whole line total as its price, and the below-cost
-- wall compared that total with the cost of ONE stock unit. A 3 fl oz line ($1.17) on a product costing $30 a gallon,
-- and every customer-supplied $0 line, were refused; 10 gallons sold for $250 at $30 a gallon passed. The "1" also
-- reached the restricted-use sales register and the sales reports.
--
-- WHAT (Mason, 2026-11-22: "Redesign", "Allow up to 50c", "$0 info line", "Stop and name it"):
--  1. New private _job_transfer_line_price_20270207 prices one job chemical line the way field-application invoices
--     already do: quantity converted to the product's sold unit (inventory_unit) and rounded to 4 decimals, a price
--     per sold unit (the job's agreed price, converted, nearest cent) and the product's current cost per sold unit,
--     read from the product row locked FOR SHARE. It stops Create Invoice, naming the product, when the unit can't be
--     converted (JOB_LINE_UNIT_UNCONVERTIBLE), the product has no cost (JOB_LINE_COST_MISSING), the exact agreed
--     price is below the exact cost (JOB_LINE_BELOW_COST, never stating the cost), or rounding would move the line's
--     amount or booked cost by more than 50 cents or bill a priced line at $0 (JOB_LINE_ROUNDING).
--  2. New private _job_transfer_split_qty_20270207 allocates a quantity to owners by acre share (largest remainder).
--  3. _transfer_job_to_invoice_intent_impl_20260908 (re-emitted from 20261120100000) writes each line with (1); a
--     multi-owner line gives each owner its allocated quantity at the same price, within 50 cents of its exact share.
--     A customer-supplied product is a $0 information line with no catalog link. Header, member totals and
--     commissions read a line's booked cost as cost x quantity; a single invoice bills the sum of its lines
--     (a field's per-acre price is not billed: Mason, 2026-11-22). A deleted
--     job is refused (JOB_DELETED) and a deleted blend ticket with a live invoice blocks (Sol round 1).
--  The below-cost wall is unchanged: a line priced per sold unit is judged by it exactly. Grants, owners, SECURITY
--  DEFINER and search_path are unchanged. No stored row changes; old invoices keep their quantity-1 lines.
--
-- ROLLBACK: scripts/smoke/job-transfer-below-cost-reverse.sql restores the transfer body and drops the helpers, proven
-- by scripts/smoke/prove-job-transfer-below-cost-real-schema.mjs. Invoices already written keep their real quantities.

DO $preflight$
DECLARE
  v_impl oid := to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)');
BEGIN
  IF v_impl IS NULL
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = v_impl) IS DISTINCT FROM 'a54e3e6a3a2b920e9bcd1a350cd92423'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = v_impl AND p.prosecdef
                       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                       AND p.proowner = 'postgres'::regrole
                       AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]) THEN
    RAISE EXCEPTION 'JOB_BELOW_COST_PREFLIGHT: the transfer body, owner, settings or grants are not the reviewed ones (20261120100000)';
  END IF;
  IF to_regprocedure('public._job_transfer_line_price_20270207(uuid,text,numeric,text,bigint,bigint)') IS NOT NULL
     OR to_regprocedure('public._job_transfer_split_qty_20270207(numeric,numeric[])') IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_BELOW_COST_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public.field_app_priced_quantity(numeric,text,text,text)') IS NULL
     OR to_regprocedure('public.safe_cents_qty(bigint,numeric)') IS NULL
     OR to_regprocedure('public.normalize_rate_unit(text)') IS NULL THEN
    RAISE EXCEPTION 'JOB_BELOW_COST_PREFLIGHT: field_app_priced_quantity, safe_cents_qty or normalize_rate_unit is missing';
  END IF;
  PERFORM set_config('crx.jbc_xid', pg_current_xact_id()::text, true);
END;
$preflight$;

-- 1. One job chemical line, priced per sold unit.
CREATE FUNCTION public._job_transfer_line_price_20270207(
  p_product_id uuid, p_product_name text, p_quantity numeric, p_job_unit text, p_price_per_unit_cents bigint,
  p_cost_per_unit_cents bigint,
  OUT o_quantity numeric, OUT o_unit text, OUT o_unit_price_cents bigint, OUT o_cost_cents bigint,
  OUT o_exact_qty numeric, OUT o_exact_cents numeric, OUT o_exact_cost_cents numeric
)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_name text := COALESCE(NULLIF(btrim(p_product_name), ''), 'A chemical');
  v_cost numeric;
  v_cost_cents bigint;
  v_sold text;
  v_form text;
  v_unit text;
BEGIN
  -- Cost, sold unit and form from one locked product row: the same row the wall reads, unchanged until the line is
  -- written (FOR SHARE).
  SELECT p.current_cost, NULLIF(btrim(p.inventory_unit), ''), p.product_form
    INTO v_cost, v_sold, v_form
    FROM public.products p WHERE p.id = p_product_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF p_quantity IS NULL OR p_quantity::text IN ('NaN', 'Infinity', '-Infinity') OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'JOB_LINE_QUANTITY_INVALID: % has no quantity on this job that can be recorded. Nothing was invoiced; correct the job''s quantity first.', v_name USING ERRCODE = 'P0001';
  END IF;
  -- Spellings are folded the way job completion folds them (normalize_rate_unit: 'fl. oz', 'gallons', 'lbs' ...),
  -- except that a fluid-ounce spelling stays 'fl oz' (so a dry product never reads it as a dry ounce) and a per-area
  -- unit ('/ac', 'per acre': Sol round 3) is never a quantity.
  IF NULLIF(btrim(p_job_unit), '') IS NOT NULL AND position('/' IN p_job_unit) = 0
     AND lower(p_job_unit) !~ '\mper\M' AND v_sold IS NOT NULL THEN
    v_unit := CASE
      WHEN public.normalize_rate_unit(p_job_unit) = 'oz' AND lower(btrim(p_job_unit)) ~ '^(fl|fluid)' THEN 'fl oz'
      ELSE COALESCE(public.normalize_rate_unit(p_job_unit), btrim(p_job_unit)) END;
    o_exact_qty := public.field_app_priced_quantity(p_quantity, v_unit, v_sold, v_form);
  END IF;
  -- Mason, 2026-11-22 ("Stop and name it").
  IF o_exact_qty IS NULL OR o_exact_qty <= 0 THEN
    RAISE EXCEPTION 'JOB_LINE_UNIT_UNCONVERTIBLE: % is recorded on this job in "%", which can''t be converted to the unit it is sold in ("%"). Nothing was invoiced; correct the unit on the job or the product first.', v_name, COALESCE(btrim(p_job_unit), ''), COALESCE(v_sold, 'not set') USING ERRCODE = 'P0001';
  END IF;
  IF v_cost IS NULL OR v_cost::text IN ('NaN', 'Infinity', '-Infinity') OR v_cost <= 0 OR v_cost <> round(v_cost, 2) THEN
    RAISE EXCEPTION 'JOB_LINE_COST_MISSING: % has no cost recorded. Nothing was invoiced; an admin must set the product''s cost first.', v_name USING ERRCODE = 'P0001';
  END IF;
  v_cost_cents := round(v_cost * 100)::bigint;
  o_exact_cents := p_quantity * COALESCE(p_price_per_unit_cents, 0);
  -- Sol round 3: the line books the job's own saved cost (as before this change), per sold unit; only the below-cost
  -- check reads today's catalog cost, as the wall does.
  o_exact_cost_cents := p_quantity * COALESCE(p_cost_per_unit_cents, 0);
  o_cost_cents := round(o_exact_cost_cents / o_exact_qty)::bigint;
  -- Exact, before any rounding: the agreed amount must cover the cost of the whole quantity. Never states the cost
  -- (cost is admin-only, 2026-10-15). No override (Mason, 2026-11-21).
  IF o_exact_cents < v_cost_cents * o_exact_qty THEN
    RAISE EXCEPTION 'JOB_LINE_BELOW_COST: % is priced below its cost on this job. Nothing was invoiced; its price must be corrected before this job can be invoiced.', v_name USING ERRCODE = 'P0001';
  END IF;
  -- At or above cost exactly, so the nearest whole cent per sold unit is too (the cost is whole cents).
  o_unit_price_cents := round(o_exact_cents / o_exact_qty)::bigint;
  o_quantity := round(o_exact_qty, 4);
  o_unit := v_sold;
  -- Mason, 2026-11-22 ("Allow up to 50c"): the line stores 4 decimals; refuse when that moves its amount or booked cost
  -- by more than 50 cents, bills a priced line at $0, or does not fit the column.
  IF o_quantity <= 0 OR o_quantity >= 100000000
     OR abs(public.safe_cents_qty(o_unit_price_cents, o_quantity) - o_exact_cents) > 50
     OR abs(public.safe_cents_qty(o_cost_cents, o_quantity) - o_exact_cost_cents) > 50
     OR (o_exact_cents > 0 AND public.safe_cents_qty(o_unit_price_cents, o_quantity) = 0) THEN
    RAISE EXCEPTION 'JOB_LINE_ROUNDING: % can''t be recorded to 4 decimals in % without its amount changing by more than $0.50. Nothing was invoiced; record this product in a smaller sold unit first.', v_name, v_sold USING ERRCODE = 'P0001';
  END IF;
END;
$function$;
ALTER FUNCTION public._job_transfer_line_price_20270207(uuid, text, numeric, text, bigint, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_transfer_line_price_20270207(uuid, text, numeric, text, bigint, bigint)
  FROM PUBLIC, anon, authenticated, service_role;

-- 2. A quantity allocated by weight in steps of 0.0001 (largest remainder; ties to the earlier owner).
CREATE FUNCTION public._job_transfer_split_qty_20270207(p_quantity numeric, p_weights numeric[])
 RETURNS numeric[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_units bigint := round(p_quantity * 10000)::bigint;
  v_total numeric := (SELECT sum(GREATEST(w, 0)) FROM unnest(p_weights) w);
  v_base bigint[] := '{}';
  v_left bigint;
  v_i integer;
BEGIN
  IF v_total IS NULL OR v_total <= 0 THEN
    RAISE EXCEPTION 'JOB_SPLIT_INVALID: the owners'' shares of this job add up to nothing' USING ERRCODE = 'P0001';
  END IF;
  FOR v_i IN 1 .. array_length(p_weights, 1) LOOP
    v_base := array_append(v_base, floor(v_units * GREATEST(p_weights[v_i], 0) / v_total)::bigint);
  END LOOP;
  v_left := v_units - (SELECT sum(b) FROM unnest(v_base) b);
  FOR v_i IN
    SELECT u.ord FROM unnest(p_weights) WITH ORDINALITY AS u(w, ord)
     ORDER BY (v_units * GREATEST(u.w, 0) / v_total) - floor(v_units * GREATEST(u.w, 0) / v_total) DESC, u.ord
     LIMIT v_left
  LOOP
    v_base[v_i] := v_base[v_i] + 1;
  END LOOP;
  RETURN ARRAY(SELECT b / 10000.0 FROM unnest(v_base) b);
END;
$function$;
ALTER FUNCTION public._job_transfer_split_qty_20270207(numeric, numeric[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_transfer_split_qty_20270207(numeric, numeric[])
  FROM PUBLIC, anon, authenticated, service_role;

-- 3. The transfer, from 20261120100000: real quantities, the deleted-job and deleted-ticket refusals.
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
  v_line RECORD;
  v_qtys numeric[];
  v_line_sum bigint := 0;
  v_owner_ext bigint;
  v_owners_ext bigint;
  v_owners_cost bigint;
  v_share RECORD;
  v_share_total bigint := 0;
  v_has_price_override boolean := false;
  v_share_cum_pct numeric := 0;
  v_share_cum_cents bigint := 0;
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
  -- 20270207125000 (Sol round 1 MED): a deleted job is never invoiced, even from a screen opened before it was deleted.
  IF v_job.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_DELETED: this job was deleted, so it can''t be invoiced. Nothing was invoiced.' USING ERRCODE = 'P0001';
  END IF;
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
      -- 20270207125000 (Sol round 1): a soft-deleted ticket blocks too while its invoice is live; voiding that invoice
      -- unblocks it (the Codex R2 P2 "block forever" case is the voided one).
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
    -- 20270207125000 (Mason, 2026-11-22: "we never bill flat per acre it is always summary of chemical and sales
    -- lines"): a field's per-acre price is not used by Create Invoice, so it no longer refuses a multi-owner job.

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
           jc.price_per_unit_cents AS job_price, jc.cost_per_unit_cents AS job_cost,
             jc.quantity,
             jc.customer_supplied, jc.unit AS job_unit,
             p.product_name, COALESCE(NULLIF(btrim(jc.unit), ''), p.unit_size) AS unit_size, p.epa_registration, p.product_form,
             COALESCE(NULLIF(btrim(jc.rate_unit), ''), NULLIF(btrim(jc.unit), ''), p.unit_size) AS rate_unit
      FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
      WHERE jc.job_id = p_job_id ORDER BY p.product_name
      -- 20270207125000 (Luna): each product row stays as read (form, name, EPA number) until its line is written.
      FOR SHARE OF p
    LOOP
      v_item_order := v_item_order + 1;
      -- 20270207125000 (Mason, 2026-11-22, "Redesign"): the line carries its real quantity in the product's sold unit,
      -- priced and checked once for the whole job line, then the quantity is allocated to the owners by acre share
      -- (largest remainder, so the owners' quantities add up to the line's).
      IF v_chem.customer_supplied THEN
        IF ROUND(COALESCE(v_chem.quantity, 0), 4) <= 0 THEN
          RAISE EXCEPTION 'JOB_LINE_QUANTITY_INVALID: % has no quantity on this job that can be recorded. Nothing was invoiced; correct the job''s quantity first.', v_chem.product_name USING ERRCODE = 'P0001';
        END IF;
        v_qtys := public._job_transfer_split_qty_20270207(ROUND(v_chem.quantity, 4), v_acre_pcts);
      ELSE
        SELECT * INTO v_line FROM public._job_transfer_line_price_20270207(
          v_chem.product_id, v_chem.product_name, v_chem.quantity, v_chem.job_unit, v_chem.job_price, v_chem.job_cost);
        v_qtys := public._job_transfer_split_qty_20270207(v_line.o_quantity, v_acre_pcts);
      END IF;
      v_owners_ext := 0;
      v_owners_cost := 0;

      FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
        v_member_acres := v_owner_acres[v_oidx];
        -- Owner's applied amount = rate x their acres (their slice of the uniform-rate application).
        v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_member_acres > 0
          THEN v_chem.rate_per_acre * v_member_acres ELSE NULL END;
        SELECT * INTO v_conversion
          FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);

        IF v_chem.customer_supplied THEN
          CONTINUE WHEN v_qtys[v_oidx] <= 0;
          -- The grower's own product: a $0 information line with no catalog link (Mason, 2026-11-22, "$0 info line"):
          -- never a sale of ours, so no below-cost check, restricted-use sales record or sales report counts it.
          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
            cost_cents, sort_order, acres, rate_per_acre, rate_unit,
            total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
            epa_registration, product_form, is_application_fee, price_source
          ) VALUES (
            v_member_ids[v_oidx], NULL, v_chem.product_name || ' (customer supplied)',
            v_qtys[v_oidx], v_chem.unit_size, 0, 0, 0,
            v_item_order, v_member_acres,
            v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
            COALESCE(v_chem.rate_unit, v_chem.unit_size),
            v_conversion.converted_value, v_conversion.converted_unit,
            v_chem.epa_registration, v_chem.product_form, false, 'manual'
          );
        ELSE
          v_owner_ext := safe_cents_qty(v_line.o_unit_price_cents, v_qtys[v_oidx]);
          -- Mason, 2026-11-22 ("Allow up to 50c"): each owner's line within 50 cents of its exact share, never $0.
          IF v_acre_pcts[v_oidx] > 0 AND (
               v_qtys[v_oidx] <= 0
               OR (v_owner_ext = 0 AND v_line.o_exact_cents > 0)
               OR abs(v_owner_ext - v_line.o_exact_cents * v_acre_pcts[v_oidx] / 100) > 50
               OR abs(safe_cents_qty(v_line.o_cost_cents, v_qtys[v_oidx])
                      - v_line.o_exact_cost_cents * v_acre_pcts[v_oidx] / 100) > 50) THEN
            RAISE EXCEPTION 'JOB_LINE_ROUNDING: % can''t be split between this job''s owners to 4 decimals in % without an owner''s amount changing by more than $0.50. Nothing was invoiced; record this product in a smaller sold unit, or invoice the owners from the field-application editor.', v_chem.product_name, v_line.o_unit USING ERRCODE = 'P0001';
          END IF;
          v_owners_ext := v_owners_ext + v_owner_ext;
          v_owners_cost := v_owners_cost + safe_cents_qty(v_line.o_cost_cents, v_qtys[v_oidx]);
          CONTINUE WHEN v_qtys[v_oidx] <= 0;
          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
            cost_cents, sort_order, acres, rate_per_acre, rate_unit,
            total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
            epa_registration, product_form, is_application_fee, price_source
          ) VALUES (
            v_member_ids[v_oidx], v_chem.product_id, v_chem.product_name,
            v_qtys[v_oidx], v_line.o_unit, v_line.o_unit_price_cents, v_owner_ext, v_line.o_cost_cents,
            v_item_order, v_member_acres,
            v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
            COALESCE(v_chem.rate_unit, v_chem.unit_size),
            v_conversion.converted_value, v_conversion.converted_unit,
            v_chem.epa_registration, v_chem.product_form, false, 'manual'
          );
        END IF;
      END LOOP;
      -- Luna round 3: the owners' lines together also stay within 50 cents of the whole line (Mason, "Allow up to 50c").
      IF NOT v_chem.customer_supplied AND (abs(v_owners_ext - v_line.o_exact_cents) > 50
                                           OR abs(v_owners_cost - v_line.o_exact_cost_cents) > 50) THEN
        RAISE EXCEPTION 'JOB_LINE_ROUNDING: % can''t be split between this job''s owners to 4 decimals in % without the line''s total or cost changing by more than $0.50. Nothing was invoiced; record this product in a smaller sold unit, or invoice the owners from the field-application editor.', v_chem.product_name, v_line.o_unit USING ERRCODE = 'P0001';
      END IF;
    END LOOP;

    -- Per-owner totals, per-acre application fee, header flip, and per-member commission.
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      v_member_id := v_member_ids[v_oidx];
      v_member_acres := v_owner_acres[v_oidx];

      -- 20270207125000: a chemical line's cost is per sold unit; its booked cost is cost x quantity.
      SELECT COALESCE(SUM(extended_cents), 0), COALESCE(SUM(safe_cents_qty(COALESCE(cost_cents, 0), quantity)), 0)
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
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - safe_cents_qty(COALESCE(ii.cost_cents, 0), COALESCE(ii.quantity, 1))), 0)
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
           jc.price_per_unit_cents AS job_price, jc.cost_per_unit_cents AS job_cost,
           jc.quantity, jc.customer_supplied, jc.unit AS job_unit,
           p.product_name, COALESCE(NULLIF(btrim(jc.unit), ''), p.unit_size) AS unit_size, p.epa_registration, p.product_form,
           COALESCE(NULLIF(btrim(jc.rate_unit), ''), NULLIF(btrim(jc.unit), ''), p.unit_size) AS rate_unit
    FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id ORDER BY p.product_name
      -- 20270207125000 (Luna): each product row stays as read (form, name, EPA number) until its line is written.
      FOR SHARE OF p
  LOOP
    v_item_order := v_item_order + 1;
    -- U4<<< a grower-supplied product costs us nothing (we didn't buy it) — keep
    -- it OUT of the invoice cost so margin isn't understated. (#53/#54)
    -- >>>U4
    v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_total_acres > 0
      THEN v_chem.rate_per_acre * v_total_acres ELSE NULL END;
    -- DELTA-6: call convert_to_gl_lb unconditionally so v_conversion always receives a
    -- tuple structure (the helper returns one row even for NULL inputs); an unrated line
    -- yields (NULL, NULL) without leaving v_conversion unassigned.
    SELECT * INTO v_conversion
      FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);
    -- 20270207125000 (Mason, 2026-11-22, "Redesign"): the line carries its real quantity in the product's sold unit,
    -- with a price and cost per sold unit (_job_transfer_line_price_20270207 checks it against cost and rounding).
    IF v_chem.customer_supplied THEN
      IF ROUND(COALESCE(v_chem.quantity, 0), 4) <= 0 THEN
        RAISE EXCEPTION 'JOB_LINE_QUANTITY_INVALID: % has no quantity on this job that can be recorded. Nothing was invoiced; correct the job''s quantity first.', v_chem.product_name USING ERRCODE = 'P0001';
      END IF;
      -- The grower's own product: a $0 information line with no catalog link (Mason, 2026-11-22, "$0 info line").
      INSERT INTO invoice_items (
        invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
        epa_registration, product_form, is_application_fee, price_source
      ) VALUES (
        v_invoice_id, NULL, v_chem.product_name || ' (customer supplied)',
        ROUND(v_chem.quantity, 4), v_chem.unit_size, 0, 0, 0,
        v_item_order, v_total_acres,
        v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
        COALESCE(v_chem.rate_unit, v_chem.unit_size),
        v_conversion.converted_value, v_conversion.converted_unit,
        v_chem.epa_registration, v_chem.product_form, false, 'manual'
      );
    ELSE
      SELECT * INTO v_line FROM public._job_transfer_line_price_20270207(
        v_chem.product_id, v_chem.product_name, v_chem.quantity, v_chem.job_unit, v_chem.job_price, v_chem.job_cost);
      v_owner_ext := safe_cents_qty(v_line.o_unit_price_cents, v_line.o_quantity);
      v_line_sum := v_line_sum + v_owner_ext;
      v_total_cost_cents := v_total_cost_cents + safe_cents_qty(v_line.o_cost_cents, v_line.o_quantity);
      INSERT INTO invoice_items (
        invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
        epa_registration, product_form, is_application_fee, price_source
      ) VALUES (
        v_invoice_id, v_chem.product_id, v_chem.product_name,
        v_line.o_quantity, v_line.o_unit, v_line.o_unit_price_cents, v_owner_ext, v_line.o_cost_cents,
        v_item_order, v_total_acres,
        v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
        COALESCE(v_chem.rate_unit, v_chem.unit_size),
        v_conversion.converted_value, v_conversion.converted_unit,
        v_chem.epa_registration, v_chem.product_form, false, 'manual'
      );
    END IF;
  END LOOP;

  -- 20270207125000: the header bills the lines as written (they differ from the job's own total only by the rounding
  -- allowed above).
  UPDATE invoices SET total_amount_cents = v_line_sum, total_cost_cents = v_total_cost_cents WHERE id = v_invoice_id;

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
        row_number() OVER (ORDER BY bool_or(fbd.is_primary) DESC, c.farm_name) AS sort_ord,
        sum(CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
          THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
          ELSE avg(fbd.split_pct) END) OVER () AS pct_total
      FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      JOIN customers c ON c.id = fbd.customer_id WHERE jf.job_id = p_job_id
      GROUP BY fbd.customer_id, c.farm_name
    LOOP
      DECLARE v_amount bigint; v_ppa bigint;
      BEGIN
        -- 20270207125000 (Mason, 2026-11-22: "we never bill flat per acre it is always summary of chemical and sales
        -- lines"): each share is its part of the lines; a field's per-acre price is not billed, so the per-acre
        -- application fee below applies as on any other field. Luna round 2: the shares split exactly the lines
        -- (cumulative rounding over the shares' own percentage total), so a 99.99% split still bills every cent.
        v_share_cum_pct := v_share_cum_pct + v_share.avg_split_pct;
        v_amount := ROUND(v_line_sum * v_share_cum_pct / v_share.pct_total)::bigint - v_share_cum_cents;
        v_share_cum_cents := v_share_cum_cents + v_amount;
        v_ppa := NULL;
        INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order, price_per_acre_cents, pricing_note)
        VALUES (v_invoice_id, v_share.customer_id, v_share.farm_name, v_share.avg_split_pct,
                v_total_acres * v_share.avg_split_pct / v_share.pct_total, v_amount, v_share.is_primary, v_share.sort_ord, v_ppa, v_share.pricing_note);
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
    SELECT v_invoice_id, v_job.customer_id, c.farm_name, 100.0, v_total_acres, v_line_sum, true, 1
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
  SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - safe_cents_qty(COALESCE(ii.cost_cents, 0), COALESCE(ii.quantity, 1))), 0)
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

DO $postflight$
DECLARE
  v_price oid := to_regprocedure('public._job_transfer_line_price_20270207(uuid,text,numeric,text,bigint,bigint)');
  v_split oid := to_regprocedure('public._job_transfer_split_qty_20270207(numeric,numeric[])');
BEGIN
  IF current_setting('crx.jbc_xid', true) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'JOB_BELOW_COST_POSTFLIGHT: the preflight did not run in this transaction; apply this file as ONE transaction';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM 'c685e841177fd393addc61478a5599dd'
     OR v_price IS NULL OR v_split IS NULL
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = v_price) IS DISTINCT FROM '83bf627f71685d3ff96b9352f48daaa1'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = v_split) IS DISTINCT FROM '265dd41fceb98f8c7721d496bbe47d81' THEN
    RAISE EXCEPTION 'JOB_BELOW_COST_POSTFLIGHT: a body is not the one this file installs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)'::regprocedure
                    AND p.prosecdef AND p.proowner = 'postgres'::regrole
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                    AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[])
     OR EXISTS (SELECT 1 FROM pg_proc p
                 WHERE p.oid IN (v_price, v_split)
                   AND (p.prosecdef OR p.proowner <> 'postgres'::regrole
                        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]))
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid IN (v_price, v_split) AND a.privilege_type = 'EXECUTE' AND a.grantee <> 'postgres'::regrole) THEN
    RAISE EXCEPTION 'JOB_BELOW_COST_POSTFLIGHT: owner, settings or grants are not as reviewed';
  END IF;
END;
$postflight$;
