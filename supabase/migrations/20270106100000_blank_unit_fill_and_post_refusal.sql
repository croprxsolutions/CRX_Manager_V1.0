-- KI-76: an order-level invoice refuses an order line with no unit instead of billing it blank.
--
-- create_invoice_from_order (body: _create_invoice_from_order_impl_20260718) copied
-- order_items.unit_size onto the invoice line as is, so an order line with no unit was billed with no
-- unit. Every return function matches the return to the invoice line by coalesce(order_items.unit_size,
-- 'ea'), so that line could never be credited (RETURN_CREDIT_UNIT_MISMATCH). Writing 'ea' would make
-- the return match but would be a guess: every live order line with no unit (2026-11-10) is a product
-- sold by the gallon. So the invoice is now refused, before anything is written, naming the lines that
-- need a unit (ORDER_LINE_UNIT_MISSING). An order line with a unit is copied unchanged, as before.
--
-- The body is otherwise live's (md5 454e04c4..., 20260827041400). SECURITY DEFINER, search_path, owner
-- and grants are unchanged.
--
-- Delivery side (below): a new order line takes the product unit; an invoice line takes its order line
-- unit, else the product unit, when written; neither ever stops a delivery from completing. Posting
-- refuses a sale line that still has no unit (INVOICE_LINE_UNIT_MISSING). A quick-delivery line always
-- records its product's unit. Existing rows are not changed.

DO $preflight$
DECLARE
  v_fn regprocedure := to_regprocedure('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)');
BEGIN
  IF v_fn IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = '_create_invoice_from_order_impl_20260718') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_INVOICE_UNIT_OVERLOAD_DRIFT';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid = v_fn
          AND p.prosecdef
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
          AND pg_get_userbyid(p.proowner) = 'postgres'
          AND md5(replace(p.prosrc, chr(13), '')) = '454e04c4e199549a4f5be9975e397e17') THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_INVOICE_UNIT_DRIFT: _create_invoice_from_order_impl_20260718 is not the reviewed live body';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._create_invoice_from_order_impl_20260718(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_order          record;
  v_invoice_id     uuid;
  v_item           record;
  v_total_cents    bigint := 0;
  v_cost_cents     bigint := 0;
  v_existing       jsonb;
  v_existing_count int;
  v_delivery_count int;
  -- CURRENT_DATE follows the UTC database date, so during the Chicago evening
  -- window this path stamped tomorrow's invoice_date and derived the wrong
  -- season, which moves due dates, aging, overdue classification, and period
  -- boundaries. Resolve one explicit business date and use it for both.
  v_business_date  date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_from_order');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  -- Codex P1: lock the order row FOR UPDATE before the existence checks below.
  -- create_delivery_with_items locks the order while it inserts a delivery; without
  -- this lock the invoice txn could read zero deliveries while a concurrent
  -- scheduled-delivery insert is still uncommitted, then create the order-level
  -- invoice anyway — recreating the exact double-billing this guard prevents.
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;

  SELECT COUNT(*) INTO v_existing_count
    FROM invoices
   WHERE order_id = p_order_id
     AND status NOT IN ('voided', 'cancelled')
     AND invoice_type <> 'credit_memo'
     AND deleted_at IS NULL;
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Active invoice already exists for order % (% existing invoice(s)). Void or cancel the existing invoice first if you need to recreate.', v_order.order_number, v_existing_count;
  END IF;

  -- W5 (sell-side #4): the order is being fulfilled via deliveries, which each
  -- produce their own invoice on completion — a manual order-level invoice here
  -- would double-represent the order. The check above only catches deliveries
  -- that ALREADY produced an invoice; a still scheduled/in_progress delivery has
  -- none yet, so this closes that gap.
  SELECT COUNT(*) INTO v_delivery_count
    FROM deliveries
   WHERE order_id = p_order_id
     AND status NOT IN ('cancelled', 'voided');
  IF v_delivery_count > 0 THEN
    RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.', v_order.order_number, v_delivery_count;
  END IF;

  -- KI-76: every line needs a unit before it is billed. A return is matched to its invoice line by the
  -- order line's unit, so a line billed with no unit could never be credited. Refuse rather than guess.
  IF EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = p_order_id AND COALESCE(btrim(oi.unit_size, E' \t\r\n' || chr(160)), '') = '') THEN
    RAISE EXCEPTION 'ORDER_LINE_UNIT_MISSING: order % has a line with no unit (%). Set each line''s unit on the order, then create the invoice again',
      v_order.order_number,
      (SELECT string_agg(COALESCE(NULLIF(btrim(oi.product_name), ''), 'unnamed product'), ', ' ORDER BY oi.sort_order NULLS LAST, oi.id)
         FROM order_items oi WHERE oi.order_id = p_order_id AND COALESCE(btrim(oi.unit_size, E' \t\r\n' || chr(160)), '') = '')
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO invoices (
    order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, invoice_date
  ) VALUES (
    p_order_id, v_order.customer_id, p_invoice_type, 'draft',
    COALESCE(v_order.season, compute_season(v_business_date)),
    COALESCE(p_salesman_id, v_order.salesman_id),
    v_actor, 0, v_business_date
  )
  RETURNING id INTO v_invoice_id;

  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size
    ) VALUES (
      v_invoice_id, v_item.id, v_item.product_id,
      COALESCE(v_item.product_name, ''),
      v_item.total_units_needed,
      round(v_item.price_per_unit * 100)::bigint,
      round(v_item.total_price * 100)::bigint,
      round(v_item.cost_per_unit * 100)::bigint,
      COALESCE(v_item.sort_order, 0),
      v_item.actual_rate,
      v_item.acres,
      v_item.unit_size
    );
    v_total_cents := v_total_cents + round(v_item.total_price * 100)::bigint;
    v_cost_cents := v_cost_cents + round(COALESCE(v_item.cost_per_unit, 0) * v_item.total_units_needed * 100)::bigint;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_cost_cents WHERE id = v_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
      'order_number', v_order.order_number,
      'customer_id', v_order.customer_id,
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Invoice created from order ' || v_order.order_number
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
    'Invoice created from order ' || v_order.order_number,
    v_actor, 'invoice', v_invoice_id, v_order.customer_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_from_order', jsonb_build_object('invoice_id', v_invoice_id));
  END IF;

  RETURN v_invoice_id;
