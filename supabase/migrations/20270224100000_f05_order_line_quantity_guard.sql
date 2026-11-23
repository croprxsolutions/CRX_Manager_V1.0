-- F05: an order line can never be scheduled or delivered past what was ordered.
-- Contract: docs/plans/2026-11-22-f05-delivery-remaining-qty-CONTRACT.md.
-- One rule, checked at the three places a line's commitment can grow, after locking the order line:
--     delivered + quantity on open (scheduled / in-progress, not soft-deleted) loads <= ordered
--   * delivery line: inserted, re-linked, or its scheduled quantity raised while its load is open;
--   * delivery header: a load that was not counted (cancelled, voided, completed, soft-deleted) becomes counted again;
--   * order line: inserted, delivered raised (completion marks its own load completed first, so it is not counted twice),
--     or ordered lowered.
-- The triggers only refuse; they never change a record. A write that does not grow the commitment (a reduction,
-- cancel, void) is never checked, so an already-over legacy line can always be brought back within its order.

-- Lock first (Luna r8): no write can slip in between the report scan below and the triggers. In completion's order
-- (header, lines, order lines), so creating the triggers cannot deadlock with a live completion.
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.deliveries, public.delivery_items, public.order_items IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_open_over integer;
  v_ids text;
BEGIN
  IF to_regprocedure('public._order_line_committed(uuid, uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public._order_line_open_loads(uuid, uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public._assert_order_line_fits(uuid, numeric, uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public._delivery_line_within_order()') IS NOT NULL
     OR to_regprocedure('public._delivery_reopen_within_order()') IS NOT NULL
     OR to_regprocedure('public._order_line_within_deliveries()') IS NOT NULL THEN
    RAISE EXCEPTION 'F05_PREFLIGHT: already applied';
  END IF;
  -- Sol r4 / Luna r13: a NaN or infinite counter would switch the check off; refuse until it is fixed by hand.
  SELECT count(*), string_agg(oi.id::text, ', ' ORDER BY oi.id) INTO v_open_over, v_ids
    FROM public.order_items oi
   WHERE NOT (oi.quantity_delivered < 'Infinity'::numeric AND oi.quantity_delivered > '-Infinity'::numeric)
      OR NOT (oi.total_units_needed < 'Infinity'::numeric AND oi.total_units_needed > '-Infinity'::numeric);
  IF v_open_over > 0 THEN
    RAISE EXCEPTION 'F05_PREFLIGHT: % order line(s) have a non-finite (NaN or infinite) ordered or delivered quantity: %. Fix them by hand first.', v_open_over, v_ids;
  END IF;
  IF to_regprocedure('public._delivery_line_matches_order_line()') IS NULL THEN
    RAISE EXCEPTION 'F05_PREFLIGHT: #1940 (_delivery_line_matches_order_line) must land first';
  END IF;
  -- Report (not block): open loads on lines already over their order. Each will be refused at completion until the
  -- office cancels the extra load. Listed by order line id for the F05b cleanup.
  SELECT count(*), string_agg(oi.id::text, ', ' ORDER BY oi.id) INTO v_open_over, v_ids
    FROM public.order_items oi
   WHERE oi.quantity_delivered + (SELECT COALESCE(sum(di.quantity), 0) FROM public.delivery_items di
                                    JOIN public.deliveries d ON d.id = di.delivery_id
                                   WHERE di.order_item_id = oi.id AND d.status IN ('scheduled', 'in_progress') AND d.deleted_at IS NULL)
         > oi.total_units_needed
     AND EXISTS (SELECT 1 FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id
                  WHERE di.order_item_id = oi.id AND d.status IN ('scheduled', 'in_progress') AND d.deleted_at IS NULL);
  RAISE NOTICE 'F05_PREFLIGHT: % order line(s) have open loads beyond what was ordered: %', v_open_over, COALESCE(v_ids, 'none');
  -- Block (Sol r3; Mason 2026-11-22 "drop it": fixed by hand before the apply): an over line whose order has an active
  -- return. Cancelling a load there is refused (DELIVERY_HAS_RECEIVED_RETURN), so the guard would leave it stuck.
  SELECT count(*), string_agg(oi.id::text, ', ' ORDER BY oi.id) INTO v_open_over, v_ids
    FROM public.order_items oi
   WHERE oi.quantity_delivered + (SELECT COALESCE(sum(di.quantity), 0) FROM public.delivery_items di
                                    JOIN public.deliveries d ON d.id = di.delivery_id
                                   WHERE di.order_item_id = oi.id AND d.status IN ('scheduled', 'in_progress') AND d.deleted_at IS NULL)
         > oi.total_units_needed
     AND EXISTS (SELECT 1 FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id
                  WHERE di.order_item_id = oi.id AND d.status IN ('scheduled', 'in_progress') AND d.deleted_at IS NULL)
     AND EXISTS (SELECT 1 FROM public.returns r
                  WHERE r.order_id = oi.order_id AND r.deleted_at IS NULL
                    AND r.status IN ('requested', 'approved', 'received', 'credited'));
  IF v_open_over > 0 THEN
    RAISE EXCEPTION 'F05_PREFLIGHT: % order line(s) have open loads beyond what was ordered and a return on the order, so the extra load cannot be cancelled: %. Fix them by hand first (F05b).', v_open_over, v_ids;
  END IF;
  -- Lines already delivered past their order (staging ORD-2026-0017): left as they are, listed for office cleanup (F05b).
  SELECT count(*), string_agg(oi.id::text, ', ' ORDER BY oi.id) INTO v_open_over, v_ids
    FROM public.order_items oi WHERE oi.quantity_delivered > oi.total_units_needed;
  RAISE NOTICE 'F05_PREFLIGHT: % order line(s) are already delivered beyond what was ordered: %', v_open_over, COALESCE(v_ids, 'none');
