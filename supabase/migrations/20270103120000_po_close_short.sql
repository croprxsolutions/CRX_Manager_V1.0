-- Written 2026-11-10. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270103120000_po_close_short.md.
-- Re-read the live ledger before applying.
--
-- WHAT (KI-142, contract docs/plans/2026-11-10-ki142-po-close-short-CONTRACT.md): a partly received purchase order can
--   be closed short, so stock that will never arrive stops counting as on order (Net Position, order-time
--   negative-stock warnings and low-stock alerts read inventory.quantity_on_order).
--   1. purchase_orders.status gains 'closed', with closed_at / closed_by / close_reason (all set exactly when closed).
--   2. close_purchase_order_short(p_po_id, p_reason, p_idempotency_key): an active admin or sales rep closes a
--      partially_received PO. Refused while active vendor bills total more than the received value. One po_closed_short activity row (plus the existing status-change row).
--      On order is recomputed by the existing trg_po_status_recompute_on_order, which counts only submitted and
--      partially_received POs, so the unreceived remainder drops out in the same transaction.
--   3. 'closed' is final (_enforce_po_status_transition, admin override included). A receipt reversal on a closed PO
--      (reverse_receiving_record sets app.reversal_rpc_active) keeps it closed instead of reopening it.
--   4. A closed PO is frozen: no header edit; no line added, removed, edited (cost columns excepted) or received into (new
--      triggers trigger_0_guard_closed_po[_item]); cost corrections and reverse_receiving_record decreases still work.
--   5. A closed PO cannot be cancelled or deleted (_guard_po_delete); cancel's refusal for a received PO now says to
--      close it short instead of naming a workflow that never existed.
--   6. A closed PO can still be billed for what arrived: _section9_create_vendor_bill_intent_impl_20260826 (live body
--      re-emitted) accepts 'closed' like 'fully_received'. Its only change is that status list.
--   7. A closed PO's active vendor bills never total more than what arrived (the close's rule), with no override: a
--      bill write (trigger_0_guard_closed_po_bill on vendor_bills, any path, KI-143's confirmed overage included), a
--      cost correction and a receipt reversal on a closed PO are each refused if they would break it.
--
-- idempotency-body-check: exempt -- close_purchase_order_short requires p_idempotency_key, checks it with
--   check_idempotency_intent bound to the caller and request (PO and trimmed reason) after authorizing the caller,
--   returns the saved answer on a matching retry (closing is final, so it stays true), and saves and binds its first
--   answer with save_idempotency and _bind_replay_receipt_20261015 in the same transaction. A refusal rolls back and
--   saves nothing.
--
-- actor-binding-check: exempt -- the actor is auth.uid() only; there is no p_performed_by parameter.
--
-- NOT CHANGED: receive_po_items, reverse_receiving_record, save_purchase_order, set_purchase_order_item_costs,
--   the public create_vendor_bill / update_vendor_bill wrappers (KI-143 owns them), _recompute_po_on_order_for_products and
--   the readers of open POs (receiving hub, dashboards, forecast, inventory position filter IN ('submitted',
--   'partially_received'), so a closed PO leaves them; the PO list's Outstanding tab excludes only cancelled and
--   fully_received and is fixed in the screen PR, before any PO is closed).
--   No existing row changes at apply.
--
-- ROLLBACK (its own reviewed migration): if no PO is closed, drop close_purchase_order_short, the three trigger_0_guard_closed_* triggers
--   and their functions, restore the previous bodies of _enforce_po_status_transition, _guard_po_delete and
--   _section9_cancel_purchase_order_serialized, restore the old status CHECK and drop the three columns. If a PO is
--   closed, it must first be decided what it becomes (a business decision), since the old CHECK has no 'closed'.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.close_purchase_order_short(uuid, text, text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                 AND proname IN ('close_purchase_order_short', '_guard_closed_po_item', '_guard_closed_po', '_guard_closed_po_bill')) THEN
    RAISE EXCEPTION 'PREFLIGHT_PO_CLOSE_SHORT_DRIFT: close_purchase_order_short or a closed-PO guard already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'purchase_orders'
              AND column_name IN ('closed_at', 'closed_by', 'close_reason')) THEN
    RAISE EXCEPTION 'PREFLIGHT_PO_CLOSE_SHORT_DRIFT: a closed_* column already exists on purchase_orders';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.purchase_orders'::regclass AND conname = 'purchase_orders_status_check'
         AND pg_get_constraintdef(oid) = 'CHECK ((status = ANY (ARRAY[''draft''::text, ''submitted''::text, ''partially_received''::text, ''fully_received''::text, ''cancelled''::text])))') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_PO_CLOSE_SHORT_DRIFT: purchase_orders status values differ from what this file expects';
  END IF;
  IF to_regprocedure('public._section9_cancel_purchase_order_serialized(uuid, text, uuid, text)') IS NULL
     OR to_regprocedure('public._section9_reverse_receiving_record_serialized(uuid, text, uuid, text)') IS NULL
     OR to_regprocedure('public._enforce_po_status_transition()') IS NULL
     OR to_regprocedure('public._guard_po_delete()') IS NULL
     OR to_regprocedure('public._recompute_po_on_order_for_products(uuid[])') IS NULL
     OR to_regprocedure('public.check_idempotency_intent(text, text, uuid, text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text, text, jsonb)') IS NULL
     OR to_regprocedure('public._bind_replay_receipt_20261015(text, text, text)') IS NULL
     OR to_regprocedure('public._replay_fingerprint_20261015(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PO_CLOSE_SHORT_DRIFT: a function this file relies on is missing';
  END IF;
  -- KI-143 (20270103110000) must be live: its public bill wrappers hold bills on any PO, closed included, to what arrived.
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
                  WHERE name = '20270103110000_ki143_vendor_bill_received_value_checks')
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('create_vendor_bill', 'update_vendor_bill')
          AND position('received_value_cents' IN prosrc) > 0) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_PO_CLOSE_SHORT_DRIFT: KI-143 (20270103110000, bills held to received value) must be applied first';
  END IF;
  -- On order must still come only from submitted and partially_received POs, recomputed on every status change.
  IF position('po.status IN (''submitted'', ''partially_received'')' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public._recompute_po_on_order_for_products(uuid[])'::regprocedure)) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.purchase_orders'::regclass
                     AND tgname = 'trg_po_status_recompute_on_order' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'PREFLIGHT_PO_CLOSE_SHORT_DRIFT: on order is no longer derived the way this file relies on';
  END IF;
  -- The reversal pin relies on reverse_receiving_record setting this flag.
  IF position('app.reversal_rpc_active' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public._section9_reverse_receiving_record_serialized(uuid, text, uuid, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_PO_CLOSE_SHORT_DRIFT: reverse_receiving_record no longer sets app.reversal_rpc_active';
  END IF;
  -- The vendor-bill re-emit below changes only this status list; refuse if the live body moved on.
  IF to_regprocedure('public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text)') IS NULL
     OR position('IF v_po_status NOT IN (''submitted'', ''partially_received'', ''fully_received'') THEN' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text)'::regprocedure)) = 0
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text)'::regprocedure)
        <> '501dea14423c9bdf63c01ce961f82fb2' THEN
    RAISE EXCEPTION 'PREFLIGHT_PO_CLOSE_SHORT_DRIFT: the vendor-bill status check is not the body this file re-emits';
  END IF;
  -- Every other body this file replaces must still be the one it was written against (live, 2026-11-10).
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._enforce_po_status_transition()'::regprocedure) <> '76103c1b50e53a94e4dffa29f808b37b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._guard_po_delete()'::regprocedure) <> '30949b0dd0dc8bfc15eadfb8e3a27081'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._section9_cancel_purchase_order_serialized(uuid, text, uuid, text)'::regprocedure) <> '57bd6a9408c65daf6d82bbf3750554f9' THEN
    RAISE EXCEPTION 'PREFLIGHT_PO_CLOSE_SHORT_DRIFT: a function body this file replaces changed since it was written';
  END IF;
END;
$preflight$;

-- 1. Status value and who/when/why.
ALTER TABLE public.purchase_orders
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by uuid REFERENCES public.profiles(id),
  ADD COLUMN close_reason text;
ALTER TABLE public.purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'submitted'::text, 'partially_received'::text, 'fully_received'::text,
                             'cancelled'::text, 'closed'::text]));
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_closed_fields_check
  CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL AND close_reason IS NOT NULL)
         AND (closed_at IS NULL) = (closed_by IS NULL) AND (closed_at IS NULL) = (close_reason IS NULL));