END;
$function$;

-- KI-76, delivery side. Completing a delivery (and the unbilled-delivery invoice) copies the delivery
-- line's unit onto the draft invoice line. Every return reads the ORDER line's unit, so the order line is
-- its first source; a new order line takes the product unit, and an invoice line falls back to the product
-- unit. The fills never refuse, so a blank unit never stops a driver from completing a delivery;
-- the refusal comes at posting, where staff can set the product unit and save the draft. A unit is blank when it is
-- NULL or only spaces, tabs, line breaks or non-breaking spaces.

-- A new order line (or one whose product changes) with no unit takes the product's unit.
-- Delivery lines take their unit from the order line (NewDelivery, DeliveryDetail) or, for a quick
-- delivery, from the product (locked below; it also inserts its order line with no unit), so they agree with this
-- fill. Live 2026-11-10: 0 of 406 delivery lines have a unit their order line lacks or differs from.
CREATE FUNCTION public._fill_order_line_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF COALESCE(btrim(NEW.unit_size, E' \t\r\n' || chr(160)), '') = '' AND NEW.product_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    NEW.unit_size := COALESCE((SELECT p.unit_size FROM public.products p
                                WHERE p.id = NEW.product_id
                                  AND COALESCE(btrim(p.unit_size, E' \t\r\n' || chr(160)), '') <> ''),
                              NEW.unit_size);
  END IF;
  RETURN NEW;
END;
$function$;

