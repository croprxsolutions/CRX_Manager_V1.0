-- KI-06: a hard delete of an invoice or a payment keeps a full copy in financial_audit_log.
--
-- Live read-only facts (2026-11-05): the app already never hard-deletes these rows. Invoices are
-- soft-deleted (deleted_at, delete_invoices), payments are voided (allocation_sets.is_active,
-- void_payment), and signed-in users hold no DELETE grant on invoices, allocation_sets or payments.
-- Only a postgres/service-role connection can still erase one (for a posted invoice, with
-- app.admin_override), and 206 old audit rows point at rows erased that way. From now on such a
-- delete writes an append-only audit row whose old_values is the whole erased row.
--
-- The rows that cascade away with the parent are copied too (new_values.cascaded_rows): an invoice's
-- invoice_items (with their invoice_line_shares), invoice_shares and field_app_locations (with their
-- field_app_location_shares); an allocation set's invoice_line_allocations and order_line_allocations.
-- The copy is taken in a BEFORE trigger, named to fire after every guard, while those rows still exist;
-- a guard that refuses, or a later failure, rolls the audit row back with the delete. The postflight
-- refuses if live has any other ON DELETE CASCADE child under these tables.
-- TRUNCATE fires no row trigger, so it is refused on these three tables instead (service_role holds
-- TRUNCATE on payments and allocation_sets live).
-- An owner who disables triggers or sets session_replication_role = replica still bypasses both.

-- Take the tables in the order money RPCs do (invoices, then the audit log) so a concurrent RPC
-- waits instead of deadlocking; give up rather than queue behind a long transaction.
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.invoices, public.allocation_sets, public.payments, public.financial_audit_log
  IN ACCESS EXCLUSIVE MODE;

-- Preflight: refuse unless live is the shape this file was written against.
DO $preflight$
BEGIN
  IF (SELECT md5(pg_get_constraintdef(oid)) FROM pg_constraint
       WHERE conrelid = 'public.financial_audit_log'::regclass
         AND conname = 'financial_audit_log_operation_type_check')
     IS DISTINCT FROM '2a95748a7e5ecdd696c35f768739207e' THEN
    RAISE EXCEPTION 'PREFLIGHT_FINANCIAL_AUDIT_OPERATION_CHECK_DRIFT';
  END IF;
  IF to_regprocedure('public._snapshot_financial_hard_delete()') IS NOT NULL
     OR to_regprocedure('public._refuse_financial_truncate()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN (
          'zz_snapshot_invoice_hard_delete',
          'zz_snapshot_allocation_set_hard_delete',
          'zz_snapshot_payment_hard_delete',
          'refuse_invoice_truncate',
          'refuse_allocation_set_truncate',
          'refuse_payment_truncate')) THEN
    RAISE EXCEPTION 'PREFLIGHT_FINANCIAL_DELETE_SNAPSHOT_ALREADY_PRESENT';
  END IF;
END
$preflight$;

-- The live list plus 'payment_deleted' and 'allocation_set_deleted' (a superset; every existing
-- row stays valid).
ALTER TABLE public.financial_audit_log
  DROP CONSTRAINT financial_audit_log_operation_type_check;
ALTER TABLE public.financial_audit_log
  ADD CONSTRAINT financial_audit_log_operation_type_check CHECK (operation_type = ANY (ARRAY[
    'invoice_created','invoice_posted','invoice_unposted','invoice_voided','invoice_cancelled',
    'invoice_updated','invoice_deleted','invoice_marked_overdue','payment_recorded',
    'payment_allocation','payment_voided','payment_allocated','split_modified',
    'split_invoices_generated','prepay_created','prepay_applied','prepay_credit_created',
    'prepay_batch_applied','prepay_edited','prepay_deleted','prepay_reconciliation',
    'batch_prepay_apply','write_off_recorded','write_off_reversed','write_off_applied',
    'finance_charge','finance_charge_generated','finance_charge_voided','credit_memo_created',
    'credit_memo_applied','credit_memo_unapplied','return_created','return_approved',
    'return_received','return_credit_issued','order_created','order_updated','order_voided',
    'order_cancelled','order_restored','delivery_created','delivery_updated',
    'delivery_cancelled','delivery_voided','delivery_restored','quote_converted',
    'blend_ticket_linked','blend_ticket_unlinked','commission_payment_created',
    'commission_payment_posted','commission_payment_voided','batch_post','batch_void',
    'batch_payment','period_reopened','quote_status_reverted','blend_ticket_approval_reversed',
    'cycle_count_completed','vendor_bill_created','vendor_bill_voided','vendor_bill_updated',
    'vendor_payment_recorded','vendor_payment_voided','rup_sales_voided','receiving_reversed',
    'payment_deleted','allocation_set_deleted'
  ]::text[]));

