-- Written 2026-11-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270225110000_m9_refunds_and_returned_checks.md.
-- Re-read the live ledger before applying.
--
-- WHY (M9, billing plan 4 Nov / audit 1.3; design docs/plans/2026-11-23-m9-refunds-returned-checks-DESIGN.md):
--   A refund paid back to a customer outside CRX (a QuickBooks check) can only be entered today by editing the
--   prepay credit down, which leaves no refund record and rewrites the credit's original amount. Nothing checks the
--   customer's stored prepay against the credits (reconcile_prepay_balances silently resets it). A bounced check
--   from a closed month cannot be recorded at all (Mason's decision 18: record a "returned check" in the open month;
--   the invoices it paid are unpaid again; any prepay it funded comes off; the closed month stays closed).
--
-- WHAT:
--   1. money_reversals (one row per refund or returned check, dated in an open month) and money_reversal_lines (what
--      it took from each prepay credit, each invoice payment, each prepay application). Append-only; written only by
--      the functions below; active admins and reps may read them (as allocation_sets).
--   2. _recompute_prepay_credit_balance: balance = original - applications + reversed applications - reversal lines
--      (one inserted term pair; the old formula when a credit has no lines). The same trigger also runs AFTER INSERT
--      on money_reversal_lines. original_amount_cents is never changed, so Month-End's prepay-check figure is not moved.
--   3. record_outside_refund(customer, amount, date, reference, reason, credit?, performed_by, key): active admin,
--      key required; date <= today and in an open month (check_period_open); oldest credit first (or only the one
--      picked); refused above the available prepay or when the stored balance is lower (drift); lowers the stored
--      balance by the amount.
--   4. record_returned_check(payment?, date, reason, performed_by, key, credit?): one of a Record Payment
--      (allocation set) or a Prepayment Manager check credit. Date in an open month, not before the check was
--      received. Reopens the invoices the check paid, reverses the prepay applications of its credits (those invoices
--      reopen too; the application rows stay), takes what is left off the credits and the unused part off the stored
--      balance. Refused if any of its prepay was already refunded. One return per payment and per credit. The payment
--      rows, allocation lines, applications and periods are never written.
--   5. get_prepay_balance_check(customer?): read-only; received - applied - refunded - returned = expected, against
--      the stored balance and the credits' balances; never fixes anything.
--   6. Month-End: _month_payments_received nets returned checks out of payments received on their entry date (not
--      counted as payments); _month_close_figures adds refunds {count,total_cents} and returned_checks figures (so the
--      review token covers them) and refunds_paid_cents / returned_checks_cents on the close receipt.
--   7. Statement (_get_customer_statement_scoped_impl): a "Returned check" row puts back what the check paid; a
--      "Refund paid (outside CRX)" row with $0 effect. statement_customer_has_later_balance_activity: a later returned
--      check makes an older A/R date unrebuildable (flagged), as a later void does.
--   8. Guards: void_payment refuses a returned payment and one whose prepay was refunded; edit_prepay_credit refuses a
--      balance change and delete_prepay_credit refuses a credit with reversal lines. Invoice void keeps refusing while
--      the returned payment's allocations exist; a reversed application can never be deleted (FK, no cascade).
--   Audit: financial_audit_log_operation_type_check gains 'prepay_refunded_outside' and 'payment_returned'.
--
-- NOT CHANGED: who may call each replaced function, its arguments, defaults, grants and security; every other
-- Month-End figure; saved close receipts; any existing row.
-- caller-analysis: record_outside_refund / record_returned_check / get_prepay_balance_check :: new; no caller yet (the
-- screen stage adds them). The replaced functions keep their signatures and wrappers.
-- ROLLBACK (its own reviewed migration, only while no money_reversals row exists): re-create the eight replaced
-- functions from the bodies pinned in this file's preflight (latest defining migrations: 20260728231350 / baseline
-- for the recompute, 20261204100000 for void_payment, baseline for edit/delete, 20270224120000 for the two Month-End
-- helpers, 20260803221244 for the tripwire, 20261204110000 for the statement), restore the audit CHECK list, drop
-- the three new functions, the trigger, the two tables and the append-only function.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE m9_refunds_returned_checks_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

CREATE TEMP TABLE m9_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
      ('public._recompute_prepay_credit_balance()', '62822c67b972a855aed23f9e9bac1d75', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}', 0, 'v'),
      ('public._void_payment_replay_impl_20261015(uuid,text,uuid,text)', '249d13c9887436709119b442a8928ad3', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres}', 2, 'v'),
      ('public._edit_prepay_credit_replay_impl_20261015(uuid,bigint,text,text,text,uuid,text)', '366db16a403a0f508b28aadc8862475c', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres}', 6, 'v'),
      ('public._delete_prepay_credit_replay_impl_20261015(uuid,text,uuid,text)', 'bcb90bd23619af6f1e45c69bb2db4169', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres}', 2, 'v'),
      ('public._month_payments_received_20270208(date,date)', 'b090a4ff1e6711f2565414c794e96d3a', false, '{"search_path=public, pg_temp"}', '{postgres=X/postgres,service_role=X/postgres}', 0, 's'),
      ('public._month_close_figures_20270208(date,date)', 'b20bcd3b5e5fd21adf8988cbbec80832', false, '{"search_path=public, pg_temp"}', '{postgres=X/postgres,service_role=X/postgres}', 0, 's'),
      ('public.statement_customer_has_later_balance_activity(uuid,date)', '92ec7763565786356e95f722e1745885', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres}', 0, 's'),
      ('public._get_customer_statement_scoped_impl(uuid,date,date)', 'ee463c1bee06baa4b71943695da3bacf', true, '{"search_path=public, pg_temp"}', '{postgres=X/postgres}', 2, 's')
) AS t(sig, md5, secdef, cfg, acl, ndefaults, vol);

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.m9_refunds_returned_checks_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.m9_refunds_returned_checks_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'M9_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.money_reversals') IS NOT NULL OR to_regclass('public.money_reversal_lines') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                 AND proname IN ('record_outside_refund', 'record_returned_check', 'get_prepay_balance_check',
                                 '_money_reversals_append_only_20270225')) THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._month_close_figures_20270208(date,date)') IS NULL THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: 20270224120000_month_close_payments_received_recheck is not applied';
  END IF;
  -- Every function replaced below, exactly as the latest migration defining it left it (body, owner, security,
  -- search_path, grants, defaults, volatility).
  SELECT string_agg(f.sig, ', ') INTO v_bad
    FROM pg_temp.m9_pins f
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.sig)
        AND md5(replace(p.prosrc, chr(13), '')) = f.md5
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef = f.secdef
        AND p.proconfig::text = f.cfg
        AND p.proacl::text = f.acl
        AND p.pronargdefaults = f.ndefaults
        AND p.provolatile::text = f.vol);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: drifted: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('_recompute_prepay_credit_balance', '_void_payment_replay_impl_20261015', '_edit_prepay_credit_replay_impl_20261015', '_delete_prepay_credit_replay_impl_20261015', '_month_payments_received_20270208', '_month_close_figures_20270208', 'statement_customer_has_later_balance_activity', '_get_customer_statement_scoped_impl')) <> 8 THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: an unexpected overload of a replaced function exists';
  END IF;
  IF (SELECT md5(pg_get_constraintdef(oid)) FROM pg_constraint
       WHERE conrelid = 'public.financial_audit_log'::regclass AND conname = 'financial_audit_log_operation_type_check')
     IS DISTINCT FROM '424d2bb072159b9064b143ecf260e88c' THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: financial_audit_log_operation_type_check drifted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_recompute_prepay_credit_balance'
                  AND tgrelid = 'public.prepay_applications'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M9_PREFLIGHT: the prepay recompute trigger is missing';
  END IF;
END
$preflight$;

-- 1. The record of money going back out (refunds) or never arriving (returned checks) -----------------------------
CREATE TABLE public.money_reversals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('outside_refund', 'returned_check')),
  customer_id       uuid NOT NULL REFERENCES public.customers(id),
  entry_date        date NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  reference         text,
  reason            text NOT NULL CHECK (reason ~ '\S'),
  allocation_set_id uuid REFERENCES public.allocation_sets(id),
  prepay_credit_id  uuid REFERENCES public.prepay_credits(id),
  performed_by      uuid NOT NULL REFERENCES public.profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT money_reversals_source CHECK (
    (kind = 'outside_refund' AND allocation_set_id IS NULL AND prepay_credit_id IS NULL)
    OR (kind = 'returned_check' AND num_nonnulls(allocation_set_id, prepay_credit_id) = 1))
);
COMMENT ON TABLE public.money_reversals IS
  'M9: a refund paid outside CRX (outside_refund) or a returned/bounced check (returned_check), dated in an open month (entry_date). Append-only; written only by record_outside_refund / record_returned_check.';
-- A check comes back once: one return per Record Payment and one per Prepayment Manager check credit.
CREATE UNIQUE INDEX money_reversals_one_return_per_payment ON public.money_reversals (allocation_set_id)
  WHERE kind = 'returned_check' AND allocation_set_id IS NOT NULL;
CREATE UNIQUE INDEX money_reversals_one_return_per_credit ON public.money_reversals (prepay_credit_id)
  WHERE kind = 'returned_check' AND prepay_credit_id IS NOT NULL;
CREATE INDEX money_reversals_customer_date ON public.money_reversals (customer_id, entry_date);
CREATE INDEX money_reversals_entry_date ON public.money_reversals (entry_date);

