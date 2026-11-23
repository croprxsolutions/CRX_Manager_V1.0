-- #2265: Unpost refused an invoice after every payment on it was voided ("it has payments, prepay, write-offs, or
-- applied credit"). void_payment keeps the payment's invoice_line_allocations rows as history and marks its
-- allocation_sets row inactive (20260718221505), but the unpost check counted every allocation row, active or not.
--
-- Change (CREATE OR REPLACE of _unpost_invoice_replay_impl_20261015, the body unpost_invoice and
-- unpost_invoice_group both run; same signature, owner, SECURITY DEFINER, search_path and postgres-only EXECUTE):
--   1. The allocation count skips rows whose set is a voided payment (entity_type 'payment' AND is_active = false),
--      the same rule void_invoice uses. An active payment, an order or invoice set, paid/prepay/write-off/credit
--      amounts, prepay and credit applications all still refuse, as before.
--   2. On a successful unpost those history rows lose only their invoice_item_id (they keep invoice_id, amount and
--      set): every draft save deletes and re-adds the lines, and the invoice_item_id foreign key has no ON DELETE,
--      so a row still naming a line would refuse the first save. allocate_payment has written invoice_id only since
--      20260315200000; rows from before then also name a line. The unpost audit row keeps each unlinked row's line
--      (new_values.voided_payment_history_unlinked: [{allocation_id, invoice_item_id, amount_cents}]).
--   3. The audit description's dollar amount is numeric(20,2) (was numeric(12,2), which overflows on a 10-billion-
--      dollar total and would roll the unpost back).
-- Body otherwise byte-identical to the 20260711050000 body renamed in 20261102180000 (md5 pinned below). No other
-- data changes.
--
-- Rollback: a NEW forward migration restoring the pinned body (never re-run or edit this file). Unlinked line links
-- are not restored (the lines they named are replaced by the next draft save); the audit rows keep them.