-- SECURITY DEFINER: service_role (the only non-owner that can delete these rows) has no INSERT on
-- financial_audit_log, and a delete must never fail for want of its audit row.
-- actor_user_id is filled by trg_fill_audit_actor (auth.uid(), else the system actor); db_role and
-- session_user record which connection really deleted, since a service-role session can set any JWT subject.
-- An allocation set is a payment only when its entity_type is 'payment' (others are split-billing sets).
-- admin_override records only that the session set app.admin_override, not that anyone approved it.
CREATE FUNCTION public._snapshot_financial_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_old      jsonb := to_jsonb(OLD);
  v_kind     text  := CASE TG_TABLE_NAME WHEN 'allocation_sets' THEN v_old ->> 'entity_type' END;
  v_children jsonb;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    v_children := jsonb_build_object(
      'invoice_items', (SELECT COALESCE(jsonb_agg(to_jsonb(ii) || jsonb_build_object('invoice_line_shares',
                          (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
                             FROM public.invoice_line_shares s WHERE s.invoice_item_id = ii.id))), '[]'::jsonb)
                          FROM public.invoice_items ii WHERE ii.invoice_id = OLD.id),
      'invoice_shares', (SELECT COALESCE(jsonb_agg(to_jsonb(sh)), '[]'::jsonb)
                           FROM public.invoice_shares sh WHERE sh.invoice_id = OLD.id),
      'field_app_locations', (SELECT COALESCE(jsonb_agg(to_jsonb(l) || jsonb_build_object('field_app_location_shares',
                                (SELECT COALESCE(jsonb_agg(to_jsonb(ls)), '[]'::jsonb)
                                   FROM public.field_app_location_shares ls WHERE ls.location_id = l.id))), '[]'::jsonb)
                                FROM public.field_app_locations l WHERE l.invoice_id = OLD.id));
  ELSIF TG_TABLE_NAME = 'allocation_sets' THEN
    v_children := jsonb_build_object(
      'invoice_line_allocations', (SELECT COALESCE(jsonb_agg(to_jsonb(ila)), '[]'::jsonb)
                                     FROM public.invoice_line_allocations ila WHERE ila.allocation_set_id = OLD.id),
      'order_line_allocations', (SELECT COALESCE(jsonb_agg(to_jsonb(ola)), '[]'::jsonb)
                                   FROM public.order_line_allocations ola WHERE ola.allocation_set_id = OLD.id));
  END IF;

  INSERT INTO public.financial_audit_log
    (operation_type, entity_type, entity_id, old_values, new_values, description)
  VALUES (
    CASE WHEN TG_TABLE_NAME = 'invoices' THEN 'invoice_deleted'
         WHEN TG_TABLE_NAME = 'payments' OR v_kind = 'payment' THEN 'payment_deleted'
         ELSE 'allocation_set_deleted' END,
    CASE TG_TABLE_NAME WHEN 'invoices' THEN 'invoice'
                       WHEN 'allocation_sets' THEN 'allocation_set'
                       ELSE 'payment' END,
    OLD.id,
    v_old,
    jsonb_build_object('hard_delete', true,
                       'allocation_entity_type', v_kind,
                       'cascaded_rows', v_children,
                       'db_role', current_setting('role', true),
                       'session_user', session_user,
                       'admin_override_setting', COALESCE(public._is_admin_override(), false)),
    'Hard delete of ' || TG_TABLE_NAME || COALESCE(' (' || v_kind || ')', '') || ' row ' || OLD.id
      || '; the full row is kept in old_values and its cascaded rows in new_values.cascaded_rows'
  );
  RETURN OLD;
END
$fn$;

REVOKE ALL ON FUNCTION public._snapshot_financial_hard_delete() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._refuse_financial_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'FINANCIAL_TRUNCATE_REFUSED: TRUNCATE of % would erase rows with no audit copy; delete the rows instead', TG_TABLE_NAME;
END
$fn$;

REVOKE ALL ON FUNCTION public._refuse_financial_truncate() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER refuse_invoice_truncate
  BEFORE TRUNCATE ON public.invoices
  FOR EACH STATEMENT EXECUTE FUNCTION public._refuse_financial_truncate();
CREATE TRIGGER refuse_allocation_set_truncate
  BEFORE TRUNCATE ON public.allocation_sets
  FOR EACH STATEMENT EXECUTE FUNCTION public._refuse_financial_truncate();
