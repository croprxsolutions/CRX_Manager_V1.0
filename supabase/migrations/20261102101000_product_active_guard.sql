-- Written 2026-11-02. STATUS: NOT APPLIED (local candidate).
-- idempotency-body-check: exempt -- set_product_active binds the request with check_idempotency_intent and a replay receipt instead of the legacy check_idempotency body pattern.
--
-- WHAT: admin-only preview and confirmation for product active status. Open orders,
--   uninvoiced fulfilled order lines, and open purchase orders prevent deactivation.
--   Quotes, quote templates, stock, crop programs and scheduled jobs are review warnings.
--   A delivered line with no completed delivery item is unknown and prevents deactivation.
--   A turned-off order line cannot regain positive remaining quantity, even when
--   its order is already partially fulfilled. New manual holds are also refused.
--   Purchase-order receipt reversal is not guarded: stock correction must remain possible.
--   Retired stock with a nonzero balance remains in inventory and increases the admin
--   inventory value by that stock's cost.
-- NOT CHANGED: business rows are not rewritten. Existing inactive lines may be edited
--   by id on their order or purchase order unless ordered quantity increases. Saving a quote rebuilds its lines, so a
--   quote holding an inactive product cannot be edited until reactivation or removal.
--   New sales through duplicate_quote, create_quote_from_template,
--   restore_quote_version, draw-down and rollover_quote_to_season refuse inactive products.
-- ACCESS CHANGE: the two review RPCs are admin-only; direct status changes require
--   a signed-in admin. A database job without a signed-in actor is refused.
--   No existing table access rule changes.
-- ROLLBACK (reviewed migration): remove the six triggers and their functions.
-- ORDERING: apply after WP-PM-12a and every older pending migration; recheck the ledger.
SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE product_active_guard_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE r record;
BEGIN
  IF to_regclass('pg_temp.product_active_guard_tx') IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_GUARD_NOT_IN_TRANSACTION';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.product_active_guard_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_GUARD_NOT_IN_TRANSACTION';
  END IF;
  IF to_regprocedure('public._product_active_review(uuid[])') IS NOT NULL
     OR to_regprocedure('public.preview_product_active_change(uuid[],boolean)') IS NOT NULL
     OR to_regprocedure('public.set_product_active(uuid[],boolean,text,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE
                (tgrelid = 'public.products'::regclass AND tgname = 'trigger_a_guard_product_deactivation')
                OR (tgrelid = 'public.inventory_holds'::regclass AND tgname = 'trigger_b_guard_inactive_manual_hold')) THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_ACTIVE_GUARD_ALREADY_EXISTS';
  END IF;
  IF to_regprocedure('public._delivery_invoice_overbilling(uuid)') IS NULL
     OR to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public._bind_replay_receipt_20261015(text,text,text)') IS NULL
     OR to_regclass('public.product_change_history') IS NULL
     OR to_regclass('public.delivery_external_billings') IS NULL
     OR to_regprocedure('public._replay_fingerprint_20261015(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_ACTIVE_GUARD_DEPENDENCY_MISSING';
  END IF;
  -- These are the bodies named above: the 2026-10-25 position implementation,
  -- the 2026-10-19 renamed cost implementation, and its admin wrapper.
  FOR r IN SELECT * FROM (VALUES
    ('public._get_inventory_position_cost_impl_20261019()', 'ae638950347495d311e4e386a9353362'),
    ('public._get_inventory_cost_report_cost_impl_20261019()', 'ae5899cb4c27fe0ea28a39ced278265b'),
    ('public.get_inventory_cost_report()', '2fdd283e39482add63e075ab84a7e52d')
  ) AS t(sig, pin) LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.pin THEN
      RAISE EXCEPTION 'PREFLIGHT_PRODUCT_ACTIVE_GUARD_BODY_DRIFT: %', r.sig;
    END IF;
  END LOOP;
END;
$preflight$;

CREATE FUNCTION public._product_active_review(p_product_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product record;
  v_record record;
  v_blockers jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_program jsonb;
BEGIN
  FOR v_product IN SELECT id, product_name FROM public.products
      WHERE id = ANY(p_product_ids) ORDER BY id LOOP
    FOR v_record IN
      SELECT DISTINCT o.order_number AS number, 'order' AS kind
        FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
       WHERE oi.product_id = v_product.id AND o.deleted_at IS NULL
         AND (o.status IN ('confirmed', 'partially_fulfilled')
           OR (o.status = 'fulfilled' AND (
                -- A historic delivered quantity without a completed item is unknown.
                (coalesce(oi.quantity_delivered, 0) > 0 AND NOT EXISTS (
                  SELECT 1 FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id
                   WHERE di.order_item_id = oi.id AND d.order_id = o.id
                     AND d.status = 'completed' AND d.deleted_at IS NULL))
                OR coalesce((
                  SELECT round(sum(coalesce(di.quantity_delivered, 0)), 4)
                    FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id
                   WHERE di.product_id = v_product.id AND d.order_id = o.id
                     AND d.status = 'completed' AND d.deleted_at IS NULL
                     AND NOT EXISTS (SELECT 1 FROM public.delivery_external_billings b
                                      WHERE b.delivery_id = d.id)), 0) >
                  coalesce((
                    SELECT round(sum(ii.quantity), 4) FROM public.invoice_items ii
                    JOIN public.invoices i ON i.id = ii.invoice_id
                    LEFT JOIN public.deliveries d ON d.id = i.delivery_id
                   WHERE ii.product_id = v_product.id
                     AND i.order_id = o.id AND i.invoice_type <> 'credit_memo'
                     AND i.deleted_at IS NULL AND i.status NOT IN ('voided', 'cancelled')
                     AND NOT (i.status = 'draft' AND coalesce(d.is_quick_delivery, false)
                       AND d.deleted_at IS NULL AND
                       (d.status IN ('scheduled', 'in_progress') OR
                        (d.status = 'completed' AND public._delivery_invoice_overbilling(i.id) IS NOT NULL)))) , 0))))
      UNION ALL
      SELECT DISTINCT po.po_number, 'purchase order' FROM public.purchase_order_items poi
        JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
       WHERE poi.product_id = v_product.id
         AND po.status IN ('draft', 'submitted', 'partially_received')
      ORDER BY kind, number
    LOOP
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'product_id', v_product.id, 'product_name', v_product.product_name,
        'kind', v_record.kind, 'number', v_record.number,
        'message', v_product.product_name || ': ' || v_record.kind || ' ' || v_record.number));
    END LOOP;

    FOR v_record IN
      SELECT DISTINCT q.quote_number AS number, 'quote' AS kind
        FROM public.quote_items qi JOIN public.quotes q ON q.id = qi.quote_id
       WHERE qi.product_id = v_product.id AND q.deleted_at IS NULL
         AND q.status IN ('draft', 'sent', 'revised', 'accepted')
         AND (q.status <> 'accepted' OR NOT EXISTS (SELECT 1 FROM public.orders o
              WHERE o.quote_id = q.id AND o.deleted_at IS NULL
                AND o.status NOT IN ('cancelled', 'voided')))
      UNION ALL
      SELECT DISTINCT t.template_name, 'quote template' FROM public.quote_templates t
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t.sections) s,
         jsonb_array_elements(coalesce(s->'items', '[]'::jsonb)) item
         WHERE item->>'product_id' = v_product.id::text)
      UNION ALL
      SELECT DISTINCT j.job_number, 'job' FROM public.job_chemicals jc
        JOIN public.jobs j ON j.id = jc.job_id
       WHERE jc.product_id = v_product.id AND j.deleted_at IS NULL
         AND j.status IN ('scheduled', 'in_progress')
      ORDER BY kind, number
    LOOP
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'product_id', v_product.id, 'product_name', v_product.product_name,
        'kind', v_record.kind, 'number', v_record.number,
        'message', v_product.product_name || ': ' || v_record.kind || ' ' || v_record.number));
    END LOOP;
    IF EXISTS (SELECT 1 FROM public.inventory
               WHERE product_id = v_product.id AND quantity_available <> 0) THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'product_id', v_product.id, 'product_name', v_product.product_name,
        'kind', 'stock', 'number', NULL,
        'message', v_product.product_name || ': stock remains on hand'));
    END IF;
    FOR v_program IN
      SELECT CASE WHEN btrim(setting_value) = '' THEN '[]'::jsonb
             WHEN jsonb_typeof(setting_value::jsonb) = 'array'
             THEN setting_value::jsonb ELSE jsonb_build_array(setting_value::jsonb) END
        FROM public.app_settings WHERE setting_key = 'crop_programs'
    LOOP
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_program) program,
          jsonb_array_elements(coalesce(program->'items', '[]'::jsonb)) item
        WHERE item->>'product_id' = v_product.id::text) THEN
        v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
          'product_id', v_product.id, 'product_name', v_product.product_name,
          'kind', 'crop program', 'number', NULL,
          'message', v_product.product_name || ': listed in a crop program'));
      END IF;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('blockers', v_blockers, 'warnings', v_warnings);
