-- Cycle counts: freeze stock movement for counted products while the count is open
-- (Mason's decision, 2026-11-02: during a cycle count the warehouse stops shipping and
-- receiving the products being counted).
--
-- idempotency-body-check: exempt — create_cycle_count below uses the intent-bound sequence of
-- upsert_product_category (check_idempotency_intent before any work, save_idempotency, then
-- _bind_replay_receipt_20261015). complete_cycle_count is the live 20260908120000 wrapper with
-- two additions and keeps its check_idempotency / receipt handling unchanged.
--
-- The bug: a count snapshots expected_qty when it starts, and completion applies
-- quantity_available + (counted - expected). A delivery or receipt made while the count was open
-- changed quantity_available AND is already in what the warehouse counted, so it landed twice.
--
-- 1. Freeze. A BEFORE UPDATE trigger on inventory refuses any change to quantity_available of an
--    inventory row (one product at one location) that is a line of an in_progress cycle count,
--    with INVENTORY_FROZEN_FOR_CYCLE_COUNT naming the product, location and count. Every stock
--    path writes that column (receiving and quick receive, receipt reversal, delivery complete /
--    void / cancel, quick delivery, job and blend application, manual adjustment, returns), so one
--    trigger covers them all, including ones added later. quantity_prebooked-only changes (taking
--    or editing orders) and holds (which never touch inventory) are not frozen: they do not change
--    on-hand stock, so they cannot affect the count, and Mason froze shipping and receiving only.
--    The count's own completion is exempt through a transaction-local setting that
--    complete_cycle_count sets to that count's id; any OTHER open count on the same row still
--    refuses. Reversing a completed count is not exempt from a different, still-open count on the
--    same row, because that reversal would be double-counted by the open count.
--
-- 2. Atomic start. New create_cycle_count(p_warehouse, p_notes, p_idempotency_key) numbers the
--    count, refuses a second open count for the same warehouse (also enforced for direct inserts by
--    the partial unique index cycle_counts_one_open_per_warehouse), locks the location's inventory
--    rows and snapshots expected_qty in one transaction. Before, the browser read stock, then
--    inserted the count, then its lines, so a movement between the read and the insert was lost
--    from the snapshot.
--
-- 3. Safety net. complete_cycle_count refuses with CYCLE_COUNT_STOCK_MOVED if any counted line's
--    current quantity_available differs from its expected_qty, so a count can never apply on top
--    of stock that moved (for example a count started from an old cached browser tab with the old
--    three-step start, or a direct data fix). The rest of the wrapper is the live body unchanged.
--    With the freeze, current = expected, so completion still sets stock to the counted quantity
--    and reverse_completed_cycle_count (unchanged) still subtracts exactly that variance.
--    expected_qty is numeric(10,2), so a row holding more than 2 decimals (one live row on
--    2026-11-02) is compared at 2 decimals and may land up to 0.005 off the counted quantity,
--    as it did before this migration.
--
-- 4. Count-table guards. Only the count functions change a count's status or its lines, but
--    admins can also write those tables directly. Two triggers keep such writes from undoing the
--    freeze: trg_guard_cycle_count_status refuses (CYCLE_COUNT_STATUS_LOCKED) marking an open
--    count completed except inside its own Complete Count, and any change out of cancelled or
--    from completed to anything but cancelled, and completed -> cancelled unless Reverse Count has
--    written its ledger rows in the same transaction, and any change of a count's warehouse;
--    trg_guard_open_cycle_count_items refuses
--    (CYCLE_COUNT_LINE_LOCKED) deleting a line of an open count or changing its expected_qty,
--    inventory_id, product_id or cycle_count_id, including moving a line into an open count. Entering counted_qty and cancelling stay allowed. The
--    one-open-count index compares lower(btrim(warehouse)) so spacing or case cannot dodge it.
--
-- Live state 2026-11-02: 17 cycle counts, all cancelled; none in_progress, so nothing is frozen
-- on apply and no data is repaired. Non-destructive: no rows change. Grants: the new functions
-- are locked down at creation; complete_cycle_count keeps its owner and grants
-- (CREATE OR REPLACE; the postflight checks them).
--
-- Rollback (new reviewed migration): DROP TRIGGER trg_freeze_inventory_during_cycle_count ON
-- public.inventory; DROP FUNCTION public._freeze_inventory_during_cycle_count_20261102();
-- DROP INDEX public.cycle_counts_one_open_per_warehouse;
-- DROP TRIGGER trg_guard_cycle_count_status ON public.cycle_counts;
-- DROP FUNCTION public._guard_cycle_count_status_20261102();
-- DROP TRIGGER trg_guard_open_cycle_count_items ON public.cycle_count_items;
-- DROP FUNCTION public._guard_open_cycle_count_items_20261102();
-- restore complete_cycle_count from 20260908120000; DROP FUNCTION public.create_cycle_count(text,
-- text, text) only after the page stops calling it.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.complete_cycle_count(uuid,uuid,text,bigint)'))
     IS DISTINCT FROM 'ad7249f15027bd75084cb0cfbf8b6bab' THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_PREFLIGHT: complete_cycle_count changed since 2026-11-02';
  END IF;
  IF to_regprocedure('public.create_cycle_count(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_PREFLIGHT: create_cycle_count already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.inventory'::regclass
              AND tgname = 'trg_freeze_inventory_during_cycle_count') THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_PREFLIGHT: the freeze trigger already exists';
  END IF;
  IF to_regprocedure('public._guard_cycle_count_status_20261102()') IS NOT NULL
     OR to_regprocedure('public._guard_open_cycle_count_items_20261102()') IS NOT NULL THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_PREFLIGHT: a count-table guard already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cycle_counts WHERE status = 'in_progress') THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_PREFLIGHT: a cycle count is open; finish or cancel it before applying';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. The freeze.
