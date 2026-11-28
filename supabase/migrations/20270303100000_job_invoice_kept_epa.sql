-- #2341: Create Invoice on a sprayed job, and the restricted-use capture of its lines, use the EPA number the job kept
-- for each product (job_product_epa), not the catalog's current one.
-- Contract: docs/plans/2026-11-24-job-invoice-kept-epa-CONTRACT.md.
-- actor-binding-check: exempt -- no new caller-facing function; the transfer's public wrapper (transfer_job_to_invoice)
-- and its actor binding and p_idempotency_key are unchanged; the new helper and the capture trigger function are not
-- callable by API roles.
--
-- Written 2026-11-24. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270303100000_job_invoice_kept_epa.md. Re-read the live ledger before applying.
--
-- WHY: a sprayed job keeps each product's EPA number (20261204120000, Mason 2026-11-06 "lock per product") and its
--   printouts show it (KI-195). Create Invoice still copied the catalog's current number onto the invoice lines, and
--   the restricted-use capture of every line stores the catalog's number, so a number corrected after the spray put
--   the new number on the job's invoice and restricted-use record (Sol round 10 on #2247, tracked by Mason 2026-11-23).
--
-- WHAT:
--   1. New private _job_kept_epa(job, product): the number the job kept for the product; NULL when it kept none, kept it
--      with no number, or it is "Not recorded". Owner postgres, no API grant.
--   2. _transfer_job_to_invoice_intent_impl_20260908 (re-emitted from 20270226150000, md5 pinned): both chemical reads
--      (single invoice and owner group) take the kept number, else the catalog's as before. Nothing else changes.
--   3. _capture_invoice_line_rup (re-emitted from 20270106110000, md5 pinned, live): a line on an invoice made from a
--      job whose own number is the number the job kept for its product (as Create Invoice writes it) stores that
--      number (normalized as captures are) with that registration's signal word (else the product's), and is Yes when
--      that registration says Yes (any Yes still wins). Every other line (no kept number, a line added under another
--      number, an invoice not made from a job) is captured exactly as before. Brand captures and the re-capture rule
--      are unchanged.
--   No row changes (live 2026-11-24: no kept rows, no job invoices). The preflight stops if an open job invoice
--   already has a line whose number differs from the job's kept number (it would post under the catalog's). Owners, SECURITY DEFINER, search_path and grants of
--   both re-emitted functions are unchanged.
--
-- NOT CHANGED: generate_rup_sales_records (its own capture insert runs only for a line with no capture; the capture
--   trigger writes one on every line insert once the REG-1 seed ran, which live has); brand captures (a job's lines have
--   no delivery brands); invoices not made from a job; REI/PHI intervals (#2329).
--
-- ROLLBACK (its own reviewed migration): re-emit the transfer body from 20270226150000 and the capture body from
--   20270106110000 (both md5-pinned below), then drop _job_kept_epa. Lines and captures written meanwhile keep the
--   kept numbers, which are the numbers the jobs were sprayed with.
--
-- ORDERING: after 20270226150000 (whose transfer body this pins).

SET LOCAL lock_timeout = '5s';
-- Luna: Create Invoice takes its job FOR UPDATE. EXCLUSIVE waits for every transfer holding a job, so the open-invoice
-- check below sees their lines, and holds later ones until this file commits. Residual: a transfer already inside the
-- old body and waiting for its job finishes with the old body (apply outside office hours; live has no job invoices).
LOCK TABLE public.jobs IN EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_transfer oid := to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)');
  v_capture oid := to_regprocedure('public._capture_invoice_line_rup()');