END;
$function$;
ALTER FUNCTION public._product_active_review(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_active_review(uuid[]) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public.preview_product_active_change(p_product_ids uuid[], p_active boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ids uuid[];
  v_review jsonb;
  v_products jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'NOT_AUTHORIZED: admin required' USING ERRCODE = '42501'; END IF;
  IF p_active IS NULL OR p_product_ids IS NULL OR cardinality(p_product_ids) = 0
     OR cardinality(p_product_ids) > 500 OR array_position(p_product_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_INVALID_SELECTION' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT id ORDER BY id) INTO v_ids FROM unnest(p_product_ids) id;
  SELECT jsonb_agg(jsonb_build_object('id', p.id, 'product_name', p.product_name,
    'is_active', p.is_active) ORDER BY p.id) INTO v_products FROM public.products p WHERE p.id = ANY(v_ids);
  IF jsonb_array_length(coalesce(v_products, '[]'::jsonb)) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_UNKNOWN_ID' USING ERRCODE = 'P0002';
  END IF;
  v_review := CASE WHEN p_active THEN jsonb_build_object('blockers', '[]'::jsonb, 'warnings', '[]'::jsonb)
                   ELSE public._product_active_review(v_ids) END;
  RETURN jsonb_build_object('products', v_products, 'blockers', v_review->'blockers',
    'warnings', v_review->'warnings', 'review_token',
    md5(array_to_string(v_ids, ',') || '|' || p_active::text || '|' || (v_review->'warnings')::text));
END;
$function$;
ALTER FUNCTION public.preview_product_active_change(uuid[], boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_product_active_change(uuid[], boolean) FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.preview_product_active_change(uuid[], boolean) TO authenticated;

CREATE FUNCTION public.set_product_active(p_product_ids uuid[], p_active boolean,
  p_review_token text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_ids uuid[];
  v_row record;
  v_count integer := 0;
  v_review jsonb;
  v_token text;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'NOT_AUTHORIZED: admin required' USING ERRCODE = '42501'; END IF;
  IF p_active IS NULL OR p_product_ids IS NULL OR cardinality(p_product_ids) = 0
     OR cardinality(p_product_ids) > 500 OR array_position(p_product_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_INVALID_SELECTION' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT id ORDER BY id) INTO v_ids FROM unnest(p_product_ids) id;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'product_ids', v_ids, 'active', p_active, 'review_token', p_review_token));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'set_product_active', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay->'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay->'result';
  END IF;
  FOR v_row IN SELECT id FROM public.products WHERE id = ANY(v_ids) ORDER BY id FOR NO KEY UPDATE LOOP
    v_count := v_count + 1;
  END LOOP;
  IF v_count <> cardinality(v_ids) THEN RAISE EXCEPTION 'PRODUCT_ACTIVE_UNKNOWN_ID' USING ERRCODE = 'P0002'; END IF;
  v_review := CASE WHEN p_active THEN jsonb_build_object('blockers', '[]'::jsonb, 'warnings', '[]'::jsonb)
                   ELSE public._product_active_review(v_ids) END;
  IF NOT p_active AND jsonb_array_length(v_review->'blockers') > 0 THEN
    RAISE EXCEPTION 'PRODUCT_DEACTIVATION_BLOCKED: %',
      (SELECT string_agg(e->>'message', '; ' ORDER BY e->>'message') FROM jsonb_array_elements(v_review->'blockers') e);
  END IF;
  v_token := md5(array_to_string(v_ids, ',') || '|' || p_active::text || '|' || (v_review->'warnings')::text);
  IF p_review_token IS DISTINCT FROM v_token THEN RAISE EXCEPTION 'PRODUCT_ACTIVE_REVIEW_STALE'; END IF;
  UPDATE public.products SET is_active = p_active, updated_at = now()
    WHERE id = ANY(v_ids) AND is_active IS DISTINCT FROM p_active;
  v_result := jsonb_build_object('products', (SELECT jsonb_agg(jsonb_build_object('id', id,
    'product_name', product_name, 'is_active', is_active) ORDER BY id)
    FROM public.products WHERE id = ANY(v_ids)), 'warnings', v_review->'warnings');
  PERFORM public.save_idempotency(p_idempotency_key, 'set_product_active', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_product_active', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.set_product_active(uuid[], boolean, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_product_active(uuid[], boolean, text, text) FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.set_product_active(uuid[], boolean, text, text) TO authenticated;

CREATE FUNCTION public.guard_product_deactivation() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_review jsonb;
BEGIN
  IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED: admin required' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF OLD.is_active AND NOT NEW.is_active THEN
    v_review := public._product_active_review(ARRAY[NEW.id]);
    IF jsonb_array_length(v_review->'blockers') > 0 THEN
      RAISE EXCEPTION 'PRODUCT_DEACTIVATION_BLOCKED: %',
        (SELECT string_agg(e->>'message', '; ' ORDER BY e->>'message') FROM jsonb_array_elements(v_review->'blockers') e);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_product_deactivation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_deactivation() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_a_guard_product_deactivation BEFORE UPDATE OF is_active ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_deactivation();

CREATE FUNCTION public.guard_inactive_product_line() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_active boolean; v_name text;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  -- Retained lines may decrease or edit other fields. An increase is a new sale.
  -- New lines and product swaps reach the same locked product check below.
  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN
    IF TG_TABLE_NAME = 'order_items' THEN
      -- A void/cancel can reopen a fully delivered line without changing the order status.
      IF COALESCE(OLD.quantity_remaining, 0) <= 0 AND COALESCE(NEW.quantity_remaining, 0) > 0 THEN
        NULL; -- Continue to the locked product check.
      ELSIF COALESCE(NEW.total_units_needed, 0) <= COALESCE(OLD.total_units_needed, 0) THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'quote_items' THEN
      IF COALESCE(NEW.total_units_needed, 0) <= COALESCE(OLD.total_units_needed, 0) THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'purchase_order_items' THEN
      IF COALESCE(NEW.quantity_ordered, 0) <= COALESCE(OLD.quantity_ordered, 0) THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  SELECT is_active, product_name INTO v_active, v_name FROM public.products
    WHERE id = NEW.product_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND: %', NEW.product_id; END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'PRODUCT_INACTIVE: % is turned off; an admin must reactivate it first', v_name;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_inactive_product_line() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_inactive_product_line() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_a_guard_inactive_order_item BEFORE INSERT OR UPDATE OF product_id, total_units_needed, quantity_remaining ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_product_line();
CREATE TRIGGER trigger_a_guard_inactive_quote_item BEFORE INSERT OR UPDATE OF product_id, total_units_needed ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_product_line();
CREATE TRIGGER trigger_a_guard_inactive_po_item BEFORE INSERT OR UPDATE OF product_id, quantity_ordered ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_product_line();

CREATE FUNCTION public.guard_inactive_manual_hold() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_active boolean; v_name text;
BEGIN
  -- Quote and job holds may still be resynced for allowed parent records.
  IF NEW.hold_type IS DISTINCT FROM 'manual' THEN RETURN NEW; END IF;
  SELECT is_active, product_name INTO v_active, v_name FROM public.products
    WHERE id = NEW.product_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND: %', NEW.product_id; END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'PRODUCT_INACTIVE: % is turned off; an admin must reactivate it first', v_name;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_inactive_manual_hold() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_inactive_manual_hold() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
-- PostgreSQL orders same-kind triggers by name: the existing intent guard runs first.
CREATE TRIGGER trigger_b_guard_inactive_manual_hold BEFORE INSERT ON public.inventory_holds
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_manual_hold();

CREATE FUNCTION public.guard_order_reopen_inactive_product() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_name text;
BEGIN
  IF OLD.status NOT IN ('confirmed', 'partially_fulfilled')
     AND NEW.status IN ('confirmed', 'partially_fulfilled') THEN
    PERFORM 1 FROM public.products p
     WHERE p.id IN (SELECT oi.product_id FROM public.order_items oi WHERE oi.order_id = NEW.id)
     ORDER BY p.id FOR SHARE;
    SELECT p.product_name INTO v_name FROM public.order_items oi
      JOIN public.products p ON p.id = oi.product_id
     WHERE oi.order_id = NEW.id AND coalesce(oi.quantity_remaining, 0) > 0
       AND NOT p.is_active ORDER BY p.id LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'PRODUCT_INACTIVE: % is turned off; an admin must reactivate it before reopening order %',
        v_name, NEW.order_number;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_order_reopen_inactive_product() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_order_reopen_inactive_product() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_z_guard_order_reopen_inactive_product BEFORE UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_reopen_inactive_product();

-- Retired products with a balance remain visible and valued. These are the newest
-- bodies from the named source migrations; only their product filters change.
CREATE OR REPLACE FUNCTION public._get_inventory_position_cost_impl_20261019()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_season_start date;
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF EXTRACT(MONTH FROM CURRENT_DATE) >= 10 THEN
    v_season_start := DATE_TRUNC('year', CURRENT_DATE)::date + INTERVAL '9 months';
  ELSE
    v_season_start := (DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year')::date + INTERVAL '9 months';
  END IF;

  RETURN (
    WITH on_order AS (
      SELECT poi.product_id, SUM(GREATEST(poi.quantity_ordered - COALESCE(poi.quantity_received, 0), 0)) AS qty
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('submitted', 'partially_received')
      GROUP BY poi.product_id
    ),
    holds AS (
      SELECT ih.product_id,
             SUM(ih.quantity) AS qty,
             -- LAYER2<<< job-type subset broken out as its own column (§4B.2 #1)
             SUM(ih.quantity) FILTER (WHERE ih.hold_type = 'job') AS job_qty
             -- >>>LAYER2
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      GROUP BY ih.product_id
    ),
    planned_quotes AS (
      -- LAYER2<<< quantity-aware dedup (§4B.2 #2): unreserved remainder per booking line.
      -- Codex A+B round-2 P2: AGGREGATE the booking per (quote, product) FIRST, THEN
      -- subtract the product-level hold/draws ONCE. Subtracting them inside a per-line
      -- SUM over-deducts when a product appears on multiple quote lines (two 50-unit
      -- lines with a 60-unit job draw and no hold would report 0 instead of 40 unreserved).
      SELECT pq.product_id, SUM(pq.remainder) AS qty
      FROM (
        SELECT b.quote_id, b.product_id,
               GREATEST(
                 b.booked
                   - COALESCE(lh.linked_hold, 0)
                   - COALESCE(od.order_drawn, 0)
                   - COALESCE(jd.job_drawn, 0),
                 0) AS remainder
        FROM (
          SELECT qi.quote_id, qi.product_id, SUM(COALESCE(qi.total_units_needed, 0)) AS booked
          FROM quote_items qi
          JOIN quotes q ON q.id = qi.quote_id
          WHERE q.is_planned = true AND q.status IN ('draft', 'sent', 'revised')
          GROUP BY qi.quote_id, qi.product_id
        ) b
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ih.quantity), 0) AS linked_hold
          FROM inventory_holds ih
          WHERE ih.source_id = b.quote_id
            AND ih.product_id = b.product_id
            AND ih.is_active = true
            AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
        ) lh ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(qpd.quantity_drawn), 0) AS order_drawn
          FROM quote_product_draws qpd
          WHERE qpd.quote_id = b.quote_id
            AND qpd.product_id = b.product_id
        ) od ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(jpd.quantity_drawn), 0) AS job_drawn
          FROM job_product_draws jpd
          WHERE jpd.quote_id = b.quote_id
            AND jpd.product_id = b.product_id
        ) jd ON true
      ) pq
      GROUP BY pq.product_id
      -- >>>LAYER2
    ),
    order_voided_products AS (
      -- void_order records one product-level reversal for the entire order and
      -- intentionally has no delivery_id. Pair that row back to all delivery
      -- events for the same order/product so its later ledger timestamp cannot
      -- move old delivered volume across season boundaries.
      SELECT DISTINCT it.order_id, it.product_id
      FROM inventory_transactions it
      WHERE it.transaction_type = 'void_delivery_reversal'
        AND it.delivery_id IS NULL
        AND it.order_id IS NOT NULL
    ),
    delivered_ytd AS (
      SELECT it.product_id,
             GREATEST(SUM(
               CASE
                 WHEN it.transaction_type = 'delivered' THEN ABS(it.quantity)
                 WHEN it.transaction_type IN ('cancelled_delivery_reversal', 'void_delivery_reversal')
                   THEN -ABS(it.quantity)
                 ELSE 0
               END
              ), 0) AS qty
      FROM inventory_transactions it
      JOIN deliveries d ON d.id = it.delivery_id
      LEFT JOIN order_voided_products ovp
        ON ovp.order_id = it.order_id
       AND ovp.product_id = it.product_id
      WHERE it.transaction_type IN ('delivered', 'cancelled_delivery_reversal', 'void_delivery_reversal')
        -- Delivery-specific reversals retain delivery_id, so they use the
        -- original delivery business date. Order-level voids are excluded by
        -- the paired order/product key above instead of their reversal date.
        AND (COALESCE(d.completed_at, it.created_at) AT TIME ZONE 'America/Chicago')::date >= v_season_start
        AND ovp.order_id IS NULL
      GROUP BY it.product_id
    ),
    base AS (
      SELECT
        p.id AS product_id, p.product_name, p.inventory_unit,
        p.container_size, p.container_type, p.vendor, p.current_cost, p.is_active,
        i.id AS inventory_id, i.location, i.unit_size,
        COALESCE(i.quantity_available, 0) AS quantity_available,
        COALESCE(i.quantity_prebooked, 0) AS quantity_prebooked,
        COALESCE(i.reorder_point, 0) AS reorder_point,
        COALESCE(i.min_stock_level, 0) AS min_stock_level
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      -- To-Do 0.13: a retired product stays listed while it still has stock on an open PO, so
      -- "what to order" does not undercount. It drops out once nothing is on order.
      WHERE p.is_active = true
         OR COALESCE(i.quantity_available, 0) <> 0
         OR EXISTS (SELECT 1 FROM on_order oo0 WHERE oo0.product_id = p.id AND oo0.qty > 0)
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.product_name), '[]'::jsonb)
    FROM (
      SELECT
        b.inventory_id, b.product_id, b.product_name, b.inventory_unit,
        b.container_size, b.container_type, b.vendor, b.current_cost,
        b.location, b.unit_size,
        b.quantity_available, b.quantity_prebooked,
        COALESCE(oo.qty, 0) AS quantity_on_order,
        COALESCE(h.qty, 0)  AS holds_qty,
        COALESCE(h.job_qty, 0) AS job_holds_qty,   -- LAYER2: new column
        COALESCE(pq.qty, 0) AS planned_qty,
        COALESCE(dy.qty, 0) AS delivered_ytd,
        (b.quantity_available - b.quantity_prebooked + COALESCE(oo.qty, 0)) AS net_position,
        b.reorder_point, b.min_stock_level,
        -- U18 #90: negative on-hand is always a stock problem, reorder_point set or not.
        -- To-Do 0.13: a retired product is listed only for its on-order stock; it is never
        -- "low", so it cannot land in the reorder banner.
        (b.is_active AND ((b.reorder_point > 0 AND b.quantity_available <= b.reorder_point) OR b.quantity_available < 0)) AS is_low_stock
      FROM base b
      LEFT JOIN on_order       oo ON oo.product_id = b.product_id
      LEFT JOIN holds          h  ON h.product_id  = b.product_id
      LEFT JOIN planned_quotes pq ON pq.product_id = b.product_id
      LEFT JOIN delivered_ytd  dy ON dy.product_id = b.product_id
      WHERE b.inventory_id IS NOT NULL OR COALESCE(oo.qty, 0) > 0
    ) r
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._get_inventory_cost_report_cost_impl_20261019()
 RETURNS TABLE(product_id uuid, product_name text, sku text, category text, vendor text, quantity_available numeric, quantity_prebooked numeric, net_available numeric, unit_cost numeric, total_cost_value numeric, reorder_point numeric, below_reorder boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;
  RETURN QUERY
  SELECT pr.id, pr.product_name, pr.sku, pr.category, pr.vendor,
    COALESCE(inv.quantity_available, 0), COALESCE(inv.quantity_prebooked, 0),
    COALESCE(inv.quantity_available, 0) - COALESCE(inv.quantity_prebooked, 0),
    COALESCE(pr.current_cost, 0),
    ROUND((COALESCE(inv.quantity_available, 0) * COALESCE(pr.current_cost, 0))::numeric, 2),
    COALESCE(inv.reorder_point, 0),
    pr.is_active AND COALESCE(inv.quantity_available, 0) < COALESCE(inv.reorder_point, 0)
  FROM products pr LEFT JOIN inventory inv ON inv.product_id = pr.id
  -- BEGIN DELTA inventory_cost_report_column_fix (2026-06-10): the live filter
  -- referenced a soft-delete timestamp column that does not exist on products
  -- (42703). The real products soft-delete mechanism is the is_active flag
  -- (Products.tsx deactivates; every picker filters is_active = true).
  WHERE pr.is_active = true OR COALESCE(inv.quantity_available, 0) <> 0
  -- END DELTA inventory_cost_report_column_fix
  ORDER BY pr.product_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_inventory_cost_report()
RETURNS TABLE(product_id uuid, product_name text, sku text, category text, vendor text,
              quantity_available numeric, quantity_prebooked numeric, net_available numeric,
              unit_cost numeric, total_cost_value numeric, reorder_point numeric, below_reorder boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15).
  PERFORM public.require_admin();
  RETURN QUERY SELECT * FROM public._get_inventory_cost_report_cost_impl_20261019();
END;
$function$;
REVOKE ALL ON FUNCTION public._get_inventory_position_cost_impl_20261019() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public._get_inventory_cost_report_cost_impl_20261019() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
       AND tgname IN ('trigger_a_guard_product_deactivation', 'trigger_a_guard_inactive_order_item',
        'trigger_a_guard_inactive_quote_item', 'trigger_a_guard_inactive_po_item',
        'trigger_z_guard_order_reopen_inactive_product', 'trigger_b_guard_inactive_manual_hold')) <> 6 THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_GUARD_POSTFLIGHT: triggers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass
    AND tgname = 'trigger_z_guard_order_reopen_inactive_product' AND tgenabled = 'O'
    AND tgfoid = 'public.guard_order_reopen_inactive_product()'::regprocedure) THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_GUARD_POSTFLIGHT: order trigger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.inventory_holds'::regclass
    AND tgname = 'trigger_b_guard_inactive_manual_hold' AND tgenabled = 'O'
    AND tgfoid = 'public.guard_inactive_manual_hold()'::regprocedure) THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_GUARD_POSTFLIGHT: hold trigger';
  END IF;
  IF has_function_privilege('anon', 'public.preview_product_active_change(uuid[],boolean)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.set_product_active(uuid[],boolean,text,text)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.preview_product_active_change(uuid[],boolean)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.set_product_active(uuid[],boolean,text,text)', 'EXECUTE')
    OR has_function_privilege('metabase_ro', 'public.preview_product_active_change(uuid[],boolean)', 'EXECUTE')
    OR has_function_privilege('metabase_ro', 'public.set_product_active(uuid[],boolean,text,text)', 'EXECUTE')
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[
      'public._product_active_review(uuid[])', 'public.guard_product_deactivation()',
      'public.guard_inactive_product_line()', 'public.guard_inactive_manual_hold()',
      'public.guard_order_reopen_inactive_product()',
      'public._get_inventory_position_cost_impl_20261019()',
      'public._get_inventory_cost_report_cost_impl_20261019()']) AS f(signature),
      unnest(ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro']) AS r(role)
      WHERE has_function_privilege(r.role, f.signature, 'EXECUTE'))
    OR NOT has_function_privilege('authenticated', 'public.preview_product_active_change(uuid[],boolean)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.set_product_active(uuid[],boolean,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_GUARD_POSTFLIGHT: grants';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.set_product_active(uuid[],boolean,text,text)'::regprocedure)
       IS DISTINCT FROM '22c79c8cc58d2e575ca353511e38c291'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.guard_inactive_product_line()'::regprocedure)
       IS DISTINCT FROM '6164651cbc549e459d7bedd8cf32abc7' THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_GUARD_POSTFLIGHT: guards';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._get_inventory_position_cost_impl_20261019()'::regprocedure)
       IS DISTINCT FROM '6043fa5c13f508bf4c123ccad5d0cb12'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._get_inventory_cost_report_cost_impl_20261019()'::regprocedure)
       IS DISTINCT FROM 'fb77a0d38ee1bb31a3c5a43dd1a0da59'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.get_inventory_cost_report()'::regprocedure)
       IS DISTINCT FROM '2fdd283e39482add63e075ab84a7e52d'
     OR position('OR COALESCE(i.quantity_available, 0) <> 0' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public._get_inventory_position_cost_impl_20261019()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_GUARD_POSTFLIGHT: inventory bodies %, %, %',
      (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._get_inventory_position_cost_impl_20261019()'::regprocedure),
      (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._get_inventory_cost_report_cost_impl_20261019()'::regprocedure),
      (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.get_inventory_cost_report()'::regprocedure);
  END IF;
END;
$postflight$;
