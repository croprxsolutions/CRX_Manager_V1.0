-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261116110000_sale_line_vendor.md.
-- Re-read the live ledger before applying.
--
-- WHAT (billing plan M3, Mason 4 Nov: vendor "auto-filled from the product's preferred vendor; Mason
--   can pick another on each sale without changing anything else"): an order line now has a vendor.
--   - New column order_items.vendor. A trigger fills it from the product's preferred vendor
--     (products.vendor, the copy 20261105180000 keeps) when a line is created without one, whichever
--     path creates it.
--   - A trigger fills invoice_items.vendor from its order line when a line is written without one, so
--     every invoice path carries it. A line from before this migration has no vendor, so it falls
--     back to the product's preferred vendor. A vendor set on the invoice line stays.
--   - An admin can change a line's vendor: UPDATE on this one column, under the existing admin-only
--     oitems_update policy. A booking draw's lines refuse update_order_items, so that isn't the path.
--   - save_invoice now takes a vendor it's sent for a line. Before, it always kept the old one, so a
--     draft's vendor couldn't be corrected when the office bills after delivery. A save that sends
--     no vendor still keeps the line's. _save_invoice_scoped_impl is re-emitted with that one change.
--
-- NOT CHANGED: products.vendor and the preferred vendor links, prices, costs, and every other invoice
--   and order function. No existing row is written.
--
-- ROLLBACK (its own reviewed migration): re-emit _save_invoice_scoped_impl from its previous body, drop
--   both triggers and their functions, then the column.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE sale_line_vendor_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.sale_line_vendor_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.sale_line_vendor_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'SALE_LINE_VENDOR_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'vendor') THEN
    RAISE EXCEPTION 'SALE_LINE_VENDOR_PREFLIGHT: order_items.vendor already exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'invoice_items' AND column_name = 'vendor')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'vendor') THEN
    RAISE EXCEPTION 'SALE_LINE_VENDOR_PREFLIGHT: invoice_items.vendor or products.vendor is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public._save_invoice_scoped_impl'::regproc
                    AND md5(replace(p.prosrc, chr(13), '')) = '594f85411f0c40f2ab980a264ac799f6'
                    AND p.proowner = 'postgres'::regrole AND p.prosecdef
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                    AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]) THEN
    RAISE EXCEPTION 'SALE_LINE_VENDOR_PREFLIGHT: _save_invoice_scoped_impl drifted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'public.order_items'::regclass AND polname = 'oitems_update'
                    AND pg_get_expr(polqual, polrelid) = 'is_admin()') THEN
    RAISE EXCEPTION 'SALE_LINE_VENDOR_PREFLIGHT: oitems_update is no longer admin-only, so the column grant would widen';
  END IF;
END
$preflight$;

ALTER TABLE public.order_items ADD COLUMN vendor text;

GRANT SELECT (vendor) ON public.order_items TO authenticated;
GRANT REFERENCES (vendor) ON public.order_items TO authenticated;
GRANT SELECT (vendor) ON public.order_items TO anon;
GRANT UPDATE (vendor) ON public.order_items TO authenticated;

CREATE FUNCTION public._fill_order_line_vendor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NULLIF(btrim(NEW.vendor), '') IS NULL AND NEW.product_id IS NOT NULL THEN
    NEW.vendor := (SELECT p.vendor FROM products p WHERE p.id = NEW.product_id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public._fill_invoice_line_vendor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NULLIF(btrim(NEW.vendor), '') IS NULL AND NEW.order_item_id IS NOT NULL THEN
    NEW.vendor := (SELECT COALESCE(NULLIF(btrim(oi.vendor), ''), p.vendor)
                     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
                    WHERE oi.id = NEW.order_item_id);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._fill_order_line_vendor() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fill_invoice_line_vendor() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_fill_order_line_vendor
  BEFORE INSERT ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._fill_order_line_vendor();

CREATE TRIGGER trg_fill_invoice_line_vendor
  BEFORE INSERT OR UPDATE OF vendor, order_item_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._fill_invoice_line_vendor();

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
       AND ii.unit_size IS NOT DISTINCT FROM preserved.unit_size;
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

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public._save_invoice_scoped_impl'::regproc
                    AND position('NULLIF(btrim(incoming.item->>''vendor''), '''')' IN p.prosrc) > 0
                    AND p.proowner = 'postgres'::regrole AND p.prosecdef
                    AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]) THEN
    RAISE EXCEPTION 'SALE_LINE_VENDOR_POSTFLIGHT: _save_invoice_scoped_impl lost its change, owner, mode or grants';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.order_items', 'vendor', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.order_items', 'price_per_unit', 'UPDATE')
     OR has_column_privilege('anon', 'public.order_items', 'vendor', 'UPDATE') THEN
    RAISE EXCEPTION 'SALE_LINE_VENDOR_POSTFLIGHT: UPDATE is not exactly the vendor column for authenticated';
  END IF;
  IF has_function_privilege('authenticated', 'public._fill_invoice_line_vendor()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fill_order_line_vendor()', 'EXECUTE') THEN
    RAISE EXCEPTION 'SALE_LINE_VENDOR_POSTFLIGHT: the trigger functions must not be callable directly';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('trg_fill_order_line_vendor', 'trg_fill_invoice_line_vendor') AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION 'SALE_LINE_VENDOR_POSTFLIGHT: a trigger is missing';
  END IF;
END
$postflight$;
