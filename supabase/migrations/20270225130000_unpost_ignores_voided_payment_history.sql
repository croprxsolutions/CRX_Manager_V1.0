-- #2265: Unpost refused an invoice after every payment on it was voided ("it has payments, prepay, write-offs, or
-- applied credit"). void_payment keeps the payment's invoice_line_allocations rows as history and marks its
-- allocation_sets row inactive (20260718221505), but the unpost check counted every allocation row, active or not.
--
-- Change (CREATE OR REPLACE of _unpost_invoice_replay_impl_20261015, the body unpost_invoice and
-- unpost_invoice_group both run; same signature, owner, SECURITY DEFINER, search_path and postgres-only EXECUTE):
--   1. The allocation count skips rows whose set is a voided payment (entity_type 'payment' AND is_active = false),
--      the same rule void_invoice uses, and now also counts a row that names only one of this invoice's lines. An
--      active payment, an order or invoice set, paid/prepay/write-off/credit amounts, prepay and credit
--      applications all still refuse, as before. Every refusal that needs no lock runs first, on a lock-free read.
--      Only then are the voided-payment sets behind rows naming one of this invoice's lines locked (FOR SHARE, id
--      order, after the invoice) with those rows (FOR UPDATE), and checked again; exactly those sets count as
--      history and the unlink uses those rows. An active set is never locked here, which keeps void_payment's
--      set-then-invoice order deadlock-free.
--   2. On a successful unpost, every voided-payment row naming one of this invoice's lines
--      loses only its invoice_item_id: every draft save deletes and re-adds the lines, and the invoice_item_id
--      foreign key has no ON DELETE, so a row still naming a line would refuse the first save. allocate_payment has
--      written invoice_id only since 20260315200000; rows from before then also name a line. A row with no
--      invoice_id gets this invoice's (ila_target_check needs one of the two). A voided-payment row that names one of
--      this invoice's lines but records ANOTHER invoice refuses the unpost (UNPOST_HISTORY_NEEDS_HAND_CHECK) instead
--      of being unlinked. The unpost audit row keeps each unlinked one
--      (new_values.voided_payment_history_unlinked: [{allocation_id, invoice_item_id, amount_cents, invoice_id_before}]).
--   3. The audit description's dollar amount is (cents * 0.01)::numeric(20,2) (was / 100.0 then numeric(12,2), which
--      overflows on a 10-billion-dollar total and would roll the unpost back).
-- Body otherwise byte-identical to the 20260711050000 body renamed in 20261102180000 (md5 pinned below). No other
-- data changes.
--
-- One statement does the whole change: the DO block below checks the pinned body, replaces it (EXECUTE), sets owner
-- and grants, and runs the postflight. A failed check raises before the only write, so nothing changes even under
-- plain `psql -f` without ON_ERROR_STOP; a failed postflight rolls the replacement back.
--
-- Rollback: a NEW forward migration restoring the pinned body (never re-run or edit this file). Unlinked line links
-- are not restored (the lines they named are replaced by the next draft save); the audit rows keep them.