CREATE FUNCTION public._freeze_inventory_during_cycle_count_20261102()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count_number text;
  v_product text;
BEGIN
  SELECT cc.count_number INTO v_count_number
    FROM public.cycle_count_items cci
    JOIN public.cycle_counts cc ON cc.id = cci.cycle_count_id
   WHERE cci.inventory_id = NEW.id
     AND cc.status = 'in_progress'
     AND cc.id::text IS DISTINCT FROM NULLIF(current_setting('crx.cycle_count_applying', true), '')
   ORDER BY cc.count_number
   LIMIT 1;
  IF FOUND THEN
    SELECT product_name INTO v_product FROM public.products WHERE id = NEW.product_id;
    RAISE EXCEPTION 'INVENTORY_FROZEN_FOR_CYCLE_COUNT: % at % is being counted in cycle count %. Shipping and receiving for it are paused until that count is completed or cancelled.',
      COALESCE(v_product, NEW.product_id::text), NEW.location, v_count_number;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._freeze_inventory_during_cycle_count_20261102() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._freeze_inventory_during_cycle_count_20261102()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER trg_freeze_inventory_during_cycle_count
  BEFORE UPDATE OF quantity_available ON public.inventory
  FOR EACH ROW
  WHEN (OLD.quantity_available IS DISTINCT FROM NEW.quantity_available)
  EXECUTE FUNCTION public._freeze_inventory_during_cycle_count_20261102();

-- One open count per warehouse, enforced for every write path (admins can still insert
-- cycle_counts rows directly). No count is open live, so this builds on no rows.
CREATE UNIQUE INDEX cycle_counts_one_open_per_warehouse
  ON public.cycle_counts (lower(btrim(warehouse))) WHERE status = 'in_progress';