CREATE TRIGGER refuse_payment_truncate
  BEFORE TRUNCATE ON public.payments
  FOR EACH STATEMENT EXECUTE FUNCTION public._refuse_financial_truncate();

-- BEFORE, so the cascaded child rows still exist; the zz_ prefix makes it fire after every other
-- BEFORE DELETE trigger (guards), so a guard that refuses or skips the delete writes no audit row.
CREATE TRIGGER zz_snapshot_invoice_hard_delete
  BEFORE DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._snapshot_financial_hard_delete();
CREATE TRIGGER zz_snapshot_allocation_set_hard_delete
  BEFORE DELETE ON public.allocation_sets
  FOR EACH ROW EXECUTE FUNCTION public._snapshot_financial_hard_delete();
CREATE TRIGGER zz_snapshot_payment_hard_delete
  BEFORE DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public._snapshot_financial_hard_delete();

-- Postflight: the three triggers are enabled row-level BEFORE DELETE triggers on the right tables and
-- fire last, the cascade tree is exactly the one the function copies, the function is SECURITY DEFINER
-- with the pinned search_path, and no API role can call it.
DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgfoid = 'public._snapshot_financial_hard_delete()'::regprocedure
         AND t.tgenabled = 'O'
         AND t.tgtype = 11  -- ROW (1) | BEFORE (2) | DELETE (8)
         AND (t.tgrelid, t.tgname) IN (
           ('public.invoices'::regclass, 'zz_snapshot_invoice_hard_delete'),
           ('public.allocation_sets'::regclass, 'zz_snapshot_allocation_set_hard_delete'),
           ('public.payments'::regclass, 'zz_snapshot_payment_hard_delete'))) <> 3 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FINANCIAL_DELETE_SNAPSHOT_TRIGGERS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid IN ('public.invoices'::regclass, 'public.allocation_sets'::regclass, 'public.payments'::regclass)
                AND NOT t.tgisinternal AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8
                AND t.tgname > CASE t.tgrelid WHEN 'public.invoices'::regclass THEN 'zz_snapshot_invoice_hard_delete'
                                              WHEN 'public.allocation_sets'::regclass THEN 'zz_snapshot_allocation_set_hard_delete'
                                              ELSE 'zz_snapshot_payment_hard_delete' END) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FINANCIAL_DELETE_SNAPSHOT_NOT_LAST';
  END IF;
  IF (WITH RECURSIVE tree AS (
        SELECT c.conrelid, c.confrelid FROM pg_constraint c
         WHERE c.contype = 'f' AND c.confdeltype = 'c'
           AND c.confrelid IN ('public.invoices'::regclass, 'public.allocation_sets'::regclass, 'public.payments'::regclass)
        UNION
        SELECT c.conrelid, c.confrelid FROM pg_constraint c JOIN tree ON c.confrelid = tree.conrelid
         WHERE c.contype = 'f' AND c.confdeltype = 'c')
      SELECT string_agg(p.relname || '>' || c.relname, ',' ORDER BY p.relname, c.relname)
        FROM tree JOIN pg_class p ON p.oid = tree.confrelid JOIN pg_class c ON c.oid = tree.conrelid)
     IS DISTINCT FROM 'allocation_sets>invoice_line_allocations,allocation_sets>order_line_allocations,'
       'field_app_locations>field_app_location_shares,invoice_items>invoice_line_shares,'
       'invoices>field_app_locations,invoices>invoice_items,invoices>invoice_shares' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FINANCIAL_DELETE_CASCADE_TREE_DRIFT';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgfoid = 'public._refuse_financial_truncate()'::regprocedure
         AND t.tgenabled = 'O'
         AND t.tgtype = 34  -- BEFORE (2) | TRUNCATE (32), statement level
         AND (t.tgrelid, t.tgname) IN (
           ('public.invoices'::regclass, 'refuse_invoice_truncate'),
           ('public.allocation_sets'::regclass, 'refuse_allocation_set_truncate'),
           ('public.payments'::regclass, 'refuse_payment_truncate'))) <> 3 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FINANCIAL_TRUNCATE_TRIGGERS';
  END IF;
  IF NOT (SELECT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']
            FROM pg_proc WHERE oid = 'public._snapshot_financial_hard_delete()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FINANCIAL_DELETE_SNAPSHOT_FUNCTION_SETTINGS';
  END IF;
  IF has_function_privilege('anon', 'public._snapshot_financial_hard_delete()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._snapshot_financial_hard_delete()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._snapshot_financial_hard_delete()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FINANCIAL_DELETE_SNAPSHOT_GRANTS';
  END IF;
END
$postflight$;
