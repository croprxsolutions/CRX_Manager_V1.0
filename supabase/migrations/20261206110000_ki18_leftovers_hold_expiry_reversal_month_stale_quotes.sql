-- KI-18 leftovers: the last "today" and month decisions in this area follow the Chicago date.
-- The live database clock is UTC, so from 6 pm (CST) / 7 pm (CDT) Central until midnight Central the UTC
-- date is already tomorrow. Each function below is its live definition (2026-11-07, md5 checked) with only
-- the marked lines changed:
--   * _sync_job_holds: a hold that expires today still counts against free stock in the job's shortfall
--     warning until the Chicago day ends (was CURRENT_DATE, the UTC date). With it, the hardening the batch 1
--     file deferred: a signed-in caller can only pass itself as p_actor (ACTOR_MISMATCH, 42501), the rule
--     _sync_quote_job_reservations already has; every live caller (the job_chemicals statement triggers, the
--     jobs lifecycle trigger and reserve_job_inventory) passes auth.uid(), and system calls with no signed-in
--     user keep their explicit actor. No idempotency key: it is an internal engine (EXECUTE postgres and
--     service_role only) that rebuilds a job's holds from scratch, so a repeat call writes nothing new.
--   * Reversing a write-off or a credit application (reverse_credit_memo_application,
--     _unapply_return_credit_guard_impl_20260826, _void_invoice_split_provenance_impl_20260719,
--     _reverse_write_off_replay_impl_20261015) checks the accounting month of the Chicago day the row was
--     made, the day its apply checked (apply_credit_memo_to_invoice, the only writer of credit_memo_applications,
--     and _apply_write_off_replay_impl_20261015 both check the Chicago date since 20261204100000). Batch 1
--     checked both the UTC and the Chicago day, so a row made 6/7-11:59 pm Central on a month's last day could
--     not be reversed once the next month closed. Mason, 2026-11-07: a reversal belongs to the Central day the
--     row was made. Live had 0 write-offs and 0 credit applications and no closed month (2026-11-07), so no
--     existing row changes month.
--   * get_call_list_stale_quotes lists a quote once its Chicago calendar-day age (the quote_age_days the row
--     already shows) reaches p_days, instead of once p_days whole 24-hour periods have passed, which put a
--     quote on its N-day list up to a day late.
-- Signatures, return types, volatility, SECURITY DEFINER, search_path, owners and grants are unchanged;
-- CREATE OR REPLACE keeps owners and grants. The preflight pins each function's body md5 (live or this
-- file's), arguments, settings, owner, exact grants and a single overload; the postflight pins the new body.
-- No row is written. Not changed here: statement and AR aging (KI-18 batch 3), the RUP register (KI-106).
-- Rollback: a forward migration re-emitting the pre-images (their md5s are in the preflight).
DO $preflight$
DECLARE
  v_row record;
  v_fn pg_proc;