-- Admins keep direct table access to the count tables (changing that is a permission change), so
-- the freeze is protected here instead. Only complete_cycle_count may mark an open count
-- completed; an open count may still be cancelled, which lifts its freeze; a cancelled count is
-- final. While a count is open its lines cannot be deleted or re-pointed, and their snapshot
-- cannot be edited. Every live writer (_complete_cycle_count_impl, cancel_cycle_count,
-- _reverse_completed_cycle_count_impl, update_cycle_count_item, bump_cycle_count_item_revision)
-- stays inside these rules.
CREATE FUNCTION public._guard_cycle_count_status_20261102()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A count's lines are that warehouse's rows, so its warehouse never changes.
  IF OLD.warehouse IS DISTINCT FROM NEW.warehouse THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STATUS_LOCKED: the warehouse of cycle count % cannot change.', OLD.count_number;
  END IF;
  IF OLD.status = 'in_progress' AND NEW.status = 'completed'
     AND NEW.id::text IS DISTINCT FROM NULLIF(current_setting('crx.cycle_count_applying', true), '') THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STATUS_LOCKED: cycle count % can only be completed with Complete Count, which applies it.', OLD.count_number;
  END IF;
  IF OLD.status = 'cancelled' OR (OLD.status = 'completed' AND NEW.status <> 'cancelled') THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STATUS_LOCKED: cycle count % is % and cannot change to %.', OLD.count_number, OLD.status, NEW.status;
  END IF;
  -- completed -> cancelled is reversal, which first writes one 'REVERSED cycle count' ledger row
  -- per adjusted line in this same transaction (created_at = now()); without them it is refused.
  IF OLD.status = 'completed'
     AND (SELECT count(*) FROM public.cycle_count_items cci
           WHERE cci.cycle_count_id = OLD.id AND cci.is_counted AND cci.inventory_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.inventory i WHERE i.id = cci.inventory_id AND i.quantity_available IS NOT NULL)
             AND cci.variance IS NOT NULL AND cci.variance <> 0)
       > (SELECT count(*) FROM public.inventory_transactions t
           WHERE t.transaction_type = 'adjusted' AND t.created_at = now()
             AND starts_with(t.notes, 'REVERSED cycle count ' || OLD.count_number || ': ')) THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STATUS_LOCKED: cycle count % can only be cancelled after completion with Reverse Count, which undoes its adjustments.', OLD.count_number;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._guard_cycle_count_status_20261102() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._guard_cycle_count_status_20261102()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER trg_guard_cycle_count_status
  BEFORE UPDATE OF status, warehouse ON public.cycle_counts
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.warehouse IS DISTINCT FROM NEW.warehouse)
  EXECUTE FUNCTION public._guard_cycle_count_status_20261102();

CREATE FUNCTION public._guard_open_cycle_count_items_20261102()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count_number text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.expected_qty IS NOT DISTINCT FROM NEW.expected_qty
     AND OLD.inventory_id IS NOT DISTINCT FROM NEW.inventory_id
     AND OLD.product_id IS NOT DISTINCT FROM NEW.product_id
     AND OLD.cycle_count_id IS NOT DISTINCT FROM NEW.cycle_count_id THEN
    RETURN NEW;
  END IF;
  -- The new count matters too: moving a line from a closed count into an open one is refused.
  SELECT count_number INTO v_count_number
    FROM public.cycle_counts
   WHERE status = 'in_progress'
     AND (id = OLD.cycle_count_id OR (TG_OP = 'UPDATE' AND id = NEW.cycle_count_id))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CYCLE_COUNT_LINE_LOCKED: lines of open cycle count % cannot be removed or have their expected quantity or product changed. Cancel the count instead.', v_count_number;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
ALTER FUNCTION public._guard_open_cycle_count_items_20261102() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._guard_open_cycle_count_items_20261102()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER trg_guard_open_cycle_count_items
  BEFORE UPDATE OR DELETE ON public.cycle_count_items
  FOR EACH ROW
  EXECUTE FUNCTION public._guard_open_cycle_count_items_20261102();

