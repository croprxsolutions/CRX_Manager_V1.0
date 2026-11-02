-- KI-85: new stock may be placed only at an active warehouse.
--
-- Deliveries, jobs, blends and holds ship from Main Warehouse only and there is
-- no transfer function, so stock received at any other location is stranded.
-- The receiving and Add Inventory screens now list active `warehouses` rows;
-- this makes the server refuse any other location instead of storing whatever
-- text is sent.
--
-- Only the two public wrappers change; each body is otherwise identical to its
-- previous definition (receive_po_items: 20260831233000; manual_inventory_add:
-- 20261016140000), except that receive_po_items' actor check now carries the
-- canonical ACTOR_MISMATCH token in front of its old text (offlineSync matches
-- either). The location check runs only when there is no saved replay, so a
-- request that already committed still replays its saved result, and neither
-- request fingerprint changes. A missing location still means Main Warehouse,
-- as in the inner bodies.
--
-- idempotency-body-check: exempt. Both wrappers read idempotency_keys through
--   check_idempotency_intent with their own operation literal; the inner bodies
--   they delegate to save the key (_section9_receive_po_items_serialized via
--   save_idempotency, then the request binding below; manual_inventory_add via
--   _bind_replay_receipt_20261015), unchanged from the definitions named above.
--
-- Grants: none here. CREATE OR REPLACE keeps each function's live ACL (authenticated and
-- service_role execute; PUBLIC and anon do not); the postcondition below re-checks anon.
-- Callers: PurchaseOrderDetail and QuickReceivePanel send a picked active warehouse;
-- ReceivingHubPanel, InventoryPage (receive) and offlineSync omit storage_location (Main
-- Warehouse); InventoryPage Add Inventory now picks an active warehouse.

CREATE OR REPLACE FUNCTION public.receive_po_items(
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by does not match authenticated user';
  END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can receive PO items';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: receive_po_items requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'items', p_items,
    'allow_over_receive', COALESCE(p_allow_over_receive, false)
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'receive_po_items', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- KI-85: refuse, never normalize, a location that is not an active warehouse.
  -- The check share-locks each warehouse it accepts, so none is deactivated or renamed before the receipt commits.
  IF jsonb_typeof(p_items) = 'array' AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_items) AS i(item)
     WHERE jsonb_typeof(i.item) = 'object'
       AND NOT EXISTS (
         SELECT 1 FROM public.warehouses w
          WHERE w.is_active
            AND w.name = COALESCE(i.item->>'storage_location', 'Main Warehouse')
          FOR SHARE
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'UNKNOWN_STORAGE_LOCATION: every storage_location must name an active warehouse';
  END IF;

  v_result := public._section9_receive_po_items_intent_impl_20260831(
    p_items, p_performed_by, p_idempotency_key, p_allow_over_receive
  );
  UPDATE public.idempotency_keys SET request_fingerprint = v_fingerprint, request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key AND operation = 'receive_po_items';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.manual_inventory_add(
  p_product_id uuid,
  p_location text,
  p_quantity numeric,
  p_unit_size text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
  p_unit_cost numeric DEFAULT NULL::numeric,
  p_idempotency_key text DEFAULT NULL::text,
  p_reorder_point numeric DEFAULT NULL::numeric,
  p_min_stock_level numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: manual_inventory_add requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'product_id', p_product_id,
    'location', p_location,
    'quantity', p_quantity,
    'unit_size', p_unit_size,
    'notes', p_notes,
    'unit_cost', p_unit_cost,
    'reorder_point', p_reorder_point,
    'min_stock_level', p_min_stock_level
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'manual_inventory_add', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  -- KI-85: refuse, never normalize, a location that is not an active warehouse.
  -- The check share-locks the warehouse it accepts, so it is not deactivated or renamed before the add commits.
  IF v_replay IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.warehouses w
     WHERE w.is_active AND w.name = COALESCE(p_location, 'Main Warehouse')
     FOR SHARE
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'UNKNOWN_STORAGE_LOCATION: the location must name an active warehouse';
  END IF;
  -- On a saved replay the impl's own check_idempotency returns the stored result before any write
  -- (20260702141000), unchanged since 20261016140000; proven live 2026-11-02 (stock rose once).
  v_result := public._manual_inventory_add_replay_impl_20261015(p_product_id, p_location, p_quantity, p_unit_size, p_performed_by, p_notes, p_unit_cost, p_idempotency_key, p_reorder_point, p_min_stock_level);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'manual_inventory_add', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

DO $ki85_postcond$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'receive_po_items') <> 1
     OR to_regprocedure('public.receive_po_items(jsonb,uuid,text,boolean)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'manual_inventory_add') <> 1
     OR to_regprocedure('public.manual_inventory_add(uuid,text,numeric,text,uuid,text,numeric,text,numeric,numeric)') IS NULL THEN
    RAISE EXCEPTION 'KI85_POSTCONDITION: receive_po_items/manual_inventory_add overload drift';
  END IF;
  IF has_function_privilege('anon', 'public.receive_po_items(jsonb,uuid,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.manual_inventory_add(uuid,text,numeric,text,uuid,text,numeric,text,numeric,numeric)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.receive_po_items(jsonb,uuid,text,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.manual_inventory_add(uuid,text,numeric,text,uuid,text,numeric,text,numeric,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'KI85_POSTCONDITION: execute grants drifted (anon must not, authenticated must)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE is_active AND name = 'Main Warehouse') THEN
    RAISE EXCEPTION 'KI85_POSTCONDITION: Main Warehouse must be an active warehouse';
  END IF;
END;
$ki85_postcond$;