BEGIN
  FOR v_row IN SELECT * FROM (VALUES
    ('_sync_job_holds(uuid,uuid)', '4745c68bde10a1a3f6086d81669fb5dd', '00445d9459efa6a25fca6149d15c1baa', '{postgres=X/postgres,service_role=X/postgres}', 'p_job_id uuid, p_actor uuid'),
    ('reverse_credit_memo_application(uuid,text,uuid,text)', 'c3f9459d3ea8ed998c8271f38b85d6c6', 'a0719c71b5570459bf5aba94cdf5c3f5', '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_unapply_return_credit_guard_impl_20260826(uuid,text,uuid,text)', '1f3a386f35d823fb14b5deb3b5f75170', '0eede200cf3d8db86ea1d5466977e56d', '{postgres=X/postgres}', 'p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_void_invoice_split_provenance_impl_20260719(uuid,text,text)', '8c20fab6159d67fb7937fd8f48d92a6d', '604b914bae32ca1da76719658a561730', '{postgres=X/postgres}', 'p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text'),
    ('_reverse_write_off_replay_impl_20261015(uuid,text,uuid,text)', '4154cbe9a13aff741d9c8ab72a508acc', '65198d25affc9998893b8845e907c269', '{postgres=X/postgres}', 'p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('get_call_list_stale_quotes(uuid,integer)', '32e3084dab9b7e8093d20f1f677ab27e', 'dfec0915b68a8aa753a4edc248d62802', '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_rep_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT 14')
  ) AS t(sig, pre_md5, post_md5, acl, args)
  LOOP
    SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.' || v_row.sig);
    IF v_fn.oid IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % is missing', v_row.sig;
    END IF;
    IF md5(replace(v_fn.prosrc, chr(13), '')) NOT IN (v_row.pre_md5, v_row.post_md5)
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR NOT v_fn.prosecdef
       OR coalesce((SELECT array_agg(g::text ORDER BY g::text COLLATE "C") FROM unnest(v_fn.proacl) g)::text, 'NULL') IS DISTINCT FROM v_row.acl
       OR pg_get_function_arguments(v_fn.oid) <> v_row.args
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres'
       OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_fn.proname) <> 1 THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % body, arguments, settings, owner, grants or overloads drifted; re-review the current definition', v_row.sig;
    END IF;
  END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._sync_job_holds(p_job_id uuid, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job jobs%ROWTYPE;
  v_actor uuid;
  v_item RECORD;
  v_active boolean;
  v_free numeric;
  v_shortfalls jsonb := '[]'::jsonb;
BEGIN
  -- idempotency-body-check: exempt
  -- Internal engine (EXECUTE: postgres, service_role): it rebuilds a job's holds from scratch, so a
  -- repeat call writes nothing new; reserve_job_inventory documents the same exemption.
  v_actor := COALESCE(p_actor, auth.uid());
  -- A signed-in caller can only act as itself; every caller passes auth.uid(), and system calls (no
  -- auth.uid()) keep their explicit actor. Same rule as _sync_quote_job_reservations.
  IF p_actor IS NOT NULL AND auth.uid() IS NOT NULL AND p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- Lock the job first (lock order: job -> quote -> inventory).
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('shortfalls', v_shortfalls); END IF;

  v_active := (v_job.deleted_at IS NULL AND v_job.status IN ('scheduled', 'in_progress'));

  IF v_job.quote_id IS NOT NULL THEN
    -- Quote-linked: coordinate ALL sibling jobs on the quote together. This
    -- reserves/releases THIS job, reallocates siblings on cancel/delete (#2),
    -- allocates the order coverage once across siblings (#3), and resyncs the
    -- parent quote's crop_program holds.
    PERFORM _sync_quote_job_reservations(v_job.quote_id, v_actor);
  ELSE
    -- Quote-less job: independent, no booking to draw from. Rebuild its holds
    -- (full demand per product, no draws). Release when terminal/deleted.
    DELETE FROM inventory_holds WHERE source_id = p_job_id AND hold_type = 'job';
    DELETE FROM job_product_draws WHERE job_id = p_job_id;
    IF v_active THEN
      FOR v_item IN
        SELECT jc.product_id,
               -- D2 (U11 follow-up): normalize FIRST — 'pt/ac'-style units NULL out of the converter; mirrors complete_job.
               SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) AS job_demand
        FROM job_chemicals jc
        JOIN products p ON p.id = jc.product_id
        -- U4<<< customer-supplied lines demand nothing from our shed. (#102)
        WHERE jc.job_id = p_job_id AND jc.product_id IS NOT NULL AND jc.customer_supplied = false
        -- >>>U4
        GROUP BY jc.product_id
        HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) > 0
      LOOP
        PERFORM 1 FROM inventory
        WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
        FOR UPDATE;
        -- status-enum-check: exempt (writes the 'job' hold_type added by A1 20260702170000)
        INSERT INTO inventory_holds (
          product_id, customer_id, quantity, hold_type, source_id,
          notes, created_by, expires_at, is_active
        ) VALUES (
          v_item.product_id, v_job.customer_id, v_item.job_demand, 'job', p_job_id,
          'Job reservation for ' || COALESCE(v_job.job_number, p_job_id::text),
          COALESCE(v_actor, v_job.created_by), NULL, true
        );
      END LOOP;
    END IF;
  END IF;

  -- WARN (never block, §6.1): shortfalls for THIS job's products, only while the
  -- job is active. free = available - prebooked - active non-expired holds, read
  -- AFTER the (re)sync above so it reflects the final hold state. A released job
  -- returns empty shortfalls (matches the old RELEASE branch).
  IF v_active THEN
    FOR v_item IN
      SELECT jc.product_id,
             SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) AS job_demand
      FROM job_chemicals jc
      JOIN products p ON p.id = jc.product_id
      -- U4<<< customer-supplied lines demand nothing — never a shortfall. (#102)
      WHERE jc.job_id = p_job_id AND jc.product_id IS NOT NULL AND jc.customer_supplied = false
      -- >>>U4
      GROUP BY jc.product_id
      HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) > 0
    LOOP
      SELECT inv.quantity_available - inv.quantity_prebooked
             - COALESCE((
                 SELECT SUM(h.quantity) FROM inventory_holds h
                 WHERE h.product_id = v_item.product_id AND h.is_active = true
                   AND (h.expires_at IS NULL OR h.expires_at >= (now() AT TIME ZONE 'America/Chicago')::date)
               ), 0)
        INTO v_free
      FROM inventory inv
      WHERE inv.product_id = v_item.product_id AND inv.location = 'Main Warehouse';

      IF v_free IS NULL THEN
        -- No Main Warehouse inventory row => the whole demand is short (Codex P2).
        v_shortfalls := v_shortfalls || jsonb_build_object(
          'product_id', v_item.product_id,
          'product_name', (SELECT product_name FROM products WHERE id = v_item.product_id),
          'short', v_item.job_demand
        );
      ELSIF v_free < 0 THEN
        v_shortfalls := v_shortfalls || jsonb_build_object(
          'product_id', v_item.product_id,
          'product_name', (SELECT product_name FROM products WHERE id = v_item.product_id),
          'short', -v_free
        );
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('shortfalls', v_shortfalls);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_credit_memo_application(p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor      uuid;
  v_actor_role text;
  v_app        record;
  v_existing   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  -- Codex BLOCKER: NULL (inactive/absent profile) must be rejected — `NULL NOT IN (...)` is not true.
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only active admins and sales reps can reverse credit applications';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required to reverse a credit application';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'reverse_credit_memo_application');
    IF v_existing IS NOT NULL THEN
      -- Codex HIGH: bind idempotency to the application id (mirror the apply RPC) so a key reused
      -- for a DIFFERENT application can't silently return the first application's success.
      IF (v_existing->>'application_id')::uuid IS DISTINCT FROM p_application_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: key % was already used to reverse a different application', p_idempotency_key;
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_app FROM credit_memo_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_APPLICATION_NOT_FOUND: %', p_application_id; END IF;
  IF v_app.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'CREDIT_APPLICATION_ALREADY_REVERSED: %', p_application_id;
  END IF;

  -- Codex HIGH: gate on the APPLICATION's own period (applied_at), NOT the memo's ISSUE date. Apply
  -- checks the Chicago date, so an application made in an open period must stay reversible in it even if
  -- the memo was issued in a since-closed period (mirrors void_payment gating on payment_date).
  -- KI-18 (Mason, 2026-11-07): the Chicago day the row was booked under, as its apply checked.
  PERFORM check_period_open((v_app.applied_at AT TIME ZONE 'America/Chicago')::date);

  PERFORM _reverse_credit_memo_application(p_application_id, v_actor, v_actor_role, p_reason);

  v_existing := jsonb_build_object(
    'success', true, 'application_id', p_application_id,
    'credit_memo_id', v_app.credit_memo_id, 'target_invoice_id', v_app.target_invoice_id,
    'amount_cents', v_app.amount_cents
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'reverse_credit_memo_application', v_existing);
  END IF;
  RETURN v_existing;
END;
$function$;

CREATE OR REPLACE FUNCTION public._unapply_return_credit_guard_impl_20260826(p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_invoice record; v_return record; v_existing jsonb; v_result jsonb; v_capp record; v_product_ids uuid[];
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'Reason is required to unapply a credit memo'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'unapply_credit_memo';
    IF v_existing IS NOT NULL THEN IF (v_existing->>'credit_memo_id')::uuid IS DISTINCT FROM p_credit_memo_id THEN RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: idempotency key was already used for a different credit memo'; END IF; RETURN v_existing; END IF;
  END IF;
  SELECT * INTO v_invoice FROM invoices WHERE id = p_credit_memo_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_credit_memo_id; END IF;
  IF v_invoice.invoice_type != 'credit_memo' THEN RAISE EXCEPTION 'Invoice % is not a credit memo (type: %)', v_invoice.invoice_number, v_invoice.invoice_type; END IF;
  IF v_invoice.status != 'posted' THEN RAISE EXCEPTION 'Only posted credit memos can be unapplied (current status: %)', v_invoice.status; END IF;
  PERFORM check_period_open(v_invoice.invoice_date);
  -- Acquire Return/Product protocol before reversing applications or voiding the memo.
  SELECT * INTO v_return FROM returns WHERE credit_invoice_id = p_credit_memo_id FOR UPDATE;
  IF v_return.id IS NOT NULL THEN
    SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id) INTO v_product_ids FROM return_items ri WHERE ri.return_id = v_return.id;
    PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  END IF;
  FOR v_capp IN SELECT id, applied_at FROM credit_memo_applications WHERE credit_memo_id = p_credit_memo_id AND reversed_at IS NULL ORDER BY id LOOP
    -- KI-18 (Mason, 2026-11-07): the Chicago day the row was booked under, as its apply checked.
    PERFORM check_period_open((v_capp.applied_at AT TIME ZONE 'America/Chicago')::date);
    PERFORM _reverse_credit_memo_application(v_capp.id, v_actor, (SELECT role FROM profiles WHERE id = v_actor), 'Auto-reversed: credit memo ' || v_invoice.invoice_number || ' unapplied — ' || p_reason);
  END LOOP;
  UPDATE invoices SET status = 'voided', voided_by = v_actor, voided_at = now(), void_reason = p_reason, updated_at = now() WHERE id = p_credit_memo_id;
  IF v_return.id IS NOT NULL THEN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE returns SET status = 'received', credit_invoice_id = NULL, total_credit_cents = 0, credited_at = NULL, credited_by = NULL, updated_at = now() WHERE id = v_return.id;
    PERFORM set_config('app.admin_override', 'false', true);
  END IF;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('credit_memo_unapplied', 'invoice', p_credit_memo_id, (SELECT role FROM profiles WHERE id = v_actor), jsonb_build_object('status', 'posted', 'total_amount_cents', v_invoice.total_amount_cents), jsonb_build_object('status', 'voided', 'return_reverted', CASE WHEN v_return.id IS NOT NULL THEN v_return.return_number ELSE NULL END), -v_invoice.total_amount_cents, 'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason);
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('credit_memo_unapplied', 'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason, v_actor, 'invoice', p_credit_memo_id, v_invoice.customer_id);
  v_result := jsonb_build_object('success', true, 'credit_memo_id', p_credit_memo_id, 'invoice_number', v_invoice.invoice_number, 'return_id', v_return.id, 'return_reverted', v_return.id IS NOT NULL);
  IF p_idempotency_key IS NOT NULL THEN INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at) VALUES (p_idempotency_key, 'unapply_credit_memo', v_result, now() + interval '24 hours') ON CONFLICT (idempotency_key) DO NOTHING; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._void_invoice_split_provenance_impl_20260719(p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv record; v_alloc record; v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0; v_prepay_app record; v_actor_role text;
  v_allocation_set_ids uuid[]; v_commissions_cancelled integer := 0; v_existing jsonb;
  v_job record;  -- U6 #65: job-release locals
  v_capp record;  -- CREDIT-APPLY: active-application cursor
BEGIN
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid() AND is_active = true;
  IF v_actor_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only admin users can void invoices'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.status = 'voided' THEN RAISE EXCEPTION 'Invoice already voided'; END IF;
  IF v_inv.status = 'cancelled' THEN RAISE EXCEPTION 'Cannot void a cancelled invoice'; END IF;

  -- draft/unposted invoices were never posted: no allocations/prepay/commissions to reverse,
  -- and the status trigger only allows →voided from posted/overdue. Route to 'cancelled'
  -- (draft→cancelled / unposted→cancelled are allowed transitions) and return.
  -- (A draft/unposted invoice can never carry a credit application — apply requires posted on
  --  both sides — so no credit reversal is needed on this branch.)
  IF v_inv.status IN ('draft', 'unposted') THEN
    UPDATE invoices SET status = 'cancelled', void_reason = p_void_reason, updated_at = now()
    WHERE id = p_invoice_id;

    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
      IF FOUND AND v_job.status = 'invoiced' THEN
        IF EXISTS (SELECT 1 FROM invoices o
                   WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                     AND o.invoice_type = 'field_application'
                     AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL) THEN
          IF v_job.invoice_id IS NOT DISTINCT FROM p_invoice_id THEN
            UPDATE application_records SET invoice_id = (
              SELECT o.id FROM invoices o
               WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                 AND o.invoice_type = 'field_application'
                 AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
               ORDER BY o.created_at, o.id LIMIT 1)
              WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
            SET LOCAL app.admin_override = 'true';
            UPDATE jobs SET invoice_id = (
              SELECT o.id FROM invoices o
               WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                 AND o.invoice_type = 'field_application'
                 AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
               ORDER BY o.created_at, o.id LIMIT 1)
              WHERE id = v_inv.job_id;
            RESET app.admin_override;
          END IF;
        ELSE
          UPDATE application_records SET invoice_id = NULL
            WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
          SET LOCAL app.admin_override = 'true';
          UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
          RESET app.admin_override;
        END IF;
      END IF;
    END IF;

    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
      END IF;
      IF EXISTS (
        SELECT 1 FROM commissions
        WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
      ) THEN
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT p.id, 'Job invoice cancelled — commissions already paid',
          'Invoice ' || v_inv.invoice_number || ' was cancelled but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
          'commission_review', 'invoice', p_invoice_id
        FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
      UPDATE commissions SET status = 'cancelled', commission_amount = 0
        WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
    VALUES ('invoice_cancelled', 'invoice', p_invoice_id, v_actor_role,
      jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents),
      jsonb_build_object('status', 'cancelled', 'void_reason', p_void_reason, 'commissions_cancelled', v_commissions_cancelled),
      0,
      'Cancelled ' || v_inv.invoice_number || ' (was ' || v_inv.status || ') — ' || p_void_reason);

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_cancelled',
      'Cancelled invoice ' || v_inv.invoice_number || ' — ' || p_void_reason,
      auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
        'success', true, 'invoice_id', p_invoice_id, 'status', 'cancelled',
        'allocations_reversed_cents', 0, 'prepay_restored_cents', 0, 'commissions_cancelled', v_commissions_cancelled));
    END IF;
    RETURN;
  END IF;

  -- H3 fix: refuse to void a posted/overdue/paid invoice that still has direct
  -- cash applied. void_invoice reverses prepay + credit-memo applications below,
  -- but does NOT re-bank direct payments (paid_amount_cents) or payment
  -- allocations (invoice_line_allocations) — voiding would strand that cash.
  -- The admin must void/unapply those payments first (void_payment re-banks the
  -- cash as customer prepay), then void the invoice. Prepay-only and
  -- credit-memo-only voids carry neither and are unaffected.
  IF v_inv.paid_amount_cents > 0
     OR EXISTS (
       SELECT 1
       FROM invoice_line_allocations ila
       JOIN allocation_sets aset ON aset.id = ila.allocation_set_id
       WHERE ila.invoice_id = p_invoice_id
         AND aset.entity_type = 'payment'
         AND aset.is_active = true
     ) THEN
    RAISE EXCEPTION 'INVOICE_HAS_APPLIED_PAYMENTS: invoice % has $% in applied payments — void or unapply those payments first (that re-banks the cash as prepay), then void the invoice',
      v_inv.invoice_number, (v_inv.paid_amount_cents / 100.0)::numeric(12,2);
  END IF;

  IF v_inv.status IN ('posted', 'paid', 'overdue') THEN PERFORM check_period_open(v_inv.invoice_date); END IF;

  -- CREDIT-APPLY: reverse every active credit-memo application that touches this invoice
  -- (as the credit memo OR as the target) BEFORE zeroing its levers. This restores the other
  -- side and drains this invoice's credit_applied_cents to 0; without it a voided target would
  -- leave credit_applied_cents set and violate invoices_balance_non_negative, and a voided memo
  -- would strand the credit it handed out (Codex #4).
  -- Codex BLOCKER: the enclosing void only period-checks status='posted', but a credited target is
  -- 'paid'/'overdue'. Each application's reversal is a money movement, so gate it on THAT
  -- application's own period (applied_at) before touching it.
  -- Codex MED (accepted, not fixed): void locks THIS invoice first, then the helper locks both sides
  -- in id order — two concurrent voids of a memo and its target can deadlock. Postgres detects it and
  -- aborts one cleanly (money stays atomic; the operator retries). Rare + non-corrupting, so it is
  -- left as a safe-abort rather than a global pre-lock of all counterparties.
  FOR v_capp IN
    SELECT id, applied_at FROM credit_memo_applications
     WHERE reversed_at IS NULL
       AND (credit_memo_id = p_invoice_id OR target_invoice_id = p_invoice_id)
     ORDER BY id
  LOOP
    -- KI-18 (Mason, 2026-11-07): the Chicago day the row was booked under, as its apply checked.
    PERFORM check_period_open((v_capp.applied_at AT TIME ZONE 'America/Chicago')::date);
    PERFORM _reverse_credit_memo_application(v_capp.id, auth.uid(), v_actor_role,
      'Auto-reversed: invoice ' || v_inv.invoice_number || ' voided — ' || p_void_reason);
  END LOOP;

  SELECT ARRAY(SELECT DISTINCT ila.allocation_set_id FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id AND ila.allocation_set_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM allocation_sets hist WHERE hist.id = ila.allocation_set_id
        AND hist.entity_type = 'payment' AND hist.is_active = false)) INTO v_allocation_set_ids;

  FOR v_alloc IN SELECT ila.id, ila.amount_cents, ila.allocation_set_id FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id
      AND NOT EXISTS (SELECT 1 FROM allocation_sets hist WHERE hist.id = ila.allocation_set_id
        AND hist.entity_type = 'payment' AND hist.is_active = false) LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.amount_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  IF v_total_allocations_reversed > 0 AND array_length(v_allocation_set_ids, 1) > 0 THEN
    UPDATE allocation_sets SET total_allocated_cents = (SELECT COALESCE(SUM(amount_cents), 0)
      FROM invoice_line_allocations WHERE allocation_set_id = allocation_sets.id),
      updated_at = now() WHERE id = ANY(v_allocation_set_ids);
  END IF;

  FOR v_prepay_app IN SELECT pa.id, pa.applied_amount_cents, pa.prepay_credit_id FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.applied_amount_cents;
    UPDATE prepay_credits SET balance_cents = balance_cents + v_prepay_app.applied_amount_cents,
      updated_at = now() WHERE id = v_prepay_app.prepay_credit_id;
    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now() WHERE id = v_inv.customer_id;
  END IF;

  -- CREDIT-APPLY: credit_applied_cents = 0 added (all applications reversed above → already 0;
  -- explicit for safety so the voided row's balance is unambiguously 0).
  UPDATE invoices SET status = 'voided', voided_by = auth.uid(), voided_at = now(),
    void_reason = p_void_reason, total_amount_cents = 0, paid_amount_cents = 0,
    prepay_applied_cents = 0, write_off_cents = 0, credit_applied_cents = 0, updated_at = now()
  WHERE id = p_invoice_id;

  -- Codex HIGH: a generic void of a CREDIT MEMO must also release its linked return (mirroring
  -- unapply_credit_memo), or the return stays 'credited' pointing at a voided memo and can never be
  -- re-credited. Regular invoices have no such link, so the guard scopes this to credit memos.
  IF v_inv.invoice_type = 'credit_memo' THEN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE returns SET
      status = 'received', credit_invoice_id = NULL, total_credit_cents = 0,
      credited_at = NULL, credited_by = NULL, updated_at = now()
    WHERE credit_invoice_id = p_invoice_id;
    PERFORM set_config('app.admin_override', 'false', true);
  END IF;

  IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
    IF FOUND AND v_job.status = 'invoiced' THEN
      IF EXISTS (SELECT 1 FROM invoices o
                 WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                   AND o.invoice_type = 'field_application'
                   AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL) THEN
        IF v_job.invoice_id IS NOT DISTINCT FROM p_invoice_id THEN
          UPDATE application_records SET invoice_id = (
            SELECT o.id FROM invoices o
             WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
               AND o.invoice_type = 'field_application'
               AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
             ORDER BY o.created_at, o.id LIMIT 1)
            WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
          SET LOCAL app.admin_override = 'true';
          UPDATE jobs SET invoice_id = (
            SELECT o.id FROM invoices o
             WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
               AND o.invoice_type = 'field_application'
               AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
             ORDER BY o.created_at, o.id LIMIT 1)
            WHERE id = v_inv.job_id;
          RESET app.admin_override;
        END IF;
      ELSE
        UPDATE application_records SET invoice_id = NULL
          WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
        SET LOCAL app.admin_override = 'true';
        UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
        RESET app.admin_override;
      END IF;
    END IF;
  END IF;

  IF v_inv.order_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE order_id = v_inv.order_id
        AND id != p_invoice_id AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL) THEN
      UPDATE commissions SET status = 'cancelled' WHERE order_id = v_inv.order_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;
  END IF;

  IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
      WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
        AND c.status = 'pending' AND cp.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
    END IF;
    IF EXISTS (
      SELECT 1 FROM commissions
      WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
    ) THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      SELECT p.id, 'Job invoice voided — commissions already paid',
        'Invoice ' || v_inv.invoice_number || ' was voided but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
        'commission_review', 'invoice', p_invoice_id
      FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
    END IF;
    UPDATE commissions SET status = 'cancelled', commission_amount = 0
      WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
    GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
  END IF;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_voided', 'invoice', p_invoice_id, v_actor_role,
    jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents, 'paid_amount_cents', v_inv.paid_amount_cents, 'prepay_applied_cents', v_inv.prepay_applied_cents, 'write_off_cents', v_inv.write_off_cents),
    jsonb_build_object('status', 'voided', 'void_reason', p_void_reason, 'allocations_reversed_cents', v_total_allocations_reversed, 'prepay_restored_cents', v_total_prepay_restored, 'commissions_cancelled', v_commissions_cancelled),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END);

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);

  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 OR v_commissions_cancelled > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id, 'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.' ||
        CASE WHEN v_commissions_cancelled > 0 THEN ' ' || v_commissions_cancelled || ' pending commission(s) cancelled.' ELSE '' END,
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
      'success', true, 'invoice_id', p_invoice_id,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored,
      'commissions_cancelled', v_commissions_cancelled));
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public._reverse_write_off_replay_impl_20261015(p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid;
  v_wo             record;
  v_existing       jsonb;
  v_new_balance    bigint;
  v_old_status     text;
  v_due_date       date;
  v_new_status     text;
  v_status_changed boolean;
  v_result         jsonb;
BEGIN
  -- Strict-actor: derive from JWT, never trust a client-supplied UUID.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF (SELECT role FROM profiles WHERE id = v_actor AND is_active = true) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse write-offs';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a write-off';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'reverse_write_off';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_wo
    FROM write_offs
   WHERE id = p_write_off_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Write-off not found: %', p_write_off_id;
  END IF;

  IF v_wo.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Write-off has already been reversed';
  END IF;

  -- OVERNIGHT FIX (finding #2): reversing a write-off retroactively changes AR and writes the
  -- append-only ledger; gate on the write-off's booked date so a closed period blocks it
  -- (Hard Red Line: never bypass check_period_open).
  -- KI-18 (Mason, 2026-11-07): the Chicago day the row was booked under, as its apply checked.
  PERFORM check_period_open((v_wo.created_at AT TIME ZONE 'America/Chicago')::date);

  SELECT status, due_date INTO v_old_status, v_due_date
    FROM invoices
   WHERE id = v_wo.invoice_id
   FOR UPDATE;

  IF v_old_status IS NULL THEN
    RAISE EXCEPTION 'Invoice not found for write-off %: %', p_write_off_id, v_wo.invoice_id;
  END IF;

  UPDATE invoices
     SET write_off_cents = GREATEST(COALESCE(write_off_cents, 0) - v_wo.amount_cents, 0),
         updated_at      = now()
   WHERE id = v_wo.invoice_id;

  SELECT balance_cents INTO v_new_balance
    FROM invoices
   WHERE id = v_wo.invoice_id;

  IF v_old_status = 'paid' AND v_new_balance > 0 THEN
    IF v_due_date IS NOT NULL AND v_due_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
      v_new_status := 'overdue';
    ELSE
      v_new_status := 'posted';
    END IF;
    UPDATE invoices
       SET status     = v_new_status,
           updated_at = now()
     WHERE id = v_wo.invoice_id;
    v_status_changed := true;
  ELSE
    v_new_status := v_old_status;
    v_status_changed := false;
  END IF;

  UPDATE write_offs
     SET reversed_at     = now(),
         reversed_by     = v_actor,
         reversed_reason = p_reason
   WHERE id = p_write_off_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'write_off_reversed', 'write_off', p_write_off_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'amount_cents',   v_wo.amount_cents,
      'reversed_at',    null,
      'invoice_status', v_old_status
    ),
    jsonb_build_object(
      'reversed_at',       now(),
      'reverse_reason',    p_reason,
      'invoice_status',    v_new_status,
      'new_balance_cents', v_new_balance
    ),
    v_wo.amount_cents,
    'Write-off of ' || (v_wo.amount_cents::numeric / 100)::text ||
      ' reversed on invoice ' || v_wo.invoice_id::text || ': ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'write_off_reversed',
    'Write-off of $' || (v_wo.amount_cents::numeric / 100)::text || ' reversed: ' || p_reason,
    v_actor, 'invoice', v_wo.invoice_id, v_wo.customer_id
  );

  v_result := jsonb_build_object(
    'success',           true,
    'write_off_id',      p_write_off_id,
    'amount_cents',      v_wo.amount_cents,
    'invoice_id',        v_wo.invoice_id,
    'new_balance_cents', v_new_balance,
    'status_changed',    v_status_changed,
    'new_status',        v_new_status
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'reverse_write_off', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_call_list_stale_quotes(p_rep_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT 14)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  IF p_days < 0 THEN
    RAISE EXCEPTION 'CALL_LIST_INVALID_DAYS';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'success', true,
      -- Every matching row, before the 200-row cut, so the screen can say "200 of N".
      'total_count', COALESCE(MAX(rows.total_count), 0),
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'quote_id', rows.quote_id,
        'quote_number', rows.quote_number,
        'quote_total_cents', rows.quote_total_cents,
        'quote_updated_at', rows.quote_updated_at,
        'quote_age_days', rows.quote_age_days
      ) ORDER BY rows.quote_updated_at, rows.quote_number, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        count(*) OVER () AS total_count,
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        q.id AS quote_id,
        q.quote_number,
        ROUND(q.total_price * 100)::bigint AS quote_total_cents,
        q.updated_at AS quote_updated_at,
        ((now() AT TIME ZONE 'America/Chicago')::date - (q.updated_at AT TIME ZONE 'America/Chicago')::date) AS quote_age_days
      FROM public.quotes q
      JOIN public.customers c ON c.id = q.customer_id
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      WHERE c.is_active
        AND q.deleted_at IS NULL
        AND q.status IN ('draft', 'sent', 'revised')
        -- KI-18: the same Chicago calendar-day age the row shows, not whole 24-hour periods.
        AND ((now() AT TIME ZONE 'America/Chicago')::date - (q.updated_at AT TIME ZONE 'America/Chicago')::date) >= p_days
        AND (
          (public.is_admin() AND (p_rep_id IS NULL OR c.assigned_sales_rep = p_rep_id))
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
      ORDER BY q.updated_at, q.quote_number, c.id
      LIMIT 200
    ) rows
  );