END
$preflight$;

-- What one order line has delivered plus on open loads, leaving out one delivery line and/or one whole delivery.
-- VOLATILE: called right after the order line lock, it must read what a session it waited for just committed.
CREATE FUNCTION public._order_line_committed(p_order_item_id uuid, p_exclude_delivery_item_id uuid, p_exclude_delivery_id uuid)
 RETURNS numeric
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(sum(di.quantity), 0)
    FROM public.delivery_items di
    JOIN public.deliveries d ON d.id = di.delivery_id
   WHERE di.order_item_id = p_order_item_id
     AND d.status IN ('scheduled', 'in_progress') AND d.deleted_at IS NULL
     AND di.id IS DISTINCT FROM p_exclude_delivery_item_id
     AND d.id IS DISTINCT FROM p_exclude_delivery_id;
$function$;
REVOKE ALL ON FUNCTION public._order_line_committed(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Open delivery numbers holding this order line (same exclusions), for the refusal message.
CREATE FUNCTION public._order_line_open_loads(p_order_item_id uuid, p_exclude_delivery_item_id uuid, p_exclude_delivery_id uuid)
 RETURNS text
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(string_agg(DISTINCT d.delivery_number, ', '), 'none')
    FROM public.delivery_items di
    JOIN public.deliveries d ON d.id = di.delivery_id
   WHERE di.order_item_id = p_order_item_id
     AND d.status IN ('scheduled', 'in_progress') AND d.deleted_at IS NULL
     AND di.id IS DISTINCT FROM p_exclude_delivery_item_id
     AND d.id IS DISTINCT FROM p_exclude_delivery_id;
$function$;
REVOKE ALL ON FUNCTION public._order_line_open_loads(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Locks the order line, then refuses if adding p_adding to it would pass what was ordered.
CREATE FUNCTION public._assert_order_line_fits(p_order_item_id uuid, p_adding numeric, p_exclude_delivery_item_id uuid, p_exclude_delivery_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_oi record;
  v_open numeric;
BEGIN
  -- The check after the lock needs a fresh snapshot, which only READ COMMITTED (every app path) gives (Luna r5, Sol r1).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ORDER_LINE_CHECK_ISOLATION: delivery and order quantities can only change in a read-committed transaction.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Serializes every scheduler, reopen, order edit and completion on this order line.
  SELECT oi.total_units_needed, oi.quantity_delivered, oi.product_name INTO v_oi
    FROM public.order_items oi WHERE oi.id = p_order_item_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN; -- _delivery_line_matches_order_line refuses a line that is not on the order.
  END IF;
  v_open := public._order_line_committed(p_order_item_id, p_exclude_delivery_item_id, p_exclude_delivery_id);
  IF COALESCE(v_oi.quantity_delivered, 0) + v_open + COALESCE(p_adding, 0) > COALESCE(v_oi.total_units_needed, 0) THEN
    RAISE EXCEPTION 'DELIVERY_OVER_ORDER: % — only % left to schedule (ordered %, delivered %, on other open deliveries %: %). Cancel another delivery for this order, or reduce one that has not started, first.',
      COALESCE(v_oi.product_name, 'this order line'),
      GREATEST(COALESCE(v_oi.total_units_needed, 0) - COALESCE(v_oi.quantity_delivered, 0) - v_open, 0),
      v_oi.total_units_needed, COALESCE(v_oi.quantity_delivered, 0), v_open,
      public._order_line_open_loads(p_order_item_id, p_exclude_delivery_item_id, p_exclude_delivery_id)
      USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public._assert_order_line_fits(uuid, numeric, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 1. Delivery line: new, re-linked or raised while its load is open.
CREATE FUNCTION public._delivery_line_within_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_counted boolean;
BEGIN
  IF NEW.order_item_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id
     AND NEW.delivery_id IS NOT DISTINCT FROM OLD.delivery_id
     AND COALESCE(NEW.quantity, 0) <= COALESCE(OLD.quantity, 0) THEN
    RETURN NEW;
  END IF;
  -- FOR SHARE: the load cannot change status until this line commits.
  SELECT d.status IN ('scheduled', 'in_progress') AND d.deleted_at IS NULL INTO v_counted
    FROM public.deliveries d WHERE d.id = NEW.delivery_id FOR SHARE;
  IF v_counted THEN
    PERFORM public._assert_order_line_fits(NEW.order_item_id, NEW.quantity, NEW.id, NULL);
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public._delivery_line_within_order() FROM PUBLIC, anon, authenticated, service_role;

-- "zz_" runs after the existing a1_/a2_ line checks, so a wrong product or unit is refused with its own message first.
CREATE TRIGGER zz_delivery_line_within_order
  BEFORE INSERT OR UPDATE OF quantity, order_item_id, delivery_id ON public.delivery_items
  FOR EACH ROW EXECUTE FUNCTION public._delivery_line_within_order();

-- 2. Delivery header: a load that was not counted becomes counted again (restore_cancelled_delivery, an un-delete,
--    and any later path).
CREATE FUNCTION public._delivery_reopen_within_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_line record;
BEGIN
  IF NEW.status IN ('scheduled', 'in_progress') AND NEW.deleted_at IS NULL
     AND NOT (OLD.status IN ('scheduled', 'in_progress') AND OLD.deleted_at IS NULL) THEN
    -- Order lines in id order, as the order edit locks them.
    FOR v_line IN
      SELECT di.order_item_id, sum(di.quantity) AS qty
        FROM public.delivery_items di
       WHERE di.delivery_id = NEW.id AND di.order_item_id IS NOT NULL
       GROUP BY di.order_item_id
       ORDER BY di.order_item_id
    LOOP
      PERFORM public._assert_order_line_fits(v_line.order_item_id, v_line.qty, NULL, NEW.id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public._delivery_reopen_within_order() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER zz_delivery_reopen_within_order
  BEFORE UPDATE OF status, deleted_at ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public._delivery_reopen_within_order();

-- 3. Order line: inserted, delivered raised, or ordered lowered. The row is already locked by this write.
CREATE FUNCTION public._order_line_within_deliveries()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_open numeric;
  v_more_delivered boolean;
BEGIN
  -- Luna r12/r13: NaN and infinities would switch the check off for this line (NaN also fails "< Infinity").
  IF NOT (NEW.total_units_needed < 'Infinity'::numeric AND NEW.total_units_needed > '-Infinity'::numeric)
     OR NOT (NEW.quantity_delivered < 'Infinity'::numeric AND NEW.quantity_delivered > '-Infinity'::numeric) THEN
    RAISE EXCEPTION 'ORDER_LINE_QUANTITY_NOT_FINITE: % — ordered and delivered quantities must be finite numbers.',
      COALESCE(NEW.product_name, 'this order line') USING ERRCODE = 'check_violation';
  END IF;
  v_more_delivered := TG_OP = 'INSERT' OR COALESCE(NEW.quantity_delivered, 0) > COALESCE(OLD.quantity_delivered, 0);
  IF NOT v_more_delivered
     AND NOT (COALESCE(NEW.total_units_needed, 0) < COALESCE(OLD.total_units_needed, 0)) THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ORDER_LINE_CHECK_ISOLATION: delivery and order quantities can only change in a read-committed transaction.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_open := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE public._order_line_committed(NEW.id, NULL, NULL) END;
  IF COALESCE(NEW.quantity_delivered, 0) + v_open <= COALESCE(NEW.total_units_needed, 0) THEN
    RETURN NEW;
  END IF;
  IF v_more_delivered THEN
    -- Drivers see this: no other load's number or quantity (they may not be allowed to read that load).
    -- No order-wide numbers either (Sol r3): a driver may see only their own load.
    -- Always "call the office" (Luna r10): never suggest recording less than was actually delivered.
    RAISE EXCEPTION 'DELIVERY_EXCEEDS_ORDER: % — this would deliver more than was ordered. Call the office before completing this delivery.',
      COALESCE(NEW.product_name, 'this order line')
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'ORDER_LINE_BELOW_DELIVERIES: % cannot go below % (delivered %, on open deliveries %: %). %',
    COALESCE(NEW.product_name, 'this order line'), COALESCE(NEW.quantity_delivered, 0) + v_open,
    COALESCE(NEW.quantity_delivered, 0), v_open, public._order_line_open_loads(NEW.id, NULL, NULL),
    CASE WHEN v_open > 0 THEN 'Cancel those deliveries, or reduce ones that have not started, first.'
         ELSE 'That much has already been delivered.' END
    USING ERRCODE = 'check_violation';
END;
$function$;
REVOKE ALL ON FUNCTION public._order_line_within_deliveries() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER zz_order_line_within_deliveries
  BEFORE INSERT OR UPDATE OF quantity_delivered, total_units_needed ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._order_line_within_deliveries();

-- Postflight (Taha's review): pin the state this migration claims on the day of the apply.
DO $postflight$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(t.name, ', ') INTO v_bad
    FROM (VALUES ('deliveries', 'zz_delivery_reopen_within_order'),
                 ('delivery_items', 'zz_delivery_line_within_order'),
                 ('order_items', 'zz_order_line_within_deliveries')) AS t(tbl, name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = ('public.' || t.tbl)::regclass AND g.tgname = t.name
                        AND g.tgenabled = 'O' AND NOT g.tgisinternal);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'F05_POSTFLIGHT: trigger(s) missing or not enabled: %', v_bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_order_line_committed', '_order_line_open_loads', '_assert_order_line_fits',
                       '_delivery_line_within_order', '_delivery_reopen_within_order', '_order_line_within_deliveries')
     AND (NOT p.prosecdef
          OR p.proowner <> 'postgres'::regrole
          OR NOT COALESCE(p.proconfig, '{}'::text[]) @> ARRAY['search_path=public, pg_temp']
          OR has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR has_function_privilege('service_role', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'F05_POSTFLIGHT: function(s) not definer-owned-locked as expected: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('_order_line_committed', '_order_line_open_loads', '_assert_order_line_fits',
                          '_delivery_line_within_order', '_delivery_reopen_within_order', '_order_line_within_deliveries')) <> 6 THEN
    RAISE EXCEPTION 'F05_POSTFLIGHT: expected exactly six F05 functions';
  END IF;
END
$postflight$;