DO $migrate$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);

  -- Preflight: the reviewed body, one overload, owner, mode, search_path and EXECUTE grants.
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

  -- The replacement, in this same statement.
  EXECUTE $create$
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
  v_history_ids uuid[] := '{}';  -- #2265
  v_history_elsewhere uuid;  -- #2265
  v_history_sets uuid[] := '{}';  -- #2265
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
  -- Every other allocation (an active payment, any order or invoice set) still does, whether it names
  -- this invoice or only one of its lines (a pre-2026-03-15 row may carry the line alone).
  -- First a lock-free read, so every refusal that needs no lock happens before any history lock: an
  -- active set only ever turns inactive, so a blocking row seen here really blocks.
  SELECT count(*) FILTER (WHERE NOT h.voided),
         (array_agg(h.id ORDER BY h.id) FILTER (WHERE h.voided AND h.on_line
                                                  AND h.invoice_id IS NOT NULL AND h.invoice_id <> p_invoice_id))[1]
    INTO v_alloc_count, v_history_elsewhere
    FROM (SELECT ila.id, ila.invoice_id,
                 COALESCE(ila.invoice_item_id IN (SELECT ii.id FROM invoice_items ii WHERE ii.invoice_id = p_invoice_id), false) AS on_line,
                 EXISTS (SELECT 1 FROM allocation_sets hist WHERE hist.id = ila.allocation_set_id
                           AND hist.entity_type = 'payment' AND hist.is_active = false) AS voided
            FROM invoice_line_allocations ila
           WHERE ila.invoice_id = p_invoice_id
              OR ila.invoice_item_id IN (SELECT ii.id FROM invoice_items ii WHERE ii.invoice_id = p_invoice_id)) h;
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
  -- #2265: a voided payment row that names one of this invoice's lines but records ANOTHER invoice is
  -- left for a person: unlinking it would leave that other invoice as its only target.
  IF v_history_elsewhere IS NOT NULL THEN
    RAISE EXCEPTION 'UNPOST_HISTORY_NEEDS_HAND_CHECK: invoice % has a voided payment allocation (%) that names one of its lines but is recorded against another invoice. Nothing was changed; check that allocation by hand before unposting.', v_inv.invoice_number, v_history_elsewhere;
  END IF;

  -- #2265: then lock only what the unlink below changes: the voided-payment sets behind rows naming
  -- one of this invoice's lines (FOR SHARE, id order) and those rows (FOR UPDATE, id order), and check
  -- again under the locks. Exactly the locked sets count as history. An active set is never locked
  -- here: it blocks whatever happens to it next, and locking it after the invoice would invert
  -- void_payment's set-then-invoice order and deadlock.
  SELECT COALESCE(array_agg(x.id ORDER BY x.id), '{}') INTO v_history_sets
    FROM (SELECT s.id FROM allocation_sets s
           WHERE s.entity_type = 'payment' AND s.is_active = false
             AND s.id IN (SELECT ila.allocation_set_id FROM invoice_line_allocations ila
                           WHERE ila.invoice_item_id IN (SELECT ii.id FROM invoice_items ii WHERE ii.invoice_id = p_invoice_id))
           ORDER BY s.id
             FOR SHARE) x;
  SELECT count(*) FILTER (WHERE NOT h.voided),
         COALESCE(array_agg(h.id ORDER BY h.id) FILTER (WHERE h.voided), '{}'),
         (array_agg(h.id ORDER BY h.id) FILTER (WHERE h.voided
                                                  AND h.invoice_id IS NOT NULL AND h.invoice_id <> p_invoice_id))[1]
    INTO v_alloc_count, v_history_ids, v_history_elsewhere
    FROM (SELECT ila.id, ila.invoice_id,
                 COALESCE(ila.allocation_set_id = ANY (v_history_sets), false) AS voided
            FROM invoice_line_allocations ila
           WHERE ila.invoice_item_id IN (SELECT ii.id FROM invoice_items ii WHERE ii.invoice_id = p_invoice_id)
           ORDER BY ila.id
             FOR UPDATE OF ila) h;
  IF v_alloc_count > 0 THEN
    RAISE EXCEPTION 'Cannot unpost invoice % — it has payments, prepay, write-offs, or applied credit. Reverse those first (or void the invoice instead).', v_inv.invoice_number;
  END IF;
  IF v_history_elsewhere IS NOT NULL THEN
    RAISE EXCEPTION 'UNPOST_HISTORY_NEEDS_HAND_CHECK: invoice % has a voided payment allocation (%) that names one of its lines but is recorded against another invoice. Nothing was changed; check that allocation by hand before unposting.', v_inv.invoice_number, v_history_elsewhere;
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
  -- has no ON DELETE, so a history row still naming one of this invoice's lines would refuse the
  -- first save. Unlink the line only (the history rows on a line locked above);
  -- each keeps its amount and set, and a missing invoice_id is filled with this invoice
  -- (ila_target_check needs one of the two). The audit row below keeps each row's line, amount and
  -- prior invoice_id.
  WITH history AS (
    SELECT ila.id, ila.invoice_id, ila.invoice_item_id, ila.amount_cents
      FROM invoice_line_allocations ila
     WHERE ila.id = ANY (v_history_ids)
  ), unlinked AS (
    UPDATE invoice_line_allocations ila
       SET invoice_item_id = NULL, invoice_id = COALESCE(ila.invoice_id, p_invoice_id)
      FROM history h WHERE ila.id = h.id
    RETURNING h.id, h.invoice_id, h.invoice_item_id, h.amount_cents
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('allocation_id', u.id, 'invoice_item_id', u.invoice_item_id,
                                               'amount_cents', u.amount_cents, 'invoice_id_before', u.invoice_id)
                    ORDER BY u.id), '[]'::jsonb)
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
    'Unposted ' || v_inv.invoice_number || ' (was ' || v_inv.status || ') — $' || (COALESCE(v_inv.total_amount_cents,0) * 0.01)::numeric(20,2)
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
$function$
$create$;
  ALTER FUNCTION public._unpost_invoice_replay_impl_20261015(uuid, uuid, text) OWNER TO postgres;
  REVOKE ALL ON FUNCTION public._unpost_invoice_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

  -- Postflight: the new body, still one overload, owner, mode, search_path and EXECUTE grants.
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._unpost_invoice_replay_impl_20261015(uuid,uuid,text)');
  IF p.oid IS NULL
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '5dbf08047772d875bfbe66ec8b63cbfd'
     OR (SELECT count(*) FROM pg_proc o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_unpost_invoice_replay_impl_20261015') <> 1
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres'] THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: _unpost_invoice_replay_impl_20261015 body, overloads, owner, mode, search_path or EXECUTE grants are wrong';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$migrate$;