-- ---------------------------------------------------------------------------------------------
-- 2. Atomic start.
CREATE OR REPLACE FUNCTION public.create_cycle_count(
  p_warehouse text, p_notes text DEFAULT NULL, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_warehouse text := btrim(p_warehouse);
  v_notes text := NULLIF(btrim(p_notes), '');
  v_fingerprint text;
  v_replay jsonb;
  v_open text;
  v_number text;
  v_id uuid;
  v_items integer;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_cycle_count requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only an admin can start a cycle count' USING ERRCODE = '42501';
  END IF;
  IF v_warehouse IS NULL OR v_warehouse = '' THEN
    RAISE EXCEPTION 'CYCLE_COUNT_WAREHOUSE_REQUIRED: choose a warehouse' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'warehouse', v_warehouse, 'notes', v_notes));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_cycle_count', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- next_cycle_count_number holds the cycle-count advisory lock to the end of this transaction,
  -- so two starts cannot both pass the open-count check below.
  v_number := public.next_cycle_count_number();

  SELECT count_number INTO v_open
    FROM public.cycle_counts
   WHERE lower(btrim(warehouse)) = lower(v_warehouse) AND status = 'in_progress'
   ORDER BY count_number
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CYCLE_COUNT_ALREADY_OPEN: cycle count % is still open for %. Complete or cancel it first.', v_open, v_warehouse;
  END IF;

  INSERT INTO public.cycle_counts (count_number, warehouse, status, initiated_by, notes)
    VALUES (v_number, v_warehouse, 'in_progress', v_actor, v_notes)
    RETURNING id INTO v_id;

  -- Lock and snapshot in one statement: a movement already in flight on a row commits before it is
  -- read, and a later one waits for this commit and then meets the freeze.
  WITH locked AS (
    SELECT i.id, i.product_id, i.quantity_available
      FROM public.inventory i
     WHERE i.location = v_warehouse
     ORDER BY i.id
       FOR NO KEY UPDATE
  )
  INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty)
  SELECT v_id, l.product_id, l.id, COALESCE(l.quantity_available, 0)
    FROM locked l
   ORDER BY l.product_id, l.id;
  GET DIAGNOSTICS v_items = ROW_COUNT;
  IF v_items = 0 THEN
    RAISE EXCEPTION 'CYCLE_COUNT_NO_INVENTORY: no inventory found at %', v_warehouse USING ERRCODE = '22023';
  END IF;

  v_result := jsonb_build_object('cycle_count_id', v_id, 'count_number', v_number,
    'warehouse', v_warehouse, 'item_count', v_items);
  PERFORM public.save_idempotency(p_idempotency_key, 'create_cycle_count', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_cycle_count', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.create_cycle_count(text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_cycle_count(text, text, text)
  FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.create_cycle_count(text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Completion: the live 20260908120000 wrapper plus the stock-moved refusal and the freeze
-- exemption for this count only.
CREATE OR REPLACE FUNCTION public.complete_cycle_count(p_cycle_count_id uuid, p_completed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_item_revision bigint DEFAULT NULL::bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_current_item_revision bigint;
  v_cache_rows integer;
  v_moved record;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_completed_by IS NOT NULL AND p_completed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: complete_cycle_count requires p_idempotency_key';
  END IF;
  -- The parameter keeps its DEFAULT so the four-argument signature is unchanged, but
  -- omitting it is now REFUSED rather than silently skipping both revision checks.
  -- Every shipped caller already sends it; a cached pre-change tab is the caller this
  -- refusal is for, and stopping it is the fail-closed direction.
  IF p_expected_item_revision IS NULL THEN
    RAISE EXCEPTION 'CYCLE_COUNT_REVISION_REQUIRED: complete_cycle_count requires p_expected_item_revision';
  END IF;
  IF p_expected_item_revision < 0 THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STALE_REVISION';
  END IF;

  v_existing := public.check_idempotency(p_idempotency_key, 'complete_cycle_count');
  IF v_existing IS NOT NULL THEN
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object'
       OR v_existing->>'_cycle_count_id' IS DISTINCT FROM p_cycle_count_id::text
       OR v_existing->>'_actor_id' IS DISTINCT FROM v_actor::text
       OR (v_existing->>'_expected_item_revision') IS DISTINCT FROM p_expected_item_revision::text THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    END IF;
    RETURN;
  END IF;

  -- Lock item rows first, in a stable order. Item writers take one of these
  -- before the parent row, so an already-started save commits or fails before
  -- this completion observes the revision and finalizes inventory.
  PERFORM 1
    FROM public.cycle_count_items
   WHERE cycle_count_id = p_cycle_count_id
   ORDER BY id
   FOR UPDATE;

  SELECT item_revision INTO v_current_item_revision
    FROM public.cycle_counts
   WHERE id = p_cycle_count_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;
  IF v_current_item_revision IS DISTINCT FROM p_expected_item_revision THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STALE_REVISION';
  END IF;

  -- Preserve the pre-existing inventory serialization contract after the new
  -- item and parent locks. The private implementation reads current on-hand
  -- values before writing inventory and its ledger, so these rows must remain
  -- locked in stable order across that entire operation.
  PERFORM 1
    FROM public.inventory i
    JOIN public.cycle_count_items cci ON cci.inventory_id = i.id
   WHERE cci.cycle_count_id = p_cycle_count_id
   ORDER BY i.id
   FOR UPDATE OF i;

  -- Applying counted - expected on top of stock that moved since the start would count that
  -- movement twice (20261102180000). expected_qty is numeric(10,2), so compare at that scale.
  SELECT p.product_name, cci.expected_qty, i.quantity_available, cc.count_number
    INTO v_moved
    FROM public.cycle_count_items cci
    JOIN public.cycle_counts cc ON cc.id = cci.cycle_count_id
    JOIN public.inventory i ON i.id = cci.inventory_id
    LEFT JOIN public.products p ON p.id = cci.product_id
   WHERE cci.cycle_count_id = p_cycle_count_id
     AND cci.is_counted = true
     AND cc.status = 'in_progress'
     AND round(COALESCE(i.quantity_available, 0), 2) IS DISTINCT FROM cci.expected_qty
   ORDER BY p.product_name, cci.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STOCK_MOVED: stock for % changed after cycle count % started (expected %, now %). Cancel this count and start a new one.',
      COALESCE(v_moved.product_name, 'a counted product'), v_moved.count_number,
      trim_scale(v_moved.expected_qty), trim_scale(COALESCE(v_moved.quantity_available, 0));
  END IF;

  -- The freeze trigger lets this count's own adjustments through, and only those.
  PERFORM set_config('crx.cycle_count_applying', p_cycle_count_id::text, true);
  PERFORM public._complete_cycle_count_impl(p_cycle_count_id, v_actor, p_idempotency_key);
  PERFORM set_config('crx.cycle_count_applying', '', true);

  UPDATE public.idempotency_keys
     SET result = jsonb_build_object(
       '_cycle_count_id', p_cycle_count_id,
       '_actor_id', v_actor,
       '_expected_item_revision', p_expected_item_revision,
       '_completed_item_revision', v_current_item_revision
     )
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'complete_cycle_count';
  GET DIAGNOSTICS v_cache_rows = ROW_COUNT;
  IF v_cache_rows <> 1 THEN RAISE EXCEPTION 'IDEMPOTENCY_CACHE_WRITE_FAILED'; END IF;
END;
$function$;

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.inventory'::regclass
                  AND tgname = 'trg_freeze_inventory_during_cycle_count' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_POSTFLIGHT: the freeze trigger is missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cycle_counts'::regclass
                  AND tgname = 'trg_guard_cycle_count_status' AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cycle_count_items'::regclass
                  AND tgname = 'trg_guard_open_cycle_count_items' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_POSTFLIGHT: a count-table guard trigger is missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index x
                  WHERE x.indexrelid = to_regclass('public.cycle_counts_one_open_per_warehouse')
                    AND x.indisunique AND x.indisvalid AND x.indrelid = 'public.cycle_counts'::regclass) THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_POSTFLIGHT: the one-open-count index is missing or invalid';
  END IF;
  IF position('CYCLE_COUNT_STOCK_MOVED' IN (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.complete_cycle_count(uuid,uuid,text,bigint)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_POSTFLIGHT: complete_cycle_count lacks the stock-moved refusal';
  END IF;
  IF has_function_privilege('anon', 'public.complete_cycle_count(uuid,uuid,text,bigint)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.complete_cycle_count(uuid,uuid,text,bigint)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.complete_cycle_count(uuid,uuid,text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_POSTFLIGHT: EXECUTE grants on complete_cycle_count moved';
  END IF;
  IF has_function_privilege('anon', 'public.create_cycle_count(text,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.create_cycle_count(text,text,text)', 'EXECUTE')
     OR has_function_privilege('metabase_ro', 'public.create_cycle_count(text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_cycle_count(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_POSTFLIGHT: EXECUTE grants on create_cycle_count are wrong';
  END IF;
  IF has_function_privilege('anon', 'public._freeze_inventory_during_cycle_count_20261102()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._freeze_inventory_during_cycle_count_20261102()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._freeze_inventory_during_cycle_count_20261102()', 'EXECUTE')
     OR has_function_privilege('metabase_ro', 'public._freeze_inventory_during_cycle_count_20261102()', 'EXECUTE') THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_POSTFLIGHT: the freeze trigger function is callable';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public._guard_cycle_count_status_20261102()',
                                        'public._guard_open_cycle_count_items_20261102()']) f,
                           unnest(ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro']) r
              WHERE has_function_privilege(r, f, 'EXECUTE')) THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_POSTFLIGHT: a count-table guard function is callable';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('public.complete_cycle_count(uuid,uuid,text,bigint)'::regprocedure,
                              'public.create_cycle_count(text,text,text)'::regprocedure,
                              'public._freeze_inventory_during_cycle_count_20261102()'::regprocedure,
                              'public._guard_cycle_count_status_20261102()'::regprocedure,
                              'public._guard_open_cycle_count_items_20261102()'::regprocedure)
                AND (pg_get_userbyid(p.proowner) <> 'postgres' OR NOT p.prosecdef
                     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'])) THEN
    RAISE EXCEPTION 'CYCLE_COUNT_FREEZE_POSTFLIGHT: an owner, SECURITY DEFINER or search_path setting is wrong';
  END IF;
END
$postflight$;
