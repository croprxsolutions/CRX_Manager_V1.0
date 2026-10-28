-- To-Do 1.12: version-checked order edits and serialized ticket/allocation numbering.
-- Parked candidate; no live apply is authorized for this task.
-- Existing lifecycle, pricing, authorization and inventory implementations remain authoritative.
-- Rollback: restore the prior update_order_items signature/body and ticket generator, then remove
-- the three new triggers/functions. Keep the additive orders.row_version column. Requires review.
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;
-- Orders use column-level SELECT grants to keep costs private.
GRANT SELECT (row_version) ON public.orders TO authenticated;

CREATE OR REPLACE FUNCTION public.bump_order_edit_version()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.bump_order_edit_version() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS orders_bump_edit_version ON public.orders;
CREATE TRIGGER orders_bump_edit_version BEFORE UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.bump_order_edit_version();

-- A line write from any existing workflow invalidates an open order editor too.
-- Definer rights are required because a child writer may not update orders directly.
CREATE OR REPLACE FUNCTION public.bump_order_item_edit_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.orders SET row_version = row_version + 1 WHERE id = OLD.order_id;
  ELSIF TG_OP = 'INSERT' THEN
    UPDATE public.orders SET row_version = row_version + 1 WHERE id = NEW.order_id;
  ELSE
    -- Stable parent order when a privileged workflow moves a line between orders.
    PERFORM 1 FROM public.orders WHERE id IN (OLD.order_id, NEW.order_id) ORDER BY id FOR UPDATE;
    UPDATE public.orders SET row_version = row_version + 1 WHERE id IN (OLD.order_id, NEW.order_id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.bump_order_item_edit_version() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS order_items_bump_edit_version ON public.order_items;
CREATE TRIGGER order_items_bump_edit_version AFTER INSERT OR UPDATE OR DELETE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.bump_order_item_edit_version();

-- Replace the public entry point, retaining the existing private implementation chain.
-- No unversioned public overload is left behind.
DROP FUNCTION IF EXISTS public.update_order_items(uuid, jsonb, uuid, text);
CREATE OR REPLACE FUNCTION public.update_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_expected_row_version bigint DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_version bigint;
  v_existing jsonb;
  v_request jsonb;
  v_result jsonb;
BEGIN
  PERFORM public._begin_below_cost_money_write('update_order_items', p_performed_by, p_items);
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 1 THEN
    RAISE EXCEPTION 'ORDER_EXPECTED_VERSION_REQUIRED';
  END IF;

  -- Approval reasons are transport metadata, not a different order-edit intent.
  v_request := jsonb_build_object('order_id', p_order_id, 'actor', v_actor,
    'expected_row_version', p_expected_row_version, 'items',
    (SELECT coalesce(jsonb_agg(item - 'below_cost_reason' ORDER BY ord), '[]'::jsonb)
       FROM jsonb_array_elements(p_items) WITH ORDINALITY AS lines(item, ord)));
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'update_order_items');
  END IF;

  SELECT row_version INTO v_version FROM public.orders
   WHERE id = p_order_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_existing IS NOT NULL THEN
    IF v_existing->'_order_edit_request' IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    END IF;
    IF (v_existing->>'row_version')::bigint IS DISTINCT FROM v_version THEN
      RAISE EXCEPTION 'ORDER_STALE_WRITE';
    END IF;
    RETURN v_existing - '_order_edit_request';
  END IF;
  IF p_expected_row_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'ORDER_STALE_WRITE';
  END IF;

  v_result := public._update_order_items_below_cost_impl_20260810(
    p_order_id, p_items, v_actor, p_idempotency_key);
  SELECT row_version INTO v_version FROM public.orders WHERE id = p_order_id;
  v_result := v_result || jsonb_build_object('order_id', p_order_id, 'row_version', v_version);
  IF p_idempotency_key IS NOT NULL THEN
    -- The private implementation already saved its receipt under this locked key.
    UPDATE public.idempotency_keys
       SET result = v_result || jsonb_build_object('_order_edit_request', v_request)
     WHERE idempotency_key = p_idempotency_key AND operation = 'update_order_items';
    IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_EDIT_RECEIPT_MISSING'; END IF;
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.update_order_items(uuid,jsonb,uuid,text,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_items(uuid,jsonb,uuid,text,bigint) TO authenticated, service_role;

-- create_blend_ticket inserts in the same transaction, so the next caller sees its number.
-- This preserves the existing year selection; document-year changes are a separate task.
CREATE OR REPLACE FUNCTION public.generate_ticket_number()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year text := extract(year FROM current_date)::text;
  v_max bigint;
  v_next text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('crx:blend-ticket-number:' || v_year, 0));
  SELECT coalesce(max(CASE WHEN ticket_number ~ ('^BT-' || v_year || '-\d+$')
    THEN split_part(ticket_number, '-', 3)::bigint ELSE 0 END), 0)
    INTO v_max FROM public.blend_tickets;
  v_next := (v_max + 1)::text;
  RETURN 'BT-' || v_year || '-' || lpad(v_next, greatest(4, length(v_next)), '0');
END;
$$;

-- Assign versions at the insert boundary rather than copying payment/date logic.
-- All existing allocation writers retain their authorization, idempotency and money checks.
CREATE OR REPLACE FUNCTION public.assign_allocation_set_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'crx:allocation-version:' || NEW.entity_type || ':' || NEW.entity_id::text, 0));
  SELECT coalesce(max(version), 0) + 1 INTO NEW.version
    FROM public.allocation_sets WHERE entity_type = NEW.entity_type AND entity_id = NEW.entity_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.assign_allocation_set_version() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS allocation_sets_assign_version ON public.allocation_sets;
CREATE TRIGGER allocation_sets_assign_version BEFORE INSERT ON public.allocation_sets
FOR EACH ROW EXECUTE FUNCTION public.assign_allocation_set_version();

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'update_order_items') <> 1 THEN
    RAISE EXCEPTION 'ORDER_EDIT_OVERLOAD_DRIFT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.orders'::regclass
    AND attname = 'row_version' AND atttypid = 'bigint'::regtype AND attnotnull) THEN
    RAISE EXCEPTION 'ORDER_EDIT_VERSION_COLUMN_DRIFT';
  END IF;
END;
$postflight$;