-- A sale line (a product line) written with no unit takes its order line's unit (the unit its returns are
-- matched on), else the product's: the order line's product, or the line's own when it has no order line.
-- The product fallback bills the right unit, but a return on a line whose order line is blank still reads
-- that order line and stays refused, as it is today; an order line cannot be edited once delivered, so this
-- is the fix staff can reach (set the product unit, save the draft). Return-credit lines are left alone:
-- their unit must equal the line they credit. Runs before every other BEFORE trigger on invoice_items
-- (a0_ sorts first), so their checks see the final unit.
CREATE FUNCTION public._fill_invoice_line_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF COALESCE(btrim(NEW.unit_size, E' \t\r\n' || chr(160)), '') = '' AND (NEW.order_item_id IS NOT NULL OR NEW.product_id IS NOT NULL)
     AND NEW.return_credit_source_item_id IS NULL AND COALESCE(NEW.quantity, 0) >= 0
     -- A line with no order line is filled only on a chemical sale (field-application lines bill differently).
     AND (NEW.order_item_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = NEW.invoice_id AND i.invoice_type = 'chemical_sale')) THEN
    NEW.unit_size := COALESCE(
      (SELECT oi.unit_size FROM public.order_items oi
        WHERE oi.id = NEW.order_item_id AND COALESCE(btrim(oi.unit_size, E' \t\r\n' || chr(160)), '') <> ''),
      (SELECT p.unit_size FROM public.products p
        WHERE p.id = COALESCE((SELECT oi.product_id FROM public.order_items oi WHERE oi.id = NEW.order_item_id), NEW.product_id)
          AND COALESCE(btrim(p.unit_size, E' \t\r\n' || chr(160)), '') <> ''),
      NEW.unit_size);
  END IF;
  RETURN NEW;
END;
$function$;

-- Posting a chemical-sale invoice refuses any sale line (a product line, with or without an order line)
-- that still has no unit (Mason, 2026-11-10: no sale line posts without a unit). Field-application and
-- misc-charge invoices bill differently and are not checked. Runs last (zz_) on any update into a
-- financial status, so a status set by an earlier trigger is still checked.
CREATE FUNCTION public._refuse_post_blank_unit_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_lines text;
BEGIN
  SELECT string_agg(COALESCE(NULLIF(btrim(ii.description), ''), 'unnamed line'), ', ' ORDER BY ii.sort_order NULLS LAST, ii.id)
    INTO v_lines
    FROM public.invoice_items ii
   WHERE ii.invoice_id = NEW.id AND (ii.order_item_id IS NOT NULL OR ii.product_id IS NOT NULL)
     AND ii.quantity > 0 AND ii.return_credit_source_item_id IS NULL
     AND COALESCE(btrim(ii.unit_size, E' \t\r\n' || chr(160)), '') = '';
  IF v_lines IS NOT NULL THEN
    RAISE EXCEPTION 'INVOICE_LINE_UNIT_MISSING: invoice % has a line with no unit (%). Set the unit on the product, save the draft invoice, then post it again',
      NEW.invoice_number, v_lines
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

-- A quick-delivery line always records its product's own unit, whatever unit the request named (Mason,
-- 2026-11-10). The app's quick-delivery screen sends the product's unit, so nothing it does changes; a request
-- built outside the app can no longer record a delivery in one unit (e.g. case) while the order and invoice
-- lines carry the product's (e.g. Gal) and are credited in it. It also runs when a line's unit or product is
-- edited directly (an admin may update delivery lines through the API; the app never edits these columns): an edit that
-- keeps the product keeps the unit the line was recorded in, so it still matches the order and invoice lines even if
-- the product's unit changed since; an edit that changes the product takes the new product's unit. Never refuses:
-- a driver is never stopped.
-- Live 2026-11-10: 0 quick-delivery lines.
CREATE FUNCTION public._lock_quick_delivery_line_unit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.product_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.deliveries d WHERE d.id = NEW.delivery_id AND d.is_quick_delivery) THEN
    IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN
      NEW.unit_size := OLD.unit_size;
    ELSE
      NEW.unit_size := (SELECT p.unit_size FROM public.products p WHERE p.id = NEW.product_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._fill_order_line_unit() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fill_invoice_line_unit() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._refuse_post_blank_unit_line() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._lock_quick_delivery_line_unit() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_fill_order_line_unit
  BEFORE INSERT OR UPDATE OF product_id ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._fill_order_line_unit();

CREATE TRIGGER a0_fill_invoice_line_unit
  BEFORE INSERT OR UPDATE OF unit_size, order_item_id, product_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._fill_invoice_line_unit();

CREATE TRIGGER a0_lock_quick_delivery_line_unit
  BEFORE INSERT OR UPDATE OF unit_size, product_id ON public.delivery_items
  FOR EACH ROW EXECUTE FUNCTION public._lock_quick_delivery_line_unit();

CREATE TRIGGER zz_refuse_post_blank_unit_line
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  WHEN (NEW.status IN ('posted', 'paid', 'overdue') AND OLD.status NOT IN ('posted', 'paid', 'overdue')
        AND NEW.invoice_type = 'chemical_sale')
  EXECUTE FUNCTION public._refuse_post_blank_unit_line();

-- Saving a draft (save_invoice -> _save_invoice_scoped_impl) deletes its lines, writes them again, then
-- restores each order-linked line's lineage, matching it by sort order, product and unit. A line saved with
-- no unit is now filled when written again, so the unit match failed (GENERATED_INVOICE_LINEAGE_RESTORE_FAILED)
-- and the draft could not be saved: the fix this change names for a blank line (set the product unit, save the
-- draft) was refused. Only that match changes: a blank saved unit accepts the filled one. The body is otherwise
-- live's (md5 12272e4b..., 20261118110000); settings, owner and grants are unchanged.
DO $save_preflight$
DECLARE
  v_fn regprocedure := to_regprocedure('public._save_invoice_scoped_impl(jsonb,jsonb,text)');
BEGIN
  IF v_fn IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = '_save_invoice_scoped_impl') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn AND p.prosecdef
                      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                      AND pg_get_userbyid(p.proowner) = 'postgres'
                      AND md5(replace(p.prosrc, chr(13), '')) = '12272e4be85f18a7772d20a59d1ddf88') THEN
    RAISE EXCEPTION 'PREFLIGHT_SAVE_INVOICE_UNIT_DRIFT: _save_invoice_scoped_impl is not the reviewed live body';
  END IF;
