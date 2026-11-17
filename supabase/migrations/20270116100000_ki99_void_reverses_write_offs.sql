-- KI-99: voiding an invoice also reverses its active write-offs.
-- Every void path (void_invoice, void_invoice_group, batch_void_invoices) ends in
-- _void_invoice_split_provenance_impl_20260719, which zeroed invoices.write_off_cents but left the
-- write_offs row active, so the customer statement (which drops voided invoices but subtracts every
-- write-off with reversed_at IS NULL) showed an unexplained credit. Mason, 2026-11-14: auto-reverse.
-- The function below is its live definition (20261206110000, md5 checked 2026-11-14) with only the
-- marked KI-99 lines added: before the invoice is zeroed, each active write-off is marked reversed
-- (reversed_at/by/reason) with one write_off_reversed audit row, after its Chicago booking month is
-- checked open. Live had 0 active write-offs on voided or cancelled invoices (2026-11-14), so no
-- existing row changes and nothing is backfilled. The credit-month half of KI-99 was already fixed by
-- 20261206110000 (KI-18).
-- Signature, return type, SECURITY DEFINER, search_path, owner and grants are unchanged; CREATE OR
-- REPLACE keeps owner and grants. The preflight pins the body md5 (live or this file's), arguments,
-- settings, owner, exact grants and a single overload; the postflight pins the new body. No row is written.
-- Rollback: a forward migration re-emitting the pre-image (md5 604b914bae32ca1da76719658a561730, body in 20261206110000).
DO $preflight$
DECLARE
  v_row record;
  v_fn pg_proc;
BEGIN
  FOR v_row IN SELECT * FROM (VALUES
    ('_void_invoice_split_provenance_impl_20260719(uuid,text,text)', '604b914bae32ca1da76719658a561730', 'd431c88af12d3c0563ce931e5f729c89', '{postgres=X/postgres}', 'p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text')
  ) AS t(sig, pre_md5, post_md5, acl, args)
  LOOP
    SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.' || v_row.sig);
    IF v_fn.oid IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % is missing', v_row.sig;
    END IF;
    IF md5(replace(v_fn.prosrc, chr(13), '')) NOT IN (v_row.pre_md5, v_row.post_md5)
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR NOT v_fn.prosecdef
       OR v_fn.provolatile <> 'v'
       OR coalesce((SELECT array_agg(g::text ORDER BY g::text COLLATE "C") FROM unnest(v_fn.proacl) g)::text, 'NULL') IS DISTINCT FROM v_row.acl
       OR pg_get_function_arguments(v_fn.oid) <> v_row.args
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres'
       OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_fn.proname) <> 1 THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % body, arguments, settings, owner, grants or overloads drifted; re-review the current definition', v_row.sig;
    END IF;
  END LOOP;
END;
$preflight$;

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
  v_wo record;  -- KI-99: active write-off cursor
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

  -- KI-99 (Mason, 2026-11-14): voiding also reverses the invoice's active write-offs, as reverse_write_off
  -- records them, so a voided invoice's write-off never stays on the customer statement. Each write-off's
  -- Chicago booking month must be open (the month its apply and reverse_write_off check); a closed one
  -- refuses the whole void. apply_write_off only writes on posted/overdue and unpost refuses a written-off
  -- invoice, so the draft/unposted branch above never has one.
  FOR v_wo IN
    SELECT id, amount_cents, created_at FROM write_offs
     WHERE invoice_id = p_invoice_id AND reversed_at IS NULL
     ORDER BY id
     FOR UPDATE
  LOOP
    PERFORM check_period_open((v_wo.created_at AT TIME ZONE 'America/Chicago')::date);
    UPDATE write_offs SET reversed_at = now(), reversed_by = auth.uid(),
      reversed_reason = 'Auto-reversed: invoice ' || v_inv.invoice_number || ' voided — ' || p_void_reason
     WHERE id = v_wo.id;
    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
    VALUES ('write_off_reversed', 'write_off', v_wo.id, v_actor_role,
      jsonb_build_object('amount_cents', v_wo.amount_cents, 'reversed_at', null, 'invoice_status', v_inv.status),
      jsonb_build_object('reversed_at', now(), 'reverse_reason', 'Auto-reversed: invoice ' || v_inv.invoice_number || ' voided — ' || p_void_reason,
        'invoice_status', 'voided'),
      v_wo.amount_cents,
      'Write-off of ' || (v_wo.amount_cents::numeric / 100)::text || ' reversed on invoice ' || p_invoice_id::text
        || ': auto-reversed, invoice ' || v_inv.invoice_number || ' voided — ' || p_void_reason);
    -- Same customer-timeline event reverse_write_off writes.
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('write_off_reversed',
      'Write-off of $' || (v_wo.amount_cents::numeric / 100)::text || ' reversed: auto-reversed, invoice ' || v_inv.invoice_number || ' voided — ' || p_void_reason,
      auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);
  END LOOP;

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

DO $postflight$
DECLARE
  v_row record;
  v_fn pg_proc;
BEGIN
  -- A void committed under the old body leaves its write-off active; refuse rather than install over it.
  LOCK TABLE public.invoices, public.write_offs IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.write_offs w JOIN public.invoices i ON i.id = w.invoice_id
             WHERE w.reversed_at IS NULL AND i.status = 'voided') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a voided invoice still has an active write-off; resolve it before applying KI-99';
  END IF;
  FOR v_row IN SELECT * FROM (VALUES
    ('_void_invoice_split_provenance_impl_20260719(uuid,text,text)', '604b914bae32ca1da76719658a561730', 'd431c88af12d3c0563ce931e5f729c89', '{postgres=X/postgres}', 'p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text')
  ) AS t(sig, pre_md5, post_md5, acl, args)
  LOOP
    SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.' || v_row.sig);
    IF v_fn.oid IS NULL
       OR md5(replace(v_fn.prosrc, chr(13), '')) <> v_row.post_md5
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR NOT v_fn.prosecdef
       OR v_fn.provolatile <> 'v'
       OR coalesce((SELECT array_agg(g::text ORDER BY g::text COLLATE "C") FROM unnest(v_fn.proacl) g)::text, 'NULL') IS DISTINCT FROM v_row.acl
       OR pg_get_function_arguments(v_fn.oid) <> v_row.args
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres' THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % did not take the new body', v_row.sig;
    END IF;
  END LOOP;
END;
$postflight$;
