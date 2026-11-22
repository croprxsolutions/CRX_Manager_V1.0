-- KI-144 (contract docs/plans/2026-11-22-ki144-po-vendor-link-CONTRACT.md; Mason 2026-11-22: "Keep original name"):
-- a purchase order keeps a link to the vendor it was written for, so renaming that vendor no longer breaks billing it.
--
-- 1. purchase_orders.vendor_id (nullable, references vendors). The vendor text stays as the name printed on the PO.
-- 2. Backfill: a billed PO is linked to the one vendor that billed it; an unbilled PO to the active vendor whose
--    name equals its text ignoring case and outer spaces (no alias). Unmatched rows stay NULL (To-Do decision 23 is Mason's). The
--    closed-PO guard is switched off for that one UPDATE inside this transaction and checked back on in the postflight.
-- 3. Only THEN the trigger that owns vendor_id: on insert, or when the text changes, it matches again (see step 3);
--    on any other update it keeps the old link; it refuses moving a PO with another vendor's live bills. Whatever a writer puts in vendor_id is overwritten.
-- 4. The vendor-bill check compares the bill's vendor with the PO's link when there is one; an unlinked PO keeps the
--    name comparison. The rest of the bill function is the pinned body unchanged.
--
-- Rollback: a NEW forward migration that drops trigger_00_po_vendor_id and restores the pinned bill-function body
-- (20270103180000_po_close_short.sql); keep the column and its values (a link cannot be rebuilt after a rename).
-- Never re-run or edit this file.

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.ki144_po_vendor_tx') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: leftover temp marker';
  END IF;
  CREATE TEMP TABLE ki144_po_vendor_tx (x int) ON COMMIT DROP;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.purchase_orders'::regclass AND attname = 'vendor_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: purchase_orders.vendor_id already exists';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_section9_create_vendor_bill_intent_impl_20260826') <> 1
     OR to_regprocedure('public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text)') IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text)'::regprocedure) <> 'ec7571ff8d5f8c3e2bfc51026282cf5e' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: the vendor-bill function is not the 20270103180000 body';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._guard_closed_po()'::regprocedure) <> 'e72e566376ad8de38f2c5a89102413d9'
     OR (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.purchase_orders'::regclass AND tgname = 'trigger_0_guard_closed_po') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: the closed-PO guard is not the 20270103180000 guard, or is not enabled';
  END IF;
  IF to_regprocedure('public._vendor_id_for_text(text)') IS NULL OR to_regprocedure('public.normalize_vendor_alias(text)') IS NULL
     OR to_regprocedure('public._po_vendor_id_for_text(text)') IS NOT NULL OR to_regprocedure('public._po_stamp_vendor_id()') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: vendor matching helpers are not as expected';
  END IF;
END;
$preflight$;

DO $tx$
BEGIN
  IF to_regclass('pg_temp.ki144_po_vendor_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 / --single-transaction)';
  END IF;
END;
$tx$;

-- 1. The link.
ALTER TABLE public.purchase_orders ADD COLUMN vendor_id uuid REFERENCES public.vendors(id);
CREATE INDEX idx_purchase_orders_vendor_id ON public.purchase_orders (vendor_id);
-- The table's standing read grants for a non-cost column (20261021141000): anon has no row policy, so it sees no rows.
GRANT SELECT (vendor_id) ON public.purchase_orders TO authenticated;
GRANT REFERENCES (vendor_id) ON public.purchase_orders TO authenticated;
GRANT SELECT (vendor_id) ON public.purchase_orders TO anon;
COMMENT ON COLUMN public.purchase_orders.vendor_id IS
  'KI-144: the vendor this PO was written for. Set only by trigger_00_po_vendor_id from the vendor text when the PO is created or its vendor text changes; a vendor rename keeps it. NULL = the text matched no single active vendor. The vendor column keeps the printed name.';

-- One vendor for a PO's vendor text: the single active vendor whose name equals it ignoring case and outer spaces (the
-- bill check's own rule), else NULL. No alias, legacy resolution (Sol round 1) or punctuation folding (Sol round 2): a
-- link is authoritative for billing, so only what the name check already accepted makes one.
CREATE FUNCTION public._po_vendor_id_for_text(p_text text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT CASE WHEN count(*) = 1 THEN min(v.id::text)::uuid END
    FROM public.vendors v
   WHERE v.deleted_at IS NULL
     AND lower(btrim(v.name)) = lower(NULLIF(btrim(p_text), ''));
$function$;
ALTER FUNCTION public._po_vendor_id_for_text(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._po_vendor_id_for_text(text) FROM PUBLIC, anon, authenticated, service_role;

-- The backfill's link for an existing PO (a temp function, gone when this database session ends): a PO already billed is linked to the one
-- vendor that billed it (those bills passed the name check when written), or left NULL if its bills disagree; an
-- unbilled PO is linked by its text. Voided or deleted bills do not count.
CREATE FUNCTION pg_temp.ki144_backfill_vendor_id(p_po_id uuid, p_text text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.vendor_bills vb WHERE vb.purchase_order_id = p_po_id AND vb.status <> 'voided' AND vb.deleted_at IS NULL)
      THEN (SELECT CASE WHEN count(DISTINCT vb.vendor_id) = 1 THEN min(vb.vendor_id::text)::uuid END
              FROM public.vendor_bills vb WHERE vb.purchase_order_id = p_po_id AND vb.status <> 'voided' AND vb.deleted_at IS NULL)
    ELSE public._po_vendor_id_for_text(p_text)
  END;
$function$;

-- 2. Backfill, before the trigger exists (it would keep the old NULL).
-- One statement, so the guard cannot stay off even if this file were run statement by statement.
DO $backfill$
BEGIN
  ALTER TABLE public.purchase_orders DISABLE TRIGGER trigger_0_guard_closed_po;
  UPDATE public.purchase_orders po
     SET vendor_id = pg_temp.ki144_backfill_vendor_id(po.id, po.vendor)
   WHERE pg_temp.ki144_backfill_vendor_id(po.id, po.vendor) IS NOT NULL;
  ALTER TABLE public.purchase_orders ENABLE TRIGGER trigger_0_guard_closed_po;
END
$backfill$;

-- 3. The trigger that owns the link. Named to fire before trigger_0_guard_closed_po, so a closed PO's link is put back
--    before the guard compares the row. Insert: link by exact name. A vendor-text edit: link by exact name (Sol round 1:
--    a re-spelt edit naming another vendor moves the link); if no vendor has that name and only case or outer spaces changed,
--    keep the link (the vendor may have been renamed). A vendor change (another link, or other text) on a PO with live
--    bills from any other vendor is refused (PO_VENDOR_HAS_BILLS), linked or not (Sol round 2). Other edits keep the link.
CREATE FUNCTION public._po_stamp_vendor_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.vendor_id := public._po_vendor_id_for_text(NEW.vendor);
    RETURN NEW;
  END IF;
  IF NEW.vendor IS NOT DISTINCT FROM OLD.vendor THEN
    NEW.vendor_id := OLD.vendor_id;
    RETURN NEW;
  END IF;
  v_id := public._po_vendor_id_for_text(NEW.vendor);
  IF v_id IS NULL AND lower(btrim(NEW.vendor)) IS NOT DISTINCT FROM lower(btrim(OLD.vendor)) THEN
    v_id := OLD.vendor_id;
  END IF;
  IF (v_id IS DISTINCT FROM OLD.vendor_id OR lower(btrim(NEW.vendor)) IS DISTINCT FROM lower(btrim(OLD.vendor))) AND EXISTS (
       SELECT 1 FROM public.vendor_bills vb
        WHERE vb.purchase_order_id = NEW.id AND vb.status <> 'voided' AND vb.deleted_at IS NULL
          AND vb.vendor_id IS DISTINCT FROM v_id) THEN
    RAISE EXCEPTION 'PO_VENDOR_HAS_BILLS: purchase order % has bills from another vendor; void them before changing its vendor', NEW.po_number
      USING ERRCODE = 'P0001';
  END IF;
  NEW.vendor_id := v_id;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._po_stamp_vendor_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._po_stamp_vendor_id() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trigger_00_po_vendor_id
  BEFORE INSERT OR UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._po_stamp_vendor_id();

-- 4. The vendor-bill check.
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
  v_po_vendor_id uuid;
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
    SELECT vendor, vendor_id, status, total_cost_cents INTO v_po_vendor, v_po_vendor_id, v_po_status, v_po_total_cents
    FROM public.purchase_orders WHERE id = p_purchase_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', p_purchase_order_id; END IF;
    IF v_po_status NOT IN ('submitted', 'partially_received', 'fully_received', 'closed') THEN
      RAISE EXCEPTION 'PO_NOT_BILLABLE: purchase order % has status %', p_purchase_order_id, v_po_status;
    END IF;
    -- KI-144: a PO linked to a vendor is billed by that vendor whatever it is called now; an unlinked PO keeps the
    -- name comparison it always had.
    IF v_po_vendor_id IS NOT NULL THEN
      IF v_po_vendor_id <> p_vendor_id THEN
        RAISE EXCEPTION 'VENDOR_PO_MISMATCH: bill vendor "%" is not this purchase order''s vendor "%" (named "%" on the PO)',
          v_vendor_name, (SELECT v.name FROM public.vendors v WHERE v.id = v_po_vendor_id), v_po_vendor;
      END IF;
    ELSIF lower(trim(v_po_vendor)) <> lower(trim(v_vendor_name)) THEN
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
ALTER FUNCTION public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_oid oid := to_regprocedure('public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text)');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid AND p.prosecdef AND p.proowner = 'postgres'::regrole
                   AND p.proconfig = ARRAY['search_path=public, pg_temp'] AND p.prosrc LIKE '%KI-144%' AND p.prosrc LIKE '%v_po_vendor_id%')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: vendor-bill function security, body or grants are wrong';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public._po_vendor_id_for_text(text)'::regprocedure, 'public._po_stamp_vendor_id()'::regprocedure)
               AND (NOT p.prosecdef OR p.proowner <> 'postgres'::regrole OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
                    OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
                    OR has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a new helper''s security or grants are wrong';
  END IF;
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.purchase_orders'::regclass AND tgname = 'trigger_0_guard_closed_po') IS DISTINCT FROM 'O'
     OR (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.purchase_orders'::regclass AND tgname = 'trigger_00_po_vendor_id') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: the closed-PO guard or the vendor-link trigger is not enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders po WHERE po.vendor_id IS DISTINCT FROM pg_temp.ki144_backfill_vendor_id(po.id, po.vendor)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a PO''s vendor link does not match its bills or vendor text';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.purchase_orders', 'vendor_id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.purchase_orders', 'vendor_id', 'REFERENCES')
     OR NOT has_column_privilege('anon', 'public.purchase_orders', 'vendor_id', 'SELECT')
     OR has_column_privilege('authenticated', 'public.purchase_orders', 'vendor_id', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.purchase_orders', 'SELECT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: vendor_id grants are wrong';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: % of % purchase orders linked to a vendor',
    (SELECT count(vendor_id) FROM public.purchase_orders), (SELECT count(*) FROM public.purchase_orders);
END;
$postflight$;