COMMENT ON COLUMN public.purchase_orders.closed_at IS 'KI-142: when a partly received PO was closed short (status closed).';
COMMENT ON COLUMN public.purchase_orders.closed_by IS 'KI-142: who closed the PO short.';
COMMENT ON COLUMN public.purchase_orders.close_reason IS 'KI-142: why the PO was closed short.';
-- purchase_orders is read through column grants (no table SELECT): the app must be able to read the new columns.
-- One privilege per statement: `GRANT SELECT, REFERENCES (cols)` would make SELECT table-wide (cost columns included).
GRANT SELECT (closed_at, closed_by, close_reason) ON public.purchase_orders TO authenticated;
GRANT REFERENCES (closed_at, closed_by, close_reason) ON public.purchase_orders TO authenticated;
GRANT SELECT (closed_at, closed_by, close_reason) ON public.purchase_orders TO anon;

-- 2. Status transitions: partially_received -> closed; closed is final.
CREATE OR REPLACE FUNCTION public._enforce_po_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  -- KI-142: closed short is final, admin override included. A receipt reversal recomputes the status; on a closed PO
  -- it stays closed, so the remainder never comes back on order.
  IF OLD.status = 'closed' THEN
    IF current_setting('app.reversal_rpc_active', true) = 'true'
       AND NEW.status IN ('submitted', 'partially_received', 'fully_received') THEN
      NEW.status := 'closed';
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PO_CLOSED: purchase order % was closed short and cannot change to %', OLD.po_number, NEW.status;
  END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  -- Forward transitions
  IF (OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
  OR (OLD.status = 'submitted' AND NEW.status IN ('partially_received', 'fully_received', 'cancelled'))
  OR (OLD.status = 'partially_received' AND NEW.status IN ('fully_received', 'cancelled', 'closed'))
  -- Reverse transitions (receiving reversals)
  OR (OLD.status = 'fully_received' AND NEW.status IN ('partially_received', 'submitted'))
  OR (OLD.status = 'partially_received' AND NEW.status = 'submitted')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid purchase order status transition: % → %', OLD.status, NEW.status;
END;
$function$;

-- 3. A closed PO cannot be deleted.
CREATE OR REPLACE FUNCTION public._guard_po_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'PO_CLOSED: purchase order % was closed short and cannot be deleted', OLD.po_number;
  END IF;
  IF _is_admin_override() THEN RETURN OLD; END IF;
  IF OLD.status IN ('submitted', 'partially_received', 'fully_received') THEN
    RAISE EXCEPTION 'Cannot delete purchase order in % status. Cancel it first.', OLD.status;
  END IF;
  RETURN OLD;
END;
$function$;

-- 4. A closed PO is frozen. Its header may change only in status (by the rules above), updated_at and its cost total
--    (set_purchase_order_item_costs); its lines only in cost columns, or by a received-quantity decrease made by
--    reverse_receiving_record (which sets app.reversal_rpc_active). Receiving into it, editing it through
--    save_purchase_order, and rewriting who closed it and why are refused.
CREATE FUNCTION public._guard_closed_po()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_free CONSTANT text[] := ARRAY['status', 'updated_at', 'total_cost', 'total_cost_cents'];
BEGIN
  IF OLD.status = 'closed' AND (to_jsonb(NEW) - c_free) IS DISTINCT FROM (to_jsonb(OLD) - c_free) THEN
    RAISE EXCEPTION 'PO_CLOSED: purchase order % was closed short and cannot be edited', OLD.po_number;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._guard_closed_po() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._guard_closed_po() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trigger_0_guard_closed_po
  BEFORE UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._guard_closed_po();

CREATE FUNCTION public._guard_closed_po_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Cost corrections stay allowed on a closed PO (set_purchase_order_item_costs); unit_cost_cents is generated.
  c_cost CONSTANT text[] := ARRAY['unit_cost', 'unit_cost_cents', 'cost_needs_review', 'cost_provenance',
                                  'cost_snapshot_at', 'product_supplier_link_id', 'supplier_price_observation_id'];
  v_same_line boolean := false;
  v_cost_only boolean := false;
  v_closed text;
  v_received_cents bigint;
  v_billed_cents bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Every column but cost and received is frozen on a closed PO's line (fires before the other BEFORE triggers).
    v_same_line := (to_jsonb(NEW) - c_cost - 'quantity_received') IS NOT DISTINCT FROM (to_jsonb(OLD) - c_cost - 'quantity_received');
    IF v_same_line AND NEW.quantity_received IS NOT DISTINCT FROM OLD.quantity_received THEN
      -- Only cost columns changed. A cost cut can lower the received value under the bills, so check that one.
      IF round(COALESCE(NEW.quantity_received, 0) * COALESCE(NEW.unit_cost, 0) * 100)
         >= round(COALESCE(OLD.quantity_received, 0) * COALESCE(OLD.unit_cost, 0) * 100) THEN
        RETURN NEW;
      END IF;
      v_cost_only := true;
    END IF;
  END IF;
  -- FOR SHARE waits for a close in flight, so a line change never slips in beside it. Both parents of a moved line.
  SELECT string_agg(po.po_number, ', ' ORDER BY po.po_number) INTO v_closed
    FROM (SELECT p.po_number, p.status FROM public.purchase_orders p
           WHERE p.id = ANY (CASE TG_OP
                               WHEN 'INSERT' THEN ARRAY[NEW.purchase_order_id]
                               WHEN 'DELETE' THEN ARRAY[OLD.purchase_order_id]
                               ELSE ARRAY[OLD.purchase_order_id, NEW.purchase_order_id] END)
           ORDER BY p.id FOR SHARE) po
   WHERE po.status = 'closed';
  IF v_closed IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF v_cost_only
     OR (v_same_line
         AND COALESCE(NEW.quantity_received, 0) < COALESCE(OLD.quantity_received, 0)
         AND current_setting('app.reversal_rpc_active', true) = 'true') THEN
    -- A cost correction, or reverse_receiving_record taking a wrong receipt back off a closed PO. Either may lower
    -- received value; a closed PO's bills stay at or under it (the close's rule).
    SELECT COALESCE(SUM(round(COALESCE(poi.quantity_received, 0) * COALESCE(poi.unit_cost, 0) * 100)), 0)::bigint
      INTO v_received_cents
      FROM public.purchase_order_items poi
     WHERE poi.purchase_order_id = NEW.purchase_order_id AND poi.id <> NEW.id;
    v_received_cents := v_received_cents + round(COALESCE(NEW.quantity_received, 0) * COALESCE(NEW.unit_cost, 0) * 100)::bigint;
    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint INTO v_billed_cents
      FROM public.vendor_bills vb
     WHERE vb.purchase_order_id = NEW.purchase_order_id AND vb.deleted_at IS NULL AND vb.status <> 'voided';
    IF v_billed_cents > v_received_cents THEN
      RAISE EXCEPTION 'PO_CLOSE_BILLED_OVER_RECEIVED: this change would put vendor bills on closed PO % above what was received; correct the bill first',
        v_closed USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PO_CLOSED: purchase order % was closed short; its lines cannot be added, removed, changed or received into', v_closed;