SET LOCAL lock_timeout = '10s';

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  CREATE TEMP TABLE unpost_2265_tx (x int) ON COMMIT DROP;
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._unpost_invoice_replay_impl_20261015(uuid,uuid,text)');
  IF p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '161f18c3ccd6126a6fb683c5160f82dc' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: _unpost_invoice_replay_impl_20261015 changed since 2026-11-23 (md5 %); re-read it before applying',
      md5(replace(p.prosrc, chr(13), ''));
  END IF;
  IF (SELECT count(*) FROM pg_proc o
       WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_unpost_invoice_replay_impl_20261015') <> 1
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres'] THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: _unpost_invoice_replay_impl_20261015 has an extra overload, or its owner, mode, search_path or EXECUTE grants changed';
  END IF;
END
$preflight$;

DO $tx$
BEGIN
  IF to_regclass('pg_temp.unpost_2265_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 / the apply script)';
  END IF;
END
$tx$;

CREATE OR REPLACE FUNCTION public._unpost_invoice_replay_impl_20261015(p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv RECORD;
  v_actor_role text;
  v_existing jsonb;
  v_result jsonb;
  v_alloc_count int := 0;
  v_prepay_count int := 0;
  v_rup_voided int := 0;
  v_credit_app_count int := 0;  -- CREDIT-APPLY
  v_history_unlinked jsonb := '[]'::jsonb;  -- #2265
BEGIN
  SELECT role INTO v_actor_role FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'unpost_invoice');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.status NOT IN ('posted', 'overdue') THEN
    IF v_inv.status IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Invoice % is not posted (status: %); there is nothing to unpost', v_inv.invoice_number, v_inv.status;
    ELSE
      RAISE EXCEPTION 'Cannot unpost a % invoice (%). Only a posted, unpaid invoice can be returned to the Unposted list.', v_inv.status, v_inv.invoice_number;
    END IF;
  END IF;

  -- #2265: a voided payment keeps its allocation rows as history on an inactive payment set
  -- (20260718221505); they are no longer money on this invoice, so they do not block unpost.
  -- Every other allocation (an active payment, any order or invoice set) still does.
  SELECT count(*) INTO v_alloc_count FROM invoice_line_allocations ila
   WHERE ila.invoice_id = p_invoice_id
     AND NOT EXISTS (SELECT 1 FROM allocation_sets hist WHERE hist.id = ila.allocation_set_id
                       AND hist.entity_type = 'payment' AND hist.is_active = false);
  SELECT count(*) INTO v_prepay_count FROM prepay_applications     WHERE invoice_id = p_invoice_id;
  -- CREDIT-APPLY: active applications where this invoice is the memo OR the target.
  SELECT count(*) INTO v_credit_app_count FROM credit_memo_applications
   WHERE reversed_at IS NULL AND (credit_memo_id = p_invoice_id OR target_invoice_id = p_invoice_id);
  IF v_alloc_count > 0
     OR v_prepay_count > 0
     OR v_credit_app_count > 0
     OR COALESCE(v_inv.paid_amount_cents, 0)    <> 0
     OR COALESCE(v_inv.prepay_applied_cents, 0) <> 0
     OR COALESCE(v_inv.write_off_cents, 0)      <> 0
     OR COALESCE(v_inv.credit_applied_cents, 0) <> 0
  THEN
    RAISE EXCEPTION 'Cannot unpost invoice % — it has payments, prepay, write-offs, or applied credit. Reverse those first (or void the invoice instead).', v_inv.invoice_number;
  END IF;

  PERFORM check_period_open(v_inv.invoice_date);

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE invoices SET
    status      = 'unposted',
    posted_by   = NULL,
    posted_at   = NULL,
    updated_at  = now()
  WHERE id = p_invoice_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- #2265: a draft save deletes and re-adds every line, and invoice_line_allocations.invoice_item_id
  -- has no ON DELETE, so a history row still naming a line would refuse the first save. Unlink the
  -- line only; the row keeps its invoice_id, amount and set, and the audit row below keeps each
  -- row's line and amount (the line attribution survives there).
  WITH history AS (
    SELECT ila.id, ila.invoice_item_id, ila.amount_cents
      FROM invoice_line_allocations ila
     WHERE ila.invoice_id = p_invoice_id
       AND ila.invoice_item_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM allocation_sets hist WHERE hist.id = ila.allocation_set_id
                     AND hist.entity_type = 'payment' AND hist.is_active = false)
       FOR UPDATE OF ila
  ), unlinked AS (
    UPDATE invoice_line_allocations ila SET invoice_item_id = NULL
      FROM history h WHERE ila.id = h.id
    RETURNING h.id, h.invoice_item_id, h.amount_cents
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('allocation_id', u.id, 'invoice_item_id', u.invoice_item_id,
                                               'amount_cents', u.amount_cents) ORDER BY u.id), '[]'::jsonb)
    INTO v_history_unlinked
    FROM unlinked u;

  UPDATE rup_sales_records SET
    voided_at  = now(),
    voided_by  = auth.uid(),
    void_reason = 'Invoice ' || v_inv.invoice_number || ' unposted'
  WHERE invoice_id = p_invoice_id
    AND voided_at IS NULL;
  GET DIAGNOSTICS v_rup_voided = ROW_COUNT;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_unposted', 'invoice', p_invoice_id, auth.uid(), v_actor_role,
    jsonb_build_object('status', v_inv.status, 'posted_at', v_inv.posted_at),
    jsonb_build_object('status', 'unposted', 'unposted_at', now()::text, 'rup_rows_voided', v_rup_voided,
      'voided_payment_history_unlinked', v_history_unlinked),
    -1 * COALESCE(v_inv.total_amount_cents, 0),
    'Unposted ' || v_inv.invoice_number || ' (was ' || v_inv.status || ') — $' || (COALESCE(v_inv.total_amount_cents,0) / 100.0)::numeric(20,2)
      || CASE WHEN v_rup_voided > 0 THEN '; ' || v_rup_voided || ' RUP sale row(s) voided' ELSE '' END
  );

  IF v_rup_voided > 0 THEN
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_user_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'rup_sales_voided', 'invoice', p_invoice_id, auth.uid(), v_actor_role,
      jsonb_build_object('rows_voided', v_rup_voided, 'reason', 'invoice_unposted'),
      0,
      v_rup_voided || ' RUP sale row(s) voided for invoice ' || v_inv.invoice_number || ' on unpost'
    );
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_unposted',
    'Unposted invoice ' || v_inv.invoice_number || ' — returned to the Unposted list',
    COALESCE(p_performed_by, auth.uid()), 'invoice', p_invoice_id, v_inv.customer_id);

  v_result := jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'invoice_number', v_inv.invoice_number,
    'previous_status', v_inv.status,
    'status', 'unposted',
    'rup_rows_voided', v_rup_voided
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'unpost_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

ALTER FUNCTION public._unpost_invoice_replay_impl_20261015(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._unpost_invoice_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._unpost_invoice_replay_impl_20261015(uuid,uuid,text)');
  IF p.oid IS NULL
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '7e00d6a01a40649b6f31f2956182e2f2'
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres'] THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: _unpost_invoice_replay_impl_20261015 body, owner, mode, search_path or EXECUTE grants are wrong';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
