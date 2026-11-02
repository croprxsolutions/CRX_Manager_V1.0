-- Written 2026-11-02. STATUS: NOT APPLIED (local candidate).
--
-- WHAT: admin-only preview and confirmation for product active status. Open orders,
--   uninvoiced fulfilled order lines, and open purchase orders prevent deactivation.
--   Quotes, stock, crop programs and scheduled jobs are review warnings.
--   A completed delivery line with no invoice or external billing is treated as unknown
--   and prevents deactivation. Reopening an order with an inactive line is refused,
--   including fulfilled to partially_fulfilled after a voided delivery.
-- NOT CHANGED: business rows are not rewritten. Existing inactive lines may be edited
--   by id on their order or purchase order. Saving a quote rebuilds its lines, so a
--   quote holding an inactive product cannot be edited until reactivation or removal.
-- ACCESS CHANGE: the two review RPCs are admin-only; direct status changes require
--   a signed-in admin. A database job without a signed-in actor is refused.
--   No existing table access rule changes.
-- ROLLBACK (reviewed migration): remove the five triggers and their functions.
-- ORDERING: apply after WP-PM-12a and every older pending migration; recheck the ledger.
SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE product_active_guard_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
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
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
                AND tgname = 'trigger_a_guard_product_deactivation') THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_ACTIVE_GUARD_ALREADY_EXISTS';
  END IF;
  IF to_regprocedure('public._order_invoice_overbilling(uuid)') IS NULL
     OR to_regclass('public.product_change_history') IS NULL
     OR to_regclass('public.delivery_external_billings') IS NULL
     OR to_regprocedure('public._replay_fingerprint_20261015(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_ACTIVE_GUARD_DEPENDENCY_MISSING';
  END IF;
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
                -- No completed delivery item means an unknown quantity: refuse.
                NOT EXISTS (
                  SELECT 1 FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id
                   WHERE di.order_item_id = oi.id AND d.order_id = o.id
                     AND d.status = 'completed' AND d.deleted_at IS NULL)
                OR coalesce((
                  SELECT sum(round(coalesce(di.quantity_delivered, 0), 4))
                    FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id
                   WHERE di.order_item_id = oi.id AND d.order_id = o.id
                     AND d.status = 'completed' AND d.deleted_at IS NULL), 0) >
                  coalesce((
                    SELECT sum(ii.quantity) FROM public.invoice_items ii
                    JOIN public.invoices i ON i.id = ii.invoice_id
                    LEFT JOIN public.deliveries d ON d.id = i.delivery_id
                   WHERE ii.order_item_id = oi.id AND ii.product_id = oi.product_id
                     AND i.order_id = o.id AND i.invoice_type <> 'credit_memo'
                     AND i.deleted_at IS NULL AND i.status NOT IN ('voided', 'cancelled')
                     AND NOT (i.status = 'draft' AND coalesce(d.is_quick_delivery, false)
                       AND d.deleted_at IS NULL AND
                       (d.status IN ('scheduled', 'in_progress') OR
                        (d.status = 'completed' AND public._delivery_invoice_overbilling(i.id) IS NOT NULL)))) , 0)
                  + coalesce((
                    SELECT sum(round(coalesce(di.quantity_delivered, 0), 4))
                      FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id
                      JOIN public.delivery_external_billings b ON b.delivery_id = d.id
                     WHERE di.order_item_id = oi.id AND d.order_id = o.id
                       AND d.status = 'completed' AND d.deleted_at IS NULL), 0))))
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
         AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.quote_id = q.id AND o.deleted_at IS NULL)
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
      SELECT CASE WHEN jsonb_typeof(setting_value::jsonb) = 'array'
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
  FOR v_row IN SELECT id FROM public.products WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE LOOP
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
  -- update_order_items and save_purchase_order update retained ids in place. Their
  -- newly inserted lines reach the lock below. save_quote rebuilds every line, so
  -- editing a quote with an inactive product requires removing or reactivating it.
  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN RETURN NEW; END IF;
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
CREATE TRIGGER trigger_a_guard_inactive_order_item BEFORE INSERT OR UPDATE OF product_id ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_product_line();
CREATE TRIGGER trigger_a_guard_inactive_quote_item BEFORE INSERT OR UPDATE OF product_id ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_product_line();
CREATE TRIGGER trigger_a_guard_inactive_po_item BEFORE INSERT OR UPDATE OF product_id ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_product_line();

CREATE FUNCTION public.guard_order_reopen_inactive_product() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v_name text;
BEGIN
  IF OLD.status NOT IN ('confirmed', 'partially_fulfilled')
     AND NEW.status IN ('confirmed', 'partially_fulfilled') THEN
    SELECT p.product_name INTO v_name FROM public.order_items oi
      JOIN public.products p ON p.id = oi.product_id
     WHERE oi.order_id = NEW.id AND NOT p.is_active ORDER BY p.id LIMIT 1 FOR SHARE OF p;
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
CREATE TRIGGER a_guard_order_reopen_inactive_product BEFORE UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_reopen_inactive_product();

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
       AND tgname IN ('trigger_a_guard_product_deactivation', 'trigger_a_guard_inactive_order_item',
        'trigger_a_guard_inactive_quote_item', 'trigger_a_guard_inactive_po_item',
        'a_guard_order_reopen_inactive_product')) <> 5 THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_GUARD_POSTFLIGHT: triggers';
  END IF;
  IF has_function_privilege('anon', 'public.preview_product_active_change(uuid[],boolean)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.set_product_active(uuid[],boolean,text,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._product_active_review(uuid[])', 'EXECUTE')
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[
      'public.guard_product_deactivation()', 'public.guard_inactive_product_line()',
      'public.guard_order_reopen_inactive_product()']) AS f(signature),
      unnest(ARRAY['anon', 'authenticated']) AS r(role)
      WHERE has_function_privilege(r.role, f.signature, 'EXECUTE'))
    OR NOT has_function_privilege('authenticated', 'public.preview_product_active_change(uuid[],boolean)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.set_product_active(uuid[],boolean,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRODUCT_ACTIVE_GUARD_POSTFLIGHT: grants';
  END IF;
END;
$postflight$;