END;
$function$;
ALTER FUNCTION public._guard_closed_po_item() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._guard_closed_po_item() FROM PUBLIC, anon, authenticated, service_role;
-- Named to fire first among the BEFORE triggers on purchase_order_items (they fire in name order).
CREATE TRIGGER trigger_0_guard_closed_po_item
  BEFORE INSERT OR DELETE OR UPDATE ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public._guard_closed_po_item();

-- 5. Cancel: a closed PO is refused; a received PO points at Close Short. Otherwise the live body unchanged.
CREATE OR REPLACE FUNCTION public._section9_cancel_purchase_order_serialized(p_po_id uuid, p_reason text DEFAULT 'Cancelled'::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_po record;
  v_actor uuid;
  v_cached_result jsonb;
  v_result jsonb;
  v_received_qty numeric;
  v_active_bill_count integer;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can cancel purchase orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'cancel_purchase_order');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  IF v_po.status = 'cancelled' THEN
    v_result := jsonb_build_object('status', 'already_cancelled', 'po_id', p_po_id, 'po_number', v_po.po_number);
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'cancel_purchase_order', v_result);
    END IF;
    RETURN v_result;
  END IF;

  IF v_po.status = 'closed' THEN
    RAISE EXCEPTION 'PO_CLOSED: cannot cancel PO %: it was already closed short', v_po.po_number;
  END IF;

  SELECT count(*) INTO v_active_bill_count FROM vendor_bills
  WHERE purchase_order_id = p_po_id AND status NOT IN ('voided') AND deleted_at IS NULL;

  IF v_active_bill_count > 0 THEN
    RAISE EXCEPTION 'PO_HAS_ACTIVE_BILLS: cannot cancel PO % — % active vendor bill(s) reference it. Void the bill(s) first.',
      v_po.po_number, v_active_bill_count;
  END IF;

  SELECT COALESCE(SUM(quantity_received), 0) INTO v_received_qty
  FROM purchase_order_items WHERE purchase_order_id = p_po_id;

  IF v_received_qty > 0 THEN
    RAISE EXCEPTION 'Cannot cancel PO %: % units already received. Use Close Short to stop waiting for the rest.',
      v_po.po_number, v_received_qty;
  END IF;

  IF v_po.status = 'fully_received' THEN
    RAISE EXCEPTION 'Cannot cancel PO %: already fully received', v_po.po_number;
  END IF;

  UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = COALESCE(NULLIF(TRIM(p_reason), ''), 'Cancelled'),
    updated_at = now()
  WHERE id = p_po_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'po_cancelled',
    'Purchase order ' || v_po.po_number || ' cancelled. Reason: '
      || COALESCE(NULLIF(TRIM(p_reason), ''), 'Cancelled'),
    v_actor, 'purchase_order', p_po_id
  );

  v_result := jsonb_build_object('status', 'cancelled', 'po_id', p_po_id, 'po_number', v_po.po_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_purchase_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- 5b. A closed PO can still be billed for what arrived. Live body (md5 501dea14423c9bdf63c01ce961f82fb2, pinned in the
--     preflight) with one change: 'closed' joins the billable status list. Owner, mode, search_path and grants are kept
--     by CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public._section9_create_vendor_bill_intent_impl_20260826(p_vendor_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_bill_number text DEFAULT ''::text, p_bill_date date DEFAULT CURRENT_DATE, p_due_date date DEFAULT NULL::date, p_payment_terms text DEFAULT NULL::text, p_subtotal_cents bigint DEFAULT 0, p_adjustment_cents bigint DEFAULT 0, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_total bigint; v_bill_id uuid; v_terms_days integer; v_terms text;
  v_actor uuid; v_actor_role text; v_existing jsonb; v_vendor_name text;
  v_po_vendor text; v_po_status text; v_po_total_cents bigint;
  v_amount_drift_pct numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles
  WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'create_vendor_bill');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'bill_id')::uuid; END IF;
  END IF;

  SELECT name INTO v_vendor_name FROM public.vendors
  WHERE id = p_vendor_id AND deleted_at IS NULL FOR UPDATE;
  IF v_vendor_name IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: vendor % does not exist or is soft-deleted', p_vendor_id;
  END IF;
  IF p_subtotal_cents IS NULL OR p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;
  v_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_total;
  END IF;

  IF p_purchase_order_id IS NOT NULL THEN
    SELECT vendor, status, total_cost_cents INTO v_po_vendor, v_po_status, v_po_total_cents
    FROM public.purchase_orders WHERE id = p_purchase_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', p_purchase_order_id; END IF;
    IF v_po_status NOT IN ('submitted', 'partially_received', 'fully_received', 'closed') THEN
      RAISE EXCEPTION 'PO_NOT_BILLABLE: purchase order % has status %', p_purchase_order_id, v_po_status;
    END IF;
    IF lower(trim(v_po_vendor)) <> lower(trim(v_vendor_name)) THEN
      RAISE EXCEPTION 'VENDOR_PO_MISMATCH: bill vendor "%" does not match PO vendor "%"', v_vendor_name, v_po_vendor;
    END IF;
  END IF;

  -- Take this after required business row locks (vendor then optional PO), but
  -- before the authoritative period check, notification/audit/idempotency side
  -- effects, and the bill INSERT. check_period_open stays a narrow reader for
  -- its many existing callers; this governed writer owns its shared lock.
  PERFORM public._lock_accounting_months(ARRAY[p_bill_date], false);
  PERFORM public.check_period_open(p_bill_date);

  IF p_purchase_order_id IS NOT NULL AND v_po_total_cents > 0 THEN
    v_amount_drift_pct := ABS(v_total - v_po_total_cents)::numeric / v_po_total_cents::numeric;
    IF v_amount_drift_pct > 0.05 THEN
      INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      SELECT p.id, 'Vendor bill amount differs from PO',
        'Bill ' || COALESCE(NULLIF(p_bill_number, ''), 'pending') || ' for ' || v_vendor_name ||
        ' is $' || (v_total / 100.0)::numeric(12,2) || ' but PO total is $' ||
        (v_po_total_cents / 100.0)::numeric(12,2) || ' (' || ROUND(v_amount_drift_pct * 100, 1) || '% drift). Verify the bill matches the PO.',
        'vendor_bill_drift', 'purchase_order', p_purchase_order_id
      FROM public.profiles p WHERE p.role = 'admin' AND p.is_active = true;
    END IF;
  END IF;

  IF p_payment_terms IS NULL THEN
    SELECT default_payment_terms, default_payment_terms_days INTO v_terms, v_terms_days
    FROM public.vendors WHERE id = p_vendor_id;
  ELSE
    v_terms := p_payment_terms;
    v_terms_days := CASE WHEN p_payment_terms ILIKE '%90%' THEN 90 WHEN p_payment_terms ILIKE '%60%' THEN 60
      WHEN p_payment_terms ILIKE '%45%' THEN 45 WHEN p_payment_terms ILIKE '%30%' THEN 30
      WHEN p_payment_terms ILIKE '%15%' THEN 15 WHEN p_payment_terms ILIKE '%10%' THEN 10 ELSE 30 END;
  END IF;

  INSERT INTO public.vendor_bills (vendor_id, purchase_order_id, bill_number, bill_date, due_date, payment_terms, subtotal_cents, adjustment_cents, total_cents, paid_cents, status, notes, created_by)
  VALUES (p_vendor_id, p_purchase_order_id, p_bill_number, p_bill_date,
    COALESCE(p_due_date, p_bill_date + (COALESCE(v_terms_days, 30) || ' days')::interval),
    v_terms, p_subtotal_cents, COALESCE(p_adjustment_cents, 0), v_total, 0, 'unpaid', p_notes, v_actor)
  RETURNING id INTO v_bill_id;
  INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, total_impact_cents, description)
  VALUES ('vendor_bill_created', 'vendor_bill', v_bill_id, v_actor, v_actor_role,
    jsonb_build_object('vendor_id', p_vendor_id, 'purchase_order_id', p_purchase_order_id,
      'bill_number', p_bill_number, 'bill_date', p_bill_date, 'total_cents', v_total,
      'po_total_cents', v_po_total_cents, 'drift_pct', v_amount_drift_pct), v_total,
    'Vendor bill ' || COALESCE(NULLIF(p_bill_number, ''), v_bill_id::text) ||
      ' created for $' || (v_total / 100.0)::numeric(12,2));
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'create_vendor_bill', jsonb_build_object('bill_id', v_bill_id));
  END IF;
  RETURN v_bill_id;