BEGIN
  IF v_transfer IS NULL
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = v_transfer) IS DISTINCT FROM 'aa385acd9adb57eadb0a52ac37b833d8' THEN
    RAISE EXCEPTION 'JOB_INVOICE_KEPT_EPA_PREFLIGHT: the transfer body is not the reviewed one (20270226150000)';
  END IF;
  IF v_capture IS NULL
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = v_capture) IS DISTINCT FROM '5fb2eb8c484b08242a46f647f9d09ec4' THEN
    RAISE EXCEPTION 'JOB_INVOICE_KEPT_EPA_PREFLIGHT: the restricted-use capture body is not the reviewed one (20270106110000)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (v_transfer, v_capture)
              AND NOT COALESCE(p.prosecdef AND p.proowner = 'postgres'::regrole
                       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                       AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[], false)) THEN
    RAISE EXCEPTION 'JOB_INVOICE_KEPT_EPA_PREFLIGHT: an owner, setting or grant of the transfer or capture is not the reviewed one';
  END IF;
  IF to_regclass('public.job_product_epa') IS NULL OR to_regprocedure('public._normalize_epa_registration(text)') IS NULL THEN
    RAISE EXCEPTION 'JOB_INVOICE_KEPT_EPA_PREFLIGHT: job_product_epa or _normalize_epa_registration is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices i
               JOIN public.invoice_items x ON x.invoice_id = i.id
               JOIN public.job_product_epa k ON k.job_id = i.job_id AND k.product_id = x.product_id AND NOT k.not_recorded
                                          AND k.epa_registration IS NOT NULL
              WHERE i.status IN ('draft', 'unposted') AND i.deleted_at IS NULL
                AND public._normalize_epa_registration(x.epa_registration)
                    IS DISTINCT FROM public._normalize_epa_registration(k.epa_registration)) THEN
    RAISE EXCEPTION 'JOB_INVOICE_KEPT_EPA_PREFLIGHT: an open job invoice has a line whose EPA number is not the job''s kept number; correct it first';
  END IF;
  IF to_regprocedure('public._job_kept_epa(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_INVOICE_KEPT_EPA_PREFLIGHT: already applied';
  END IF;
END;
$preflight$;

-- 1. The number a job kept for a product.
CREATE FUNCTION public._job_kept_epa(p_job_id uuid, p_product_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$
  SELECT k.epa_registration FROM public.job_product_epa k
   WHERE k.job_id = p_job_id AND k.product_id = p_product_id AND NOT k.not_recorded;
$function$;
ALTER FUNCTION public._job_kept_epa(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_kept_epa(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 2. Create Invoice (re-emitted from 20270226150000; only the two chemical reads change).
CREATE OR REPLACE FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_unsplit_fields text;
  v_payer_id uuid;
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
  -- ==========================================================================
  -- 20270226150000 (Mason, 2026-11-22: every field has a billing split, 100% or shared; each owner is billed the
  -- acres of their own fields; invoices bill the payer saved on the job): each field's payers are the split saved on
  -- the job, else its Field Setup split (_job_transfer_shares_20270207); a field with neither stops Create Invoice by
  -- name, never falling back to a payer (Sol round 5).
  -- Sol round 6: the fields and their Field Setup splits are locked first (FOR SHARE; Field Setup's save_field updates
  -- the field row before replacing its splits). Sol round 8: the job's own fields, chemicals and saved split can't
  -- change meanwhile: their lock trigger waits for this job row (held FOR UPDATE above) and then refuses an invoiced job.
  PERFORM 1 FROM job_fields jf JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = p_job_id ORDER BY f.id FOR SHARE OF f;
  PERFORM 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id ORDER BY fbd.id FOR SHARE OF fbd;
  SELECT string_agg(f.field_name, ', ' ORDER BY f.field_name) INTO v_unsplit_fields
    FROM job_fields jf JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = p_job_id
      AND NOT EXISTS (SELECT 1 FROM public._job_transfer_shares_20270207(p_job_id) s WHERE s.field_id = jf.field_id);
  IF v_unsplit_fields IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_FIELD_NO_BILLING_SPLIT: % has no billing split. Nothing was invoiced; set who pays for it (100%% or a shared split) in Field Setup first.', v_unsplit_fields USING ERRCODE = 'P0001';
  END IF;

  SELECT count(DISTINCT s.customer_id) INTO v_n_owners FROM public._job_transfer_shares_20270207(p_job_id) s;

  IF COALESCE(v_n_owners, 0) > 1 THEN
    -- 20270207125000 (Mason, 2026-11-22: "we never bill flat per acre it is always summary of chemical and sales
    -- lines"): a field's per-acre price is not used by Create Invoice, so it no longer refuses a multi-owner job.

    -- Validate every billed field's splits total 100 (mirror FIELD_SPLIT_NOT_100), so the
    -- owner acre shares sum to the job acres and calculate_billing_splits stays penny-exact.
    IF EXISTS (
      SELECT 1 FROM public._job_transfer_shares_20270207(p_job_id) s
      GROUP BY s.field_id HAVING sum(s.split_pct) < 99.99 OR sum(s.split_pct) > 100.01
    ) THEN
      RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: one or more of this job''s fields has billing splits that do not total 100%%. Fix the field billing defaults before invoicing.';
    END IF;

    -- Ordered owner arrays (stable ORDER BY owner_id) with each owner's BILLABLE ACRES:
    -- each field contributes acres_to_treat * split_pct/100 (every field has a split: checked and locked above).
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
        SELECT s.customer_id AS owner_id,
               COALESCE(s.acres_to_treat, 0) * s.split_pct / 100.0 AS billable_acres,
               s.is_primary, c.farm_name
          FROM public._job_transfer_shares_20270207(p_job_id) s
          JOIN customers c ON c.id = s.customer_id
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
          FROM public._job_transfer_shares_20270207(p_job_id) s
          JOIN fields f ON f.id = s.field_id
          WHERE s.customer_id = v_owner_ids[v_oidx]
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
        -- Sol r9 (Mason, 2026-11-22): job notes print only on the job customer's own invoice.
        v_job.job_date, CASE WHEN v_owner_ids[v_oidx] = v_job.customer_id THEN v_job.notes END,
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
           jc.price_per_unit_cents AS job_price,
             jc.quantity,
             jc.customer_supplied, jc.unit AS job_unit,
             p.product_name, COALESCE(NULLIF(btrim(jc.unit), ''), p.unit_size) AS unit_size,
             -- #2341: the EPA number the job kept for this product, else the catalog's (as before).
             COALESCE(public._job_kept_epa(p_job_id, jc.product_id), p.epa_registration) AS epa_registration, p.product_form,
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
          v_chem.product_id, v_chem.product_name, v_chem.quantity, v_chem.job_unit, v_chem.job_price);
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
      -- Sol round 4: nested, so a customer-supplied line never reads v_line (unassigned when it is the job's first line).
      IF NOT v_chem.customer_supplied THEN
        IF abs(v_owners_ext - v_line.o_exact_cents) > 50 OR abs(v_owners_cost - v_line.o_exact_cost_cents) > 50 THEN
          RAISE EXCEPTION 'JOB_LINE_ROUNDING: % can''t be split between this job''s owners to 4 decimals in % without the line''s total or cost changing by more than $0.50. Nothing was invoiced; record this product in a smaller sold unit, or invoice the owners from the field-application editor.', v_chem.product_name, v_line.o_unit USING ERRCODE = 'P0001';
        END IF;
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
    SELECT 1 FROM public._job_transfer_shares_20270207(p_job_id) s
    GROUP BY s.field_id HAVING sum(s.split_pct) < 99.99 OR sum(s.split_pct) > 100.01
  ) THEN
    RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: one or more of this job''s fields has billing splits that do not total 100%%. Fix the field billing defaults before invoicing.';
  END IF;

  -- Sol round 6 (Mason, 2026-11-22: each owner is billed for their own fields' acres): a job whose fields are all
  -- billed to one owner is invoiced to that owner (header, receivable, restricted-use buyer, commissions), even when
  -- the job's own customer is someone else; a job with no fields stays on the job's customer. Sol round 8: the payer
  -- saved on the job, the one its screen names.
  SELECT s.customer_id INTO v_payer_id FROM public._job_transfer_shares_20270207(p_job_id) s LIMIT 1;
  v_payer_id := COALESCE(v_payer_id, v_job.customer_id);

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
    v_invoice_number, v_payer_id, 'field_application', 'draft',
    (now() AT TIME ZONE 'America/Chicago')::date, NULL::date,  -- KI-14: the due-date trigger derives it from this owner's terms
    COALESCE(v_job.total_price_cents, 0), 0, 0, 0,
    v_field_names, v_crop_type, v_total_acres, v_applicator_name, v_vehicle_name,
    -- Sol r9 (Mason, 2026-11-22): job notes print only on the job customer's own invoice.
    v_job.job_date, CASE WHEN v_payer_id = v_job.customer_id THEN v_job.notes END,
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
           jc.price_per_unit_cents AS job_price,
           jc.quantity, jc.customer_supplied, jc.unit AS job_unit,
           p.product_name, COALESCE(NULLIF(btrim(jc.unit), ''), p.unit_size) AS unit_size,
             -- #2341: the EPA number the job kept for this product, else the catalog's (as before).
             COALESCE(public._job_kept_epa(p_job_id, jc.product_id), p.epa_registration) AS epa_registration, p.product_form,
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
        v_chem.product_id, v_chem.product_name, v_chem.quantity, v_chem.job_unit, v_chem.job_price);
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

  IF EXISTS (SELECT 1 FROM public._job_transfer_shares_20270207(p_job_id)) THEN
    FOR v_share IN
      SELECT s.customer_id, c.farm_name,
        CASE WHEN sum(COALESCE(s.acres_to_treat, 0)) > 0
          THEN sum(s.split_pct * COALESCE(s.acres_to_treat, 0)) / sum(COALESCE(s.acres_to_treat, 0))
          ELSE avg(s.split_pct) END AS avg_split_pct,
        sum(COALESCE(s.acres_to_treat, 0)) *
          CASE WHEN sum(COALESCE(s.acres_to_treat, 0)) > 0
            THEN sum(s.split_pct * COALESCE(s.acres_to_treat, 0)) / sum(COALESCE(s.acres_to_treat, 0))
            ELSE avg(s.split_pct) END / 100.0 AS share_acres,
        bool_or(s.is_primary) AS is_primary,
        max(s.pricing_note) AS pricing_note,
        row_number() OVER (ORDER BY bool_or(s.is_primary) DESC, c.farm_name) AS sort_ord,
        sum(CASE WHEN sum(COALESCE(s.acres_to_treat, 0)) > 0
          THEN sum(s.split_pct * COALESCE(s.acres_to_treat, 0)) / sum(COALESCE(s.acres_to_treat, 0))
          ELSE avg(s.split_pct) END) OVER () AS pct_total
      FROM public._job_transfer_shares_20270207(p_job_id) s
      JOIN customers c ON c.id = s.customer_id
      GROUP BY s.customer_id, c.farm_name
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
    p_job_id, v_invoice_id, v_payer_id,
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
      'customer_id', v_payer_id,
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

-- 3. Restricted-use capture (re-emitted from 20270106110000; only the per-line number changes).
CREATE OR REPLACE FUNCTION public._capture_invoice_line_rup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_same_product boolean;
BEGIN
  IF NOT public._epa_registrations_seeded() THEN
    RETURN NULL;  -- before the seed nothing is captured; the seed captures every line that exists
  END IF;
  -- B-1b: the per-brand captures, before the per-line early return below. The registration lock first, so no
  -- registration edit runs between reading the facts and writing them.
  -- Only while the invoice is open, the same freeze as the brand snapshot: a posted line's captures stay as posted.
  IF NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = NEW.invoice_id AND i.status NOT IN ('draft', 'unposted')) THEN
    IF NEW.product_id IS NOT NULL AND jsonb_typeof(NEW.brand_lines) = 'array' AND jsonb_array_length(NEW.brand_lines) > 0 THEN
      PERFORM public._epa_registration_lock(false);
      PERFORM public._sync_invoice_line_brand_captures(NEW.id, NEW.product_id, NEW.brand_lines, 'save');
    ELSE
      DELETE FROM public.invoice_line_brand_rup_captures WHERE invoice_item_id = NEW.id;
    END IF;
  END IF;
  IF NEW.product_id IS NULL THEN
    DELETE FROM public.invoice_line_rup_captures WHERE invoice_item_id = NEW.id;
    RETURN NULL;
  END IF;
  -- Kept unless the product changed or the saved number changed. Any change re-captures, a blank number filled in
  -- included, whether the writer or _fill_invoice_line_epa filled it (Sol r9: the fill can ride a price edit, so the
  -- trigger fires on every update and compares here). A price, quantity or unit edit keeps the capture.
  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND public._normalize_epa_registration(NEW.epa_registration)
         IS NOT DISTINCT FROM public._normalize_epa_registration(OLD.epa_registration)
     AND EXISTS (SELECT 1 FROM public.invoice_line_rup_captures c WHERE c.invoice_item_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  v_same_product := TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id;
  PERFORM public._epa_registration_lock(false);
  INSERT INTO public.invoice_line_rup_captures AS c (invoice_item_id, epa_registration, rup_status, signal_word, source)
  -- #2341: a line of an invoice made from a job that carries the number the job kept for its product (as Create
  -- Invoice writes it) records that number (k.n), with that registration's signal word, and Yes when that
  -- registration says Yes. Any other line (an added line under the current number, say) is captured exactly as before.
  SELECT NEW.id, COALESCE(k.n, f.epa_registration),
         CASE WHEN EXISTS (SELECT 1 FROM public.epa_registrations r WHERE r.epa_registration = k.n AND r.rup_status = 'yes')
              THEN 'yes' ELSE f.rup_status END,
         CASE WHEN k.n IS NULL THEN f.signal_word
              ELSE COALESCE((SELECT r.signal_word FROM public.epa_registrations r WHERE r.epa_registration = k.n),
                            (SELECT p.signal_word FROM public.products p WHERE p.id = NEW.product_id)) END,
         'save'
    FROM public._invoice_line_rup_facts(NEW.product_id, NEW.epa_registration) f
   CROSS JOIN LATERAL (SELECT public._normalize_epa_registration(public._job_kept_epa(
           (SELECT i.job_id FROM public.invoices i WHERE i.id = NEW.invoice_id), NEW.product_id)) AS kn) kk
   CROSS JOIN LATERAL (SELECT CASE WHEN kk.kn = public._normalize_epa_registration(NEW.epa_registration) THEN kk.kn END AS n) k
  ON CONFLICT (invoice_item_id) DO UPDATE
    SET epa_registration = EXCLUDED.epa_registration,
        -- a Yes always wins (Mason, 2026-11-10): a re-capture on the same product never turns a Yes back
        rup_status = CASE WHEN v_same_product AND c.rup_status = 'yes' THEN 'yes' ELSE EXCLUDED.rup_status END,
        signal_word = EXCLUDED.signal_word, source = EXCLUDED.source, captured_at = now();
  RETURN NULL;
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM '53ecf1279da3aa7ea1590f440c6eb225'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
          WHERE p.oid = 'public._capture_invoice_line_rup()'::regprocedure) IS DISTINCT FROM '263009a66a66952f30f9237d5dd3edc8' THEN
    RAISE EXCEPTION 'JOB_INVOICE_KEPT_EPA_POSTFLIGHT: a re-emitted body is not this file''s';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)'::regprocedure,
                              'public._capture_invoice_line_rup()'::regprocedure)
                AND NOT COALESCE(p.prosecdef AND p.proowner = 'postgres'::regrole
                         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                         AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[], false)) THEN
    RAISE EXCEPTION 'JOB_INVOICE_KEPT_EPA_POSTFLIGHT: an owner, setting or grant changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = 'public._job_kept_epa(uuid,uuid)'::regprocedure AND a.grantee <> p.proowner)
     OR (SELECT proacl IS NULL FROM pg_proc WHERE oid = 'public._job_kept_epa(uuid,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'JOB_INVOICE_KEPT_EPA_POSTFLIGHT: _job_kept_epa must be executable by its owner only';
  END IF;
END;
$postflight$;