END;
$function$;

DO $postflight$
DECLARE
  v_row record;
  v_fn pg_proc;
BEGIN
  FOR v_row IN SELECT * FROM (VALUES
    ('_sync_job_holds(uuid,uuid)', '4745c68bde10a1a3f6086d81669fb5dd', '00445d9459efa6a25fca6149d15c1baa', '{postgres=X/postgres,service_role=X/postgres}', 'p_job_id uuid, p_actor uuid'),
    ('reverse_credit_memo_application(uuid,text,uuid,text)', 'c3f9459d3ea8ed998c8271f38b85d6c6', 'a0719c71b5570459bf5aba94cdf5c3f5', '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_unapply_return_credit_guard_impl_20260826(uuid,text,uuid,text)', '1f3a386f35d823fb14b5deb3b5f75170', '0eede200cf3d8db86ea1d5466977e56d', '{postgres=X/postgres}', 'p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_void_invoice_split_provenance_impl_20260719(uuid,text,text)', '8c20fab6159d67fb7937fd8f48d92a6d', '604b914bae32ca1da76719658a561730', '{postgres=X/postgres}', 'p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text'),
    ('_reverse_write_off_replay_impl_20261015(uuid,text,uuid,text)', '4154cbe9a13aff741d9c8ab72a508acc', '65198d25affc9998893b8845e907c269', '{postgres=X/postgres}', 'p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('get_call_list_stale_quotes(uuid,integer)', '32e3084dab9b7e8093d20f1f677ab27e', 'dfec0915b68a8aa753a4edc248d62802', '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_rep_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT 14')
  ) AS t(sig, pre_md5, post_md5, acl, args)
  LOOP
    SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.' || v_row.sig);
    IF v_fn.oid IS NULL
       OR md5(replace(v_fn.prosrc, chr(13), '')) <> v_row.post_md5
       OR regexp_replace(v_fn.prosrc, '--[^\n]*', '', 'g') ~* '\mcurrent_date\M|AT TIME ZONE ''UTC''|make_interval'
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR NOT v_fn.prosecdef
       OR coalesce((SELECT array_agg(g::text ORDER BY g::text COLLATE "C") FROM unnest(v_fn.proacl) g)::text, 'NULL') IS DISTINCT FROM v_row.acl
       OR pg_get_function_arguments(v_fn.oid) <> v_row.args
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres' THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % did not take the new body', v_row.sig;
    END IF;
  END LOOP;
END;
$postflight$;