END;
$function$;

-- 5c. A closed PO's active bills never total more than what arrived, on any write path and with no overage override.
--     The PO row lock matches the close (FOR UPDATE) and KI-143's wrappers (which already hold it), so two bills, or a
--     bill and the close, cannot both pass on stale totals.
CREATE FUNCTION public._guard_closed_po_bill()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_po record;
  v_received_cents bigint;
  v_billed_cents bigint;
BEGIN
  IF NEW.purchase_order_id IS NULL OR NEW.deleted_at IS NOT NULL OR NEW.status = 'voided' THEN
    RETURN NEW;
  END IF;
  -- An already-active bill on the same PO that does not grow (a payment, an edit down) never adds to the total.
  IF TG_OP = 'UPDATE' AND OLD.purchase_order_id = NEW.purchase_order_id AND OLD.deleted_at IS NULL
     AND OLD.status <> 'voided' AND NEW.total_cents <= OLD.total_cents THEN
    RETURN NEW;
  END IF;
  SELECT po.po_number, po.status INTO v_po
    FROM public.purchase_orders po WHERE po.id = NEW.purchase_order_id FOR UPDATE;
  IF v_po.status IS DISTINCT FROM 'closed' THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(SUM(round(COALESCE(poi.quantity_received, 0) * COALESCE(poi.unit_cost, 0) * 100)), 0)::bigint
    INTO v_received_cents
    FROM public.purchase_order_items poi WHERE poi.purchase_order_id = NEW.purchase_order_id;
  SELECT COALESCE(SUM(vb.total_cents), 0)::bigint INTO v_billed_cents
    FROM public.vendor_bills vb
   WHERE vb.purchase_order_id = NEW.purchase_order_id AND vb.id <> NEW.id
     AND vb.deleted_at IS NULL AND vb.status <> 'voided';
  IF v_billed_cents + COALESCE(NEW.total_cents, 0) > v_received_cents THEN
    -- No amounts in the message: received value is quantity x cost, and PO cost is admin-only.
    RAISE EXCEPTION 'PO_CLOSE_BILLED_OVER_RECEIVED: bills on closed PO % would total more than what was received; a closed PO cannot be billed past what arrived',
      v_po.po_number USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._guard_closed_po_bill() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._guard_closed_po_bill() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trigger_0_guard_closed_po_bill
  BEFORE INSERT OR UPDATE OF purchase_order_id, total_cents, status, deleted_at ON public.vendor_bills
  FOR EACH ROW EXECUTE FUNCTION public._guard_closed_po_bill();