CREATE TABLE public.money_reversal_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reversal_id           uuid NOT NULL REFERENCES public.money_reversals(id),
  line_kind             text NOT NULL CHECK (line_kind IN ('prepay_credit', 'invoice_payment', 'prepay_application')),
  prepay_credit_id      uuid REFERENCES public.prepay_credits(id),
  invoice_id            uuid REFERENCES public.invoices(id),
  -- No cascade: a reversed application can never be deleted (an invoice void that would delete it is refused).
  prepay_application_id uuid REFERENCES public.prepay_applications(id),
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT money_reversal_lines_shape CHECK (
    (line_kind = 'prepay_credit' AND prepay_credit_id IS NOT NULL AND invoice_id IS NULL AND prepay_application_id IS NULL)
    OR (line_kind = 'invoice_payment' AND invoice_id IS NOT NULL AND prepay_credit_id IS NULL AND prepay_application_id IS NULL)
    OR (line_kind = 'prepay_application' AND prepay_application_id IS NOT NULL AND prepay_credit_id IS NOT NULL AND invoice_id IS NOT NULL))
);
COMMENT ON TABLE public.money_reversal_lines IS
  'M9: what one money_reversals row took from each prepay credit (prepay_credit), each invoice payment (invoice_payment) and each prepay application (prepay_application). Counted by _recompute_prepay_credit_balance. Append-only.';
CREATE UNIQUE INDEX money_reversal_lines_one_per_application ON public.money_reversal_lines (prepay_application_id)
  WHERE prepay_application_id IS NOT NULL;
CREATE INDEX money_reversal_lines_reversal ON public.money_reversal_lines (reversal_id);
CREATE INDEX money_reversal_lines_credit ON public.money_reversal_lines (prepay_credit_id) WHERE prepay_credit_id IS NOT NULL;
CREATE INDEX money_reversal_lines_invoice ON public.money_reversal_lines (invoice_id) WHERE invoice_id IS NOT NULL;

CREATE FUNCTION public._money_reversals_append_only_20270225()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'MONEY_REVERSAL_IMMUTABLE: % rows cannot be changed or deleted', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$function$;
REVOKE ALL ON FUNCTION public._money_reversals_append_only_20270225() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER money_reversals_append_only BEFORE UPDATE OR DELETE ON public.money_reversals
  FOR EACH ROW EXECUTE FUNCTION public._money_reversals_append_only_20270225();
CREATE TRIGGER money_reversal_lines_append_only BEFORE UPDATE OR DELETE ON public.money_reversal_lines
  FOR EACH ROW EXECUTE FUNCTION public._money_reversals_append_only_20270225();
CREATE TRIGGER money_reversal_lines_truncate_refused BEFORE TRUNCATE ON public.money_reversal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public._money_reversals_append_only_20270225();
CREATE TRIGGER money_reversals_truncate_refused BEFORE TRUNCATE ON public.money_reversals
  FOR EACH STATEMENT EXECUTE FUNCTION public._money_reversals_append_only_20270225();

-- Reads: active admins and sales reps, as allocation_sets (20261022040000). No API role writes.
ALTER TABLE public.money_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.money_reversal_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.money_reversals, public.money_reversal_lines FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.money_reversals, public.money_reversal_lines TO authenticated, service_role;
CREATE POLICY money_reversals_staff_read ON public.money_reversals FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());
CREATE POLICY money_reversal_lines_staff_read ON public.money_reversal_lines FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

-- 2. The prepay credit balance counts reversal lines; the same trigger runs when a line is written ----------------
-- Audit operation types for the two new writers (the current list plus two).
ALTER TABLE public.financial_audit_log DROP CONSTRAINT financial_audit_log_operation_type_check;
ALTER TABLE public.financial_audit_log ADD CONSTRAINT financial_audit_log_operation_type_check
  CHECK ((operation_type = ANY (ARRAY['invoice_created'::text, 'invoice_posted'::text, 'invoice_unposted'::text, 'invoice_voided'::text, 'invoice_cancelled'::text, 'invoice_updated'::text, 'invoice_deleted'::text, 'invoice_marked_overdue'::text, 'payment_recorded'::text, 'payment_allocation'::text, 'payment_voided'::text, 'payment_allocated'::text, 'split_modified'::text, 'split_invoices_generated'::text, 'prepay_created'::text, 'prepay_applied'::text, 'prepay_credit_created'::text, 'prepay_batch_applied'::text, 'prepay_edited'::text, 'prepay_deleted'::text, 'prepay_reconciliation'::text, 'batch_prepay_apply'::text, 'write_off_recorded'::text, 'write_off_reversed'::text, 'write_off_applied'::text, 'finance_charge'::text, 'finance_charge_generated'::text, 'finance_charge_voided'::text, 'credit_memo_created'::text, 'credit_memo_applied'::text, 'credit_memo_unapplied'::text, 'return_created'::text, 'return_approved'::text, 'return_received'::text, 'return_credit_issued'::text, 'order_created'::text, 'order_updated'::text, 'order_voided'::text, 'order_cancelled'::text, 'order_restored'::text, 'delivery_created'::text, 'delivery_updated'::text, 'delivery_cancelled'::text, 'delivery_voided'::text, 'delivery_restored'::text, 'quote_converted'::text, 'blend_ticket_linked'::text, 'blend_ticket_unlinked'::text, 'commission_payment_created'::text, 'commission_payment_posted'::text, 'commission_payment_voided'::text, 'batch_post'::text, 'batch_void'::text, 'batch_payment'::text, 'period_reopened'::text, 'quote_status_reverted'::text, 'blend_ticket_approval_reversed'::text, 'cycle_count_completed'::text, 'vendor_bill_created'::text, 'vendor_bill_voided'::text, 'vendor_bill_updated'::text, 'vendor_payment_recorded'::text, 'vendor_payment_voided'::text, 'rup_sales_voided'::text, 'receiving_reversed'::text, 'payment_deleted'::text, 'allocation_set_deleted'::text, 'prepay_refunded_outside'::text, 'payment_returned'::text])));

CREATE OR REPLACE FUNCTION public._recompute_prepay_credit_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid;
BEGIN
  v_target := COALESCE(NEW.prepay_credit_id, OLD.prepay_credit_id);

  UPDATE prepay_credits
     SET balance_cents = original_amount_cents - COALESCE(
           (SELECT SUM(applied_amount_cents)
              FROM prepay_applications
             WHERE prepay_credit_id = v_target),
           0
         )
         -- M9: an application reversed by a returned check counts back; a refund or returned-check line takes off.
         + COALESCE(
           (SELECT SUM(amount_cents)
              FROM money_reversal_lines
             WHERE prepay_credit_id = v_target AND line_kind = 'prepay_application'),
           0
         )
         - COALESCE(
           (SELECT SUM(amount_cents)
              FROM money_reversal_lines
             WHERE prepay_credit_id = v_target AND line_kind = 'prepay_credit'),
           0
         ),
         updated_at = now()
   WHERE id = v_target;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public._void_payment_replay_impl_20261015(p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_set              record;
  v_alloc            record;
  v_actor            uuid;
  v_reversed_cents   bigint := 0;
  v_invoice_count    int    := 0;
  v_prepay_reversed  bigint := 0;
  v_old_balance      bigint;
  v_credit           record;
  v_app              record;
  v_apps_reversed_cents bigint := 0;
  v_existing         jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'void_payment';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_set FROM allocation_sets WHERE id = p_allocation_set_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation set not found: %', p_allocation_set_id; END IF;
  IF NOT v_set.is_active THEN RAISE EXCEPTION 'Payment already voided'; END IF;

  -- M9: a check recorded as returned (bounced) is not voided as well, and a payment whose prepay was partly refunded
  -- cannot be voided (its credit would go below $0). The credits are locked first, as a refund locks them.
  PERFORM 1 FROM prepay_credits
   WHERE allocation_set_id = p_allocation_set_id AND source_type = 'overpayment' ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM money_reversals WHERE kind = 'returned_check' AND allocation_set_id = p_allocation_set_id) THEN
    RAISE EXCEPTION 'PAYMENT_RETURNED: this check is recorded as returned (bounced); it cannot also be voided';
  END IF;
  IF EXISTS (SELECT 1 FROM money_reversal_lines l JOIN prepay_credits pc ON pc.id = l.prepay_credit_id
              WHERE pc.allocation_set_id = p_allocation_set_id AND pc.source_type = 'overpayment') THEN
    RAISE EXCEPTION 'PAYMENT_PREPAY_REFUNDED: part of this payment''s prepay was refunded to the customer; it cannot be voided';
  END IF;

  PERFORM check_period_open(COALESCE(v_set.payment_date, (now() AT TIME ZONE 'America/Chicago')::date));

  FOR v_alloc IN
    SELECT ila.invoice_id, SUM(ila.amount_cents) AS total_amount
    FROM invoice_line_allocations ila
    WHERE ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
    GROUP BY ila.invoice_id
  LOOP
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN status IN ('paid', 'posted') THEN
            -- CREDIT-APPLY: include credit_applied_cents in the settled recompute
            CASE WHEN (total_amount_cents - (GREATEST(paid_amount_cents - v_alloc.total_amount, 0) + prepay_applied_cents + write_off_cents + credit_applied_cents)) <= 0
                 THEN 'paid' ELSE 'posted' END
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;
    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  FOR v_credit IN
    SELECT id, balance_cents
    FROM prepay_credits
    WHERE source_type = 'overpayment'
      AND customer_id = v_set.customer_id
      AND allocation_set_id = p_allocation_set_id
    FOR UPDATE
  LOOP
    FOR v_app IN
      SELECT pa.invoice_id, pa.applied_amount_cents
      FROM prepay_applications pa
      WHERE pa.prepay_credit_id = v_credit.id
    LOOP
      PERFORM 1 FROM invoices WHERE id = v_app.invoice_id FOR UPDATE;
      UPDATE invoices
      SET prepay_applied_cents = GREATEST(prepay_applied_cents - v_app.applied_amount_cents, 0),
          status = CASE
            WHEN status IN ('paid', 'posted') THEN
              CASE WHEN (total_amount_cents - (paid_amount_cents + GREATEST(prepay_applied_cents - v_app.applied_amount_cents, 0) + write_off_cents + credit_applied_cents)) <= 0
                   THEN 'paid' ELSE 'posted' END
            ELSE status
          END,
          updated_at = now()
      WHERE id = v_app.invoice_id;
      v_apps_reversed_cents := v_apps_reversed_cents + v_app.applied_amount_cents;
    END LOOP;

    DELETE FROM prepay_applications WHERE prepay_credit_id = v_credit.id;

    UPDATE prepay_credits
    SET balance_cents = 0, original_amount_cents = 0, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now()
    WHERE id = v_credit.id;
    v_prepay_reversed := v_prepay_reversed + v_credit.balance_cents;
  END LOOP;

  IF v_prepay_reversed > 0 THEN
    UPDATE customers SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0) WHERE id = v_set.customer_id;
  END IF;

  UPDATE allocation_sets SET is_active = false, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now() WHERE id = p_allocation_set_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id, v_actor,
    jsonb_build_object('total_payment_cents', v_set.total_payment_cents, 'total_allocated_cents', v_set.total_allocated_cents, 'payment_method', v_set.payment_method, 'check_number', v_set.check_number, 'customer_id', v_set.customer_id),
    jsonb_build_object('reason', p_reason, 'invoices_reversed', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed, 'prepay_applications_reversed_cents', v_apps_reversed_cents),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'void_payment', to_jsonb(p_allocation_set_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'reversed_cents', v_reversed_cents, 'invoices_affected', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed, 'prepay_applications_reversed_cents', v_apps_reversed_cents);