END;
$save_preflight$;

CREATE OR REPLACE FUNCTION public._save_invoice_scoped_impl(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice_id uuid := NULLIF(p_invoice->>'id', '')::uuid;
  v_invoice_status text;
  v_cached jsonb;
  v_forward_items jsonb := '[]'::jsonb;
  v_lineage jsonb := '[]'::jsonb;
  v_result uuid;
  v_restored integer := 0;
  -- S16b (20261106130000): a field-application invoice re-splits its own total across growers.
  v_keeps_line_cents boolean;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_cached IS NOT NULL THEN
      RETURN (v_cached->>'invoice_id')::uuid;
    END IF;
  END IF;

  IF jsonb_typeof(COALESCE(p_items, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'INVOICE_ITEMS_MUST_BE_ARRAY';
  END IF;

  SELECT COALESCE(
           jsonb_agg(incoming.item || jsonb_build_object('sort_order', incoming.ordinality - 1)
                     ORDER BY incoming.ordinality),
           '[]'::jsonb
         )
    INTO v_forward_items
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS incoming(item, ordinality);

  IF v_invoice_id IS NOT NULL THEN
    SELECT i.status
      INTO v_invoice_status
    FROM public.invoices i
    WHERE i.id = v_invoice_id
    FOR UPDATE;
  END IF;

  IF v_invoice_status IN ('draft', 'unposted') THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_forward_items) AS incoming(item)
      WHERE NULLIF(incoming.item->>'id', '') IS NOT NULL
      GROUP BY incoming.item->>'id'
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINE_ID_DUPLICATE';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_forward_items) AS incoming(item)
      WHERE NULLIF(incoming.item->>'id', '') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.invoice_items ii
          WHERE ii.id = (incoming.item->>'id')::uuid
            AND ii.invoice_id = v_invoice_id
        )
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINE_ID_INVALID';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.invoice_items ii
      WHERE ii.invoice_id = v_invoice_id
        AND ii.order_item_id IS NOT NULL
        AND ii.quantity > 0
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_forward_items) AS incoming(item)
          WHERE incoming.item->>'id' = ii.id::text
        )
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINEAGE_LINE_REQUIRED: void and reissue instead of deleting an order-linked line';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.invoice_items ii
      JOIN jsonb_array_elements(v_forward_items) AS incoming(item)
        ON incoming.item->>'id' = ii.id::text
      WHERE ii.invoice_id = v_invoice_id
        AND ii.order_item_id IS NOT NULL
        AND ii.quantity > 0
        AND (
          (incoming.item->>'product_id')::uuid IS DISTINCT FROM ii.product_id
          OR incoming.item->>'unit_size' IS DISTINCT FROM ii.unit_size
          OR (incoming.item->>'order_item_id')::uuid IS DISTINCT FROM ii.order_item_id
        )
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINEAGE_IDENTITY_IMMUTABLE: void and reissue to change product, unit, or order line';
    END IF;

    SELECT COALESCE(
             jsonb_agg(jsonb_build_object(
               'sort_order', incoming.ordinality - 1,
               'source_item_id', ii.id,
               'order_item_id', ii.order_item_id,
               'product_id', ii.product_id,
               'unit_size', ii.unit_size,
               'cost_cents', ii.cost_cents,
               'quantity', ii.quantity,
               'unit_price_cents', ii.unit_price_cents,
               'extended_cents', ii.extended_cents,
               'created_at', ii.created_at,
               'tote_number', ii.tote_number,
               -- Billing plan M3: a vendor the save sends changes the line; otherwise the line keeps its own.
               'vendor', COALESCE(NULLIF(btrim(incoming.item->>'vendor'), ''), ii.vendor),
               'warehouse', ii.warehouse
             ) ORDER BY incoming.ordinality),
             '[]'::jsonb
           )
      INTO v_lineage
    FROM jsonb_array_elements(v_forward_items) WITH ORDINALITY AS incoming(item, ordinality)
    JOIN public.invoice_items ii
      ON ii.id = NULLIF(incoming.item->>'id', '')::uuid
     AND ii.invoice_id = v_invoice_id
     AND ii.order_item_id IS NOT NULL
     AND ii.quantity > 0;
  END IF;

  v_result := public._save_invoice_lineage_unaware_impl_20260827(
    p_invoice,
    v_forward_items,
    p_idempotency_key
  );

  SELECT i.invoice_type IS DISTINCT FROM 'field_application'
    INTO v_keeps_line_cents
    FROM public.invoices i
   WHERE i.id = v_result;

  IF jsonb_array_length(v_lineage) > 0 THEN
    WITH preserved AS (
      SELECT
        (entry->>'sort_order')::integer AS sort_order,
        (entry->>'source_item_id')::uuid AS source_item_id,
        (entry->>'order_item_id')::uuid AS order_item_id,
        (entry->>'product_id')::uuid AS product_id,
        entry->>'unit_size' AS unit_size,
        (entry->>'cost_cents')::bigint AS cost_cents,
        (entry->>'quantity')::numeric AS quantity,
        (entry->>'unit_price_cents')::bigint AS unit_price_cents,
        (entry->>'extended_cents')::bigint AS extended_cents,
        (entry->>'created_at')::timestamptz AS created_at,
        entry->>'tote_number' AS tote_number,
        entry->>'vendor' AS vendor,
        entry->>'warehouse' AS warehouse
      FROM jsonb_array_elements(v_lineage) AS saved(entry)
    )
    UPDATE public.invoice_items ii
       SET id = preserved.source_item_id,
           order_item_id = preserved.order_item_id,
           cost_cents = preserved.cost_cents,
           -- S16b: an order line delivered in parts carries its cents through each part (the last part
           -- takes the remainder, 20260817120000). A line saved back with the same quantity and unit
           -- price keeps the total it was given, instead of re-rounding quantity x price, which turned
           -- $13.32 into $13.33 and billed a $26.65 line $26.66 when only a note was edited.
           extended_cents = CASE
             WHEN v_keeps_line_cents
              AND ii.quantity = preserved.quantity
              AND ii.unit_price_cents = preserved.unit_price_cents
             THEN preserved.extended_cents
             ELSE ii.extended_cents
           END,
           created_at = preserved.created_at,
           tote_number = preserved.tote_number,
           vendor = preserved.vendor,
           warehouse = preserved.warehouse
      FROM preserved
     WHERE ii.invoice_id = v_result
       AND ii.sort_order = preserved.sort_order
       AND ii.product_id IS NOT DISTINCT FROM preserved.product_id
       -- KI-76: a line saved with no unit takes a unit when it is written again (a0_fill_invoice_line_unit), so a
       -- blank saved unit matches the filled one. Any other unit must still match exactly.
       AND (ii.unit_size IS NOT DISTINCT FROM preserved.unit_size
            OR COALESCE(btrim(preserved.unit_size, E' \t\r\n' || chr(160)), '') = '');
    GET DIAGNOSTICS v_restored = ROW_COUNT;

    IF v_restored <> jsonb_array_length(v_lineage) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINEAGE_RESTORE_FAILED';
    END IF;
  END IF;

  UPDATE public.invoices i
     SET total_amount_cents = CASE WHEN v_keeps_line_cents
           THEN COALESCE((SELECT SUM(ii.extended_cents)::bigint FROM public.invoice_items ii WHERE ii.invoice_id = v_result), 0)
           ELSE i.total_amount_cents END,
         total_cost_cents = COALESCE((
           SELECT SUM(
             CASE WHEN ii.is_application_fee
               THEN ii.cost_cents
               ELSE ROUND(ii.cost_cents * ii.quantity)::bigint
             END
           )::bigint
           FROM public.invoice_items ii
           WHERE ii.invoice_id = v_result
         ), 0),
         updated_at = now()
   WHERE i.id = v_result
     AND i.status IN ('draft', 'unposted');

  RETURN v_result;