-- 6. The office call.
CREATE FUNCTION public.close_purchase_order_short(
  p_po_id uuid,
  p_reason text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_reason text := btrim(p_reason, E' \t\r\n');  -- tabs and line breaks too
  v_fingerprint text;
  v_replay jsonb;
  v_po public.purchase_orders%ROWTYPE;
  v_received_cents bigint;
  v_billed_cents bigint;
  v_received_qty numeric;
  v_lines jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: close_purchase_order_short requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_po_id IS NULL OR v_reason IS NULL OR v_reason !~ '[^[:space:]]' OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'PO_CLOSE_INVALID: a purchase order and a reason (up to 500 characters) are required' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  -- FOR SHARE: a concurrent demotion or deactivation waits until this call ends.
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = v_actor AND p.is_active = true FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can close a purchase order short' USING ERRCODE = '42501';
  END IF;

  -- The PO-derived-state lock cancel, receive and the on-order recompute take.
  PERFORM pg_advisory_xact_lock(73492009);

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'po_id', p_po_id, 'reason', v_reason));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'close_purchase_order_short', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';  -- closing is final, so the first answer stays true
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PO_NOT_FOUND: purchase order not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_po.status = 'closed' THEN
    -- Says which close won: this caller's reason was not recorded.
    v_result := jsonb_build_object('status', 'already_closed', 'po_id', p_po_id, 'po_number', v_po.po_number,
                                   'closed_at', v_po.closed_at, 'closed_by', v_po.closed_by,
                                   'close_reason', v_po.close_reason, 'lines_released', '[]'::jsonb);
  ELSIF v_po.status = 'submitted' THEN
    RAISE EXCEPTION 'PO_CLOSE_NOTHING_RECEIVED: nothing on PO % has been received yet; cancel it instead', v_po.po_number
      USING ERRCODE = '55000';
  ELSIF v_po.status <> 'partially_received' THEN
    RAISE EXCEPTION 'PO_CLOSE_INVALID_STATUS: only a partly received purchase order can be closed short; PO % is %',
      v_po.po_number, v_po.status USING ERRCODE = '55000';
  ELSE
    -- Received value: each line's received quantity at its cost, rounded per line as the PO total is. The remainder
    -- per line is exactly what _recompute_po_on_order_for_products stops counting.
    SELECT COALESCE(SUM(round(COALESCE(poi.quantity_received, 0) * COALESCE(poi.unit_cost, 0) * 100)), 0)::bigint,
           COALESCE(SUM(COALESCE(poi.quantity_received, 0)), 0),
           COALESCE(jsonb_agg(jsonb_build_object(
               'po_item_id', poi.id, 'product_id', poi.product_id, 'product_name', poi.product_name,
               'unit_size', poi.unit_size, 'quantity', poi.quantity_ordered - COALESCE(poi.quantity_received, 0))
             ORDER BY poi.product_name, poi.id)
             FILTER (WHERE poi.quantity_ordered > COALESCE(poi.quantity_received, 0)), '[]'::jsonb)
      INTO v_received_cents, v_received_qty, v_lines
      FROM public.purchase_order_items poi
     WHERE poi.purchase_order_id = p_po_id;
    IF v_received_qty <= 0 THEN
      RAISE EXCEPTION 'PO_CLOSE_NOTHING_RECEIVED: nothing on PO % has been received yet; cancel it instead', v_po.po_number
        USING ERRCODE = '55000';
    END IF;
    IF jsonb_array_length(v_lines) = 0 THEN
      RAISE EXCEPTION 'PO_CLOSE_NOTHING_OUTSTANDING: every line on PO % is already received', v_po.po_number
        USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint INTO v_billed_cents
      FROM public.vendor_bills vb
     WHERE vb.purchase_order_id = p_po_id AND vb.deleted_at IS NULL AND vb.status <> 'voided';
    IF v_billed_cents > v_received_cents THEN
      -- No amounts in the message: received value is quantity x cost, and PO cost is admin-only.
      RAISE EXCEPTION 'PO_CLOSE_BILLED_OVER_RECEIVED: vendor bills on PO % total more than what was received; void or correct the bill first',
        v_po.po_number USING ERRCODE = '55000';
    END IF;

    UPDATE public.purchase_orders
       SET status = 'closed', closed_at = now(), closed_by = v_actor, close_reason = v_reason, updated_at = now()
     WHERE id = p_po_id;

    INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
    VALUES ('po_closed_short',
            'Purchase order ' || v_po.po_number || ' closed short; the rest of ' || jsonb_array_length(v_lines)
              || ' line(s) is no longer on order. Reason: ' || v_reason,
            v_actor, 'purchase_order', p_po_id);

    v_result := jsonb_build_object('status', 'closed', 'po_id', p_po_id, 'po_number', v_po.po_number,
                                   'closed_at', now(), 'closed_by', v_actor, 'close_reason', v_reason,
                                   'lines_released', v_lines);
  END IF;

  PERFORM public.save_idempotency(p_idempotency_key, 'close_purchase_order_short', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'close_purchase_order_short', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.close_purchase_order_short(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_purchase_order_short(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_purchase_order_short(uuid, text, text) TO authenticated;
COMMENT ON FUNCTION public.close_purchase_order_short(uuid, text, text) IS
  'KI-142: close a partly received purchase order short (status closed); its unreceived remainder stops counting as on order. Active admin or sales rep; reason required; refused while active vendor bills exceed the received value. Answers closed or already_closed with who, when, why and lines_released (the remainder per line). Key required, bound to caller and request.';

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = 'public.close_purchase_order_short(uuid, text, text)'::regprocedure;
  IF NOT p.prosecdef OR p.proowner <> 'postgres'::regrole
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     OR has_function_privilege('anon', p.oid, 'EXECUTE')
     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTFLIGHT: close_purchase_order_short lost its owner, mode, search_path or grants';
  END IF;
  IF has_function_privilege('authenticated', 'public._guard_closed_po_item()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public._guard_closed_po_item()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._guard_closed_po()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public._guard_closed_po()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: a closed-PO guard is callable by a client role';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.purchase_orders', 'closed_at', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.purchase_orders', 'closed_by', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.purchase_orders', 'close_reason', 'SELECT')
     OR NOT has_column_privilege('anon', 'public.purchase_orders', 'close_reason', 'SELECT')
     OR has_table_privilege('authenticated', 'public.purchase_orders', 'SELECT')
     OR has_table_privilege('anon', 'public.purchase_orders', 'SELECT')
     OR has_column_privilege('authenticated', 'public.purchase_orders', 'total_cost_cents', 'SELECT') THEN
    RAISE EXCEPTION 'POSTFLIGHT: the closed_* columns must be readable column by column, and PO cost must stay carved out';
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE status = 'closed') THEN
    RAISE EXCEPTION 'POSTFLIGHT: no PO may be closed by this migration';
  END IF;
  IF has_function_privilege('authenticated', 'public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: the vendor-bill helper must stay callable by postgres only';
  END IF;
END;
$postflight$;
