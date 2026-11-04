-- Written 2026-11-03. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261106130000_invoice_resave_keeps_line_cents.md.
-- Re-read the live ledger before applying.
--
-- WHAT (S16b, money fix; Mason's order, 2 Nov): 5 gal at $5.33 ($26.65) delivered in two halves
--   is invoiced $13.33 + $13.32: the second half carries the remainder (20260817120000). Saving
--   the second draft invoice again with only a note changed re-rounded its line to 2.5 x $5.33 =
--   $13.33, so the customer was billed $26.66. save_invoice rebuilds every line; its wrapper
--   (_save_invoice_scoped_impl) already restores each order-linked line's identity, order line and
--   cost after the rebuild. It now also restores the line's total when the line comes back with
--   the same quantity and unit price, and the invoice total is summed from the lines again.
--
-- NOT CHANGED: a line whose quantity or unit price changes is still priced quantity x price; new
--   and manual lines; field-application invoices (their total is re-split across growers by the
--   implementation and is left exactly as it is); the implementation
--   _save_invoice_lineage_unaware_impl_20260827; the cap, below-cost and posted-invoice triggers
--   (they run on this UPDATE as before); grants. No table, column, grant or row is added, changed
--   or deleted; a draft invoice's lines and total change only when it is next saved.
--
-- ROLLBACK (its own reviewed migration): re-emit _save_invoice_scoped_impl from its
--   20261013220000 body and restore the cost-exposure-review keys this changes.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE invoice_resave_cents_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  IF to_regclass('pg_temp.invoice_resave_cents_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.invoice_resave_cents_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'INVOICE_RESAVE_CENTS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- The re-emitted function, pinned to its current body (20261013220000), owner, mode,
  -- search_path and EXECUTE grants. It has exactly one overload.
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._save_invoice_scoped_impl(jsonb,jsonb,text)');
  IF NOT FOUND
     OR (SELECT count(*) FROM pg_proc o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_save_invoice_scoped_impl') <> 1
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '622210352fd3c9fa3e293a8e48957429'
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres'] THEN
    RAISE EXCEPTION 'PREFLIGHT_SAVE_INVOICE_SCOPED_DRIFT: _save_invoice_scoped_impl differs from its pinned body, owner, mode, search_path or grants';
  END IF;
  -- The restore reads these columns by name; refuse if one has gone.
  IF EXISTS (
    SELECT 1
      FROM (VALUES ('quantity'), ('unit_price_cents'), ('extended_cents'), ('order_item_id')) AS c(col)
     WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = 'public.invoice_items'::regclass AND a.attname = c.col AND NOT a.attisdropped)
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_SAVE_INVOICE_SCOPED_DRIFT: an invoice_items column the restore reads is missing';
  END IF;
END
$preflight$;

-- _save_invoice_scoped_impl: the 20261013220000 body, plus the S16b line-total restore.
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
               'vendor', ii.vendor,
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
$function$
;

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._save_invoice_scoped_impl(jsonb,jsonb,text)');
  IF NOT FOUND
     OR (SELECT count(*) FROM pg_proc o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_save_invoice_scoped_impl') <> 1
     OR position('v_keeps_line_cents' IN p.prosrc) = 0
     OR position('extended_cents = CASE' IN p.prosrc) = 0
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres'] THEN
    RAISE EXCEPTION 'POSTFLIGHT: _save_invoice_scoped_impl lost its change, owner, mode, search_path or grants';
  END IF;
END
$postflight$;
