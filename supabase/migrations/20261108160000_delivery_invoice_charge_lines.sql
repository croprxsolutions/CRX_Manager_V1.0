-- Written 2026-11-05. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261108110000_delivery_invoice_charge_lines.md.
-- Re-read the live ledger before applying.
--
-- WHAT (billing plan M1, Mason 4 Nov: "one-off misc charge lines (freight, delivery, service) can
--   go on a chemical sale"): a delivery invoice now accepts typed charge lines (freight,
--   application fee, service, other). _delivery_invoice_overbilling refused every line with no
--   product; it now refuses only a no-product line with no charge type. Charge lines are left out
--   of the delivered-quantity caps (they carry no product). invoice_items' existing CHECK already
--   holds a charge line to one amount: no product, no order line, quantity 1, cost 0, price above 0.
--   Order invoices with no delivery already accept typed charges (_order_invoice_overbilling,
--   20261029160000); this brings delivery invoices in line.
--
-- NOT CHANGED: every product rule. An extra product, a product the delivery didn't carry, more
--   than was delivered, a negative quantity, and posting before the delivery is completed are all
--   still refused. The trigger function enforce_delivery_invoice_within_delivered, both triggers,
--   the below-cost guard, save_invoice and every policy and grant. No table, column or row changes.
--
-- ROLLBACK (its own reviewed migration): re-emit public._delivery_invoice_overbilling(uuid) from its
--   20261010120000 body. Any delivery invoice already carrying a charge line must have that line
--   removed (or the invoice voided) first, or its next line write is refused.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE delivery_invoice_charge_lines_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  IF to_regclass('pg_temp.delivery_invoice_charge_lines_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.delivery_invoice_charge_lines_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CHARGE_LINES_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- The re-emitted function, pinned to its current body (20261010120000), owner, mode, search_path
  -- and grants. It has exactly one overload.
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._delivery_invoice_overbilling(uuid)');
  IF NOT FOUND
     OR (SELECT count(*) FROM pg_proc o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_delivery_invoice_overbilling') <> 1
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '5d706ffe2938e49a89eb36f38bab059d'
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[] THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CHARGE_LINES_PREFLIGHT: _delivery_invoice_overbilling drifted from 20261010120000';
  END IF;
  -- The charge-line shape this relies on (20261021050000).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.invoice_items'::regclass AND c.contype = 'c'
                    AND pg_get_constraintdef(c.oid) LIKE 'CHECK (((charge_type IS NULL) OR ((product_id IS NULL) AND (order_item_id IS NULL)%(quantity = (1)::numeric) AND (cost_cents = 0)%(unit_price_cents > 0)%') THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CHARGE_LINES_PREFLIGHT: the invoice_items charge-line CHECK is missing or changed';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._delivery_invoice_overbilling(p_invoice_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice record;
  v_delivery record;
  v_bad record;
BEGIN
  SELECT i.id, i.invoice_number, i.delivery_id, i.invoice_type, i.status, i.deleted_at
    INTO v_invoice
    FROM public.invoices i
   WHERE i.id = p_invoice_id;
  IF NOT FOUND
     OR v_invoice.delivery_id IS NULL
     OR v_invoice.invoice_type = 'credit_memo'
     OR v_invoice.deleted_at IS NOT NULL
     OR v_invoice.status IN ('voided', 'cancelled') THEN
    RETURN NULL;
  END IF;

  SELECT d.id, d.delivery_number, d.status, d.deleted_at
    INTO v_delivery
    FROM public.deliveries d
   WHERE d.id = v_invoice.delivery_id;
  IF NOT FOUND THEN
    RETURN format('invoice %s names a delivery that does not exist', v_invoice.invoice_number);
  END IF;

  IF v_invoice.status IN ('posted', 'paid', 'overdue')
     AND v_delivery.deleted_at IS NULL
     AND v_delivery.status IN ('scheduled', 'in_progress') THEN
    RETURN format('invoice %s cannot be posted before delivery %s is completed',
                  v_invoice.invoice_number, v_delivery.delivery_number);
  END IF;

  PERFORM 1
    FROM public.invoice_items ii
   WHERE ii.invoice_id = v_invoice.id
     AND ((ii.product_id IS NULL AND ii.charge_type IS NULL)
          OR (ii.product_id IS NOT NULL AND (ii.quantity IS NULL OR ii.quantity < 0)));
  IF FOUND THEN
    RETURN format('invoice %s has a line with no product and no charge type, or a negative quantity; a delivery invoice bills the products delivery %s delivered, plus typed charges (freight, application fee, service, other)',
                  v_invoice.invoice_number, v_delivery.delivery_number);
  END IF;

  -- An order-linked line must be an order line this delivery carried, for the same product.
  SELECT COALESCE(NULLIF(btrim(ii.description), ''), p.product_name, 'a product') AS label INTO v_bad
    FROM public.invoice_items ii
    LEFT JOIN public.products p ON p.id = ii.product_id
   WHERE ii.invoice_id = v_invoice.id
     AND ii.order_item_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.delivery_items di
        WHERE di.delivery_id = v_delivery.id
          AND di.order_item_id = ii.order_item_id
          AND di.product_id = ii.product_id)
   ORDER BY ii.sort_order, ii.id
   LIMIT 1;
  IF FOUND THEN
    RETURN format('invoice %s bills %s from an order line delivery %s did not carry',
                  v_invoice.invoice_number, v_bad.label, v_delivery.delivery_number);
  END IF;

  -- Quantity caps, across every active invoice for this delivery.
  WITH allowed AS (
    SELECT di.order_item_id, di.product_id,
           SUM(ROUND(CASE
                 WHEN v_delivery.deleted_at IS NOT NULL OR v_delivery.status IN ('cancelled', 'voided') THEN 0
                 WHEN v_delivery.status = 'completed' THEN COALESCE(di.quantity_delivered, 0)
                 ELSE GREATEST(COALESCE(di.quantity, 0), COALESCE(di.quantity_delivered, 0))
               END, 4)) AS qty
      FROM public.delivery_items di
     WHERE di.delivery_id = v_delivery.id
     GROUP BY di.order_item_id, di.product_id
  ), billed AS (
    SELECT ii.order_item_id, ii.product_id, ii.quantity
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
     WHERE i.delivery_id = v_delivery.id
       AND ii.product_id IS NOT NULL   -- a typed charge line carries no product quantity
       AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND i.status NOT IN ('voided', 'cancelled')
  ), over_line AS (
    SELECT b.product_id, SUM(b.quantity) AS billed_qty,
           (SELECT COALESCE(SUM(a.qty), 0) FROM allowed a WHERE a.order_item_id = b.order_item_id) AS allowed_qty
      FROM billed b
     WHERE b.order_item_id IS NOT NULL
     GROUP BY b.order_item_id, b.product_id
  ), over_product AS (
    SELECT b.product_id, SUM(b.quantity) AS billed_qty,
           (SELECT COALESCE(SUM(a.qty), 0) FROM allowed a WHERE a.product_id = b.product_id) AS allowed_qty
      FROM billed b
     GROUP BY b.product_id
  )
  SELECT COALESCE(p.product_name, o.product_id::text) AS label, o.billed_qty, o.allowed_qty INTO v_bad
    FROM (SELECT * FROM over_line UNION ALL SELECT * FROM over_product) o
    LEFT JOIN public.products p ON p.id = o.product_id
   WHERE o.billed_qty > o.allowed_qty
   ORDER BY 1, 2
   LIMIT 1;
  IF FOUND THEN
    RETURN format('invoice %s bills %s of %s, but delivery %s allows %s',
                  v_invoice.invoice_number, v_bad.billed_qty, v_bad.label,
                  v_delivery.delivery_number, v_bad.allowed_qty);
  END IF;

  RETURN NULL;
END;
$function$;


ALTER FUNCTION public._delivery_invoice_overbilling(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._delivery_invoice_overbilling(uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public._delivery_invoice_overbilling(uuid)');
  IF p.oid IS NULL
     OR position('ii.product_id IS NULL AND ii.charge_type IS NULL' IN p.prosrc) = 0
     OR position('AND ii.product_id IS NOT NULL   -- a typed charge line' IN p.prosrc) = 0
     OR position('cannot be posted before delivery' IN p.prosrc) = 0
     OR position('from an order line delivery' IN p.prosrc) = 0
     OR position('but delivery %s allows %s' IN p.prosrc) = 0
     OR p.proowner <> 'postgres'::regrole OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[] THEN
    RAISE EXCEPTION 'POSTFLIGHT: _delivery_invoice_overbilling lost its change, a product rule, owner, mode, search_path or grants';
  END IF;
END
$postflight$;
