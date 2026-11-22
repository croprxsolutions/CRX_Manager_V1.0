-- F05: an order line can never be scheduled or delivered past what was ordered.
-- Contract: docs/plans/2026-11-22-f05-delivery-remaining-qty-CONTRACT.md.
-- One rule, checked at the three places a line's commitment can grow, after locking the order line:
--     delivered + quantity on open (scheduled / in-progress) loads <= ordered
--   * delivery line: inserted, re-linked, or its scheduled quantity raised while its load is open;
--   * delivery header: a load that was not open (cancelled, voided, completed) becomes open again;
--   * order line: inserted, delivered raised (completion marks its own load completed first, so it is not counted twice),
--     or ordered lowered.
-- The triggers only refuse; they never change a record. A write that does not grow the commitment (a reduction,
-- cancel, void) is never checked, so an already-over legacy line can always be brought back within its order.

SET LOCAL lock_timeout = '5s';
-- In completion's order (header, lines, order lines), so the trigger creation cannot deadlock with a live completion.
LOCK TABLE public.deliveries, public.delivery_items, public.order_items IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_open_over integer;
BEGIN
  IF to_regprocedure('public._order_line_committed(uuid, uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public._order_line_open_loads(uuid, uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public._assert_order_line_fits(uuid, numeric, uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public._delivery_line_within_order()') IS NOT NULL
     OR to_regprocedure('public._delivery_reopen_within_order()') IS NOT NULL
     OR to_regprocedure('public._order_line_within_deliveries()') IS NOT NULL THEN
    RAISE EXCEPTION 'F05_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._delivery_line_matches_order_line()') IS NULL THEN
    RAISE EXCEPTION 'F05_PREFLIGHT: #1940 (_delivery_line_matches_order_line) must land first';
  END IF;
  -- Report (not block): open loads on lines already over their order. Each will be refused at completion until the
  -- office cancels the extra load. Only a count here; the apply step lists the lines read-only before applying.
  SELECT count(*) INTO v_open_over
    FROM public.order_items oi
   WHERE oi.quantity_delivered + (SELECT COALESCE(sum(di.quantity), 0) FROM public.delivery_items di
                                    JOIN public.deliveries d ON d.id = di.delivery_id
                                   WHERE di.order_item_id = oi.id AND d.status IN ('scheduled', 'in_progress'))
         > oi.total_units_needed
     AND EXISTS (SELECT 1 FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id
                  WHERE di.order_item_id = oi.id AND d.status IN ('scheduled', 'in_progress'));
  RAISE NOTICE 'F05_PREFLIGHT: % order line(s) have open loads beyond what was ordered', v_open_over;
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
     AND d.status IN ('scheduled', 'in_progress')
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
     AND d.status IN ('scheduled', 'in_progress')
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
  -- Serializes every scheduler, reopen, order edit and completion on this order line.
  SELECT oi.total_units_needed, oi.quantity_delivered, oi.product_name INTO v_oi
    FROM public.order_items oi WHERE oi.id = p_order_item_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN; -- _delivery_line_matches_order_line refuses a line that is not on the order.
  END IF;
  v_open := public._order_line_committed(p_order_item_id, p_exclude_delivery_item_id, p_exclude_delivery_id);
  IF COALESCE(v_oi.quantity_delivered, 0) + v_open + COALESCE(p_adding, 0) > COALESCE(v_oi.total_units_needed, 0) THEN
    RAISE EXCEPTION 'DELIVERY_OVER_ORDER: % — only % left to schedule (ordered %, delivered %, on other open deliveries %: %). Cancel or reduce another delivery for this order first.',
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
  v_status text;
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
  SELECT d.status INTO v_status FROM public.deliveries d WHERE d.id = NEW.delivery_id FOR SHARE;
  IF v_status IN ('scheduled', 'in_progress') THEN
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

-- 2. Delivery header: a load that was not open becomes open again (restore_cancelled_delivery and any later path).
CREATE FUNCTION public._delivery_reopen_within_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_line record;
BEGIN
  IF NEW.status IN ('scheduled', 'in_progress')
     AND OLD.status IS DISTINCT FROM 'scheduled' AND OLD.status IS DISTINCT FROM 'in_progress' THEN
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
  BEFORE UPDATE OF status ON public.deliveries
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
  v_more_delivered := TG_OP = 'INSERT' OR COALESCE(NEW.quantity_delivered, 0) > COALESCE(OLD.quantity_delivered, 0);
  IF NOT v_more_delivered
     AND NOT (COALESCE(NEW.total_units_needed, 0) < COALESCE(OLD.total_units_needed, 0)) THEN
    RETURN NEW;
  END IF;
  v_open := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE public._order_line_committed(NEW.id, NULL, NULL) END;
  IF COALESCE(NEW.quantity_delivered, 0) + v_open <= COALESCE(NEW.total_units_needed, 0) THEN
    RETURN NEW;
  END IF;
  IF v_more_delivered THEN
    RAISE EXCEPTION 'DELIVERY_EXCEEDS_ORDER: % — this would bring the line to % delivered with % more on open deliveries (%), but only % was ordered. Ask the office to cancel the extra delivery, then complete this one.',
      COALESCE(NEW.product_name, 'this order line'), NEW.quantity_delivered, v_open,
      public._order_line_open_loads(NEW.id, NULL, NULL), NEW.total_units_needed
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'ORDER_LINE_BELOW_DELIVERIES: % cannot go below % (delivered %, on open deliveries %: %). Cancel or reduce those deliveries first.',
    COALESCE(NEW.product_name, 'this order line'), COALESCE(NEW.quantity_delivered, 0) + v_open,
    COALESCE(NEW.quantity_delivered, 0), v_open, public._order_line_open_loads(NEW.id, NULL, NULL)
    USING ERRCODE = 'check_violation';
END;
$function$;
REVOKE ALL ON FUNCTION public._order_line_within_deliveries() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER zz_order_line_within_deliveries
  BEFORE INSERT OR UPDATE OF quantity_delivered, total_units_needed ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._order_line_within_deliveries();