END;
$function$;

DO $save_postflight$
DECLARE
  v_fn regprocedure := 'public._save_invoice_scoped_impl(jsonb,jsonb,text)'::regprocedure;
BEGIN
  IF (SELECT md5(replace(replace(p.prosrc, chr(13), ''), $new$       -- KI-76: a line saved with no unit takes a unit when it is written again (a0_fill_invoice_line_unit), so a
       -- blank saved unit matches the filled one. Any other unit must still match exactly.
       AND (ii.unit_size IS NOT DISTINCT FROM preserved.unit_size
            OR COALESCE(btrim(preserved.unit_size, E' \t\r\n' || chr(160)), '') = '');
$new$, $old$       AND ii.unit_size IS NOT DISTINCT FROM preserved.unit_size;
$old$)) FROM pg_proc p WHERE p.oid = v_fn)
       <> '12272e4be85f18a7772d20a59d1ddf88'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn AND p.prosecdef
                      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                      AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_SAVE_INVOICE_UNIT_BODY';
  END IF;
END;
$save_postflight$;

DO $postflight$
DECLARE
  v_fn regprocedure := 'public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'::regprocedure;
  v_src text;
BEGIN
  SELECT replace(p.prosrc, chr(13), '') INTO v_src FROM pg_proc p WHERE p.oid = v_fn;
  -- The new body is live's with only the KI-76 refusal added before the invoice is written.
  IF md5(replace(v_src, $ki76_block$  -- KI-76: every line needs a unit before it is billed. A return is matched to its invoice line by the
  -- order line's unit, so a line billed with no unit could never be credited. Refuse rather than guess.
  IF EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = p_order_id AND COALESCE(btrim(oi.unit_size, E' \t\r\n' || chr(160)), '') = '') THEN
    RAISE EXCEPTION 'ORDER_LINE_UNIT_MISSING: order % has a line with no unit (%). Set each line''s unit on the order, then create the invoice again',
      v_order.order_number,
      (SELECT string_agg(COALESCE(NULLIF(btrim(oi.product_name), ''), 'unnamed product'), ', ' ORDER BY oi.sort_order NULLS LAST, oi.id)
         FROM order_items oi WHERE oi.order_id = p_order_id AND COALESCE(btrim(oi.unit_size, E' \t\r\n' || chr(160)), '') = '')
      USING ERRCODE = 'check_violation';
  END IF;

$ki76_block$, '')) <> '454e04c4e199549a4f5be9975e397e17'
     OR position('ORDER_LINE_UNIT_MISSING' in v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_UNIT_BODY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn AND p.prosecdef
                   AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                   AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_UNIT_SETTINGS';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('_fill_order_line_unit', '_fill_invoice_line_unit', '_refuse_post_blank_unit_line',
                           '_lock_quick_delivery_line_unit')
         AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) <> 4
     OR (SELECT count(*) FROM pg_trigger t
          WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
            AND (t.tgrelid, t.tgname) IN (('public.order_items'::regclass, 'trg_fill_order_line_unit'),
                                          ('public.invoice_items'::regclass, 'a0_fill_invoice_line_unit'),
                                          ('public.delivery_items'::regclass, 'a0_lock_quick_delivery_line_unit'),
                                          ('public.invoices'::regclass, 'zz_refuse_post_blank_unit_line'))) <> 4 THEN
    RAISE EXCEPTION 'POSTFLIGHT_BLANK_UNIT_TRIGGERS';
  END IF;
END;
$postflight$;