END;
$function$;

CREATE OR REPLACE FUNCTION public._edit_prepay_credit_replay_impl_20261015(p_credit_id uuid, p_new_balance_cents bigint DEFAULT NULL::bigint, p_reference_number text DEFAULT NULL::text, p_bucket_label text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_delta       bigint;
  v_actor       uuid;
  v_actor_role  text;
  v_existing    jsonb;
  v_sum_applied bigint;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'edit_prepay_credit';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Codex P1 fix (2026-05-16): IS DISTINCT FROM treats NULL (deactivated user
  -- or missing profile row) as "not admin" and raises. Prior `!= 'admin'`
  -- evaluated to NULL when subquery was empty and silently allowed mutation.
  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin access required to edit prepay credits';
  END IF;

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id; END IF;

  -- M9: a credit with a refund or a returned check recorded on it keeps its amounts (the edit would rewrite its
  -- original amount and erase them). Reference, label and notes can still change; the screen always sends the
  -- balance, so an unchanged balance is treated as no balance change.
  IF EXISTS (SELECT 1 FROM money_reversal_lines WHERE prepay_credit_id = p_credit_id) THEN
    IF p_new_balance_cents IS NOT NULL AND p_new_balance_cents IS DISTINCT FROM v_credit.balance_cents THEN
      RAISE EXCEPTION 'PREPAY_CREDIT_HAS_REVERSALS: this credit has a refund or returned check recorded; its balance cannot be edited';
    END IF;
    p_new_balance_cents := NULL;
  END IF;

  v_old_balance := v_credit.balance_cents;

  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications WHERE prepay_credit_id = p_credit_id;

  UPDATE prepay_credits SET
    balance_cents    = COALESCE(p_new_balance_cents, balance_cents),
    original_amount_cents = CASE
      WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents + v_sum_applied
      ELSE original_amount_cents
    END,
    reference_number = COALESCE(p_reference_number, reference_number),
    bucket_label     = COALESCE(p_bucket_label, bucket_label),
    notes            = COALESCE(p_notes, notes),
    updated_at       = now()
  WHERE id = p_credit_id;

  IF p_new_balance_cents IS NOT NULL AND p_new_balance_cents != v_old_balance THEN
    v_delta := p_new_balance_cents - v_old_balance;
    UPDATE customers
    SET prepay_balance_cents = GREATEST(prepay_balance_cents + v_delta, 0)
    WHERE id = v_credit.customer_id;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_edited', 'prepay', p_credit_id, v_actor,
    jsonb_build_object(
      'balance_cents', v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents', v_sum_applied,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object(
      'balance_cents', COALESCE(p_new_balance_cents, v_old_balance),
      'original_amount_cents', CASE
        WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents + v_sum_applied
        ELSE v_credit.original_amount_cents
      END,
      'reference_number', COALESCE(p_reference_number, v_credit.reference_number),
      'bucket_label', COALESCE(p_bucket_label, v_credit.bucket_label)
    ),
    COALESCE(p_new_balance_cents - v_old_balance, 0),
    'Edited prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text)
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'edit_prepay_credit', jsonb_build_object('credit_id', p_credit_id));
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'credit_id', p_credit_id,
    'old_balance_cents', v_old_balance,
    'new_balance_cents', COALESCE(p_new_balance_cents, v_old_balance)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._delete_prepay_credit_replay_impl_20261015(p_credit_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_actor       uuid;
  v_actor_role  text;
  v_existing    jsonb;
  v_sum_applied bigint;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'delete_prepay_credit';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Codex P1 fix (2026-05-16): null-safe admin check via IS DISTINCT FROM.
  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin access required to delete prepay credits';
  END IF;

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id; END IF;

  -- M9: a credit with a refund or a returned check recorded on it cannot be deleted (the delete would rewrite its
  -- original amount and erase them).
  IF EXISTS (SELECT 1 FROM money_reversal_lines WHERE prepay_credit_id = p_credit_id) THEN
    RAISE EXCEPTION 'PREPAY_CREDIT_HAS_REVERSALS: this credit has a refund or returned check recorded; it cannot be deleted';
  END IF;

  v_old_balance := v_credit.balance_cents;
  IF v_old_balance = 0 THEN RAISE EXCEPTION 'Prepay credit already has zero balance'; END IF;

  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications WHERE prepay_credit_id = p_credit_id;

  UPDATE prepay_credits
  SET balance_cents         = 0,
      original_amount_cents = v_sum_applied,
      notes                 = COALESCE(notes, '') || ' [DELETED: ' || p_reason || ']',
      updated_at            = now()
  WHERE id = p_credit_id;

  UPDATE customers
  SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_old_balance, 0)
  WHERE id = v_credit.customer_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_deleted', 'prepay', p_credit_id, v_actor,
    jsonb_build_object(
      'balance_cents', v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents', v_sum_applied,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object('balance_cents', 0, 'original_amount_cents', v_sum_applied, 'reason', p_reason),
    -1 * v_old_balance,
    'Deleted prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'delete_prepay_credit', jsonb_build_object('credit_id', p_credit_id));
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'credit_id', p_credit_id, 'deleted_balance_cents', v_old_balance
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._month_payments_received_20270208(p_start date, p_end date)
 RETURNS TABLE(payment_count bigint, total_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH received AS (
    -- Record Payment: the whole check, including a part kept as prepay; a voided payment is inactive.
    SELECT COALESCE(a.total_payment_cents, a.total_allocated_cents, 0)::numeric AS cents
      FROM public.allocation_sets a
     WHERE a.entity_type = 'payment'
       AND a.is_active
       AND a.payment_date BETWEEN p_start AND p_end
    UNION ALL
    -- Prepayment Manager checks at their current amount; the bucket splits of one check (one call: one created_at and
    -- one source_reference, never edited) are one payment.
    SELECT sum(pc.original_amount_cents)::numeric
      FROM public.prepay_credits pc
     WHERE pc.source_type = 'check'
       AND pc.allocation_set_id IS NULL
       AND pc.original_amount_cents > 0
       AND (pc.created_at AT TIME ZONE 'America/Chicago')::date BETWEEN p_start AND p_end
     GROUP BY pc.customer_id, pc.created_at, pc.source_reference
    UNION ALL
    -- Legacy payments table (none live), not deleted; dollars kept exact and rounded once on the total.
    SELECT p.amount * 100
      FROM public.payments p
     WHERE p.deleted_at IS NULL
       AND p.payment_date BETWEEN p_start AND p_end
    UNION ALL
    -- M9: a returned (bounced) check comes off the month it was recorded in (always an open month), never the month
    -- it was received in; it is not a payment, so it is not counted.
    SELECT -mr.amount_cents::numeric
      FROM public.money_reversals mr
     WHERE mr.kind = 'returned_check'
       AND mr.entry_date BETWEEN p_start AND p_end
  )
  SELECT count(*) FILTER (WHERE cents > 0)::bigint, round(COALESCE(sum(cents), 0))::bigint FROM received;
$function$;

CREATE OR REPLACE FUNCTION public._month_close_figures_20270208(p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_payments record;
BEGIN
  SELECT * INTO v_payments FROM public._month_payments_received_20270208(p_period_start, p_period_end);
  RETURN jsonb_build_object(
    'period_start', p_period_start,
    'period_end', p_period_end,
    'invoices', jsonb_build_object(
      'posted_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL),
      'total_amount_cents', COALESCE((SELECT sum(total_amount_cents - public._invoice_sales_tax_cents_20270109(id)) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL), 0),
      'total_cost_cents', COALESCE((SELECT sum(CASE
        WHEN inv.invoice_type = 'credit_memo'
         AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = inv.id)
          THEN inv.total_cost_cents
        -- (KI-126) a fee line's cost is already extended by acres
        ELSE (SELECT COALESCE(sum(CASE WHEN ii.is_application_fee THEN ii.cost_cents
                                       ELSE ROUND(ii.cost_cents * ii.quantity)::bigint END), 0)
              FROM public.invoice_items ii WHERE ii.invoice_id = inv.id)
      END) FROM public.invoices inv WHERE inv.invoice_date BETWEEN p_period_start AND p_period_end AND inv.status IN ('posted', 'overdue', 'paid') AND inv.deleted_at IS NULL), 0),
      'draft_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('draft', 'unposted') AND deleted_at IS NULL),
      'voided_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'voided' AND deleted_at IS NULL)
    ),
    -- (KI-129) money received: Record Payment, prepayment checks and live legacy rows
    'payments', jsonb_build_object('count', v_payments.payment_count, 'total_cents', v_payments.total_cents),
    -- M9: refunds paid outside CRX and returned checks recorded in the dates (returned checks are already netted out
    -- of payments received above).
    'refunds', (SELECT jsonb_build_object('count', count(*), 'total_cents', COALESCE(sum(mr.amount_cents), 0))
                  FROM public.money_reversals mr
                 WHERE mr.kind = 'outside_refund' AND mr.entry_date BETWEEN p_period_start AND p_period_end),
    'returned_checks', (SELECT jsonb_build_object('count', count(*), 'total_cents', COALESCE(sum(mr.amount_cents), 0))
                  FROM public.money_reversals mr
                 WHERE mr.kind = 'returned_check' AND mr.entry_date BETWEEN p_period_start AND p_period_end),
    'orders', jsonb_build_object('count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 'total_cents', COALESCE((SELECT sum((total_price * 100)::bigint) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 0)),
    'deliveries', jsonb_build_object('count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status NOT IN ('cancelled', 'voided') AND deleted_at IS NULL), 'completed_count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status = 'completed' AND deleted_at IS NULL)),
    'applications', jsonb_build_object('count', (SELECT count(*) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 'total_acres', COALESCE((SELECT sum(total_acres) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 0)),
    -- (KI-125) commission matched to the share of its sale billed in this period
    'commissions', (SELECT jsonb_build_object('earned_cents', r.earned_cents, 'paid_count', r.paid_count, 'basis', 'billed_share')
                       FROM public._report_commission_cents_20270203(p_period_start, p_period_end) r),
    'close_receipt', jsonb_build_object(
      'invoices_posted', (
        SELECT count(*) FROM public.invoices
         WHERE invoice_date BETWEEN p_period_start AND p_period_end
           AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL),
      'total_invoiced_cents', COALESCE((
        SELECT sum(total_amount_cents) FROM public.invoices
         WHERE invoice_date BETWEEN p_period_start AND p_period_end
           AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL), 0),
      'payments_received_cents', v_payments.total_cents,
      'refunds_paid_cents', COALESCE((SELECT sum(mr.amount_cents) FROM public.money_reversals mr
         WHERE mr.kind = 'outside_refund' AND mr.entry_date BETWEEN p_period_start AND p_period_end), 0),
      'returned_checks_cents', COALESCE((SELECT sum(mr.amount_cents) FROM public.money_reversals mr
         WHERE mr.kind = 'returned_check' AND mr.entry_date BETWEEN p_period_start AND p_period_end), 0),
      'orders_count', (
        SELECT count(*) FROM public.orders
         WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL),
      'deliveries_count', (
        SELECT count(*) FROM public.deliveries
         WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.statement_customer_has_later_balance_activity(p_customer_id uuid, p_as_of_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.invoices i
      JOIN public.invoice_line_allocations ila ON ila.invoice_id = i.id
      JOIN public.allocation_sets aset ON aset.id = ila.allocation_set_id
      WHERE i.customer_id = p_customer_id
        AND i.invoice_date <= p_as_of_date
        AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        AND aset.entity_type = 'payment'
        AND (
          (aset.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
          OR (aset.updated_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
          OR aset.payment_date > p_as_of_date
          OR EXISTS (
            SELECT 1
            FROM public.financial_audit_log fal
            WHERE fal.operation_type = 'payment_voided'
              AND fal.entity_type = 'allocation_set'
              AND fal.entity_id = aset.id
              AND (fal.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
          )
        )
    )
    OR EXISTS (
      -- prepay_applications are immutable while present, but a payment void
      -- deletes them. The parent credit's update timestamp is therefore the
      -- durable customer-level tripwire for both a later application and its
      -- later removal.
      SELECT 1
      FROM public.prepay_credits pc
      WHERE pc.customer_id = p_customer_id
        AND (
          (pc.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
          OR (pc.updated_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
        )
        AND EXISTS (
          SELECT 1
          FROM public.invoices i
          WHERE i.customer_id = p_customer_id
            AND i.invoice_date <= p_as_of_date
            AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.invoices i
      JOIN public.prepay_applications pa ON pa.invoice_id = i.id
      WHERE i.customer_id = p_customer_id
        AND i.invoice_date <= p_as_of_date
        AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        AND (pa.applied_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
    )
    OR EXISTS (
      SELECT 1
      FROM public.invoices i
      JOIN public.write_offs wo ON wo.invoice_id = i.id
      WHERE i.customer_id = p_customer_id
        AND i.invoice_date <= p_as_of_date
        AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        AND (
          (wo.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
          OR (wo.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
        )
    )
    OR EXISTS (
      -- A payment void can reverse cash allocations and can delete affected
      -- prepay_applications. Its audit row is durable, but it does not retain
      -- every target invoice id, so a customer-wide rejection is the only
      -- truthful historical behavior after such a reversal.
      SELECT 1
      FROM public.financial_audit_log fal
      JOIN public.allocation_sets aset ON aset.id = fal.entity_id
      WHERE fal.operation_type = 'payment_voided'
        AND fal.entity_type = 'allocation_set'
        AND aset.entity_type = 'payment'
        AND aset.customer_id = p_customer_id
        AND (fal.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
        AND EXISTS (
          SELECT 1
          FROM public.invoices i
          WHERE i.customer_id = p_customer_id
            AND i.invoice_date <= p_as_of_date
            AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        )
    )
    OR EXISTS (
      -- M9: a returned (bounced) check recorded after the cutoff reopened invoices and reversed prepay applications;
      -- the balance as of the cutoff cannot be rebuilt from today's invoice rows.
      SELECT 1
      FROM public.money_reversals mr
      WHERE mr.customer_id = p_customer_id
        AND mr.kind = 'returned_check'
        AND (mr.entry_date > p_as_of_date OR (mr.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
        AND EXISTS (
          SELECT 1
          FROM public.invoices i
          WHERE i.customer_id = p_customer_id
            AND i.invoice_date <= p_as_of_date
            AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        )
    );
$function$;

CREATE OR REPLACE FUNCTION public._get_customer_statement_scoped_impl(p_customer_id uuid, p_start_date date DEFAULT (((now() AT TIME ZONE 'America/Chicago'::text))::date - '90 days'::interval)::date, p_end_date date DEFAULT ((now() AT TIME ZONE 'America/Chicago'::text))::date)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, amount_cents bigint, running_balance bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = auth.uid()
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'INVALID_STATEMENT_DATE_RANGE';
  END IF;

  RETURN QUERY
  WITH all_txns AS (
    SELECT
      i.invoice_date::date AS txn_date,
      CASE WHEN i.invoice_type = 'credit_memo' THEN 'credit' ELSE 'invoice' END AS txn_type,
      i.invoice_number AS ref_num,
      CASE WHEN i.invoice_type = 'credit_memo'
           THEN 'Credit Memo ' || i.invoice_number
           ELSE 'Invoice ' || i.invoice_number END AS descr,
      i.total_amount_cents AS amt,
      10 AS source_rank,
      i.id AS sort_id
    FROM public.invoices i
    WHERE i.customer_id = p_customer_id
      AND i.status IN ('posted', 'paid', 'overdue')
      AND i.deleted_at IS NULL

    UNION ALL

    SELECT
      p.payment_date::date,
      'payment',
      COALESCE(p.reference_number, ''),
      'Payment - ' || p.payment_method,
      -(p.amount * 100)::bigint,
      20,
      p.id
    FROM public.payments p
    LEFT JOIN public.orders o ON o.id = p.order_id
    WHERE COALESCE(o.customer_id, p.customer_id) = p_customer_id
      AND p.deleted_at IS NULL

    UNION ALL

    SELECT
      COALESCE(a.payment_date, (a.created_at AT TIME ZONE 'America/Chicago')::date),
      'payment',
      COALESCE(a.reference_number, a.check_number, ''),
      'Payment - ' || COALESCE(a.payment_method, 'other'),
      -COALESCE(a.total_allocated_cents, 0),
      21,
      a.id
    FROM public.allocation_sets a
    WHERE a.entity_type = 'payment'
      AND a.is_active = true
      AND a.customer_id = p_customer_id
      AND COALESCE(a.total_allocated_cents, 0) > 0

    UNION ALL

    SELECT
      (pa.applied_at AT TIME ZONE 'America/Chicago')::date,
      'prepay',
      '',
      'Prepay Applied',
      -pa.applied_amount_cents,
      30,
      pa.id
    FROM public.prepay_applications pa
    INNER JOIN public.prepay_credits pc ON pc.id = pa.prepay_credit_id
    WHERE pc.customer_id = p_customer_id

    UNION ALL

    SELECT
      (wo.created_at AT TIME ZONE 'America/Chicago')::date,
      'write_off',
      i.invoice_number,
      'Write-off - ' || wo.reason,
      -wo.amount_cents,
      40,
      wo.id
    FROM public.write_offs wo
    INNER JOIN public.invoices i ON i.id = wo.invoice_id
    WHERE wo.customer_id = p_customer_id
      AND wo.reversed_at IS NULL

    UNION ALL

    -- M9: a returned (bounced) check puts back what it paid (cash and prepay) on the day it was recorded; the
    -- original payment and prepay rows stay.
    SELECT
      mr.entry_date,
      'returned_check',
      COALESCE(mr.reference, ''),
      'Returned check ' || COALESCE(mr.reference, '') || ' - ' || mr.reason,
      COALESCE((SELECT sum(l.amount_cents) FROM public.money_reversal_lines l
                 WHERE l.reversal_id = mr.id AND l.line_kind IN ('invoice_payment', 'prepay_application')), 0)::bigint,
      45,
      mr.id
    FROM public.money_reversals mr
    WHERE mr.customer_id = p_customer_id
      AND mr.kind = 'returned_check'

    UNION ALL

    -- M9: a refund paid outside CRX comes out of prepay, not out of what is owed: shown, $0.00 effect.
    SELECT
      mr.entry_date,
      'refund',
      COALESCE(mr.reference, ''),
      'Refund paid (outside CRX) ' || COALESCE(mr.reference, ''),
      0::bigint,
      46,
      mr.id
    FROM public.money_reversals mr
    WHERE mr.customer_id = p_customer_id
      AND mr.kind = 'outside_refund'
  ),
  opening AS (
    SELECT COALESCE(SUM(a.amt), 0)::bigint AS amt
      FROM all_txns a
     WHERE a.txn_date < p_start_date
  ),
  statement_txns AS (
    SELECT
      p_start_date AS txn_date,
      'opening_balance'::text AS txn_type,
      ''::text AS ref_num,
      'Opening Balance'::text AS descr,
      o.amt,
      0 AS source_rank,
      '00000000-0000-0000-0000-000000000000'::uuid AS sort_id
    FROM opening o
    WHERE o.amt <> 0

    UNION ALL

    SELECT a.txn_date, a.txn_type, a.ref_num, a.descr, a.amt,
           a.source_rank, a.sort_id
      FROM all_txns a
     WHERE a.txn_date BETWEEN p_start_date AND p_end_date
  )
  SELECT
    t.txn_date,
    t.txn_type,
    t.ref_num,
    t.descr,
    t.amt,
    SUM(t.amt) OVER (
      ORDER BY t.txn_date, t.source_rank, t.sort_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )::bigint
  FROM statement_txns t
  ORDER BY t.txn_date, t.source_rank, t.sort_id;
END;
$function$;

CREATE TRIGGER trg_recompute_prepay_credit_balance_m9 AFTER INSERT ON public.money_reversal_lines
  FOR EACH ROW EXECUTE FUNCTION public._recompute_prepay_credit_balance();

-- 3. Refund paid outside CRX ---------------------------------------------------------------------------------------
CREATE FUNCTION public.record_outside_refund(
  p_customer_id uuid,
  p_amount_cents bigint,
  p_refund_date date,
  p_reference text,
  p_reason text,
  p_credit_id uuid DEFAULT NULL::uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_today       date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_reference   text := NULLIF(btrim(p_reference), '');
  v_reason      text := NULLIF(btrim(p_reason), '');
  v_fingerprint text;
  v_replay      jsonb;
  v_available   bigint;
  v_stored      bigint;
  v_farm        text;
  v_left        bigint;
  v_take        bigint;
  v_credit      record;
  v_reversal_id uuid;
  v_lines       jsonb := '[]'::jsonb;
  v_result      jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- FOR SHARE holds off a deactivation or demotion until this call commits.
  PERFORM 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE: only an active admin can record a refund'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '\S' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: record_outside_refund requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'customer_id', p_customer_id, 'amount_cents', p_amount_cents, 'refund_date', p_refund_date,
    'reference', v_reference, 'reason', v_reason, 'credit_id', p_credit_id)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'record_outside_refund', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;

  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_REQUIRED: choose the customer'; END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT: the refund must be more than $0.00'; END IF;
  IF p_refund_date IS NULL THEN RAISE EXCEPTION 'REFUND_DATE_REQUIRED: enter the date the refund was paid'; END IF;
  IF p_refund_date > v_today THEN
    RAISE EXCEPTION 'REFUND_DATE_IN_FUTURE: refund date % is after today (%) in Central time', p_refund_date, v_today;
  END IF;
  IF v_reference IS NULL THEN RAISE EXCEPTION 'REFERENCE_REQUIRED: enter how it was paid (for example "QuickBooks check 1042")'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'REASON_REQUIRED: enter why the refund was paid'; END IF;
  IF length(v_reference) > 200 OR length(v_reason) > 2000 THEN
    RAISE EXCEPTION 'BAD_VALUE: reference at most 200 characters, reason at most 2000';
  END IF;
  -- The month lock (KI-19), then the closed-period refusal: a refund is dated in an open month only.
  PERFORM public.check_period_open(p_refund_date);

  IF p_credit_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.prepay_credits WHERE id = p_credit_id AND customer_id = p_customer_id) THEN
    RAISE EXCEPTION 'CREDIT_NOT_FOUND: that prepay credit is not this customer''s';
  END IF;
  -- Credits first, then the customer: the order apply_prepay_to_invoice and void_payment take them in.
  PERFORM 1 FROM public.prepay_credits
   WHERE customer_id = p_customer_id AND (p_credit_id IS NULL OR id = p_credit_id) AND balance_cents > 0
   ORDER BY id FOR UPDATE;
  SELECT COALESCE(sum(balance_cents), 0) INTO v_available FROM public.prepay_credits
   WHERE customer_id = p_customer_id AND (p_credit_id IS NULL OR id = p_credit_id) AND balance_cents > 0;
  SELECT prepay_balance_cents, farm_name INTO v_stored, v_farm FROM public.customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: %', p_customer_id; END IF;
  IF p_amount_cents > v_available THEN
    RAISE EXCEPTION 'PREPAY_REFUND_EXCEEDS_AVAILABLE: refund $% is more than the $% prepay available%',
      round(p_amount_cents / 100.0, 2), round(v_available / 100.0, 2),
      CASE WHEN p_credit_id IS NOT NULL THEN ' on that credit' ELSE '' END;
  END IF;
  IF COALESCE(v_stored, 0) < p_amount_cents THEN
    RAISE EXCEPTION 'PREPAY_BALANCE_DRIFT: the customer''s stored prepay ($%) is below the refund; run the prepay balance check first',
      round(COALESCE(v_stored, 0) / 100.0, 2);
  END IF;

  INSERT INTO public.money_reversals (kind, customer_id, entry_date, amount_cents, reference, reason, performed_by)
  VALUES ('outside_refund', p_customer_id, p_refund_date, p_amount_cents, v_reference, v_reason, v_actor)
  RETURNING id INTO v_reversal_id;

  -- Oldest credit first (or only the one picked); each line lowers that credit through the recompute trigger.
  v_left := p_amount_cents;
  FOR v_credit IN
    SELECT id, balance_cents FROM public.prepay_credits
     WHERE customer_id = p_customer_id AND (p_credit_id IS NULL OR id = p_credit_id) AND balance_cents > 0
     ORDER BY created_at, id
  LOOP
    EXIT WHEN v_left = 0;
    v_take := LEAST(v_credit.balance_cents, v_left);
    INSERT INTO public.money_reversal_lines (reversal_id, line_kind, prepay_credit_id, amount_cents)
    VALUES (v_reversal_id, 'prepay_credit', v_credit.id, v_take);
    v_lines := v_lines || jsonb_build_object('prepay_credit_id', v_credit.id, 'amount_cents', v_take);
    v_left := v_left - v_take;
  END LOOP;

  UPDATE public.customers
     SET prepay_balance_cents = prepay_balance_cents - p_amount_cents, updated_at = now()
   WHERE id = p_customer_id;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'prepay_refunded_outside', 'customer', p_customer_id, v_actor, 'admin',
    jsonb_build_object('reversal_id', v_reversal_id, 'refund_date', p_refund_date, 'reference', v_reference,
                       'reason', v_reason, 'credits', v_lines),
    -p_amount_cents,
    'Refund paid outside CRX $' || round(p_amount_cents / 100.0, 2) || ' to ' || COALESCE(v_farm, 'customer') || ' (' || v_reference || ')');
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('prepay_refunded_outside', 'Refund paid (outside CRX) $' || round(p_amount_cents / 100.0, 2) || ' - ' || v_reference,
          v_actor, 'money_reversal', v_reversal_id, p_customer_id);

  v_result := jsonb_build_object(
    'reversal_id', v_reversal_id, 'kind', 'outside_refund', 'customer_id', p_customer_id, 'refund_date', p_refund_date,
    'amount_cents', p_amount_cents, 'credits', v_lines,
    'prepay_balance_cents', (SELECT prepay_balance_cents FROM public.customers WHERE id = p_customer_id));
  PERFORM public.save_idempotency(p_idempotency_key, 'record_outside_refund', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'record_outside_refund', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.record_outside_refund(uuid, bigint, date, text, text, uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_outside_refund(uuid, bigint, date, text, text, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_outside_refund(uuid, bigint, date, text, text, uuid, uuid, text) TO authenticated, service_role;

-- 4. Returned (bounced) check: a Record Payment, or a Prepayment Manager check credit ------------------------------
CREATE FUNCTION public.record_returned_check(
  p_allocation_set_id uuid,
  p_returned_date date,
  p_reason text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_credit_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor        uuid := auth.uid();
  v_today        date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_reason       text := NULLIF(btrim(p_reason), '');
  v_fingerprint  text;
  v_replay       jsonb;
  v_set          record;
  v_src          record;
  v_customer     uuid;
  v_amount       bigint;
  v_reference    text;
  v_received_on  date;
  v_credit_ids   uuid[];
  v_refunded     bigint;
  v_before       bigint;
  v_stored       bigint;
  v_reversal_id  uuid;
  v_inv          record;
  v_app          record;
  v_left         bigint;
  v_invoice_cents bigint := 0;
  v_app_cents    bigint := 0;
  v_removed      bigint := 0;
  v_reopened     uuid[] := ARRAY[]::uuid[];
  v_credit_id    uuid;
  v_result       jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE: only an active admin can record a returned check'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '\S' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: record_returned_check requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'allocation_set_id', p_allocation_set_id, 'credit_id', p_credit_id,
    'returned_date', p_returned_date, 'reason', v_reason)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'record_returned_check', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;

  IF num_nonnulls(p_allocation_set_id, p_credit_id) <> 1 THEN
    RAISE EXCEPTION 'RETURNED_CHECK_SOURCE: give the payment or the prepayment check, exactly one';
  END IF;
  IF p_returned_date IS NULL THEN RAISE EXCEPTION 'RETURNED_DATE_REQUIRED: enter the date the bank returned the check'; END IF;
  IF p_returned_date > v_today THEN
    RAISE EXCEPTION 'RETURNED_DATE_IN_FUTURE: returned date % is after today (%) in Central time', p_returned_date, v_today;
  END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'REASON_REQUIRED: enter why the check came back'; END IF;
  IF length(v_reason) > 2000 THEN RAISE EXCEPTION 'BAD_VALUE: reason at most 2000 characters'; END IF;
  -- Decision 18: the entry is dated in an open month; the month the check was received in may be closed.
  PERFORM public.check_period_open(p_returned_date);

  -- The source is locked (void_payment / edit / delete take the same row lock) but never written.
  IF p_allocation_set_id IS NOT NULL THEN
    SELECT * INTO v_set FROM public.allocation_sets WHERE id = p_allocation_set_id FOR UPDATE;
    IF NOT FOUND OR v_set.entity_type IS DISTINCT FROM 'payment' THEN
      RAISE EXCEPTION 'PAYMENT_NOT_FOUND: %', p_allocation_set_id;
    END IF;
    IF NOT v_set.is_active THEN RAISE EXCEPTION 'PAYMENT_VOIDED: this payment was voided; nothing to return'; END IF;
    v_customer := v_set.customer_id;
    v_amount := COALESCE(v_set.total_payment_cents, v_set.total_allocated_cents, 0);
    v_reference := COALESCE(NULLIF(v_set.check_number, ''), NULLIF(v_set.reference_number, ''));
    v_received_on := v_set.payment_date;
    SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_credit_ids FROM public.prepay_credits
     WHERE allocation_set_id = p_allocation_set_id AND source_type = 'overpayment';
  ELSE
    SELECT * INTO v_src FROM public.prepay_credits WHERE id = p_credit_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_NOT_FOUND: %', p_credit_id; END IF;
    IF v_src.source_type IS DISTINCT FROM 'check' OR v_src.allocation_set_id IS NOT NULL THEN
      RAISE EXCEPTION 'NOT_A_PREPAYMENT_CHECK: only a Prepayment Manager check can be returned this way; return a Record Payment by its payment';
    END IF;
    IF v_src.original_amount_cents <= 0 THEN RAISE EXCEPTION 'CHECK_ALREADY_REMOVED: this prepayment check was deleted; nothing to return'; END IF;
    v_customer := v_src.customer_id;
    v_amount := v_src.original_amount_cents;
    v_reference := COALESCE(NULLIF(v_src.source_reference, ''), NULLIF(v_src.reference_number, ''));
    v_received_on := (v_src.created_at AT TIME ZONE 'America/Chicago')::date;
    v_credit_ids := ARRAY[p_credit_id];
  END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'NOTHING_TO_RETURN: this check has no amount'; END IF;
  IF p_returned_date < v_received_on THEN
    RAISE EXCEPTION 'RETURNED_BEFORE_RECEIVED: the check was received on %; it cannot come back before that', v_received_on;
  END IF;
  IF EXISTS (SELECT 1 FROM public.money_reversals
              WHERE kind = 'returned_check' AND (allocation_set_id = p_allocation_set_id OR prepay_credit_id = p_credit_id)) THEN
    RAISE EXCEPTION 'CHECK_ALREADY_RETURNED: this check is already recorded as returned';
  END IF;

  -- Credits (locked in id order), refused when cash already went back out of them.
  PERFORM 1 FROM public.prepay_credits WHERE id = ANY (v_credit_ids) ORDER BY id FOR UPDATE;
  SELECT COALESCE(sum(l.amount_cents), 0) INTO v_refunded
    FROM public.money_reversal_lines l JOIN public.money_reversals r ON r.id = l.reversal_id
   WHERE l.prepay_credit_id = ANY (v_credit_ids) AND l.line_kind = 'prepay_credit' AND r.kind = 'outside_refund';
  IF v_refunded > 0 THEN
    RAISE EXCEPTION 'CHECK_PREPAY_REFUNDED: $% of this check''s prepay was already refunded to the customer; record this bounce by hand',
      round(v_refunded / 100.0, 2);
  END IF;
  SELECT COALESCE(sum(balance_cents), 0) INTO v_before FROM public.prepay_credits WHERE id = ANY (v_credit_ids);

  INSERT INTO public.money_reversals (kind, customer_id, entry_date, amount_cents, reference, reason,
                                     allocation_set_id, prepay_credit_id, performed_by)
  VALUES ('returned_check', v_customer, p_returned_date, v_amount, v_reference, v_reason,
          p_allocation_set_id, p_credit_id, v_actor)
  RETURNING id INTO v_reversal_id;

  -- 1. The invoices this check paid are unpaid again (void_payment's status rule).
  FOR v_inv IN
    SELECT ila.invoice_id, sum(ila.amount_cents)::bigint AS cents
      FROM public.invoice_line_allocations ila
     WHERE p_allocation_set_id IS NOT NULL AND ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
     GROUP BY ila.invoice_id ORDER BY ila.invoice_id
  LOOP
    PERFORM 1 FROM public.invoices WHERE id = v_inv.invoice_id AND paid_amount_cents >= v_inv.cents FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_PAYMENT_CHANGED: an invoice this check paid no longer shows that payment; reload'; END IF;
    UPDATE public.invoices
       SET paid_amount_cents = paid_amount_cents - v_inv.cents,
           status = CASE
             WHEN status IN ('paid', 'posted') THEN
               CASE WHEN (total_amount_cents - ((paid_amount_cents - v_inv.cents) + prepay_applied_cents + write_off_cents + credit_applied_cents)) <= 0
                    THEN 'paid' ELSE 'posted' END
             ELSE status
           END,
           updated_at = now()
     WHERE id = v_inv.invoice_id;
    INSERT INTO public.money_reversal_lines (reversal_id, line_kind, invoice_id, amount_cents)
    VALUES (v_reversal_id, 'invoice_payment', v_inv.invoice_id, v_inv.cents);
    v_invoice_cents := v_invoice_cents + v_inv.cents;
    v_reopened := v_reopened || v_inv.invoice_id;
  END LOOP;

  -- 2. Prepay this check funded and already applied is reversed: those invoices are unpaid again. The application
  --    rows stay (history); a reversal line counts each one back on its credit.
  FOR v_app IN
    SELECT pa.id, pa.prepay_credit_id, pa.invoice_id, pa.applied_amount_cents
      FROM public.prepay_applications pa
     WHERE pa.prepay_credit_id = ANY (v_credit_ids)
     ORDER BY pa.invoice_id, pa.id
  LOOP
    PERFORM 1 FROM public.invoices WHERE id = v_app.invoice_id AND prepay_applied_cents >= v_app.applied_amount_cents FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_PREPAY_CHANGED: an invoice this check''s prepay paid no longer shows it; reload'; END IF;
    UPDATE public.invoices
       SET prepay_applied_cents = prepay_applied_cents - v_app.applied_amount_cents,
           status = CASE
             WHEN status IN ('paid', 'posted') THEN
               CASE WHEN (total_amount_cents - (paid_amount_cents + (prepay_applied_cents - v_app.applied_amount_cents) + write_off_cents + credit_applied_cents)) <= 0
                    THEN 'paid' ELSE 'posted' END
             ELSE status
           END,
           updated_at = now()
     WHERE id = v_app.invoice_id;
    INSERT INTO public.money_reversal_lines (reversal_id, line_kind, prepay_credit_id, invoice_id, prepay_application_id, amount_cents)
    VALUES (v_reversal_id, 'prepay_application', v_app.prepay_credit_id, v_app.invoice_id, v_app.id, v_app.applied_amount_cents);
    v_app_cents := v_app_cents + v_app.applied_amount_cents;
    IF NOT v_app.invoice_id = ANY (v_reopened) THEN v_reopened := v_reopened || v_app.invoice_id; END IF;
  END LOOP;

  -- 3. Whatever is left on the credits comes off (each ends at $0).
  FOREACH v_credit_id IN ARRAY v_credit_ids LOOP
    SELECT balance_cents INTO v_left FROM public.prepay_credits WHERE id = v_credit_id;
    IF v_left > 0 THEN
      INSERT INTO public.money_reversal_lines (reversal_id, line_kind, prepay_credit_id, amount_cents)
      VALUES (v_reversal_id, 'prepay_credit', v_credit_id, v_left);
      v_removed := v_removed + v_left;
    END IF;
  END LOOP;

  -- The customer's stored prepay drops by what was unapplied before (the applied part already came off when applied).
  SELECT prepay_balance_cents INTO v_stored FROM public.customers WHERE id = v_customer FOR UPDATE;
  IF v_before > 0 THEN
    IF COALESCE(v_stored, 0) < v_before THEN
      RAISE EXCEPTION 'PREPAY_BALANCE_DRIFT: the customer''s stored prepay ($%) is below this check''s unused prepay ($%); run the prepay balance check first',
        round(COALESCE(v_stored, 0) / 100.0, 2), round(v_before / 100.0, 2);
    END IF;
    UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents - v_before, updated_at = now() WHERE id = v_customer;
  END IF;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'payment_returned', CASE WHEN p_allocation_set_id IS NOT NULL THEN 'allocation_set' ELSE 'prepay_credit' END,
    COALESCE(p_allocation_set_id, p_credit_id), v_actor, 'admin',
    jsonb_build_object('reversal_id', v_reversal_id, 'returned_date', p_returned_date, 'reason', v_reason,
                       'invoices_reopened', to_jsonb(v_reopened), 'invoice_payment_cents', v_invoice_cents,
                       'prepay_applications_reversed_cents', v_app_cents, 'prepay_removed_cents', v_removed),
    -v_amount,
    'Returned check ' || COALESCE(v_reference, '') || ' $' || round(v_amount / 100.0, 2) || ' - ' || v_reason);
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('payment_returned', 'Returned check ' || COALESCE(v_reference, '') || ' $' || round(v_amount / 100.0, 2),
          v_actor, 'money_reversal', v_reversal_id, v_customer);

  v_result := jsonb_build_object(
    'reversal_id', v_reversal_id, 'kind', 'returned_check', 'customer_id', v_customer,
    'allocation_set_id', p_allocation_set_id, 'prepay_credit_id', p_credit_id, 'returned_date', p_returned_date,
    'amount_cents', v_amount, 'invoices_reopened', cardinality(v_reopened), 'invoice_payment_cents', v_invoice_cents,
    'prepay_applications_reversed_cents', v_app_cents, 'prepay_removed_cents', v_removed,
    'prepay_balance_cents', (SELECT prepay_balance_cents FROM public.customers WHERE id = v_customer));
  PERFORM public.save_idempotency(p_idempotency_key, 'record_returned_check', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'record_returned_check', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.record_returned_check(uuid, date, text, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_returned_check(uuid, date, text, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_returned_check(uuid, date, text, uuid, text, uuid) TO authenticated, service_role;

-- 5. Prepay balance check (read-only; never fixes) -------------------------------------------------------------------
CREATE FUNCTION public.get_prepay_balance_check(p_customer_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only an active admin can run the prepay balance check';
  END IF;
  RETURN (
    WITH cust AS (
      SELECT c.id, c.farm_name, COALESCE(c.prepay_balance_cents, 0)::bigint AS stored
        FROM public.customers c
       WHERE CASE WHEN p_customer_id IS NOT NULL THEN c.id = p_customer_id
                  ELSE COALESCE(c.prepay_balance_cents, 0) <> 0
                       OR EXISTS (SELECT 1 FROM public.prepay_credits pc WHERE pc.customer_id = c.id) END
    ), credits AS (
      SELECT pc.customer_id, sum(pc.original_amount_cents)::bigint AS received, sum(pc.balance_cents)::bigint AS on_credits
        FROM public.prepay_credits pc JOIN cust ON cust.id = pc.customer_id GROUP BY pc.customer_id
    ), applied AS (
      SELECT pc.customer_id, sum(pa.applied_amount_cents)::bigint AS cents
        FROM public.prepay_applications pa JOIN public.prepay_credits pc ON pc.id = pa.prepay_credit_id
        JOIN cust ON cust.id = pc.customer_id GROUP BY pc.customer_id
    ), lines AS (
      SELECT pc.customer_id,
             COALESCE(sum(l.amount_cents) FILTER (WHERE l.line_kind = 'prepay_application'), 0)::bigint AS reversed,
             COALESCE(sum(l.amount_cents) FILTER (WHERE l.line_kind = 'prepay_credit' AND r.kind = 'outside_refund'), 0)::bigint AS refunded,
             COALESCE(sum(l.amount_cents) FILTER (WHERE l.line_kind = 'prepay_credit' AND r.kind = 'returned_check'), 0)::bigint AS voided
        FROM public.money_reversal_lines l
        JOIN public.money_reversals r ON r.id = l.reversal_id
        JOIN public.prepay_credits pc ON pc.id = l.prepay_credit_id
        JOIN cust ON cust.id = pc.customer_id
       GROUP BY pc.customer_id
    ), rows AS (
      SELECT cust.id, cust.farm_name, cust.stored,
             COALESCE(cr.received, 0) AS received,
             COALESCE(ap.cents, 0) - COALESCE(ln.reversed, 0) AS applied,
             COALESCE(ln.refunded, 0) AS refunded,
             COALESCE(ln.voided, 0) AS voided,
             COALESCE(cr.on_credits, 0) AS on_credits
        FROM cust
        LEFT JOIN credits cr ON cr.customer_id = cust.id
        LEFT JOIN applied ap ON ap.customer_id = cust.id
        LEFT JOIN lines ln ON ln.customer_id = cust.id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'customer_id', id, 'farm_name', farm_name,
             'received_cents', received, 'applied_cents', applied, 'refunded_cents', refunded, 'voided_cents', voided,
             'expected_cents', received - applied - refunded - voided,
             'stored_cents', stored, 'credits_cents', on_credits,
             'difference_cents', stored - (received - applied - refunded - voided),
             'ok', stored = received - applied - refunded - voided AND on_credits = received - applied - refunded - voided)
             ORDER BY farm_name, id), '[]'::jsonb)
      FROM rows);
END;
$function$;
ALTER FUNCTION public.get_prepay_balance_check(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_prepay_balance_check(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_prepay_balance_check(uuid) TO authenticated, service_role;

-- 6. Postflight -----------------------------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.m9_strip(p_text text, p_blocks text[]) RETURNS text LANGUAGE plpgsql AS $strip$
DECLARE b text;
BEGIN
  FOREACH b IN ARRAY p_blocks LOOP p_text := replace(p_text, b, ''); END LOOP;
  RETURN p_text;
END
$strip$;

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  -- Each replaced body minus its inserted M9 blocks is byte-identical to the pinned body; nothing else changed.
  SELECT string_agg(f.sig, ', ') INTO v_bad
    FROM pg_temp.m9_pins f
    JOIN (VALUES
      ('public._recompute_prepay_credit_balance()', ARRAY[$m9blk$
         -- M9: an application reversed by a returned check counts back; a refund or returned-check line takes off.
         + COALESCE(
           (SELECT SUM(amount_cents)
              FROM money_reversal_lines
             WHERE prepay_credit_id = v_target AND line_kind = 'prepay_application'),
           0
         )
         - COALESCE(
           (SELECT SUM(amount_cents)
              FROM money_reversal_lines
             WHERE prepay_credit_id = v_target AND line_kind = 'prepay_credit'),
           0
         )$m9blk$]),
      ('public._void_payment_replay_impl_20261015(uuid,text,uuid,text)', ARRAY[$m9blk$
  -- M9: a check recorded as returned (bounced) is not voided as well, and a payment whose prepay was partly refunded
  -- cannot be voided (its credit would go below $0). The credits are locked first, as a refund locks them.
  PERFORM 1 FROM prepay_credits
   WHERE allocation_set_id = p_allocation_set_id AND source_type = 'overpayment' ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM money_reversals WHERE kind = 'returned_check' AND allocation_set_id = p_allocation_set_id) THEN
    RAISE EXCEPTION 'PAYMENT_RETURNED: this check is recorded as returned (bounced); it cannot also be voided';
  END IF;
  IF EXISTS (SELECT 1 FROM money_reversal_lines l JOIN prepay_credits pc ON pc.id = l.prepay_credit_id
              WHERE pc.allocation_set_id = p_allocation_set_id AND pc.source_type = 'overpayment') THEN
    RAISE EXCEPTION 'PAYMENT_PREPAY_REFUNDED: part of this payment''s prepay was refunded to the customer; it cannot be voided';
  END IF;
$m9blk$]),
      ('public._edit_prepay_credit_replay_impl_20261015(uuid,bigint,text,text,text,uuid,text)', ARRAY[$m9blk$
  -- M9: a credit with a refund or a returned check recorded on it keeps its amounts (the edit would rewrite its
  -- original amount and erase them). Reference, label and notes can still change; the screen always sends the
  -- balance, so an unchanged balance is treated as no balance change.
  IF EXISTS (SELECT 1 FROM money_reversal_lines WHERE prepay_credit_id = p_credit_id) THEN
    IF p_new_balance_cents IS NOT NULL AND p_new_balance_cents IS DISTINCT FROM v_credit.balance_cents THEN
      RAISE EXCEPTION 'PREPAY_CREDIT_HAS_REVERSALS: this credit has a refund or returned check recorded; its balance cannot be edited';
    END IF;
    p_new_balance_cents := NULL;
  END IF;
$m9blk$]),
      ('public._delete_prepay_credit_replay_impl_20261015(uuid,text,uuid,text)', ARRAY[$m9blk$
  -- M9: a credit with a refund or a returned check recorded on it cannot be deleted (the delete would rewrite its
  -- original amount and erase them).
  IF EXISTS (SELECT 1 FROM money_reversal_lines WHERE prepay_credit_id = p_credit_id) THEN
    RAISE EXCEPTION 'PREPAY_CREDIT_HAS_REVERSALS: this credit has a refund or returned check recorded; it cannot be deleted';
  END IF;
$m9blk$]),
      ('public._month_payments_received_20270208(date,date)', ARRAY[$m9blk$
    UNION ALL
    -- M9: a returned (bounced) check comes off the month it was recorded in (always an open month), never the month
    -- it was received in; it is not a payment, so it is not counted.
    SELECT -mr.amount_cents::numeric
      FROM public.money_reversals mr
     WHERE mr.kind = 'returned_check'
       AND mr.entry_date BETWEEN p_start AND p_end$m9blk$] || ARRAY[$m9blk$ FILTER (WHERE cents > 0)$m9blk$]),
      ('public._month_close_figures_20270208(date,date)', ARRAY[$m9blk$    -- M9: refunds paid outside CRX and returned checks recorded in the dates (returned checks are already netted out
    -- of payments received above).
    'refunds', (SELECT jsonb_build_object('count', count(*), 'total_cents', COALESCE(sum(mr.amount_cents), 0))
                  FROM public.money_reversals mr
                 WHERE mr.kind = 'outside_refund' AND mr.entry_date BETWEEN p_period_start AND p_period_end),
    'returned_checks', (SELECT jsonb_build_object('count', count(*), 'total_cents', COALESCE(sum(mr.amount_cents), 0))
                  FROM public.money_reversals mr
                 WHERE mr.kind = 'returned_check' AND mr.entry_date BETWEEN p_period_start AND p_period_end),
$m9blk$] || ARRAY[$m9blk$      'refunds_paid_cents', COALESCE((SELECT sum(mr.amount_cents) FROM public.money_reversals mr
         WHERE mr.kind = 'outside_refund' AND mr.entry_date BETWEEN p_period_start AND p_period_end), 0),
      'returned_checks_cents', COALESCE((SELECT sum(mr.amount_cents) FROM public.money_reversals mr
         WHERE mr.kind = 'returned_check' AND mr.entry_date BETWEEN p_period_start AND p_period_end), 0),
$m9blk$]),
      ('public.statement_customer_has_later_balance_activity(uuid,date)', ARRAY[$m9blk$
    OR EXISTS (
      -- M9: a returned (bounced) check recorded after the cutoff reopened invoices and reversed prepay applications;
      -- the balance as of the cutoff cannot be rebuilt from today's invoice rows.
      SELECT 1
      FROM public.money_reversals mr
      WHERE mr.customer_id = p_customer_id
        AND mr.kind = 'returned_check'
        AND (mr.entry_date > p_as_of_date OR (mr.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
        AND EXISTS (
          SELECT 1
          FROM public.invoices i
          WHERE i.customer_id = p_customer_id
            AND i.invoice_date <= p_as_of_date
            AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
        )
    )$m9blk$]),
      ('public._get_customer_statement_scoped_impl(uuid,date,date)', ARRAY[$m9blk$
    UNION ALL

    -- M9: a returned (bounced) check puts back what it paid (cash and prepay) on the day it was recorded; the
    -- original payment and prepay rows stay.
    SELECT
      mr.entry_date,
      'returned_check',
      COALESCE(mr.reference, ''),
      'Returned check ' || COALESCE(mr.reference, '') || ' - ' || mr.reason,
      COALESCE((SELECT sum(l.amount_cents) FROM public.money_reversal_lines l
                 WHERE l.reversal_id = mr.id AND l.line_kind IN ('invoice_payment', 'prepay_application')), 0)::bigint,
      45,
      mr.id
    FROM public.money_reversals mr
    WHERE mr.customer_id = p_customer_id
      AND mr.kind = 'returned_check'

    UNION ALL

    -- M9: a refund paid outside CRX comes out of prepay, not out of what is owed: shown, $0.00 effect.
    SELECT
      mr.entry_date,
      'refund',
      COALESCE(mr.reference, ''),
      'Refund paid (outside CRX) ' || COALESCE(mr.reference, ''),
      0::bigint,
      46,
      mr.id
    FROM public.money_reversals mr
    WHERE mr.customer_id = p_customer_id
      AND mr.kind = 'outside_refund'
$m9blk$])
    ) AS b(sig, blocks) ON b.sig = f.sig
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.sig)
        AND md5(pg_temp.m9_strip(replace(p.prosrc, chr(13), ''), b.blocks)) = f.md5
        AND (SELECT bool_and(position(blk IN replace(p.prosrc, chr(13), '')) > 0) FROM unnest(b.blocks) blk)
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef = f.secdef
        AND p.proconfig::text = f.cfg
        AND p.proacl::text = f.acl
        AND p.pronargdefaults = f.ndefaults
        AND p.provolatile::text = f.vol);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M9_POSTFLIGHT: not the expected body or contract: %', v_bad;
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'financial_audit_log_operation_type_check'
       AND conrelid = 'public.financial_audit_log'::regclass) IS DISTINCT FROM $m9chk$CHECK ((operation_type = ANY (ARRAY['invoice_created'::text, 'invoice_posted'::text, 'invoice_unposted'::text, 'invoice_voided'::text, 'invoice_cancelled'::text, 'invoice_updated'::text, 'invoice_deleted'::text, 'invoice_marked_overdue'::text, 'payment_recorded'::text, 'payment_allocation'::text, 'payment_voided'::text, 'payment_allocated'::text, 'split_modified'::text, 'split_invoices_generated'::text, 'prepay_created'::text, 'prepay_applied'::text, 'prepay_credit_created'::text, 'prepay_batch_applied'::text, 'prepay_edited'::text, 'prepay_deleted'::text, 'prepay_reconciliation'::text, 'batch_prepay_apply'::text, 'write_off_recorded'::text, 'write_off_reversed'::text, 'write_off_applied'::text, 'finance_charge'::text, 'finance_charge_generated'::text, 'finance_charge_voided'::text, 'credit_memo_created'::text, 'credit_memo_applied'::text, 'credit_memo_unapplied'::text, 'return_created'::text, 'return_approved'::text, 'return_received'::text, 'return_credit_issued'::text, 'order_created'::text, 'order_updated'::text, 'order_voided'::text, 'order_cancelled'::text, 'order_restored'::text, 'delivery_created'::text, 'delivery_updated'::text, 'delivery_cancelled'::text, 'delivery_voided'::text, 'delivery_restored'::text, 'quote_converted'::text, 'blend_ticket_linked'::text, 'blend_ticket_unlinked'::text, 'commission_payment_created'::text, 'commission_payment_posted'::text, 'commission_payment_voided'::text, 'batch_post'::text, 'batch_void'::text, 'batch_payment'::text, 'period_reopened'::text, 'quote_status_reverted'::text, 'blend_ticket_approval_reversed'::text, 'cycle_count_completed'::text, 'vendor_bill_created'::text, 'vendor_bill_voided'::text, 'vendor_bill_updated'::text, 'vendor_payment_recorded'::text, 'vendor_payment_voided'::text, 'rup_sales_voided'::text, 'receiving_reversed'::text, 'payment_deleted'::text, 'allocation_set_deleted'::text, 'prepay_refunded_outside'::text, 'payment_returned'::text])))$m9chk$ THEN
    RAISE EXCEPTION 'M9_POSTFLIGHT: financial_audit_log_operation_type_check is not the expected list';
  END IF;
  SELECT string_agg(sig, ', ') INTO v_bad FROM (VALUES
      ('public.record_outside_refund(uuid,bigint,date,text,text,uuid,uuid,text)', true),
      ('public.record_returned_check(uuid,date,text,uuid,text,uuid)', true),
      ('public.get_prepay_balance_check(uuid)', true),
      ('public._money_reversals_append_only_20270225()', false)) AS n(sig, callable)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(n.sig)
        AND p.proowner = 'postgres'::regrole
        AND p.proconfig::text = '{"search_path=public, pg_temp"}'
        AND p.proacl::text = CASE WHEN n.callable
              THEN '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres}' END);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M9_POSTFLIGHT: new function contract: %', v_bad;
  END IF;
  IF has_table_privilege('authenticated', 'public.money_reversals', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.money_reversal_lines', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.money_reversals', 'SELECT')
     OR has_table_privilege('anon', 'public.money_reversal_lines', 'SELECT') THEN
    RAISE EXCEPTION 'M9_POSTFLIGHT: an API role can write the reversal tables or anon can read them';
  END IF;
END
$postflight$;
